import { loadConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import {
  HEAD_PREFIX_LENGTH,
  lineHasBranch,
  pushedHeadsOf,
  refPackageLines,
} from "./branch-push.ts";
import { readCrossDepends, type CrossDependsRepo } from "./cross-depends.ts";
import type { Runner } from "./exec.ts";
import { readPushRecord } from "./finish.ts";
import { envSecrets, redactSecrets, REMOTE } from "./github.ts";
import { taskMergedInto } from "./merged.ts";

// 共通の版が出たか・共通の枝を取り込み直すかの判定（読むだけ）。共通の clone ではタグの取得だけをする。
// 見張りの回（45秒の上限）から呼ばれるので、共通ごとに git fetch は1回、ほかは短い git だけを使う

/**
 * bump＝共通の版が出たので版を上げる、reimport＝共通の枝が動いたので取り込み直す、
 * wait＝まだ何もしない（版のタグ待ち・読めない・push 待ちなど）、done＝枝の取り込みは残っていない
 */
export type AppBumpVerdict = "bump" | "reimport" | "wait" | "done";

/** 記録の枝のある共通1つ分の判定 */
export interface AppBumpItem {
  /** 共通の名前（記録の repos[].name） */
  name: string;
  /** 共通のタスクの枝（記録の repos[].branch） */
  branch: string;
  verdict: AppBumpVerdict;
  /** bump のときだけ、上げる版（`v` なしの 1.2.0）。ほかは null */
  version: string | null;
  /** bump・reimport のときだけ、同じ判定を見分ける文字列（bump:〈名前〉:〈版〉・reimport:〈名前〉:〈push した先頭の頭12文字〉）。ほかは null */
  key: string | null;
  /** 判定の理由（日本語） */
  reason: string;
}

export interface PlanOptions {
  /** タグを取ってくる git fetch の打ち切り（ミリ秒）。既定は 20 秒 */
  fetchTimeoutMs?: number;
  /** 取得の失敗の文から伏せる値を探す環境変数。既定は process.env */
  env?: NodeJS.ProcessEnv;
}

/** タグの取得の結果。ok＝取れた、failed＝終了コードが0以外（手元のタグは読める）、timeout＝時間切れ */
interface FetchOutcome {
  status: "ok" | "failed" | "timeout";
  reason: string;
}

const FETCH_TIMEOUT_MS = 20_000;
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

const message = (error: unknown) =>
  error instanceof FlowError || error instanceof Error
    ? error.message
    : String(error);

const compareParts = (a: number[], b: number[]): number =>
  a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

/** タグの並びから、前置きのない `v数.数.数` のうち一番小さい版（`v` なし）。なければ null */
export function smallestStableVersion(tags: readonly string[]): string | null {
  let best: number[] | null = null;
  for (const tag of tags) {
    const m = STABLE_TAG.exec(tag.trim());
    if (!m) continue;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (best === null || compareParts(parts, best) < 0) best = parts;
  }
  return best === null ? null : best.join(".");
}

const item = (
  repo: CrossDependsRepo,
  verdict: AppBumpVerdict,
  reason: string,
  extra: { version?: string; key?: string } = {},
): AppBumpItem => ({
  name: repo.name,
  branch: repo.branch!,
  verdict,
  version: extra.version ?? null,
  key: extra.key ?? null,
  reason,
});

/** 失敗の文から理由の1行を選ぶ（`!`・`error:`・`fatal:` で始まる行。なければ最後の行） */
function failureLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.find((l) => /^(!|error:|fatal:)/.test(l)) ?? lines.at(-1) ?? "";
}

/**
 * 共通の clone でタグだけを取る（ブランチ・作業ツリー・記録は書かない）。
 * 利用者の fetch.prune などの設定で、手元だけのタグが消えないようにする
 */
async function fetchTags(
  runner: Runner,
  repoPath: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<FetchOutcome> {
  const result = await runner(
    "git",
    [
      "-c",
      "gc.auto=0",
      "fetch",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--no-prune",
      "--no-prune-tags",
      REMOTE,
      "refs/tags/*:refs/tags/*",
    ],
    {
      cwd: repoPath,
      timeoutMs,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (result.timedOut)
    return { status: "timeout", reason: "タグの取得が時間切れでした" };
  if (result.code !== 0)
    return {
      status: "failed",
      reason: redactSecrets(
        `タグを取ってこられませんでした：${failureLine(result.stderr || result.stdout)}`,
        envSecrets(env),
      ),
    };
  return { status: "ok", reason: "" };
}

/** マージのコミットを全部含むタグ（共通の clone の手元のタグだけを読む）。読めなければ null */
async function tagsContaining(
  runner: Runner,
  repoPath: string,
  commits: readonly string[],
): Promise<string[] | null> {
  let common: string[] | null = null;
  for (const commit of commits) {
    const result = await runner("git", ["tag", "--contains", commit], {
      cwd: repoPath,
    });
    if (result.code !== 0) return null;
    const tags = result.stdout.split(/\r?\n/).filter((t) => t !== "");
    common = common === null ? tags : common.filter((t) => tags.includes(t));
  }
  return common ?? [];
}

/**
 * アプリのタスク（記録の ID と、そのブランチ）の判定。またぐ依存の記録の `branch` のある要素ごとに返す。
 * 記録がなければ null、記録が壊れていれば FlowError(1)。`branch` のない要素（`--bumps`）は判定しない。
 *
 * - タスクのブランチの先頭のパッケージの定義・ロックファイルに枝の名前がなければ done
 * - 共通の ID が全部 PR でマージされていれば、タグを取ってきて、マージのコミットを全部含む一番小さい `v数.数.数` を版にして bump
 *   （前置きつきのタグは数えない。タグがない・取れないときは wait）
 * - まだマージされていなければ、push した先頭の頭12文字がタスクのブランチの先頭のロックファイルになければ reimport
 *   （verify の警告と同じ比べ方）。push がまだ・入っているときは wait
 */
export async function planAppBump(
  runner: Runner,
  root: string,
  id: string,
  taskBranch: string,
  options: PlanOptions = {},
): Promise<AppBumpItem[] | null> {
  const record = await readCrossDepends(runner, root, id);
  if (record === null) return null;
  const fetched = new Map<string, FetchOutcome>();
  const items: AppBumpItem[] = [];
  for (const repo of record.repos) {
    if (typeof repo.branch !== "string") continue;
    items.push(
      await planOne(
        runner,
        root,
        taskBranch,
        repo,
        fetched,
        options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
        options.env ?? process.env,
      ),
    );
  }
  return items;
}

async function planOne(
  runner: Runner,
  root: string,
  taskBranch: string,
  repo: CrossDependsRepo,
  fetched: Map<string, FetchOutcome>,
  fetchTimeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<AppBumpItem> {
  const branch = repo.branch!;
  const lines = await refPackageLines(runner, root, taskBranch, branch);
  if (lines === null)
    return item(
      repo,
      "wait",
      `${taskBranch} の先頭のパッケージの定義を読めませんでした`,
    );
  if (!lines.some((line) => lineHasBranch(line, branch)))
    return item(
      repo,
      "done",
      `${taskBranch} に枝 ${branch} の取り込みは残っていません`,
    );

  // 共通の ID が全部 PR でマージされたか（件名の行は数えない）
  const commits: string[] = [];
  let allMerged = true;
  try {
    const loaded = await loadConfig(repo.path);
    if (!loaded.exists)
      return item(repo, "wait", `${repo.name} の設定を読めません（init 前）`);
    for (const dep of repo.ids) {
      const merged = await taskMergedInto(
        runner,
        repo.path,
        loaded.config,
        dep,
        loaded.config.baseBranch,
        { countSubject: false },
      );
      if (!merged.merged) {
        allMerged = false;
        continue;
      }
      const commit = (await readPushRecord(runner, repo.path, dep))
        ?.mergeCommit;
      if (typeof commit === "string") commits.push(commit);
    }
  } catch (error) {
    return item(
      repo,
      "wait",
      `${repo.name} のマージを確かめられません：${message(error)}`,
    );
  }

  if (allMerged && commits.length > 0)
    return planBump(runner, repo, commits, fetched, fetchTimeoutMs, env);
  if (allMerged)
    return item(repo, "wait", `${repo.name} のマージのコミットが分かりません`);
  return planRebase(runner, root, taskBranch, repo);
}

async function planBump(
  runner: Runner,
  repo: CrossDependsRepo,
  commits: readonly string[],
  fetched: Map<string, FetchOutcome>,
  fetchTimeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<AppBumpItem> {
  if (!fetched.has(repo.path))
    fetched.set(
      repo.path,
      await fetchTags(runner, repo.path, fetchTimeoutMs, env),
    );
  const outcome = fetched.get(repo.path)!;
  if (outcome.status === "timeout")
    return item(repo, "wait", `${repo.name}：${outcome.reason}`);
  // 取得が失敗しても（付け直されたタグの上書きの拒否など）、手元のタグで版が分かれば上げる
  const tags = await tagsContaining(runner, repo.path, commits);
  if (tags === null)
    return item(repo, "wait", `${repo.name} のタグを読めませんでした`);
  const version = smallestStableVersion(tags);
  if (version === null && outcome.status === "failed")
    return item(repo, "wait", `${repo.name}：${outcome.reason}`);
  if (version === null)
    return item(
      repo,
      "wait",
      `${repo.name} のマージを含む正式な版（v数.数.数）のタグがまだありません（前置きつきは数えません）`,
    );
  return item(
    repo,
    "bump",
    `${repo.name} の版 ${version} が出ています。${repo.package} を ${version} に上げてください`,
    { version, key: `bump:${repo.name}:${version}` },
  );
}

async function planRebase(
  runner: Runner,
  root: string,
  taskBranch: string,
  repo: CrossDependsRepo,
): Promise<AppBumpItem> {
  const found = await pushedHeadsOf(runner, repo);
  if (found === null)
    return item(repo, "wait", `${repo.name} の枝の印を読めませんでした`);
  if (found.heads.length === 0)
    return item(
      repo,
      "wait",
      `${repo.name} の枝 ${repo.branch} はまだ push されていません`,
    );
  const prefixes = found.heads.map((h) => h.slice(0, HEAD_PREFIX_LENGTH));
  for (const prefix of prefixes) {
    const hit = await refPackageLines(runner, root, taskBranch, prefix);
    if (hit === null)
      return item(
        repo,
        "wait",
        `${taskBranch} の先頭のロックファイルを読めませんでした`,
      );
    // 複数の ID があるときは、どれかの先頭が入っていれば古くない
    if (hit.length > 0)
      return item(
        repo,
        "wait",
        `${repo.name} の枝 ${repo.branch} の先頭は取り込み済みです。共通のマージ待ちです`,
      );
  }
  return item(
    repo,
    "reimport",
    `${repo.name} の枝 ${repo.branch} の push した先頭（${prefixes[0]}）が、${taskBranch} のロックファイルにありません。枝を取り込み直してください`,
    { key: `reimport:${repo.name}:${prefixes.join(",")}` },
  );
}
