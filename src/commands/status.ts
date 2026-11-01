import { requireConfig, type FlowConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  readAuto,
  TURN_LABEL,
  withTurn,
  writeAuto,
  type TurnKind,
} from "../lib/auto.ts";
import {
  currentBranch,
  diffNames,
  gitCommonDir,
  isIgnored,
  requireRoot,
  runGit,
} from "../lib/git.ts";
import {
  cardForState,
  createOrca,
  NOTE_STATES,
  TASK_STATES,
  type TaskState,
} from "../lib/orca.ts";
import { idFromBranch } from "../lib/task-id.ts";
import { reportPath, taskDocPath } from "../lib/tasks.ts";
import { allInSkipPaths, readRecord } from "../lib/verified.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

/** 統合待ちに進むとき、verify の記録がない・HEAD と違えば警告する（止めない） */
async function warnUnverified(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  id: string,
): Promise<void> {
  try {
    const head = (
      await runGit(ctx.runner, root, ["rev-parse", "HEAD"], "git rev-parse")
    ).trim();
    const record = await readRecord(ctx.runner, root, id);
    if (record && record.head === head) return;
    const files = await diffNames(ctx.runner, root, config.baseBranch, "HEAD");
    if (allInSkipPaths(files, config.verifySkipPaths)) return;
    ctx.stderr(
      `警告：${record ? "verify の記録が今の HEAD と違います" : "verify の記録がありません"}。integrate が戻されるので、先に orca-flow verify を流してください`,
    );
  } catch {
    // 警告のための確認が失敗しても、状態の更新は止めない
  }
}

/**
 * おまかせの記録があるときだけ、番を立てる（spec-review＝承認・integrate-wait＝統合）。
 * ほかの状態では、まだ拾われていない番を消す。記録がなければ何もしない（ファイルも作らない）。
 * 記録を読み書けなくても、状態の更新は止めない
 */
async function markAutoTurn(
  ctx: CommandContext,
  root: string,
  id: string,
  state: TaskState,
  updated: boolean,
): Promise<{ turn: TurnKind | null; line: string | null } | null> {
  try {
    const common = await gitCommonDir(ctx.runner, root);
    const record = await readAuto(common, id);
    if (!record || !record.auto) return null;
    const kind: TurnKind | null =
      state === "spec-review"
        ? "approve"
        : state === "integrate-wait"
          ? "integrate"
          : null;
    // カードを更新できなかったときは番を立てない（人の確認の流れに戻る）
    if (kind && !updated) return null;
    if (kind) {
      await writeAuto(common, withTurn(record, kind, ctx.now()));
      return {
        turn: kind,
        line: `おまかせ：${TURN_LABEL[kind]}は統括役が進めます（人の確認は要りません）`,
      };
    }
    if (record.turn && !record.turn.picked)
      await writeAuto(common, { ...record, turn: null });
    return { turn: null, line: null };
  } catch (error) {
    ctx.stderr(
      `警告：おまかせの記録を更新できませんでした（${error instanceof Error ? error.message : String(error)}）`,
    );
    return null;
  }
}

/** タスク長が、4章の表のとおりに Orca のカードを更新する。進捗表は触らない */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["note"]);
  const [state, ...rest] = args.positionals;
  if (!state || rest.length > 0 || !TASK_STATES.includes(state as TaskState))
    throw new FlowError(
      1,
      `状態は ${TASK_STATES.join("・")} のどれか1つを書いてください`,
    );
  const note = args.values.get("note");
  if (note !== undefined && !NOTE_STATES.includes(state as TaskState))
    throw new FlowError(
      1,
      `--note は ${NOTE_STATES.join("・")} でだけ使えます（${state} には一言をつけられません）`,
    );
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  const branch = await currentBranch(ctx.runner, root);
  const id = branch
    ? idFromBranch(branch, config.branchPrefix, config.idPrefix)
    : null;
  if (!id)
    throw new FlowError(
      1,
      `タスクの worktree（${config.branchPrefix}${config.idPrefix}〈数〉-… のブランチ）で呼んでください（今は ${branch ?? "切り離された HEAD"}）`,
    );

  if (state === "integrate-wait") await warnUnverified(ctx, root, config, id);

  const update = cardForState(state as TaskState, {
    note,
    reportPath: reportPath(config, id),
  });
  const data: {
    id: string;
    state: string;
    card: typeof update;
    updated: boolean;
    auto?: { turn: TurnKind | null };
  } = { id, state, card: update, updated: false };
  const orca = createOrca(ctx.runner, root);
  try {
    await orca.setCard(root, update);
    data.updated = true;
  } catch (error) {
    ctx.stderr(
      `警告：Orca のカードを更新できませんでした（${error instanceof Error ? error.message : String(error)}）。状態は ${state} のつもりで進めてください`,
    );
  }
  const autoTurn = await markAutoTurn(
    ctx,
    root,
    id,
    state as TaskState,
    data.updated,
  );
  if (autoTurn) data.auto = { turn: autoTurn.turn };

  // 記録が無視されているときだけ、Orca のタブで開く（失敗しても警告だけ）
  const record =
    state === "spec-review"
      ? taskDocPath(config, id)
      : state === "integrate-wait"
        ? reportPath(config, id)
        : null;
  if (data.updated && record && (await isIgnored(ctx.runner, root, record))) {
    try {
      await orca.openFile(root, record);
    } catch (error) {
      ctx.stderr(
        `警告：${record} を Orca のタブで開けませんでした（${error instanceof Error ? error.message : String(error)}）。ファイルは worktree にあります`,
      );
    }
  }
  if (!data.updated) {
    return { code: 0, data };
  }
  if (!ctx.json) {
    ctx.stdout(`${id} のカードを ${state}（${update.comment}）にしました`);
    if (autoTurn?.line) ctx.stdout(autoTurn.line);
  }
  return { code: 0, data };
};
