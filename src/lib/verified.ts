import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_PATH, type FlowConfig } from "../config.ts";
import type { CommandContext } from "../types.ts";
import { shellCommand } from "./exec.ts";
import { runGit } from "./git.ts";
import { isUnder, matchingPathVerify } from "./overlap.ts";
import type { Runner } from "./exec.ts";
import { requireIdShape } from "./task-id.ts";

export const TAIL_LINES = 80;
export const VERIFY_TIMEOUT_MS = 30 * 60_000;

/** verify が通った記録（タスクごとに1つ） */
export interface VerifiedRecord {
  id: string;
  /** ブランチの先頭のコミット */
  head: string;
  /** そのときの baseBranch の先頭のコミット */
  base: string;
  /** 流したコマンド */
  commands: string[];
  /** 通った時刻（ISO 8601） */
  at: string;
}

const tail = (text: string, lines: number) =>
  text.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");

/** 記録を置くディレクトリ：git-common-dir の下の orca-flow/verified（作業ツリーの外） */
export async function verifiedDir(
  runner: Runner,
  cwd: string,
): Promise<string> {
  const out = await runGit(
    runner,
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "git rev-parse",
  );
  return path.join(out.trim(), "orca-flow", "verified");
}

const recordFile = async (runner: Runner, cwd: string, id: string) => {
  requireIdShape(id);
  return path.join(await verifiedDir(runner, cwd), `${id}.json`);
};

const isRecord = (value: unknown): value is VerifiedRecord => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.head === "string" &&
    typeof v.base === "string" &&
    typeof v.at === "string" &&
    Array.isArray(v.commands) &&
    v.commands.every((c) => typeof c === "string")
  );
};

/** 記録を読む。なければ・壊れていれば null */
export async function readRecord(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<VerifiedRecord | null> {
  const file = await recordFile(runner, cwd, id);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeRecord(
  runner: Runner,
  cwd: string,
  record: VerifiedRecord,
): Promise<void> {
  const file = await recordFile(runner, cwd, record.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

export async function clearRecord(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<void> {
  await rm(await recordFile(runner, cwd, id), { force: true });
}

/** 差分が1つ以上あり、すべて verifySkipPaths の中か */
export function allInSkipPaths(
  files: readonly string[],
  skipPaths: readonly string[],
): boolean {
  return (
    files.length > 0 &&
    files.every((file) => skipPaths.some((p) => isUnder(file, p)))
  );
}

/** 流すコマンド：verify と、差分が当たる pathVerify */
export const commandsFor = (
  config: FlowConfig,
  files: readonly string[],
): string[] => [
  ...config.verify,
  ...matchingPathVerify(files, config.pathVerify),
];

/**
 * コマンドを順に流す（時間切れ30分、落ちたら最後の80行を標準エラーに出す）。
 * 全部通れば null、落ちたらそのコマンドを返す
 */
export async function runVerifyCommands(
  ctx: CommandContext,
  cwd: string,
  id: string,
  commands: readonly string[],
): Promise<string | null> {
  for (const command of commands) {
    const [cmd, cmdArgs] = shellCommand(command);
    if (!ctx.json) ctx.stdout(`確かめています：${command}`);
    const result = await ctx.runner(cmd, cmdArgs, {
      cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.timedOut) {
      const output = tail(`${result.stdout}\n${result.stderr}`, TAIL_LINES);
      ctx.stderr(
        `${id} の worktree で「${command}」が${result.timedOut ? "時間内に終わりませんでした" : "落ちました"}（最後の${TAIL_LINES}行）：\n${output}`,
      );
      return command;
    }
  }
  return null;
}

/** 記録が今の状態に合うか。合わなければ理由を返す */
export function recordMismatch(
  record: VerifiedRecord | null,
  now: { head: string; base: string; commands: readonly string[] },
): string | null {
  if (!record) return "verify の記録がありません";
  if (record.head !== now.head)
    return "記録のあとにタスクのブランチが動きました";
  if (record.base !== now.base) return "記録のあとに main が動きました";
  if (
    record.commands.length !== now.commands.length ||
    record.commands.some((c, i) => c !== now.commands[i])
  )
    return "記録のあとに流すコマンドが変わりました";
  return null;
}

/** テストに関係しない場所：verifySkipPaths、設定のファイル、進捗表（progress が null なら足さない） */
export const testIrrelevantPaths = (config: FlowConfig): string[] => [
  ...config.verifySkipPaths,
  CONFIG_PATH,
  ...(config.progress ? [config.progress.file] : []),
];

/** ファイルのうち、テストに関係するもの（テストに関係しない場所の外） */
export const testRelevantFiles = (
  files: readonly string[],
  config: FlowConfig,
): string[] => {
  const irrelevant = testIrrelevantPaths(config);
  return files.filter((file) => !irrelevant.some((p) => isUnder(file, p)));
};

/** 記録の base から今の baseBranch までの変わり方 */
export type BaseDrift =
  | { kind: "same" }
  | { kind: "irrelevant"; changed: string[] }
  | { kind: "relevant"; changed: string[]; relevant: string[] }
  | { kind: "unknown"; why: string };

/**
 * 記録のあとに baseBranch で変わったファイルを調べる。
 * 記録の base が見つからない・今の baseBranch の祖先でない・diff が失敗なら unknown
 */
export async function baseDrift(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  recordBase: string,
  currentBase: string,
): Promise<BaseDrift> {
  if (recordBase === currentBase) return { kind: "same" };
  const ancestor = await runner(
    "git",
    ["merge-base", "--is-ancestor", recordBase, currentBase],
    { cwd },
  );
  if (ancestor.code !== 0 && ancestor.code !== 1)
    return {
      kind: "unknown",
      why: "記録の main のコミットが見つかりません",
    };
  if (ancestor.code === 1)
    return {
      kind: "unknown",
      why: "記録の main のコミットが今の main の祖先ではありません",
    };
  const diff = await runner(
    "git",
    ["diff", "--name-only", "--no-renames", `${recordBase}..${currentBase}`],
    { cwd },
  );
  if (diff.code !== 0)
    return {
      kind: "unknown",
      why: "記録のあとの main の変更を調べられませんでした",
    };
  const changed = diff.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  const relevant = testRelevantFiles(changed, config);
  return relevant.length > 0
    ? { kind: "relevant", changed, relevant }
    : { kind: "irrelevant", changed };
}
