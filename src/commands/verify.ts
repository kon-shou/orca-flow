import { requireConfig } from "../config.ts";
import {
  checkDecisionsAppendOnly,
  fixDecisionsBlankLines,
} from "../lib/decisions.ts";
import {
  currentBranch,
  diffNames,
  rebaseOrAbort,
  requireRoot,
  runGit,
  uncommittedChanges,
} from "../lib/git.ts";
import { staleBranchWarnings } from "../lib/branch-push.ts";
import { readCrossDepends } from "../lib/cross-depends.ts";
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

  // rebase で記録の行が消えていないか（手で rebase したあとも確かめる）。main に記録がなければ何もしない
  const mainText = await checkDecisionsAppendOnly(ctx.runner, config, root, {
    id,
    against: "HEAD",
    caller: "verify",
  });
  if (config.decisionsFile !== null && mainText !== null) {
    const file = config.decisionsFile;
    // union のマージで欠けた見出しの前の空行を戻す
    if (await fixDecisionsBlankLines(ctx.runner, root, file, mainText, id)) {
      if (!ctx.json)
        ctx.stdout(
          `${file} の見出しの前の空行を戻してコミットしました（${id}: マージで欠けた決定の記録の空行を戻す）`,
        );
    }
  }

  // 枝で取り込んだ共通が、push のあとに進んでいないか（警告だけ。終了コードは変えない）
  try {
    const record = await readCrossDepends(ctx.runner, root, id);
    for (const warning of await staleBranchWarnings(
      ctx.runner,
      root,
      record?.repos ?? [],
    ))
      ctx.stderr(`警告：${warning}`);
  } catch {
    // 記録が読めなくても verify は止めない（門が止める）
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
