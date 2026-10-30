import { requireConfig } from "../config.ts";
import {
  currentBranch,
  diffNames,
  rebaseOrAbort,
  requireRoot,
  runGit,
  uncommittedChanges,
} from "../lib/git.ts";
import { warnIfMainFailed } from "./main-check.ts";
import { idFromBranch } from "../lib/task-id.ts";
import {
  clearRecord,
  commandsFor,
  runVerifyCommands,
  writeRecord,
} from "../lib/verified.ts";
import { FlowError, type Command } from "../types.ts";

/** タスク長が、main を取り込んでテストを流し、通ったら記録を残す（8章 verify） */
export const run: Command = async (ctx) => {
  if (ctx.argv.length > 0)
    throw new FlowError(1, "使い方：orca-flow verify（引数はありません）");
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

  await warnIfMainFailed(ctx, root, config);

  // 落ちたときに古い記録が残らないよう、始めに消す
  await clearRecord(ctx.runner, root, id);

  const changes = await uncommittedChanges(ctx.runner, root, false);
  if (changes.length > 0)
    throw new FlowError(
      2,
      `未コミットの変更があります。コミットしてから呼んでください：\n${changes.join("\n")}`,
    );

  const base = config.baseBranch;
  const ancestor = await ctx.runner(
    "git",
    ["merge-base", "--is-ancestor", base, "HEAD"],
    { cwd: root },
  );
  const rebased = ancestor.code !== 0;
  if (rebased) {
    await rebaseOrAbort(ctx.runner, root, base, id);
    if (!ctx.json) ctx.stdout(`${base} を取り込みました（git rebase ${base}）`);
  }

  const files = await diffNames(ctx.runner, root, base, "HEAD");
  const commands = commandsFor(config, files);
  const failed = await runVerifyCommands(ctx, root, id, commands);
  if (failed !== null) return { code: 1, data: { id, failed } };

  const rev = async (ref: string) =>
    (
      await runGit(ctx.runner, root, ["rev-parse", ref], "git rev-parse")
    ).trim();
  const record = {
    id,
    head: await rev("HEAD"),
    base: await rev(base),
    commands,
    at: ctx.now().toISOString(),
  };
  await writeRecord(ctx.runner, root, record);
  if (!ctx.json)
    ctx.stdout(
      `${id} の確認が通りました（${commands.length} 件）。記録を残しました。integrate-wait に進めます`,
    );
  return { code: 0, data: { ...record, rebased } };
};
