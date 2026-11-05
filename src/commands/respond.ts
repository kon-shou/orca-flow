import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireIdShape } from "../lib/auto.ts";
import {
  findPr,
  redactSecrets,
  envSecrets,
  type GhContext,
} from "../lib/github.ts";
import { gitCommonDir, requireActiveTask, requireRoot } from "../lib/git.ts";
import { READ_TIMEOUT_MS, createOrca } from "../lib/orca.ts";
import { bodyProblemsOf } from "../lib/outbox.ts";
import {
  deleteDraftComment,
  draftThreadReply,
  editDraftComment,
  loadPendingDrafts,
  setReviewSummary,
  type BodyGuard,
  type DraftStore,
} from "../lib/pending-review.ts";
import {
  fetchRespondSource,
  fetchThreadLocations,
  renderRespondInput,
  threadFiles,
} from "../lib/respond-input.ts";
import { commonRecordPath } from "../lib/task-id.ts";
import {
  FlowError,
  type Command,
  type CommandContext,
  type CommandResult,
} from "../types.ts";

/** CI の直しの上限（設定にしない固定の回数） */
export const CI_FIX_LIMIT = 2;

const USAGE = `使い方：
  orca-flow respond input <ID>
  orca-flow respond draft <ID> --thread <スレッドの ID> --body-file <パス>
  orca-flow respond draft <ID> --edit <コメントの ID> --body-file <パス>
  orca-flow respond draft <ID> --delete <コメントの ID>
  orca-flow respond draft <ID> --summary-file <パス>
  orca-flow respond drafts <ID>
  orca-flow respond ci-fix <ID>
  orca-flow respond open <ID>`;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const respondFile = (common: string, id: string, name: string) =>
  commonRecordPath(common, "respond", id, `${path.sep}${name}`);

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

// ---- CI の直しの回数（respond/〈ID〉/ci.json） ----

/** ない＝0回。読めない・形が違う＝壊れている（broken）。壊れたまま0に戻して上限の守りを開かない */
async function readCiCount(
  common: string,
  id: string,
): Promise<{ count: number; broken: boolean }> {
  let text: string;
  try {
    text = await readFile(respondFile(common, id, "ci.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { count: 0, broken: false };
    return { count: 0, broken: true };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const count =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { count?: unknown }).count
        : null;
    return typeof count === "number" && Number.isInteger(count) && count >= 0
      ? { count, broken: false }
      : { count: 0, broken: true };
  } catch {
    return { count: 0, broken: true };
  }
}

async function writeCiCount(
  common: string,
  id: string,
  count: number,
  now: Date,
): Promise<void> {
  await writeAtomic(
    respondFile(common, id, "ci.json"),
    `${JSON.stringify({ count, updatedAt: now.toISOString() }, null, 2)}\n`,
  );
}

// ---- 共通 ----

interface Place {
  id: string;
  root: string;
  common: string;
  g: GhContext;
  store: DraftStore;
  pr: number;
  prUrl: string;
  guard: BodyGuard;
  taskPath: string;
}

async function place(ctx: CommandContext, id: string): Promise<Place> {
  requireIdShape(id);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  const common = await gitCommonDir(ctx.runner, root);
  const g: GhContext = { runner: ctx.runner, cwd: root, env: ctx.env };
  const pr = await findPr(g, task.branch);
  if (!pr)
    throw new FlowError(
      1,
      `${id} の PR が見つかりません（push で PR を出してから使ってください）`,
    );
  if (pr.state !== "open")
    throw new FlowError(
      1,
      `${id} の PR #${pr.number} は開いていません（${pr.state}）`,
    );
  return {
    id,
    root,
    common,
    g,
    store: { common, taskId: id },
    pr: pr.number,
    prUrl: pr.url,
    guard: {
      env: ctx.env,
      problems: (text) =>
        bodyProblemsOf(text, { env: ctx.env, config, root, task }),
    },
    taskPath: task.path,
  };
}

async function readBodyFile(ctx: CommandContext, file: string, what: string) {
  return readFile(path.resolve(ctx.cwd, file), "utf8").catch(() => {
    throw new FlowError(1, `${what}のファイルを読めません：${file}`);
  });
}

function oneId(args: ReturnType<typeof parseArgs>): string {
  const [id, ...rest] = args.positionals;
  if (!id || rest.length > 0) throw new FlowError(1, USAGE);
  return id;
}

// ---- サブコマンド ----

async function input(ctx: CommandContext): Promise<CommandResult> {
  const id = oneId(parseArgs(ctx.argv.slice(1), []));
  const p = await place(ctx, id);
  const source = await fetchRespondSource(p.g, p.pr);
  const { text, counts } = renderRespondInput(source, undefined, ctx.env);
  const file = respondFile(p.common, id, "input.md");
  await writeAtomic(file, text);
  // CI の緑を見たら、直しの回数を0に戻す
  // （壊れた記録も、緑を見たこのときに0で書き直す）
  if (counts.ci === "passed") {
    const recorded = await readCiCount(p.common, id);
    if (recorded.count > 0 || recorded.broken)
      await writeCiCount(p.common, id, 0, ctx.now());
  }
  if (!ctx.json) {
    // 他人の文章は出さない（パスと件数だけ）
    ctx.stdout(`入力ファイル：${file}`);
    ctx.stdout(
      `未解決のスレッド ${counts.threads} 件・会話の欄 ${counts.conversation} 件・レビューの本文 ${counts.reviews} 件・落ちた CI ${counts.failedChecks} 件（CI：${counts.ci}）`,
    );
    if (counts.incomplete)
      ctx.stdout(
        "注意：読みきれなかった指摘があります。入力ファイルの「読めた量」を確かめてください",
      );
  }
  return { code: 0, data: { file, pr: p.pr, counts } };
}

async function draft(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), [
    "thread",
    "body-file",
    "edit",
    "delete",
    "summary-file",
  ]);
  const id = oneId(args);
  const thread = args.values.get("thread");
  const edit = args.values.get("edit");
  const del = args.values.get("delete");
  const summary = args.values.get("summary-file");
  const bodyFile = args.values.get("body-file");
  const modes = [thread, edit, del, summary].filter((v) => v !== undefined);
  if (modes.length !== 1)
    throw new FlowError(
      1,
      `--thread・--edit・--delete・--summary-file のどれか1つだけを渡してください\n${USAGE}`,
    );
  if ((thread !== undefined || edit !== undefined) && bodyFile === undefined)
    throw new FlowError(1, "--body-file で本文のファイルを渡してください");
  if ((del !== undefined || summary !== undefined) && bodyFile !== undefined)
    throw new FlowError(
      1,
      "--body-file は --thread か --edit のときだけ渡せます",
    );
  const p = await place(ctx, id);

  if (thread !== undefined) {
    const body = await readBodyFile(ctx, bodyFile!, "本文");
    const r = await draftThreadReply(
      p.g,
      p.store,
      { pr: p.pr, threadId: thread, body },
      p.guard,
    );
    if (!ctx.json)
      ctx.stdout(
        `保留中のレビューに返信を足しました：${r.commentId}（本人にしか見えません）`,
      );
    return { code: 0, data: { pr: p.pr, ...r } };
  }
  if (edit !== undefined) {
    const body = await readBodyFile(ctx, bodyFile!, "本文");
    await editDraftComment(
      p.g,
      p.store,
      { pr: p.pr, commentId: edit, body },
      p.guard,
    );
    if (!ctx.json) ctx.stdout(`保留中のコメントを直しました：${edit}`);
    return { code: 0, data: { pr: p.pr, commentId: edit } };
  }
  if (del !== undefined) {
    await deleteDraftComment(p.g, p.store, { pr: p.pr, commentId: del });
    if (!ctx.json) ctx.stdout(`保留中のコメントを消しました：${del}`);
    return { code: 0, data: { pr: p.pr, commentId: del } };
  }
  const body = await readBodyFile(ctx, summary!, "レビューの本文");
  const r = await setReviewSummary(p.g, p.store, { pr: p.pr, body }, p.guard);
  if (!ctx.json)
    ctx.stdout("保留中のレビューの本文を書きました（本人にしか見えません）");
  return { code: 0, data: { pr: p.pr, ...r } };
}

async function drafts(ctx: CommandContext): Promise<CommandResult> {
  const id = oneId(parseArgs(ctx.argv.slice(1), []));
  const p = await place(ctx, id);
  const d = await loadPendingDrafts(p.g, p.store, p.pr);
  // 自分が書いた下書きなので全文を出してよい（人に見せる）。秘密は伏せる
  const show = (t: string) => redactSecrets(t, envSecrets(ctx.env));
  if (!ctx.json) {
    if (d.reviewId === null) ctx.stdout("保留中のレビューはありません");
    else {
      ctx.stdout(`保留中のレビュー（PR #${p.pr}）`);
      ctx.stdout(`返信の下書き ${d.mine.length} 件`);
      for (const c of d.mine) {
        ctx.stdout(
          `- ${c.id}  ${c.path ?? "（行に付いていません）"}${c.line !== null ? `:${c.line}` : ""}`,
        );
        ctx.stdout(
          show(c.body)
            .split(/\r?\n/)
            .map((l) => `    ${l}`)
            .join("\n"),
        );
      }
      if (d.body.trim() !== "") {
        ctx.stdout("レビューの本文（会話の欄への返事）：");
        ctx.stdout(
          show(d.body)
            .split(/\r?\n/)
            .map((l) => `    ${l}`)
            .join("\n"),
        );
      }
      if (d.foreign.length > 0)
        ctx.stdout(
          `注意：respond が書いていないコメントが ${d.foreign.length} 件あります（人が GitHub で書いたもの）。reply は積めません`,
        );
    }
  }
  return {
    code: 0,
    data: {
      pr: p.pr,
      reviewId: d.reviewId,
      body: show(d.body),
      mine: d.mine.map((c) => ({ ...c, body: show(c.body) })),
      foreign: d.foreign.map((c) => ({ id: c.id, path: c.path, line: c.line })),
    },
  };
}

async function ciFix(ctx: CommandContext): Promise<CommandResult> {
  const id = oneId(parseArgs(ctx.argv.slice(1), []));
  requireIdShape(id);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);
  const file = respondFile(common, id, "ci.json");
  const recorded = await readCiCount(common, id);
  if (recorded.broken)
    throw new FlowError(
      1,
      `CI の直しの回数の記録が壊れています：${file}\n何回直したか分からないので、数えを進めません。CI が緑になって orca-flow respond input ${id} を流すと0に戻ります。それより前に戻すなら、人がこのファイルを消してください`,
    );
  const count = recorded.count;
  if (count >= CI_FIX_LIMIT)
    throw new FlowError(
      2,
      `CI の直しは ${CI_FIX_LIMIT} 回までです（${count} 回直しました）。これ以上は直さず、人に回してください。CI が緑になって orca-flow respond input ${id} を流すと0に戻ります。それより前に戻すなら、人が ${file} を消してください`,
    );
  await writeCiCount(common, id, count + 1, ctx.now());
  if (!ctx.json)
    ctx.stdout(`CI の直し ${count + 1}/${CI_FIX_LIMIT} 回目を数えました`);
  return { code: 0, data: { count: count + 1, limit: CI_FIX_LIMIT } };
}

async function open(ctx: CommandContext): Promise<CommandResult> {
  const id = oneId(parseArgs(ctx.argv.slice(1), []));
  const p = await place(ctx, id);
  const orca = createOrca(ctx.runner, p.root);
  const warn = (what: string, error: unknown) =>
    ctx.stderr(
      `警告：${what}（${redactSecrets(message(error), envSecrets(ctx.env))}）`,
    );
  // 始めに Orca が応えるかを短い時間切れで確かめる。だめなら警告を1つだけ出し、残りは省く
  try {
    await orca.ping(READ_TIMEOUT_MS);
  } catch (error) {
    warn("Orca が応えないので、タブとカードの更新を省きます", error);
    return {
      code: 0,
      data: { pr: p.pr, files: [], tab: false, linked: false, orca: false },
    };
  }
  // 指摘のファイルの場所だけを読む（CI のログも返信も読まない）
  const source = await fetchThreadLocations(p.g, p.pr);
  const files = threadFiles(source);
  const opened: string[] = [];
  for (const file of files) {
    try {
      await orca.openFile(p.taskPath, file);
      opened.push(file);
    } catch (error) {
      warn(`${file} を Orca のタブで開けませんでした`, error);
    }
  }
  const url = source.prUrl || p.prUrl;
  let tab = false;
  if (url) {
    try {
      await orca.openUrlTab(p.taskPath, `${url.replace(/\/+$/, "")}/files`);
      tab = true;
    } catch (error) {
      warn("PR の Files changed を Orca のタブで開けませんでした", error);
    }
  }
  let linked = false;
  try {
    await orca.linkPr(p.taskPath, p.pr);
    linked = true;
  } catch (error) {
    warn("PR をカードの参照に足せませんでした", error);
  }
  if (!ctx.json)
    ctx.stdout(
      `Orca で開きました：指摘のファイル ${opened.length}/${files.length} 件・Files changed ${tab ? "あり" : "なし"}・カードの PR の参照 ${linked ? "あり" : "なし"}`,
    );
  return {
    code: 0,
    data: { pr: p.pr, files: opened, tab, linked, orca: true },
  };
}

export const run: Command = async (ctx) => {
  switch (ctx.argv[0]) {
    case "input":
      return input(ctx);
    case "draft":
      return draft(ctx);
    case "drafts":
      return drafts(ctx);
    case "ci-fix":
      return ciFix(ctx);
    case "open":
      return open(ctx);
    default:
      throw new FlowError(1, USAGE);
  }
};
