import { requireFlowConfig } from "../lib/flow-config.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "../lib/args.ts";
import { requireRoot } from "../lib/git.ts";
import {
  LESSONS_LINE_LIMIT,
  checkNewLesson,
  countLines,
  lessonsDir,
  lessonsPath,
  parseLessons,
  readLessons,
  renderLessons,
  withLessonsLock,
  writeLessons,
} from "../lib/lessons.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE =
  "使い方：orca-flow lessons [--path] | lessons add 〈ファイル〉 | lessons remove 〈番号〉 [--heading 〈見出し〉]";

export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["heading"], ["path"]);
  const [sub, ...rest] = args.positionals;
  const heading = args.values.get("heading");
  if (heading !== undefined && sub !== "remove") throw new FlowError(1, USAGE);

  if (sub === undefined) {
    if (args.flags.has("path") === false && rest.length > 0)
      throw new FlowError(1, USAGE);
    const root = await requireRoot(ctx.runner, ctx.cwd);
    const file = await lessonsPath(ctx.runner, root);
    if (args.flags.has("path")) {
      if (!ctx.json) ctx.stdout(file);
      return { code: 0, data: { path: file } };
    }
    const text = await readLessons(file);
    const items = text === null ? [] : parseLessons(text).items;
    if (items.length === 0) {
      if (!ctx.json) ctx.stdout("教訓はありません");
      return { code: 0, data: { path: file, items: [] } };
    }
    if (!ctx.json)
      ctx.stdout(
        items
          .map((item, i) =>
            [`${i + 1}. ${item.heading}`, ...item.lines.slice(1)].join("\n"),
          )
          .join("\n\n"),
      );
    return {
      code: 0,
      data: {
        path: file,
        items: items.map((item, i) => ({
          number: i + 1,
          heading: item.heading,
        })),
      },
    };
  }

  if (args.flags.has("path")) throw new FlowError(1, USAGE);

  if (sub === "add") {
    const [source, ...extra] = rest;
    if (!source || extra.length > 0) throw new FlowError(1, USAGE);
    const root = await requireRoot(ctx.runner, ctx.cwd);
    const config = await requireFlowConfig(ctx.runner, root);
    const sourcePath = path.resolve(ctx.cwd, source);
    let text: string;
    try {
      text = await readFile(sourcePath, "utf8");
    } catch (error) {
      throw new FlowError(
        1,
        `${source} を読めませんでした（${error instanceof Error ? error.message : String(error)}）。足していません`,
      );
    }
    const item = checkNewLesson(text, {
      idPrefix: config.idPrefix,
      root,
      env: ctx.env,
    });
    const dir = await lessonsDir(ctx.runner, root);
    const file = await lessonsPath(ctx.runner, root);
    const lines = await withLessonsLock(dir, async () => {
      const parsed = parseLessons((await readLessons(file)) ?? "");
      parsed.items.push(item);
      const next = renderLessons(parsed);
      await writeLessons(file, next);
      return countLines(next);
    });
    if (!ctx.json)
      ctx.stdout(`教訓を足しました：${item.heading}（${lines} 行）`);
    if (lines > LESSONS_LINE_LIMIT)
      ctx.stderr(
        `警告：教訓のファイルが ${lines} 行になり、目安の ${LESSONS_LINE_LIMIT} 行を越えました。似た項のまとめ直しや、テストや lint になった項の削除（orca-flow lessons remove 〈番号〉）を考えてください`,
      );
    return {
      code: 0,
      data: {
        path: file,
        heading: item.heading,
        lines,
        overLimit: lines > LESSONS_LINE_LIMIT,
      },
    };
  }

  if (sub === "remove") {
    const [numberText, ...extra] = rest;
    if (!numberText || extra.length > 0 || !/^[1-9][0-9]*$/.test(numberText))
      throw new FlowError(1, USAGE);
    const number = Number(numberText);
    const root = await requireRoot(ctx.runner, ctx.cwd);
    const dir = await lessonsDir(ctx.runner, root);
    const file = await lessonsPath(ctx.runner, root);
    const removed = await withLessonsLock(dir, async () => {
      const text = await readLessons(file);
      const parsed = parseLessons(text ?? "");
      if (number > parsed.items.length)
        throw new FlowError(
          1,
          `${number} 番の教訓はありません（今は ${parsed.items.length} 項）。何も消していません`,
        );
      if (heading !== undefined) {
        const want = heading.trim();
        const now = parsed.items[number - 1]!.heading;
        if (now !== want) {
          const at = parsed.items.findIndex((item) => item.heading === want);
          throw new FlowError(
            1,
            `${number} 番の見出しは「${now}」で、渡された見出し「${want}」ではありません。「${want}」の今の番号：${at < 0 ? "ない" : `${at + 1} 番`}。何も消していません。教訓を読み直して番号を取り直してください`,
          );
        }
      }
      const [gone] = parsed.items.splice(number - 1, 1);
      await writeLessons(file, renderLessons(parsed));
      return gone!;
    });
    if (!ctx.json) ctx.stdout(`教訓を消しました：${removed.heading}`);
    return { code: 0, data: { path: file, number, heading: removed.heading } };
  }

  throw new FlowError(1, USAGE);
};
