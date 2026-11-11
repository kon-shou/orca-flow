import { requireFlowConfig } from "../lib/flow-config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  docBlob,
  newRecord,
  readAuto,
  waitState,
  writeAuto,
} from "../lib/auto.ts";
import {
  gitCommonDir,
  mergeBaseOrAbort,
  requireActiveTask,
  requireIntegratorPlace,
  requireRoot,
  uncommittedChanges,
} from "../lib/git.ts";
import { acquireMainLock } from "../lib/finish.ts";
import { warnIfMainFailed } from "./main-check.ts";
import { cardForState, createOrca, sendFailMessage } from "../lib/orca.ts";
import { readStages, recordStage } from "../lib/stage-log.ts";
import { startAfterReadiness } from "../lib/start-after.ts";
import { setCell } from "../lib/progress.ts";
import { parseTaskDoc } from "../lib/task-doc.ts";
import { stackBase } from "../lib/stack.ts";
import {
  applyProgress,
  planProgress,
  readTaskRecord,
  taskDocPath,
} from "../lib/tasks.ts";
import type { FlowConfig } from "../config.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

const USAGE =
  "使い方：orca-flow approve 〈ID〉 [--prechanges-done] [--when-ready] [--doc-blob 〈blob〉]";

const BLOB_FORM = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * 承認する設計書を読む。設計書がコミットされていない・worktree に未コミットの変更がある・
 * 読んだ指紋（readBlob）と今の blob が違う、のどれかなら終了コード1
 */
async function readApprovedDoc(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  task: { id: string; branch: string; path: string },
  readBlob: string | null,
): Promise<{ text: string; blob: () => Promise<string> }> {
  const id = task.id;
  const docFile = taskDocPath(config, id);
  const docRecord = await readTaskRecord(ctx.runner, root, task, docFile);
  const text = docRecord.text;
  if (text === null)
    throw new FlowError(
      1,
      docRecord.ignored
        ? `設計書 ${docRecord.absolute} がありません`
        : `${task.branch} に設計書 ${docFile} がコミットされていません`,
    );
  const changes = await uncommittedChanges(ctx.runner, task.path, true);
  if (changes.length > 0)
    throw new FlowError(
      1,
      `${id} の worktree に未コミットの変更があります。タスク長にコミットしてもらってください：\n${changes.join("\n")}`,
    );
  // --doc-blob がないときは指紋を求めない（今までの道で git hash-object を増やさないため）
  let cached: Promise<string> | null = null;
  const blob = () => (cached ??= docBlob(ctx.runner, task.path, text));
  if (readBlob !== null) {
    const now = await blob();
    if (now !== readBlob)
      throw new FlowError(
        1,
        `設計書が読んだときから変わっています（読んだとき：${readBlob}、今：${now}）。何も変えていません。設計書を読み直してから、もう一度承認してください`,
      );
  }
  return { text, blob };
}

/** --doc-blob の値。形でなければ、何かを読む前に終了コード1 */
function readBlobArg(values: Map<string, string>): string | null {
  const value = values.get("doc-blob");
  if (value === undefined) return null;
  const lower = value.toLowerCase();
  if (!BLOB_FORM.test(lower))
    throw new FlowError(
      1,
      `--doc-blob には設計書の blob（16進の40字か64字）を書いてください（今は「${value}」）。${USAGE}`,
    );
  return lower;
}

/**
 * 先の承認（--when-ready）：前を待つ印の前が整っていないタスクの設計書の blob と時刻を、おまかせの記録に残す。
 * 取り込み・進捗表・カード・送りはしない（前が整ったら待ち受けの番で、人の承認として進める）
 */
async function approveWhenReady(
  ctx: CommandContext,
  id: string,
  readBlob: string | null,
) {
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  await requireIntegratorPlace(ctx.runner, root, config);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  const common = await gitCommonDir(ctx.runner, root);

  const readiness = await startAfterReadiness(
    ctx.runner,
    root,
    common,
    config,
    id,
  );
  if (readiness === null)
    throw new FlowError(
      1,
      `${id} には前を待つ印がありません。--when-ready は前の実装完了を待つタスクにだけ使えます。今承認するなら orca-flow approve ${id} を流してください`,
    );
  if (readiness.problem !== null)
    throw new FlowError(
      1,
      `${id} の前を待つ印が読めません（${readiness.problem}）。先の承認はできません。今承認するなら orca-flow approve ${id} を流してください`,
    );
  const unreadable = readiness.entries.filter((e) => e.unreadable);
  if (unreadable.length > 0)
    throw new FlowError(
      1,
      `${id} の前が読めません（${unreadable.map((e) => `${e.label}：${e.reason}`).join("、")}）。先の承認はできません。今承認するなら orca-flow approve ${id} を流してください`,
    );
  if (readiness.ready)
    throw new FlowError(
      1,
      `${id} の前はもう整っています。先の承認ではなく、orca-flow approve ${id} で今承認してください`,
    );

  const last = (await readStages(common, id))?.entries.at(-1);
  if (last?.state !== "spec-review")
    throw new FlowError(
      1,
      `${id} は設計書のレビュー待ち（段の記録の最後が spec-review）ではありません（今は ${last?.state ?? "記録なし"}）。先に承認できるのは spec-review のタスクだけです`,
    );

  const doc = await readApprovedDoc(ctx, root, config, task, readBlob);

  const now = ctx.now();
  const preApproval = {
    blob: await doc.blob(),
    at: now.toISOString(),
  };
  // 書く直前に読み直す（待ち受けと status が同じ記録を書くため）。外してあったおまかせは、承認だけのおまかせとして入に戻す
  const current = await readAuto(common, id);
  const base =
    current && current.auto
      ? current
      : {
          ...(current ?? newRecord(id, now, true)),
          auto: true,
          approveOnly: true,
          turn: null,
          offReason: null,
          offAt: null,
        };
  const record = { ...base, preApproval };
  await writeAuto(common, record);

  const wait = await waitState(common);
  const data = {
    id,
    preApproval,
    approveOnly: record.approveOnly,
    waiting: wait.running,
  };
  if (!ctx.json) {
    ctx.stdout(
      `先に承認しました：${id}。前が整ったら、統括役の待ち受け（/orca-flow:auto）が人の承認として実装を始めます。設計書が変わると先の承認は外れます`,
    );
    if (!wait.running)
      ctx.stdout(
        "待ち受けが動いていません。/orca-flow:auto で待ち受けを始めてください",
      );
  }
  return { code: 0 as const, data };
}

/** 統括役が設計を承認して実行を始める（8章 approve） */
export const run: Command = async (ctx) => {
  const args = parseArgs(
    ctx.argv,
    ["doc-blob"],
    ["prechanges-done", "when-ready"],
  );
  const [id, ...rest] = args.positionals;
  if (!id || rest.length > 0) throw new FlowError(1, USAGE);
  const readBlob = readBlobArg(args.values);
  if (args.flags.has("when-ready")) {
    if (args.flags.has("prechanges-done"))
      throw new FlowError(
        1,
        `--when-ready と --prechanges-done は一緒に使えません。先の承認は main への事前変更を入れずに残し、事前変更は前が整って承認するときに入れます。${USAGE}`,
      );
    return approveWhenReady(ctx, id, readBlob);
  }

  // ① 統括役の場所の確認
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  await requireIntegratorPlace(ctx.runner, root, config);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  await warnIfMainFailed(ctx, root, config);
  // 乗せているタスクは、baseBranch の代わりに乗せた先の枝を取り込む（乗せた先が見つからなければ終了コード2）
  const base = await stackBase(ctx.runner, root, config, id);

  // ② 設計書がコミットされていて、worktree に未コミットの変更がなく、読んだ指紋と同じ
  const { text: docText } = await readApprovedDoc(
    ctx,
    root,
    config,
    task,
    readBlob,
  );

  // ③ main への事前変更
  const doc = parseTaskDoc(docText);
  for (const warning of doc.warnings) ctx.stderr(`警告：${warning}`);
  if (doc.prechanges.length > 0 && !args.flags.has("prechanges-done")) {
    ctx.stderr(
      `${id} の設計書に「main への事前変更」があります。統括役が main で入れてコミットしてから、--prechanges-done をつけて呼んでください：\n${doc.prechanges.map((p) => `- ${p}`).join("\n")}`,
    );
    return { code: 2, data: { id, prechanges: doc.prechanges } };
  }

  // Orca につながるかと、送り先のターミナルを先に確かめる
  const orca = createOrca(ctx.runner, root);
  await orca.ping();
  const found = await orca.findSendTarget(task.path, config.lead.agent);
  if (found.kind !== "found" && found.kind !== "none")
    throw new FlowError(2, sendFailMessage(id, found, config.lead.agent));
  const terminal = found.kind === "found" ? found.terminal : null;

  // 進捗表を組み立てる前から取り込みまで、main を書き換える他の処理（integrate・push の道の後始末・new）と同じロックを取る
  const releaseMain = await acquireMainLock(ctx, root, "approve");
  let committed: boolean;
  try {
    // 進捗表の書き換えを先に組み立てる
    const progress = config.progress;
    const plan = await planProgress(ctx, root, config, (text) =>
      progress
        ? setCell(text, progress, id, "state", progress.stateLabels.working)
        : text,
    );

    // ④ 取り込み（競合したら abort して終了コード3）。進捗表を変える前に確かめる
    await mergeBaseOrAbort(ctx.runner, task.path, base, id);

    // ⑤ 進捗表。コミットしたら、もう一度取り込んで承認のコミットも取り込ませる
    // （run の手順2が、タスクのブランチが baseBranch を含むかを確かめるため）。
    // 乗せている間は main を直に取り込まない（run は土台を含むかを確かめる）
    committed = await applyProgress(
      ctx.runner,
      root,
      plan,
      `${config.integratorName}: ${id} の設計を承認する`,
    );
    if (committed && base === config.baseBranch)
      await mergeBaseOrAbort(ctx.runner, task.path, base, id);
  } finally {
    await releaseMain();
  }

  // 承認の時刻は送る前に取る（送ったあとのタスク長の working より後ろに並ばないため）
  const approvedAt = ctx.now();

  // ⑥ タスク長に /clear を送り、run を新しい会話で始める
  // カードは送る前に「実装中」にする（/clear のあとのフックが古い状態を伝えないため）
  const prompt = `/orca-flow:run ${id}`;
  const markWorking = async () => {
    try {
      await orca.setCard(task.path, cardForState("working"));
    } catch (error) {
      ctx.stderr(
        `警告：カードを「実装中」にできませんでした（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  };
  // 送るか起動するのに失敗したら、カードを設計書のレビュー待ちに戻す
  const revertCard = async () => {
    try {
      await orca.setCard(task.path, cardForState("spec-review"));
    } catch (error) {
      ctx.stderr(
        `警告：カードを「設計書のレビュー待ち」に戻せませんでした（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  };
  let delivery: "send" | "launch";
  if (terminal) {
    // 送る直前にもう一度、同じターミナルの入力欄を確かめる（取り込みの間に変わったかもしれない）
    const block = await orca.checkInput(terminal.handle, config.lead.agent);
    if (block)
      throw new FlowError(
        2,
        `${sendFailMessage(id, block, config.lead.agent)}。取り込みと進捗表のコミットは済んでいます（もう一度 orca-flow approve ${id}${args.flags.has("prechanges-done") ? " --prechanges-done" : ""}${readBlob === null ? "" : ` --doc-blob ${readBlob}`} を流せば続きから進みます）`,
      );
    await markWorking();
    try {
      await orca.sendText(terminal.handle, "/clear", { waitSubmit: 5 });
      await orca.sendText(terminal.handle, prompt, { waitSubmit: 5 });
    } catch (error) {
      await revertCard();
      throw error;
    }
    delivery = "send";
  } else {
    await markWorking();
    try {
      await orca.launchAgent({
        worktreePath: task.path,
        lead: config.lead,
        prompt,
      });
    } catch (error) {
      await revertCard();
      throw error;
    }
    delivery = "launch";
  }

  await recordStage(ctx, root, id, "working", null, "approve", approvedAt);

  const data = {
    id,
    branch: task.branch,
    delivery,
    progressCommitted: committed,
  };
  if (!ctx.json)
    ctx.stdout(
      `${id} の設計を承認しました。${delivery === "send" ? "タスク長のターミナルに" : "タスク長を起動して"} ${prompt} を送りました`,
    );
  return { code: 0, data };
};
