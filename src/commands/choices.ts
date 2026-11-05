import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "../lib/args.ts";
import {
  CHOICES_LINE_LIMIT,
  checkNewChoice,
  choicesDir,
  choicesPath,
  countLines,
  parseChoices,
  readChoices,
  renderChoices,
  sameChoice,
  withChoicesLock,
  writeChoices,
} from "../lib/choices.ts";
import { requireRoot } from "../lib/git.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE =
  "使い方：orca-flow choices [--path] | choices add 〈ファイル〉 | choices remove 〈番号〉 --heading 〈見出し〉";

export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["heading"], ["path"]);
  const [sub, ...rest] = args.positionals;
  const heading = args.values.get("heading");
  if (heading !== undefined && sub !== "remove") throw new FlowError(1, USAGE);

  if (sub === undefined) {
    if (!args.flags.has("path") && rest.length > 0)
      throw new FlowError(1, USAGE);
    const root = await requireRoot(ctx.runner, ctx.cwd);
    const file = await choicesPath(ctx.runner, root);
    if (args.flags.has("path")) {
      if (!ctx.json) ctx.stdout(file);
      return { code: 0, data: { path: file } };
    }
    const text = await readChoices(file);
    const items = text === null ? [] : parseChoices(text).items;
    if (items.length === 0) {
      if (!ctx.json) ctx.stdout("人の選択はありません");
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
    const item = checkNewChoice(text);
    const dir = await choicesDir(ctx.runner, root);
    const file = await choicesPath(ctx.runner, root);
    const result = await withChoicesLock(dir, async () => {
      const parsed = parseChoices((await readChoices(file)) ?? "");
      const same = parsed.items.find((i) => i.heading === item.heading);
      if (same) {
        if (sameChoice(same, item))
          return { added: false, lines: countLines(renderChoices(parsed)) };
        throw new FlowError(
          1,
          `見出し「${item.heading}」の選択はすでにあり、中身が違います。足していません。置き換えるなら、違う見出しで足してから古い項を remove --heading で消してください`,
        );
      }
      parsed.items.push(item);
      const next = renderChoices(parsed);
      await writeChoices(file, next);
      return { added: true, lines: countLines(next) };
    });
    const { added, lines } = result;
    if (!ctx.json)
      ctx.stdout(
        added
          ? `人の選択を足しました：${item.heading}（${lines} 行）`
          : `人の選択はすでにあります（同じ中身）。足していません：${item.heading}`,
      );
    if (added && lines > CHOICES_LINE_LIMIT)
      ctx.stderr(
        `警告：人の選択のファイルが ${lines} 行になり、目安の ${CHOICES_LINE_LIMIT} 行を越えました。古い選択の削除（orca-flow choices remove 〈番号〉 --heading 〈見出し〉）を考えてください`,
      );
    return {
      code: 0,
      data: {
        path: file,
        heading: item.heading,
        added,
        lines,
        overLimit: added && lines > CHOICES_LINE_LIMIT,
      },
    };
  }

  if (sub === "remove") {
    const [numberText, ...extra] = rest;
    if (
      !numberText ||
      extra.length > 0 ||
      !/^[1-9][0-9]*$/.test(numberText) ||
      heading === undefined
    )
      throw new FlowError(1, USAGE);
    const number = Number(numberText);
    const root = await requireRoot(ctx.runner, ctx.cwd);
    const dir = await choicesDir(ctx.runner, root);
    const file = await choicesPath(ctx.runner, root);
    const removed = await withChoicesLock(dir, async () => {
      const parsed = parseChoices((await readChoices(file)) ?? "");
      if (number > parsed.items.length)
        throw new FlowError(
          1,
          `${number} 番の人の選択はありません（今は ${parsed.items.length} 項）。何も消していません`,
        );
      const want = heading.trim();
      const now = parsed.items[number - 1]!.heading;
      if (now !== want) {
        const at = parsed.items.findIndex((item) => item.heading === want);
        throw new FlowError(
          1,
          `${number} 番の見出しは「${now}」で、渡された見出し「${want}」ではありません。「${want}」の今の番号：${at < 0 ? "ない" : `${at + 1} 番`}。何も消していません。人の選択を読み直して番号を取り直してください`,
        );
      }
      const [gone] = parsed.items.splice(number - 1, 1);
      const next = renderChoices(parsed);
      await writeChoices(file, next);
      return { gone: gone! };
    });
    if (!ctx.json) ctx.stdout(`人の選択を消しました：${removed.gone.heading}`);
    return {
      code: 0,
      data: { path: file, number, heading: removed.gone.heading },
    };
  }

  throw new FlowError(1, USAGE);
};
