import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  rebaseOrAbort,
  requireActiveTask,
  requireIntegratorPlace,
  requireRoot,
  uncommittedChanges,
} from "../lib/git.ts";
import { warnIfMainFailed } from "./main-check.ts";
import { cardForState, createOrca, sendFailMessage } from "../lib/orca.ts";
import { setCell } from "../lib/progress.ts";
import { parseTaskDoc } from "../lib/task-doc.ts";
import {
  applyProgress,
  planProgress,
  readTaskRecord,
  taskDocPath,
} from "../lib/tasks.ts";
import { FlowError, type Command } from "../types.ts";

/** 統括役が設計を承認して実行を始める（8章 approve） */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, [], ["prechanges-done"]);
  const [id, ...rest] = args.positionals;
  if (!id || rest.length > 0)
    throw new FlowError(
      1,
      "使い方：orca-flow approve 〈ID〉 [--prechanges-done]",
    );

  // ① 統括役の場所の確認
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  await requireIntegratorPlace(ctx.runner, root, config);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  await warnIfMainFailed(ctx, root, config);

  // ② 設計書がコミットされていて、worktree に未コミットの変更がない
  const docFile = taskDocPath(config, id);
  const docRecord = await readTaskRecord(ctx.runner, root, task, docFile);
  const docText = docRecord.text;
  if (docText === null)
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

  // 進捗表の書き換えを先に組み立てる
  const progress = config.progress;
  const plan = await planProgress(ctx, root, config, (text) =>
    progress
      ? setCell(text, progress, id, "state", progress.stateLabels.working)
      : text,
  );

  // ④ rebase（競合したら abort して終了コード3）。進捗表を変える前に確かめる
  await rebaseOrAbort(ctx.runner, task.path, config.baseBranch, id);

  // ⑤ 進捗表。コミットしたら、もう一度 rebase して承認のコミットも取り込ませる
  // （run の手順2が、タスクのブランチが baseBranch を含むかを確かめるため）
  const committed = await applyProgress(
    ctx.runner,
    root,
    plan,
    `${config.integratorName}: ${id} の設計を承認する`,
  );
  if (committed)
    await rebaseOrAbort(ctx.runner, task.path, config.baseBranch, id);

  // ⑥ タスク長に /orca-flow:run を送る
  const prompt = `/orca-flow:run ${id}`;
  let delivery: "send" | "launch";
  if (terminal) {
    // 送る直前にもう一度、同じターミナルの入力欄を確かめる（rebase の間に変わったかもしれない）
    const block = await orca.checkInput(terminal.handle, config.lead.agent);
    if (block)
      throw new FlowError(
        2,
        `${sendFailMessage(id, block, config.lead.agent)}。rebase と進捗表のコミットは済んでいます（もう一度 orca-flow approve ${id}${args.flags.has("prechanges-done") ? " --prechanges-done" : ""} を流せば続きから進みます）`,
      );
    await orca.sendText(terminal.handle, prompt);
    delivery = "send";
  } else {
    await orca.launchAgent({
      worktreePath: task.path,
      lead: config.lead,
      prompt,
    });
    delivery = "launch";
  }

  // ⑦ カード
  try {
    await orca.setCard(task.path, cardForState("working"));
  } catch (error) {
    ctx.stderr(
      `警告：カードを「実装中」にできませんでした（${error instanceof Error ? error.message : String(error)}）`,
    );
  }

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
