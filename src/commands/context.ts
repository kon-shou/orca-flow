import { realpathSync } from "node:fs";
import path from "node:path";
import { loadConfig, type FlowConfig } from "../config.ts";
import { listAuto, waitState } from "../lib/auto.ts";
import { isMainCheckout } from "../lib/detect.ts";
import { repoRoot, type Runner } from "../lib/exec.ts";
import type { Command, CommandContext } from "../types.ts";

/** Orca に聞くのを打ち切るまで */
export const ORCA_TIMEOUT_MS = 1000;
/**
 * context 全体の安全のための上限（SessionStart のフックの timeout 5秒より短く）。
 * 当たったときも、そこまでに git で分かった役の文は出す
 */
export const TOTAL_TIMEOUT_MS = 4000;

export interface ContextData {
  role: "integrator" | "lead";
  id?: string;
  text: string;
}

/**
 * SessionStart のフックが呼ぶ。今の場所で自分が何の役かを短い日本語で出す。
 * どんなときも終了コード0。役・ID・設計書のパスは git だけで決め、締め切りと競わせない。
 * Orca に聞く部分（状態）だけを ORCA_TIMEOUT_MS で打ち切る
 */
export const run: Command = async (ctx) => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, TOTAL_TIMEOUT_MS);
  });
  /** git で分かったところまでの文。Orca の状態が取れたら書き換える */
  const progress: Progress = { data: null };
  try {
    await Promise.race([
      buildContext(ctx, progress).catch((error: unknown) => {
        ctx.stderr(
          `orca-flow context：役を調べられませんでした（${error instanceof Error ? error.message : String(error)}）`,
        );
      }),
      deadline,
    ]);
    const data = progress.data;
    if (data && !ctx.json) ctx.stdout(data.text);
    return { code: 0, data };
  } finally {
    clearTimeout(timer);
  }
};

interface Progress {
  data: ContextData | null;
}

async function buildContext(
  ctx: CommandContext,
  progress: Progress,
): Promise<void> {
  const { runner, cwd } = ctx;
  const root = await repoRoot(runner, cwd);
  if (!root) return;
  const loaded = await loadConfig(root);
  if (!loaded.exists) return;
  const config = loaded.config;

  const main = await isMainCheckout(runner, root);
  if (main === null) return;
  if (main) return integratorContext(runner, root, config, progress);

  const branch = await git(runner, root, ["branch", "--show-current"]);
  const id = branch === null ? null : taskIdOf(branch, config);
  if (!id) return;
  return leadContext(runner, root, config, id, progress);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `〈branchPrefix〉〈ID〉-…` のブランチから ID を取る。当たらなければ null */
export function taskIdOf(branch: string, config: FlowConfig): string | null {
  const pattern = new RegExp(
    `^${escape(config.branchPrefix)}(${escape(config.idPrefix)}\\d+[A-Za-z]*)(?:-|$)`,
  );
  return pattern.exec(branch)?.[1] ?? null;
}

async function git(
  runner: Runner,
  cwd: string,
  args: string[],
): Promise<string | null> {
  const result = await runner("git", args, { cwd });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Orca に1回だけ聞く。1秒で打ち切り、だめなら null */
async function askOrca(
  runner: Runner,
  cwd: string,
  args: string[],
): Promise<Record<string, unknown> | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ORCA_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      runner("orca", args, { cwd, timeoutMs: ORCA_TIMEOUT_MS }),
      timeout,
    ]);
    if (!result || result.timedOut || result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout) as { result?: unknown };
    const value = parsed.result;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Card {
  comment?: unknown;
  workspaceStatus?: unknown;
  path?: unknown;
}

function describeCard(card: Card | undefined | null): string | null {
  if (!card) return null;
  const comment = typeof card.comment === "string" ? card.comment.trim() : "";
  if (comment) return comment;
  return typeof card.workspaceStatus === "string" && card.workspaceStatus
    ? card.workspaceStatus
    : null;
}

const real = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

function summarizeShared(paths: readonly string[]): string {
  const shown = paths.slice(0, 8).join("、");
  return paths.length > 8 ? `${shown} ほか${paths.length - 8}件` : shown;
}

async function integratorContext(
  runner: Runner,
  root: string,
  config: FlowConfig,
  progress: Progress,
): Promise<void> {
  const tasks: { id: string; path: string }[] = [];
  const list = await git(runner, root, ["worktree", "list", "--porcelain"]);
  // 統合済み＝baseBranch のマージのコミットの2つ目の親（integrate は --no-ff でマージする）。
  // 作ったばかりでまだコミットのないタスクも作業中に数えるため、--merged では判定しない
  const merges = await git(runner, root, [
    "log",
    config.baseBranch,
    "--merges",
    "-n",
    "1000",
    "--format=%P",
  ]);
  const integrated = new Set(
    (merges ?? "")
      .split("\n")
      .map((line) => line.split(" ")[1])
      .filter((sha): sha is string => Boolean(sha)),
  );
  let current: { path?: string; branch?: string; head?: string } = {};
  const flush = () => {
    if (current.path && current.branch) {
      const id = taskIdOf(current.branch, config);
      if (id && !(current.head && integrated.has(current.head)))
        tasks.push({ id, path: current.path });
    }
    current = {};
  };
  for (const line of `${list ?? ""}\n`.split("\n")) {
    if (line === "") flush();
    else if (line.startsWith("worktree ")) current.path = line.slice(9);
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch "))
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }

  // おまかせのタスクが作業中にあり、待ち受けが動いていなければ一言足す
  let autoNote = "";
  if (tasks.length > 0) {
    const common = await git(runner, root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (common) {
      const ids = new Set(tasks.map((t) => t.id));
      const autoIds = (await listAuto(common))
        .filter((r) => r.auto && ids.has(r.id))
        .map((r) => r.id);
      if (autoIds.length > 0 && !(await waitState(common)).running)
        autoNote = `おまかせのタスク（${autoIds.join("・")}）の待ち受けが動いていません。/orca-flow:auto で待ち受けを始め直す。`;
    }
  }

  const text = (cards: Map<string, Card> | null) => {
    const active =
      tasks.length === 0
        ? "なし"
        : tasks
            .map((task) => {
              const card = cards
                ? describeCard(cards.get(real(task.path)))
                : null;
              return `${task.id}（${card ?? "状態は Orca から取れませんでした"}）`;
            })
            .join("、");
    return (
      `このリポジトリは orca-flow で開発する。あなたは${config.integratorName}。` +
      `タスクは /orca-flow:new で始める。` +
      `共有のファイル（${summarizeShared(config.sharedPaths)}）は${config.integratorName}が ${config.baseBranch} で変える。` +
      `作業中のタスク：${active}` +
      (autoNote ? `。${autoNote}` : "")
    );
  };
  // git で分かったところで、先に役の文を決めておく
  progress.data = { role: "integrator", text: text(null) };

  if (tasks.length > 0) {
    const result = await askOrca(runner, root, [
      "worktree",
      "list",
      "--repo",
      `path:${root}`,
      "--json",
    ]);
    const rows = Array.isArray(result?.worktrees)
      ? (result.worktrees as Card[])
      : [];
    const cards = new Map(
      rows
        .filter((row) => typeof row.path === "string")
        .map((row) => [real(row.path as string), row]),
    );
    progress.data = { role: "integrator", text: text(cards) };
  }
}

async function leadContext(
  runner: Runner,
  root: string,
  config: FlowConfig,
  id: string,
  progress: Progress,
): Promise<void> {
  const spec = path.posix.join(config.tasksDir, `${id}.md`);
  const text = (card: string | null) =>
    `あなたは ${id} のタスク長。設計書：${spec}。` +
    `今の状態：${card ?? "Orca から取れませんでした"}。` +
    `設計書が承認されるまでコードを書かない。書き込んでよいのは設計書の範囲だけ。` +
    `ほかのタスクや共有のファイルに関わることは、人間に伝えて${config.integratorName}に回す`;
  // git で分かったところで、先に役の文を決めておく
  progress.data = { role: "lead", id, text: text(null) };

  const result = await askOrca(runner, root, ["worktree", "current", "--json"]);
  const card = describeCard(
    (result?.worktree ?? null) as Card | null | undefined,
  );
  if (card) progress.data = { role: "lead", id, text: text(card) };
}
