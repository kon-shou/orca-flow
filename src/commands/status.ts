import { requireFlowConfig } from "../lib/flow-config.ts";
import { type FlowConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  approveNowNote,
  entryStateText,
  preApprovalState,
  readAuto,
  waitDetail,
  TURN_LABEL,
  withTurn,
  writeAuto,
  type PreApprovalState,
  type TurnKind,
} from "../lib/auto.ts";
import { readPushRecord } from "../lib/finish.ts";
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
import { stackBase } from "../lib/stack.ts";
import {
  startAfterFile,
  startAfterReadiness,
  startAfterUnreadable,
  type StartAfterReadiness,
} from "../lib/start-after.ts";
import { notifyStacked } from "../lib/stack-notice.ts";
import { recordStage } from "../lib/stage-log.ts";
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
    const files = await diffNames(
      ctx.runner,
      root,
      await stackBase(ctx.runner, root, config, id),
      "HEAD",
    );
    if (allInSkipPaths(files, config.verifySkipPaths)) return;
    ctx.stderr(
      `警告：${record ? "verify の記録が今の HEAD と違います" : "verify の記録がありません"}。integrate が戻されるので、先に orca-flow verify を流してください`,
    );
  } catch {
    // 警告のための確認が失敗しても、状態の更新は止めない
  }
}

const PRE_APPROVAL_TEXT: Record<PreApprovalState, string> = {
  valid: "先に承認してあります。",
  stale: "先の承認は、設計書が変わったので外れました。",
};

/**
 * 前を待つ印の整い具合を1行にする。整っていなければ「前の実装完了を待っています」、
 * 整っていれば「前が整っています」で始める。印か前が読めなければ、記録の場所と承認の抜け方を添える。
 * おまかせを外してあれば、待ち受けは進めないので人が approve する。
 * 先の承認があれば有効か外れたかを添え、有効でなく前が読めれば、先に承認できることを添える
 */
export function startAfterLine(
  readiness: StartAfterReadiness,
  file: string,
  off: boolean,
  pre: PreApprovalState | null = null,
): string {
  const preText = off || pre === null ? "" : PRE_APPROVAL_TEXT[pre];
  const howTo =
    pre === "valid"
      ? "番を立てて、先の承認のまま進めます"
      : "番を立てて進めます";
  if (readiness.ready)
    return `前が整っています（${readiness.entries.map(entryStateText).join("、")}）。${off ? "おまかせを外してあるので、/orca-flow:approve で承認します" : `${preText}承認は、統括役の待ち受け（/orca-flow:auto）が${howTo}`}`;
  const head = `前の実装完了を待っています（${waitDetail(readiness)}）。`;
  if (startAfterUnreadable(readiness))
    return `${head}${preText}${approveNowNote(file)}`;
  if (off)
    return `${head}おまかせを外してあるので、前が整ったら /orca-flow:approve で承認します`;
  return `${head}${preText}承認は、前が整ったあと統括役の待ち受け（/orca-flow:auto）が${howTo}${pre === "valid" ? "" : "。/orca-flow:approve で先に承認しておけます"}`;
}

/**
 * 印の1行のための、記録の場所・おまかせを外してあるか・先の承認。記録が読めなければ外していない・先の承認なしとし、
 * 先の承認があって見分けられなければ外れたとする
 */
async function startAfterLineFor(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  task: { id: string; branch: string },
  readiness: StartAfterReadiness,
): Promise<string> {
  let file = "";
  let off = false;
  let pre: PreApprovalState | null = null;
  try {
    const common = await gitCommonDir(ctx.runner, root);
    file = startAfterFile(common, task.id);
    const record = await readAuto(common, task.id);
    off = record?.auto === false;
    if (record?.auto && record.preApproval)
      try {
        pre = await preApprovalState(
          ctx.runner,
          root,
          config,
          { ...task, path: root },
          record.preApproval,
        );
      } catch {
        // 見分けられなければ、auto と同じく外れたと見せる（人の承認として進めない）
        pre = "stale";
      }
  } catch {
    // 1行は出す（場所が分からなくても、待っていることは伝える）
  }
  return startAfterLine(readiness, file, off, pre);
}

/**
 * spec-review のときだけ、前を待つ印の整い具合を見る。印がなければ null。
 * 読めなくても状態の更新は止めない（警告して null）
 */
async function readStartAfterState(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  id: string,
  state: TaskState,
): Promise<StartAfterReadiness | null> {
  if (state !== "spec-review") return null;
  try {
    const common = await gitCommonDir(ctx.runner, root);
    return await startAfterReadiness(ctx.runner, root, common, config, id);
  } catch (error) {
    ctx.stderr(
      `警告：前を待つ印を読めませんでした（${error instanceof Error ? error.message : String(error)}）`,
    );
    return null;
  }
}

/**
 * おまかせの記録があるときだけ、番を立てる（spec-review＝承認・integrate-wait＝統合）。
 * 承認だけのおまかせは統合の番を立てない。前を待つ印の前が整っていなければ承認の番も立てない
 * （整ったら待ち受けが立てる）。番を立てないときは、まだ拾われていない番を消す。
 * 記録がなければ何もしない（ファイルも作らない）。記録を読み書けなくても、状態の更新は止めない
 */
async function markAutoTurn(
  ctx: CommandContext,
  root: string,
  id: string,
  state: TaskState,
  updated: boolean,
  startAfter: StartAfterReadiness | null,
): Promise<{ turn: TurnKind | null; line: string | null } | null> {
  try {
    const common = await gitCommonDir(ctx.runner, root);
    const record = await readAuto(common, id);
    if (!record || !record.auto) return null;
    let kind: TurnKind | null =
      state === "spec-review"
        ? "approve"
        : state === "integrate-wait"
          ? "integrate"
          : null;
    if (kind === "integrate" && record.approveOnly) kind = null;
    if (kind === "approve" && startAfter !== null && !startAfter.ready)
      kind = null;
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
  const config = await requireFlowConfig(ctx.runner, root);
  const branch = await currentBranch(ctx.runner, root);
  const id = branch
    ? idFromBranch(branch, config.branchPrefix, config.idPrefix)
    : null;
  if (!id)
    throw new FlowError(
      1,
      `タスクの worktree（${config.branchPrefix}${config.idPrefix}〈数〉-… のブランチ）で呼んでください（今は ${branch ?? "切り離された HEAD"}）`,
    );

  // responding は、push で PR を出したタスクだけが使える（taskEnd によらない）
  if (
    state === "responding" &&
    !(await readPushRecord(ctx.runner, root, id))?.pr
  )
    throw new FlowError(
      1,
      `responding は push で PR を出したタスクでだけ使えます（${id} には push の記録の PR がありません）。手で開いた PR は respond の対象外です。統括役のタブで /orca-flow:push ${id} と /orca-flow:send ${id} を通すと使えます`,
    );

  if (state === "integrate-wait") await warnUnverified(ctx, root, config, id);

  const update = cardForState(state as TaskState, {
    note,
    reportPath: reportPath(config, id),
    taskEnd: config.taskEnd,
  });
  const data: {
    id: string;
    state: string;
    card: typeof update;
    updated: boolean;
    auto?: { turn: TurnKind | null };
    startAfter?: StartAfterReadiness;
    stackNotified?: string[];
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
  // カードの更新が失敗しても、状態は変わったとみなして記録する
  await recordStage(ctx, root, id, state, note, "status");
  const startAfter = await readStartAfterState(
    ctx,
    root,
    config,
    id,
    state as TaskState,
  );
  if (startAfter) data.startAfter = startAfter;
  const autoTurn = await markAutoTurn(
    ctx,
    root,
    id,
    state as TaskState,
    data.updated,
    startAfter,
  );
  if (autoTurn) data.auto = { turn: autoTurn.turn };
  // カードを更新できなくても状態は変わったとみなすので、知らせも送る
  if (state === "spec-review")
    data.stackNotified = await notifyStacked(ctx, config, root, id, "respec");

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
    if (startAfter)
      ctx.stdout(
        await startAfterLineFor(
          ctx,
          root,
          config,
          { id, branch: branch! },
          startAfter,
        ),
      );
  }
  return { code: 0, data };
};
