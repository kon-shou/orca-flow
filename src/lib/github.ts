import { FlowError } from "../types.ts";
import type { RunResult, Runner } from "./exec.ts";

// GitHub（gh）と git push の呼び出しを1か所にまとめたファイル。必ず Runner を通す。
// push するのはタスクのブランチだけ（baseBranch へは push しない）。リモートは origin。

export const REMOTE = "origin";

/** gh の時間切れ（ミリ秒） */
export const GH_TIMEOUT_MS = 60_000;
/** git push の時間切れ（ミリ秒） */
export const PUSH_TIMEOUT_MS = 120_000;

/** トークンらしい値を伏せる。エラー文・警告に出す前に必ず通す */
export function redactSecrets(
  text: string,
  extra: readonly (string | undefined)[] = [],
): string {
  let out = text
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}/g, "〈トークン〉")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "〈トークン〉")
    .replace(
      /\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      "$1 〈伏せた〉",
    )
    .replace(/(https?:\/\/)[^\s/@:]+(:[^\s/@]*)?@/g, "$1〈伏せた〉@")
    .replace(/\b((?:GH|GITHUB)_[A-Z_]*TOKEN)=\S+/g, "$1=〈伏せた〉");
  for (const secret of extra)
    if (secret && secret.length >= 8)
      out = out.split(secret).join("〈伏せた〉");
  return out;
}

/** 環境変数のトークン（出力から伏せる対象） */
export const envSecrets = (env: NodeJS.ProcessEnv) => [
  env.GH_TOKEN,
  env.GITHUB_TOKEN,
  env.GH_ENTERPRISE_TOKEN,
  env.GITHUB_ENTERPRISE_TOKEN,
];

export interface GhContext {
  runner: Runner;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

const detailOf = (result: RunResult, env: NodeJS.ProcessEnv | undefined) =>
  redactSecrets((result.stderr || result.stdout).trim(), envSecrets(env ?? {}));

async function gh(
  g: GhContext,
  args: readonly string[],
  what: string,
): Promise<RunResult> {
  const result = await g.runner("gh", args, {
    cwd: g.cwd,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.code === 127)
    throw new FlowError(
      2,
      "gh（GitHub CLI）が見つかりません。入れて gh auth login でログインしてから、もう一度流してください",
    );
  if (result.timedOut)
    throw new FlowError(1, `gh の${what}が時間内に終わりませんでした`);
  return result;
}

async function ghOk(
  g: GhContext,
  args: readonly string[],
  what: string,
): Promise<string> {
  const result = await gh(g, args, what);
  if (result.code !== 0) {
    const detail = detailOf(result, g.env);
    throw new FlowError(
      1,
      `gh の${what}に失敗しました${detail ? `：${detail}` : ""}`,
    );
  }
  return result.stdout;
}

/** gh があり、ログインしていることを確かめる。だめなら FlowError(2) */
export async function requireGh(g: GhContext): Promise<void> {
  const version = await gh(g, ["--version"], "バージョンの確認");
  if (version.code !== 0)
    throw new FlowError(
      2,
      "gh（GitHub CLI）を動かせません。入れ直して gh auth login でログインしてください",
    );
  const auth = await gh(g, ["auth", "status"], "ログインの確認");
  if (auth.code !== 0)
    throw new FlowError(
      2,
      "gh にログインしていません。gh auth login でログインしてから、もう一度流してください",
    );
}

/** `git push` を流す。タスクのブランチだけを渡す。失敗は FlowError(1) */
async function gitPush(g: GhContext, args: readonly string[]): Promise<void> {
  const result = await g.runner("git", ["push", ...args], {
    cwd: g.cwd,
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  if (result.timedOut)
    throw new FlowError(1, "git push が時間内に終わりませんでした");
  if (result.code !== 0) {
    const detail = detailOf(result, g.env);
    throw new FlowError(
      1,
      `git push に失敗しました${detail ? `：${detail}` : ""}`,
    );
  }
}

/**
 * タスクのブランチを origin に push する。expectedRemoteHead があるときは、その先頭を期待値にした
 * --force-with-lease（タスクのブランチだけ）。baseBranch を渡すことはできない
 */
export async function pushTaskBranch(
  g: GhContext,
  branch: string,
  base: string,
  options: { expectedRemoteHead?: string } = {},
): Promise<void> {
  if (branch === base)
    throw new FlowError(
      1,
      `${base} へは push しません（タスクのブランチだけ push します）`,
    );
  if (options.expectedRemoteHead)
    await gitPush(g, [
      `--force-with-lease=${branch}:${options.expectedRemoteHead}`,
      "--set-upstream",
      REMOTE,
      branch,
    ]);
  else await gitPush(g, ["--set-upstream", REMOTE, branch]);
}

export type PrState = "open" | "merged" | "closed";
/** CI の結果：none＝チェックがない／pending＝待ち／passed／failed */
export type CiResult = "none" | "pending" | "passed" | "failed";

export interface PrInfo {
  number: number;
  url: string;
  isDraft: boolean;
  state: PrState;
  /** GitHub 側のブランチの先頭 */
  headSha: string | null;
  ci: CiResult;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** statusCheckRollup（CheckRun と StatusContext の混じった配列）から CI の結果を決める */
export function ciResultOf(rollup: unknown): CiResult {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const item of rollup) {
    if (!isObject(item)) continue;
    const verdict = String(item.conclusion || item.state || "").toUpperCase();
    const status = String(item.status || "").toUpperCase();
    if (
      [
        "FAILURE",
        "ERROR",
        "TIMED_OUT",
        "CANCELLED",
        "STARTUP_FAILURE",
        "ACTION_REQUIRED",
      ].includes(verdict)
    )
      return "failed";
    if (
      (status !== "" && status !== "COMPLETED") ||
      verdict === "" ||
      verdict === "PENDING" ||
      verdict === "EXPECTED"
    )
      pending = true;
  }
  return pending ? "pending" : "passed";
}

function prFrom(value: unknown): PrInfo | null {
  if (!isObject(value) || typeof value.number !== "number") return null;
  const raw = String(value.state ?? "").toUpperCase();
  const state: PrState =
    raw === "MERGED" ? "merged" : raw === "CLOSED" ? "closed" : "open";
  return {
    number: value.number,
    url: typeof value.url === "string" ? value.url : "",
    isDraft: value.isDraft === true,
    state,
    headSha: typeof value.headRefOid === "string" ? value.headRefOid : null,
    ci: ciResultOf(value.statusCheckRollup),
  };
}

const PR_FIELDS =
  "number,url,isDraft,state,headRefOid,statusCheckRollup,isCrossRepository";

/** ブランチの PR。開いているものを先に、なければ新しい番号のもの。なければ null */
export async function findPr(
  g: GhContext,
  branch: string,
): Promise<PrInfo | null> {
  const out = await ghOk(
    g,
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      PR_FIELDS,
    ],
    "PR の検索",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new FlowError(1, "gh の PR の検索の出力を読めませんでした");
  }
  // フォークからの PR（同じ名前のブランチ）は、タスクの PR ではない
  const prs = (Array.isArray(parsed) ? parsed : [])
    .filter((item) => !(isObject(item) && item.isCrossRepository === true))
    .map(prFrom)
    .filter((p): p is PrInfo => p !== null);
  if (prs.length === 0) return null;
  prs.sort((a, b) => b.number - a.number);
  return prs.find((p) => p.state === "open") ?? prs[0]!;
}

/** 番号で PR の今の状態を読む */
export async function readPr(g: GhContext, number: number): Promise<PrInfo> {
  const out = await ghOk(
    g,
    ["pr", "view", String(number), "--json", PR_FIELDS],
    `PR #${number} の読み取り`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = null;
  }
  const pr = prFrom(parsed);
  if (!pr)
    throw new FlowError(1, `gh の PR #${number} の出力を読めませんでした`);
  return pr;
}

/** 下書きの PR を出す。件名と本文のファイルを渡す */
export async function createDraftPr(
  g: GhContext,
  input: { base: string; head: string; title: string; bodyFile: string },
): Promise<{ number: number; url: string }> {
  const out = await ghOk(
    g,
    [
      "pr",
      "create",
      "--draft",
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body-file",
      input.bodyFile,
    ],
    "PR の作成",
  );
  const url = /https?:\/\/\S+\/pull\/(\d+)/.exec(out);
  if (!url) {
    const found = await findPr(g, input.head);
    if (found) return { number: found.number, url: found.url };
    throw new FlowError(
      1,
      "gh の PR の作成の出力から PR の番号を読めませんでした",
    );
  }
  return { number: Number(url[1]), url: url[0] };
}

/** 下書きを外す（レビューの依頼） */
export async function markPrReady(g: GhContext, number: number): Promise<void> {
  await ghOk(
    g,
    ["pr", "ready", String(number)],
    `PR #${number} の下書きの解除`,
  );
}
