import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import { FlowError, type CommandContext } from "../types.ts";
import type { CrossDependsRepo } from "./cross-depends.ts";
import type { Runner } from "./exec.ts";
import { activeTasks, gitCommonDir, runGit } from "./git.ts";
import { REMOTE, pushApprovedSha } from "./github.ts";
import { commonRecordPath, hasIdShape } from "./task-id.ts";

// 共通のタスクの枝を、承認なしで push してよいという印（7章7番の例外）。
// 印は `〈git の共通ディレクトリ〉/orca-flow/branch-push/〈ID〉.json`（作業ツリーの外。統合のあとも消さない）

export interface BranchPushMark {
  id: string;
  /** 印を書いた時のタスクの枝 */
  branch: string;
  /** 印を書いた時刻（ISO） */
  at: string;
  /** 前に push した先頭（まだ push していなければなし） */
  pushedHead?: string;
  /** 前に push した時刻（ISO） */
  pushedAt?: string;
}

export function branchPushFileAt(common: string, id: string): string {
  return commonRecordPath(common, "branch-push", id, ".json");
}

/** 印を書く（古い印は、push した先頭ごと置き換える）。一時ファイルと rename */
export async function writeBranchPushMarkAt(
  common: string,
  id: string,
  branch: string,
  now: Date,
): Promise<void> {
  const mark: BranchPushMark = { id, branch, at: now.toISOString() };
  await writeMarkFile(branchPushFileAt(common, id), mark);
}

async function writeMarkFile(file: string, mark: BranchPushMark) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(mark, null, 2)}\n`);
  await rename(tmp, file);
}

/** 同じ ID の古い印を消す（なくてもよい） */
export async function removeBranchPushMarkAt(
  common: string,
  id: string,
): Promise<void> {
  await rm(branchPushFileAt(common, id), { force: true });
}

/** 印を読む。ない・壊れている・ID の形が違うなら null */
export async function readBranchPushMarkAt(
  common: string,
  id: string,
): Promise<BranchPushMark | null> {
  if (!hasIdShape(id)) return null;
  try {
    const raw: unknown = JSON.parse(
      await readFile(branchPushFileAt(common, id), "utf8"),
    );
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (r.id !== id || typeof r.branch !== "string" || typeof r.at !== "string")
      return null;
    return {
      id,
      branch: r.branch,
      at: r.at,
      ...(typeof r.pushedHead === "string" ? { pushedHead: r.pushedHead } : {}),
      ...(typeof r.pushedAt === "string" ? { pushedAt: r.pushedAt } : {}),
    };
  } catch {
    return null;
  }
}

export async function readBranchPushMark(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<BranchPushMark | null> {
  return readBranchPushMarkAt(await gitCommonDir(runner, cwd), id);
}

export interface BranchPushResult {
  id: string;
  branch: string;
  head: string;
  /** 前の先頭を期待値にした --force-with-lease で送ったか */
  leased: boolean;
  pushedAt: string;
}

/**
 * `push 〈ID〉 --branch`：印のあるタスクの自分の枝だけを push する（PR・案・返信は作らない）。
 * 印がなければ終了コード2。2回目からは、印の push した先頭を --force-with-lease の期待値にする
 */
export async function pushTaskBranchWithMark(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  id: string,
): Promise<BranchPushResult> {
  if (!config.outbound.allow.includes("push"))
    throw new FlowError(
      2,
      `outbound.allow に push がないので、${id} の枝は push しませんでした`,
    );
  const common = await gitCommonDir(ctx.runner, root);
  const mark = await readBranchPushMarkAt(common, id);
  if (!mark)
    throw new FlowError(
      2,
      `${id} には承認なしで push してよい印がありません。push しませんでした（共通の new に --allow-branch-push を付けて始めたタスクだけです）`,
    );
  const task = (await activeTasks(ctx.runner, root, config)).find(
    (t) => t.id === id,
  );
  if (!task)
    throw new FlowError(
      1,
      `作業中のタスクに ${id} が見つかりません（${config.branchPrefix}${id}-… のブランチの worktree がありません）`,
    );
  if (
    task.branch === config.baseBranch ||
    !task.branch.startsWith(`${config.branchPrefix}${id}-`)
  )
    throw new FlowError(
      1,
      `${task.branch} は ${id} のタスクの枝ではないので push しません`,
    );
  const head = (
    await runGit(ctx.runner, root, ["rev-parse", task.branch], "git rev-parse")
  ).trim();
  const expected = mark.pushedHead ?? null;
  await pushApprovedSha(
    { runner: ctx.runner, cwd: root, env: ctx.env },
    task.branch,
    config.baseBranch,
    head,
    { expectedRemoteHead: expected },
  );
  const pushedAt = ctx.now().toISOString();
  try {
    await writeMarkFile(branchPushFileAt(common, id), {
      ...mark,
      branch: task.branch,
      pushedHead: head,
      pushedAt,
    });
  } catch (error) {
    throw new FlowError(
      1,
      `${id} の枝を ${REMOTE} へ push しましたが、印に先頭を書けませんでした（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  return {
    id,
    branch: task.branch,
    head,
    leased: expected !== null,
    pushedAt,
  };
}

/** パッケージの定義とロックファイル（7章1番の1つ目の箇条。どの階層にあっても当たる）。範囲の例外・門・verify が共通で使う */
export const BRANCH_PACKAGE_FILES: readonly string[] = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "composer.json",
  "composer.lock",
];

const PACKAGE_FILES: ReadonlySet<string> = new Set(BRANCH_PACKAGE_FILES);

/** 枝の名前の前に続いてよくない文字（長い名前の一部を当てない）。前の `-` は `dev-枝` のために許す */
const BEFORE_BAD = /[A-Za-z0-9_./]/;
const AFTER_BAD = /[A-Za-z0-9_./-]/;

/** 行（文字列）に枝の名前が（長い名前の一部でなく）あるか */
export function lineHasBranch(line: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(name, from);
    if (at < 0) return false;
    const before = line[at - 1] ?? "";
    const after = line[at + name.length] ?? "";
    if (!BEFORE_BAD.test(before) && !AFTER_BAD.test(after)) return true;
    from = at + 1;
  }
}

export function isPackageFile(file: string): boolean {
  return PACKAGE_FILES.has(file.replace(/\\/g, "/").split("/").pop() ?? "");
}

/**
 * またぐ依存の記録に、枝で取り込むリポジトリ（repos[].branch）があるか。
 * finish.ts から呼ぶため、cross-depends.ts（merged.ts を通って finish.ts に戻る）を import せず、
 * ファイルの JSON だけを読む。none＝記録なし、plain＝枝なし、branch＝枝あり、broken＝壊れている
 */
export async function recordBranchState(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<"none" | "plain" | "branch" | "broken"> {
  if (!hasIdShape(id)) return "none";
  let text: string;
  try {
    text = await readFile(
      commonRecordPath(
        await gitCommonDir(runner, cwd),
        "cross-depends",
        id,
        ".json",
      ),
      "utf8",
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "none"
      : "broken";
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "broken";
  }
  if (typeof raw !== "object" || raw === null) return "broken";
  const r = raw as { id?: unknown; repos?: unknown };
  if (r.id !== id || !Array.isArray(r.repos)) return "broken";
  if (r.repos.some((x) => typeof x !== "object" || x === null)) return "broken";
  return r.repos.some(
    (x) => typeof (x as { branch?: unknown }).branch === "string",
  )
    ? "branch"
    : "plain";
}

/**
 * 共通の push の記録（`push/〈ID〉.json`。PR の道で送った先頭）から、枝が同じときの先頭を読む。
 * finish.ts の readPushRecord と同じ形を直に読む（finish.ts がこのファイルを import しているため輪になる）
 */
async function readPushRecordHead(
  common: string,
  id: string,
  branch: string,
): Promise<string | null> {
  if (!hasIdShape(id)) return null;
  try {
    const raw: unknown = JSON.parse(
      await readFile(commonRecordPath(common, "push", id, ".json"), "utf8"),
    );
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return typeof r.pushedHead === "string" && r.branch === branch
      ? r.pushedHead
      : null;
  } catch {
    return null;
  }
}

/** 作業ツリーの（追跡されている）ロックファイルの中身を全部つなげる。読めなければ空 */
async function lockfileText(runner: Runner, root: string): Promise<string> {
  const listed = await runner(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      ...BRANCH_PACKAGE_FILES.map((f) => `:(glob)**/${f}`),
    ],
    { cwd: root },
  );
  if (listed.code !== 0) return "";
  let text = "";
  for (const rel of listed.stdout.split("\0").filter((f) => f !== "")) {
    try {
      text += `${await readFile(path.join(root, rel), "utf8")}\n`;
    } catch {
      // 消えたファイルは読まない
    }
  }
  return text;
}

/**
 * 枝で取り込む共通のリポジトリの、push した先頭の並び（ID ごと。push の記録を印より先に見る）と、印があったか。
 * 印を読めなければ null。verify の警告と app-bump が同じ比べ方をするために共有する
 */
export async function pushedHeadsOf(
  runner: Runner,
  repo: Pick<CrossDependsRepo, "path" | "ids" | "branch">,
): Promise<{ heads: string[]; anyMark: boolean } | null> {
  const heads: string[] = [];
  let anyMark = false;
  try {
    const common = await gitCommonDir(runner, repo.path);
    for (const id of repo.ids) {
      const mark = await readBranchPushMarkAt(common, id);
      const own = mark && mark.branch === repo.branch ? mark : null;
      if (own) anyMark = true;
      const head =
        (await readPushRecordHead(common, id, repo.branch ?? "")) ??
        own?.pushedHead;
      if (head !== undefined) heads.push(head);
    }
  } catch {
    return null;
  }
  return { heads, anyMark };
}

/** 比べる先頭の頭の桁数（verify の警告と app-bump で同じ） */
export const HEAD_PREFIX_LENGTH = 12;

/**
 * タスクのブランチの先頭（作業ツリーは読まない）のパッケージの定義・ロックファイルのうち、needle を含む行（なければ空）。
 * 読めなければ null（git grep が見つからない＝終了コード1 以外の失敗）
 */
export async function refPackageLines(
  runner: Runner,
  root: string,
  ref: string,
  needle: string,
  files: readonly string[] = BRANCH_PACKAGE_FILES,
): Promise<string[] | null> {
  if (ref === "" || ref.startsWith("-") || needle === "") return [];
  const result = await runner(
    "git",
    [
      "grep",
      "-h",
      "-I",
      "-F",
      "-e",
      needle,
      ref,
      "--",
      ...files.map((f) => `:(glob)**/${f}`),
    ],
    { cwd: root },
  );
  if (result.code === 1) return [];
  if (result.code !== 0) return null;
  return result.stdout.split(/\r?\n/).filter((l) => l !== "");
}

/** パッケージの定義（5種。どの階層でも）。版上げの確かめとアプリの見分けが読む */
export const BRANCH_DEFINITION_FILES: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
];

/** パッケージ名に使う文字 */
const NAME_CHAR = /[A-Za-z0-9\-_./@]/;

/** パッケージ名が、前後にパッケージ名の文字が続かない形で行にあるか */
export function hasPackageName(line: string, pkg: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(pkg, from);
    if (at < 0) return false;
    const before = line[at - 1] ?? "";
    const after = line[at + pkg.length] ?? "";
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true;
    from = at + 1;
  }
}

/**
 * 古い取り込みの見分け（verify の警告）。記録に枝のあるリポジトリごとに、共通の push の記録（なければ印）の push した先頭の
 * 頭12文字が、作業ツリーのロックファイルのどれにも含まれなければ「取り込み直す」と出す（作業ツリーに枝の名前が残っているときだけ）。
 * 印がない・まだ push していないときは、その旨を出す。警告の文の並びを返す（なければ空）
 */
export async function staleBranchWarnings(
  runner: Runner,
  root: string,
  repos: readonly CrossDependsRepo[],
): Promise<string[]> {
  const warnings: string[] = [];
  let locks: string | null = null;
  for (const repo of repos) {
    if (typeof repo.branch !== "string") continue;
    // 作業ツリーに枝の名前が残っているときだけ比べる（正式な版に戻したあとは何も出さない）
    locks ??= await lockfileText(runner, root);
    if (!lineHasBranch(locks, repo.branch)) continue;
    // ID ごとの比べる先頭（push の記録を印より先に見る）
    const found = await pushedHeadsOf(runner, repo);
    if (found === null) {
      warnings.push(
        `${repo.name} の枝の印を読めませんでした（${repo.path}）。古い取り込みかは確かめていません`,
      );
      continue;
    }
    const { heads, anyMark } = found;
    if (heads.length === 0) {
      warnings.push(
        anyMark
          ? `${repo.name} の枝 ${repo.branch} はまだ push していません。古い取り込みかは確かめていません`
          : `${repo.name} の枝 ${repo.branch} の push の印がありません。古い取り込みかは確かめていません`,
      );
      continue;
    }
    // 複数の ID があるときは、どれかの先頭が入っていれば古くない
    if (!heads.some((h) => locks!.includes(h.slice(0, HEAD_PREFIX_LENGTH))))
      warnings.push(
        `${repo.name} の枝 ${repo.branch} の push した先頭（${heads[0]!.slice(0, HEAD_PREFIX_LENGTH)}）が、このタスクのロックファイルにありません。枝を取り込み直す必要があります（${repo.branchCommand ?? "記録の branchCommand"}）`,
      );
  }
  return warnings;
}
