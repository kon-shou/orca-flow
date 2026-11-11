import { unlink } from "node:fs/promises";
import type { FlowConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import {
  activeTasks,
  gitCommonDir,
  isTaskMerged,
  listBranches,
  type ActiveTask,
} from "./git.ts";
import { taskMergedInto } from "./merged.ts";
import {
  readStackAt,
  safeShape,
  stackFile,
  type StackRecord,
} from "./stack-record.ts";
import { hasIdShape } from "./task-id.ts";

export {
  readStackAt,
  stackFile,
  writeStackAt,
  type StackRecord,
} from "./stack-record.ts";

// 乗せる記録（前のタスクの枝を土台に後ろのタスクを始めた印）と、そこから決まる土台。

/**
 * 土台の見分け。
 * - none：乗せていない。base は baseBranch
 * - merged：乗せた先が baseBranch に入った。base は baseBranch
 * - open：乗せた先が作業中で入っていない。base は乗せた先の枝（task は乗せた先の作業中のタスク）
 * - missing：乗せた先が作業中にも baseBranch にもない。base はない（stackBase は終了コード2で止める）
 */
export type StackState =
  | { kind: "none"; base: string }
  | { kind: "merged"; base: string; record: StackRecord }
  | { kind: "open"; base: string; record: StackRecord; task: ActiveTask }
  | { kind: "missing"; record: StackRecord };

/** 乗せた先の枝として使ってよい名前か（安全な文字だけで、〈branchPrefix〉〈乗せた先の ID〉で始まる） */
export function isSafeStackBranch(
  config: Pick<FlowConfig, "branchPrefix">,
  on: string,
  branch: string,
): boolean {
  const head = `${config.branchPrefix}${on}`;
  return (
    safeShape(branch) && (branch === head || branch.startsWith(`${head}-`))
  );
}

/** 乗せた先の枝の名前が安全でなければ FlowError(1)（名前を直すか --unstack を案内する） */
export function requireSafeStackBranch(
  config: Pick<FlowConfig, "branchPrefix">,
  id: string | null,
  on: string,
  branch: string,
): void {
  if (isSafeStackBranch(config, on, branch)) return;
  const prefix = `${config.branchPrefix}${on}-`;
  throw new FlowError(
    1,
    `${on} のブランチ名が乗せる土台として使えない形です。英数字と / . _ - だけで、${prefix} で始まる名前に直してから、もう一度流してください` +
      (id === null
        ? ""
        : `。乗せるのをやめるなら、統括役の場所で orca-flow depends ${id} --unstack で乗せる記録を消してください`),
  );
}

/** どの作業ツリーからでも記録を読む（readStackAt と同じ） */
export async function readStack(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<StackRecord | null> {
  if (!hasIdShape(id)) return null;
  return readStackAt(await gitCommonDir(runner, cwd), id);
}

/** 記録を消す。消したら true、もともとなければ false */
export async function removeStack(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<boolean> {
  const file = stackFile(await gitCommonDir(runner, cwd), id);
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * タスクが baseBranch に入ったか。merged の見分け（件名の行・push の記録のマージのコミット）に、
 * 乗せたときの枝が baseBranch にマージ済みか（作業中の見分けと同じ isTaskMerged）を足す。
 * baseBranch がコミットとして読めなければ FlowError(1)
 */
export async function stackTargetMerged(
  runner: Runner,
  cwd: string,
  config: Pick<FlowConfig, "baseBranch" | "integratorName">,
  id: string,
  branch: string | null,
): Promise<boolean> {
  const base = config.baseBranch;
  if ((await taskMergedInto(runner, cwd, config, id, base)).merged) return true;
  return (
    branch !== null &&
    (await listBranches(runner, cwd)).includes(branch) &&
    (await isTaskMerged(runner, cwd, id, branch, base))
  );
}

/**
 * 乗せる記録から土台を見分ける（missing でも止めない）。
 * 記録が壊れている・乗せた先の枝の名前が安全でなければ FlowError(1)
 */
export async function stackState(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  id: string,
): Promise<StackState> {
  const record = await readStack(runner, cwd, id);
  if (record === null) return { kind: "none", base: config.baseBranch };
  if (await stackTargetMerged(runner, cwd, config, record.on, record.branch))
    return { kind: "merged", base: config.baseBranch, record };
  const task = (await activeTasks(runner, cwd, config)).find(
    (t) => t.id === record.on,
  );
  if (task) {
    requireSafeStackBranch(config, id, record.on, task.branch);
    return { kind: "open", base: task.branch, record, task };
  }
  return { kind: "missing", record };
}

/** 乗せた先が見つからないときの文（--unstack を案内する） */
export function missingMessage(id: string, record: StackRecord): string {
  return `${id} を乗せた先 ${record.on}（${record.branch}）が、作業中にも baseBranch にもありません。土台を決められないので止めます。乗せた先を捨てたなら、統括役の場所で orca-flow depends ${id} --unstack で乗せる記録を消してから、もう一度流してください`;
}

/** 土台の枝の名前。乗せた先が見つからなければ FlowError(2)（--unstack を案内する） */
export async function stackBase(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  id: string,
): Promise<string> {
  const state = await stackState(runner, cwd, config, id);
  if (state.kind === "missing")
    throw new FlowError(2, missingMessage(id, state.record));
  return state.base;
}

/** onId に乗せている作業中のタスク（ID の順）。候補の記録が壊れていれば FlowError(1) */
export async function stackedOn(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  onId: string,
): Promise<ActiveTask[]> {
  const common = await gitCommonDir(runner, cwd);
  const found: ActiveTask[] = [];
  for (const task of await activeTasks(runner, cwd, config)) {
    if (task.id === onId) continue;
    if ((await readStackAt(common, task.id))?.on === onId) found.push(task);
  }
  return found;
}
