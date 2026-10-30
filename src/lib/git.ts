import { realpath } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import { repoRoot, runOrThrow, type Runner } from "./exec.ts";
import { idFromBranch } from "./task-id.ts";

const git = (
  runner: Runner,
  cwd: string,
  args: readonly string[],
  what: string,
) => runOrThrow(runner, "git", args, what, { cwd });

const canonical = async (p: string) => {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
};

/** cwd を含む git のトップ。git の外なら FlowError(1) */
export async function requireRoot(
  runner: Runner,
  cwd: string,
): Promise<string> {
  const root = await repoRoot(runner, cwd);
  if (!root) throw new FlowError(1, "git のリポジトリの中で呼んでください");
  return root;
}

/** 今のブランチの名前。切り離された HEAD なら null */
export async function currentBranch(
  runner: Runner,
  cwd: string,
): Promise<string | null> {
  const result = await runner(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      cwd,
    },
  );
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/** git の共通ディレクトリ（どの worktree から呼んでも同じ） */
export async function gitCommonDir(
  runner: Runner,
  cwd: string,
): Promise<string> {
  const out = await git(
    runner,
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "git rev-parse",
  );
  return out.trim();
}

/** メインの作業ツリー（git-dir と git-common-dir が同じ）か */
export async function isMainWorktree(
  runner: Runner,
  cwd: string,
): Promise<boolean> {
  const out = await git(
    runner,
    cwd,
    [
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
      "--git-common-dir",
    ],
    "git rev-parse",
  );
  const [gitDir, commonDir] = out.trim().split(/\r?\n/);
  if (!gitDir || !commonDir) return false;
  return (await canonical(gitDir)) === (await canonical(commonDir));
}

/** メインの作業ツリーの場所（どの worktree から呼んでもよい） */
export async function mainWorktreePath(
  runner: Runner,
  cwd: string,
): Promise<string> {
  const out = await git(
    runner,
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "git rev-parse",
  );
  return path.dirname(await canonical(out.trim()));
}

/** 未コミットの変更の一覧（porcelain の行）。untracked を含めるかを選ぶ */
export async function uncommittedChanges(
  runner: Runner,
  cwd: string,
  includeUntracked: boolean,
): Promise<string[]> {
  const out = await git(
    runner,
    cwd,
    [
      "status",
      "--porcelain",
      includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
    ],
    "git status",
  );
  return out.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/**
 * 統括役の場所の確認（8章）：baseBranch にいて、メインの作業ツリーで、追跡中のファイルに未コミットの変更がない。
 * 満たさなければ FlowError(2)。git のトップを返す
 */
export async function requireIntegratorPlace(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
): Promise<string> {
  const root = await requireRoot(runner, cwd);
  if (!(await isMainWorktree(runner, root)))
    throw new FlowError(
      2,
      "ここはタスクの worktree です。メインのチェックアウト（統括役のタブ）で呼んでください",
    );
  const branch = await currentBranch(runner, root);
  if (branch !== config.baseBranch)
    throw new FlowError(
      2,
      `メインのチェックアウトが ${config.baseBranch} ではありません（今は ${branch ?? "切り離された HEAD"}）。git switch ${config.baseBranch} をしてから呼んでください`,
    );
  const changes = await uncommittedChanges(runner, root, false);
  if (changes.length > 0)
    throw new FlowError(
      2,
      `メインのチェックアウトに未コミットの変更があります。コミットするか片づけてから呼んでください：\n${changes.join("\n")}`,
    );
  return root;
}

export interface WorktreeEntry {
  path: string;
  /** refs/heads/ を取ったブランチ名。切り離された HEAD なら null */
  branch: string | null;
  head: string | null;
}

/** git worktree list --porcelain */
export async function listWorktrees(
  runner: Runner,
  cwd: string,
): Promise<WorktreeEntry[]> {
  const out = await git(
    runner,
    cwd,
    ["worktree", "list", "--porcelain"],
    "git worktree list",
  );
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        head: null,
      };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    }
  }
  return entries;
}

/** ローカルのブランチの一覧 */
export async function listBranches(
  runner: Runner,
  cwd: string,
  pattern?: string,
): Promise<string[]> {
  const out = await git(
    runner,
    cwd,
    [
      "for-each-ref",
      "--format=%(refname:short)",
      pattern ? `refs/heads/${pattern}` : "refs/heads/",
    ],
    "git for-each-ref",
  );
  return out.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/**
 * ブランチが baseBranch にマージ済みか。
 * 先端が baseBranch から辿れて、かつ baseBranch の first-parent の列にない（＝ merge --no-ff で入った）ものをマージ済みとする。
 * 作ったばかりで1つもコミットのないブランチは、先端が baseBranch の列にあるのでマージ済みにしない
 */
export async function isMerged(
  runner: Runner,
  cwd: string,
  branch: string,
  base: string,
): Promise<boolean> {
  const ancestor = await runner(
    "git",
    ["merge-base", "--is-ancestor", branch, base],
    { cwd },
  );
  if (ancestor.code !== 0) return false;
  const tip = (
    await git(runner, cwd, ["rev-parse", branch], "git rev-parse")
  ).trim();
  const firstParents = await git(
    runner,
    cwd,
    ["rev-list", "--first-parent", base],
    "git rev-list",
  );
  return !firstParents.split(/\r?\n/).includes(tip);
}

export interface ActiveTask {
  id: string;
  branch: string;
  /** worktree の絶対パス */
  path: string;
}

/**
 * 作業中のタスク（8章 active）：〈branchPrefix〉〈idPrefix〉* のブランチで、baseBranch にマージされておらず、worktree がある
 */
export async function activeTasks(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
): Promise<ActiveTask[]> {
  const worktrees = await listWorktrees(runner, cwd);
  const tasks: ActiveTask[] = [];
  for (const wt of worktrees) {
    if (!wt.branch) continue;
    const id = idFromBranch(wt.branch, config.branchPrefix, config.idPrefix);
    if (!id) continue;
    if (await isMerged(runner, cwd, wt.branch, config.baseBranch)) continue;
    tasks.push({ id, branch: wt.branch, path: wt.path });
  }
  return tasks.sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true }),
  );
}

/** 作業中のタスクから ID で探す。なければ FlowError(1) */
export async function requireActiveTask(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  id: string,
): Promise<ActiveTask> {
  const task = (await activeTasks(runner, cwd, config)).find(
    (t) => t.id === id,
  );
  if (!task)
    throw new FlowError(
      1,
      `作業中のタスクに ${id} が見つかりません（${config.branchPrefix}${id}-… のブランチの worktree がないか、すでにマージ済みです）`,
    );
  return task;
}

/** ブランチのファイルの中身。なければ null */
export async function showFile(
  runner: Runner,
  cwd: string,
  ref: string,
  file: string,
): Promise<string | null> {
  const result = await runner("git", ["show", `${ref}:${file}`], { cwd });
  return result.code === 0 ? result.stdout : null;
}

/** そのファイルが、作業ツリー cwd で git に無視されているか（追跡中のファイルは無視されない） */
export async function isIgnored(
  runner: Runner,
  cwd: string,
  file: string,
  options: { noIndex?: boolean } = {},
): Promise<boolean> {
  const args = ["check-ignore", "-q"];
  // --no-index：追跡中でも、.gitignore の行に当たるかを見る
  if (options.noIndex) args.push("--no-index");
  const result = await runner("git", [...args, "--", file], {
    cwd,
  });
  return result.code === 0;
}

/** `git rebase 〈base〉`。競合したら `git rebase --abort` して FlowError(3) */
export async function rebaseOrAbort(
  runner: Runner,
  worktree: string,
  base: string,
  id: string,
): Promise<void> {
  const result = await runner("git", ["rebase", base], { cwd: worktree });
  if (result.code === 0) return;
  const conflicts = await runner(
    "git",
    ["diff", "--name-only", "--diff-filter=U"],
    { cwd: worktree },
  );
  await runner("git", ["rebase", "--abort"], { cwd: worktree });
  const files = conflicts.stdout.trim();
  throw new FlowError(
    3,
    `${id} の worktree で git rebase ${base} が競合したので取りやめました（worktree は元のままです）${files ? `。競合したファイル：\n${files}` : `：${(result.stderr || result.stdout).trim()}`}`,
  );
}

/** `git diff --name-only --no-renames 〈base〉...〈branch〉`（移したファイルは移動元も入る） */
export async function diffNames(
  runner: Runner,
  cwd: string,
  base: string,
  branch: string,
): Promise<string[]> {
  const out = await git(
    runner,
    cwd,
    ["diff", "--name-only", "--no-renames", `${base}...${branch}`],
    "git diff",
  );
  return out.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/** `git merge --no-ff`。失敗したら `git merge --abort` して FlowError(3) */
export async function mergeNoFf(
  runner: Runner,
  cwd: string,
  branch: string,
  message: string,
): Promise<void> {
  const result = await runner(
    "git",
    ["merge", "--no-ff", branch, "-m", message],
    {
      cwd,
    },
  );
  if (result.code === 0) return;
  await runner("git", ["merge", "--abort"], { cwd });
  throw new FlowError(
    3,
    `git merge --no-ff ${branch} が競合したので取りやめました：${(result.stderr || result.stdout).trim()}`,
  );
}

/** 1つのファイルだけをコミットする */
export async function commitFile(
  runner: Runner,
  cwd: string,
  file: string,
  message: string,
): Promise<void> {
  await git(runner, cwd, ["add", "--", file], "git add");
  await git(runner, cwd, ["commit", "-m", message, "--", file], "git commit");
}

export { git as runGit };
