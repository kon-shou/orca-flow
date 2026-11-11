import { requireFlowConfig } from "../flow-config.ts";
import path from "node:path";
import { type FlowConfig, type QaConfig } from "../../config.ts";
import { FlowError } from "../../types.ts";
import type { Runner } from "../exec.ts";
import { gitCommonDir, requireRoot } from "../git.ts";
import { requireIdShape } from "../task-id.ts";

export interface QaTask {
  config: FlowConfig;
  qa: QaConfig;
  /** 借りるリポジトリの印（メインの作業ツリーのパス） */
  repo: string;
  id: string;
  /** タスクのブランチ */
  branch: string;
  /** origin のそのブランチの先頭 */
  head: string;
}

/** 設定の qa。なければ FlowError(2) */
export function requireQa(config: FlowConfig): QaConfig {
  if (!config.qa)
    throw new FlowError(
      2,
      "設定に qa がありません。.orca-flow/config.json に qa を書いてください（docs/spec.md の6章）。qa を使うときは、settings の permissions.ask に Bash(orca-flow qa deploy *) があるかも確かめてください（仕様の12章）",
    );
  return config.qa;
}

/** メインの作業ツリーのパス（どの worktree から呼んでも同じ） */
export async function repoKey(runner: Runner, cwd: string): Promise<string> {
  const common = await gitCommonDir(runner, cwd);
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

/** 手元のブランチから、タスクのブランチを1つ決める。0・2つ以上なら FlowError(1) */
export async function findTaskBranch(
  runner: Runner,
  root: string,
  prefix: string,
  id: string,
): Promise<string> {
  const result = await runner(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd: root },
  );
  if (result.code !== 0)
    throw new FlowError(
      1,
      `git for-each-ref に失敗しました：${result.stderr.trim()}`,
    );
  const start = `${prefix}${id}-`;
  const found = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(start));
  if (found.length === 0)
    throw new FlowError(
      1,
      `${id} のブランチ（${start}…）がこのリポジトリにありません`,
    );
  if (found.length > 1)
    throw new FlowError(
      1,
      `${id} のブランチが複数あります。1つに絞ってください：${found.join("、")}`,
    );
  const branch = found[0]!;
  if (!isSafeBranchName(branch))
    throw new FlowError(
      1,
      `${id} のブランチ名が使える形ではないので送りません：${JSON.stringify(branch)}`,
    );
  return branch;
}

/** origin のブランチの先頭。origin になければ FlowError(2) */
export async function originHead(
  runner: Runner,
  root: string,
  branch: string,
): Promise<string> {
  const result = await runner(
    "git",
    ["ls-remote", "origin", `refs/heads/${branch}`],
    { cwd: root, timeoutMs: 60_000 },
  );
  if (result.timedOut || result.code !== 0)
    throw new FlowError(
      1,
      `git ls-remote origin に失敗しました${result.stderr.trim() ? `：${result.stderr.trim()}` : ""}`,
    );
  const line = result.stdout
    .split("\n")
    .find((l) => l.trim().endsWith(`refs/heads/${branch}`));
  const head = line?.trim().split(/\s+/)[0];
  if (!head)
    throw new FlowError(
      2,
      `origin に ${branch} がありません。先に push してください`,
    );
  return head;
}

/** plan と deploy が共通で確かめる：ID の形、設定、タスクのブランチ、origin の先頭 */
export async function resolveTask(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<QaTask> {
  requireIdShape(id);
  const root = await requireRoot(runner, cwd);
  const config = await requireFlowConfig(runner, root);
  const qa = requireQa(config);
  const branch = await findTaskBranch(runner, root, config.branchPrefix, id);
  const head = await originHead(runner, root, branch);
  return { config, qa, repo: await repoKey(runner, cwd), id, branch, head };
}

/** --branch のブランチの形。設定の baseBranch と同じ確かめ（config.ts の確かめの写し） */
export function isSafeBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (/^[-/.]/.test(value)) return false;
  if (/\.\.|\/\/|\/\./.test(value)) return false;
  if (value.split("/").some((part) => part.endsWith(".lock"))) return false;
  if (/[/.]$/.test(value)) return false;
  return true;
}
