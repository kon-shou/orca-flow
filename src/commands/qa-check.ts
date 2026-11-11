import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "../lib/args.ts";
import { gitCommonDir, requireRoot } from "../lib/git.ts";
import { previewBaseStatus } from "../lib/preview-base.ts";
import { createOrca, type Orca } from "../lib/orca.ts";
import { readPreviewRecord, urlAnswers } from "../lib/preview.ts";
import {
  countResults,
  deleteQaProfile,
  describeCounts,
  forgetProfile,
  httpOrigin,
  isShotName,
  listShots,
  parseRecordInput,
  qaChecksDir,
  qaProfileLabel,
  readPages,
  readProfile,
  readResult,
  writePages,
  writeProfile,
  writeResult,
  writeShot,
  type OpenedPages,
  type Side,
} from "../lib/qa-check.ts";
import { hasIdShape } from "../lib/task-id.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

const USAGE =
  "使い方：orca-flow qa-check 〈ID〉 [--open [--base]|--shot 〈名前〉 [--base]|--record --input 〈JSON のパス〉|--show|--close|--clear] [--json]";

const ACTIONS = ["open", "shot", "record", "show", "close", "clear"] as const;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * QA 項目の確かめ（8章 qa-check）。プレビューの記録の URL だけをタブに開き、画面を撮り、結果を残す。
 * 置き場は 〈git の共通ディレクトリ〉/orca-flow/qa-checks/〈ID〉/
 */
export const run: Command = async (ctx) => {
  const args = parseArgs(
    ctx.argv,
    ["shot", "input"],
    ["open", "record", "show", "close", "clear", "base"],
  );
  const id = args.positionals[0];
  if (id === undefined || args.positionals.length !== 1 || !hasIdShape(id))
    throw new FlowError(1, USAGE);
  const chosen = ACTIONS.filter((a) =>
    a === "shot" ? args.values.has("shot") : args.flags.has(a),
  );
  const action = chosen[0];
  const base = args.flags.has("base");
  if (
    chosen.length !== 1 ||
    action === undefined ||
    (base && action !== "open" && action !== "shot") ||
    args.values.has("input") !== (action === "record")
  )
    throw new FlowError(1, USAGE);

  if (action === "shot" && !isShotName(args.values.get("shot")!))
    throw new FlowError(
      1,
      `--shot の名前は英小文字・数字・ハイフンだけ（先頭は英小文字か数字、64文字まで）にしてください：${JSON.stringify(args.values.get("shot"))}`,
    );

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);
  const dir = qaChecksDir(common, id);
  const env = { ctx, root, dir, id, orca: createOrca(ctx.runner, root) };

  switch (action) {
    case "open":
      return open(env, common, base);
    case "shot":
      return shot(env, args.values.get("shot")!, base ? "before" : "after");
    case "record":
      return record(env, args.values.get("input")!);
    case "show":
      return show(env);
    case "close":
      return close(env);
    case "clear":
      return clear(env);
  }
};

interface Env {
  ctx: CommandContext;
  root: string;
  dir: string;
  id: string;
  orca: Orca;
}

/** 開いたタブを閉じる。閉じられなくても警告だけ */
async function closePages(
  env: Env,
  pages: OpenedPages,
  sides: readonly Side[],
) {
  const closed: string[] = [];
  for (const side of sides) {
    const page = pages[side];
    if (page === undefined) continue;
    try {
      await env.orca.closeTab(page.page);
      closed.push(page.page);
    } catch (error) {
      env.ctx.stderr(
        `警告：${env.id} の QA のタブ（${page.page}）を閉じられませんでした（${message(error)}）。Orca で閉じてください`,
      );
    }
  }
  return closed;
}

async function open(env: Env, common: string, base: boolean) {
  const { ctx, id } = env;
  const next = base
    ? `orca-flow preview ${id} --base`
    : `orca-flow preview ${id}`;
  let url: string;
  let worktree: string;
  if (base) {
    const status = await previewBaseStatus(common, id);
    if (!status.answers)
      throw new FlowError(
        2,
        `${status.reason}。タブは開いていません。先に ${next} で前の画面を立ててください`,
      );
    url = status.url;
    worktree = status.record.taskWorktree;
  } else {
    const rec = await readPreviewRecord(common, id);
    const reason =
      rec === null
        ? "プレビューの記録がありません"
        : rec.url === undefined
          ? "プレビューの URL がまだ分かりません"
          : !(await urlAnswers(rec.url))
            ? `プレビューが答えません（${rec.url}）`
            : null;
    if (rec === null || rec.url === undefined || reason !== null)
      throw new FlowError(
        2,
        `${reason}。タブは開いていません。先に ${next} でアプリを立ててください`,
      );
    url = rec.url;
    worktree = rec.worktree;
  }
  const origin = httpOrigin(url);
  if (origin === null)
    throw new FlowError(
      1,
      `記録の URL が http(s) ではありません（${url}）。タブは開いていません`,
    );

  const side: Side = base ? "before" : "after";
  const pages = await readPages(env.dir);
  await closePages(env, pages, [side]);
  // タブを作れずに終わっても、閉じたページの ID を残さない
  delete pages[side];
  await writePages(env.dir, pages);
  const profile = await qaProfile(env);
  const page = await env.orca.createProfileTab(worktree, url, profile);
  pages[side] = { page, url, origin, worktree, at: ctx.now().toISOString() };
  await checkTabProfile(env, pages, page, profile);
  await writePages(env.dir, pages);
  if (!ctx.json)
    ctx.stdout(
      `${id} の${base ? "前の画面" : "プレビュー"}をタブに開きました（ページ ${page}、${url}）`,
    );
  return {
    code: 0 as const,
    data: { id, page, url, origin, base, profile },
  };
}

/** 記録の profile。なければ isolated の profile を作って記録する。作れなければタブを作らずに1 */
async function qaProfile(env: Env): Promise<string> {
  const recorded = await readProfile(env.dir);
  if (recorded !== null) return recorded;
  let profile: string;
  try {
    profile = await env.orca.createIsolatedProfile(qaProfileLabel(env.id));
  } catch (error) {
    throw new FlowError(
      1,
      `${env.id} の QA の確かめのブラウザの profile を作れませんでした（${message(error)}）。タブは開いていません`,
    );
  }
  await writeProfile(env.dir, profile, env.ctx.now().toISOString());
  return profile;
}

/**
 * 作ったタブに記録の profile がついたかを確かめる。違う・読めなければ、
 * Orca が既定の区画（人のサインインがある所）に戻したとみて、タブを閉じ、profile を消して1。
 * 作ったタブ（pages に入れて渡す）のほか、もう一方の画面のタブも消す profile を使っているので、あわせて閉じる。
 * profile を消せなくても記録は消す。Orca 側でなくなった ID を使い続けると、--open が毎回ここで落ちるため
 */
async function checkTabProfile(
  env: Env,
  pages: OpenedPages,
  page: string,
  profile: string,
) {
  let problem: string | null = null;
  try {
    const actual = await env.orca.tabProfile(page);
    if (actual !== profile)
      problem = `タブについた profile（${actual ?? "既定"}）が記録の profile（${profile}）と違います`;
  } catch (error) {
    problem = `タブについた profile を読めませんでした（${message(error)}）`;
  }
  if (problem === null) return;
  await closePages(env, pages, ["after", "before"]);
  await writePages(env.dir, {});
  if (!(await deleteQaProfile(env.ctx, env.orca, env.dir, env.id)))
    await forgetProfile(env.dir);
  throw new FlowError(
    1,
    `${problem}。人のサインインが来うるので、タブを閉じました。Orca が profile つきのタブを作れるか確かめてから、orca-flow qa-check ${env.id} --open をやり直してください`,
  );
}

async function shot(env: Env, name: string, side: Side) {
  const { ctx, id } = env;
  const pages = await readPages(env.dir);
  const opened = pages[side];
  if (opened === undefined)
    throw new FlowError(
      1,
      `${id} の${side === "before" ? "前の画面" : "プレビュー"}のタブがありません。先に orca-flow qa-check ${id} --open${side === "before" ? " --base" : ""} を流してください`,
    );
  const sameOrigin = async () => {
    let now: string;
    try {
      now = await env.orca.tabUrl(opened.page);
    } catch (error) {
      // 人がタブを閉じた・Orca を立て直したあとは、開き直す手のほかに進めようがない
      throw new FlowError(
        1,
        `${id} の QA のタブを読めませんでした（${message(error)}）。撮っていません。タブが見つからなければ orca-flow qa-check ${id} --open（前の画面なら --open --base）で開き直してください`,
      );
    }
    if (httpOrigin(now) !== opened.origin)
      throw new FlowError(
        1,
        `今のタブの origin が開いた origin（${opened.origin}）と違います（${httpOrigin(now) ?? now}）。撮っていません`,
      );
  };
  await sameOrigin();
  const png = await env.orca.screenshotPng(opened.page);
  // 撮る間に別の origin へ移っていたら置かない
  await sameOrigin();
  const file = await writeShot(env.dir, name, side, png);
  if (!ctx.json) ctx.stdout(`撮りました：${file}`);
  return { code: 0 as const, data: { id, name, side, file } };
}

async function record(env: Env, inputPath: string) {
  const { ctx, id } = env;
  const file = path.resolve(ctx.cwd, inputPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new FlowError(
      1,
      `--input の JSON を読めませんでした（${file}）：${message(error)}`,
    );
  }
  const { items, notices } = parseRecordInput(raw, await listShots(env.dir));
  const resultMd = await writeResult(env.dir, {
    id,
    at: ctx.now().toISOString(),
    items,
    notices,
  });
  const counts = countResults(items);
  if (!ctx.json)
    ctx.stdout(`${id} の QA の確かめ：${describeCounts(counts)}\n${resultMd}`);
  return { code: 0 as const, data: { id, counts, resultMd } };
}

async function show(env: Env) {
  const { ctx, id } = env;
  const result = await readResult(env.dir);
  if (result === null)
    throw new FlowError(
      1,
      `${id} の QA の確かめの結果がありません（--record で残します）`,
    );
  const resultMd = path.join(env.dir, "result.md");
  const counts = countResults(result.items);
  if (!ctx.json) {
    const lines = [`${id} の QA の確かめ：${describeCounts(counts)}`];
    for (const item of result.items)
      lines.push(
        `- [${item.result}] ${item.text}${item.reason ? `（${item.reason}）` : ""}`,
      );
    for (const notice of result.notices) lines.push(`- 崩れ：${notice.text}`);
    lines.push(resultMd);
    ctx.stdout(lines.join("\n"));
  }
  return { code: 0 as const, data: { ...result, counts, resultMd } };
}

async function close(env: Env) {
  const { ctx, id } = env;
  const pages = await readPages(env.dir);
  const closed = await closePages(env, pages, ["after", "before"]);
  await writePages(env.dir, {});
  // タブを閉じてから消す。消せなければ記録を残し、--clear で消し直す
  await deleteQaProfile(ctx, env.orca, env.dir, id);
  if (!ctx.json)
    ctx.stdout(
      closed.length > 0
        ? `${id} の QA のタブを閉じました`
        : `${id} には閉じる QA のタブがありません`,
    );
  return { code: 0 as const, data: { id, closed } };
}

async function clear(env: Env) {
  const { ctx, id } = env;
  // 前の回のタブが残っていれば、置き場とともに手がかりが消える前に閉じる
  await closePages(env, await readPages(env.dir), ["after", "before"]);
  await deleteQaProfile(ctx, env.orca, env.dir, id);
  await rm(env.dir, { recursive: true, force: true });
  if (!ctx.json) ctx.stdout(`${id} の QA の確かめの置き場を空にしました`);
  return { code: 0 as const, data: { id, cleared: true } };
}
