import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { currentBranch, requireRoot, runGit } from "../lib/git.ts";
import {
  differences,
  ownChange,
  ownChangeExclude,
  writeReviewed,
  type FileDifference,
} from "../lib/rebase-review.ts";
import { reportPath, taskDocPath } from "../lib/tasks.ts";
import { idFromBranch } from "../lib/task-id.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE =
  "使い方：orca-flow rebase-review 〈rebase の前のコミット〉 | orca-flow rebase-review --done";

const show = (d: FileDifference) =>
  [
    `${d.file}${d.reordered ? "（行の集まりは同じで、並びだけが変わりました）" : ""}`,
    ...d.onlyBefore.map((l) => `  前にだけ：${l}`),
    ...d.onlyNow.map((l) => `  今にだけ：${l}`),
  ].join("\n");

/** タスク長が rebase のあとに流す：タスク自身の変更が変わっていないかを確かめ、見直しの記録を書く（8章 rebase-review） */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, [], ["done"]);
  const done = args.flags.has("done");
  const [previous, ...rest] = args.positionals;
  if (rest.length > 0 || (done ? previous !== undefined : !previous))
    throw new FlowError(1, USAGE);

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

  const exclude = ownChangeExclude(
    config,
    taskDocPath(config, id),
    reportPath(config, id),
  );
  const head = (
    await runGit(ctx.runner, root, ["rev-parse", "HEAD"], "git rev-parse")
  ).trim();
  const now = await ownChange(
    ctx.runner,
    root,
    config.baseBranch,
    head,
    exclude,
  );
  const record = async () => {
    await writeReviewed(ctx.runner, root, {
      id,
      head,
      fingerprint: now.fingerprint,
      at: ctx.now().toISOString(),
    });
  };

  if (done) {
    await record();
    if (!ctx.json)
      ctx.stdout(
        `${id} の見直しを記録しました（タスク自身の変更の指紋 ${now.fingerprint.slice(0, 12)}）`,
      );
    return {
      code: 0,
      data: { id, head, fingerprint: now.fingerprint, recorded: true },
    };
  }

  const resolved = await ctx.runner(
    "git",
    ["rev-parse", "--verify", "--quiet", `${previous}^{commit}`],
    { cwd: root },
  );
  if (resolved.code !== 0)
    throw new FlowError(1, `コミット ${previous} が見つかりません`);
  const before = await ownChange(
    ctx.runner,
    root,
    config.baseBranch,
    resolved.stdout.trim(),
    exclude,
  );

  if (before.fingerprint === now.fingerprint) {
    await record();
    if (!ctx.json)
      ctx.stdout(
        `${id} のタスク自身の変更は rebase の前と同じです。見直しを記録しました`,
      );
    return {
      code: 0,
      data: {
        id,
        same: true,
        head,
        fingerprint: now.fingerprint,
        recorded: true,
        files: [],
      },
    };
  }

  const files = differences(before.change, now.change);
  if (!ctx.json)
    ctx.stdout(
      `${id} のタスク自身の変更が rebase で変わりました（記録は書いていません）。変わったところ：\n${files.map(show).join("\n")}`,
    );
  return {
    code: 1,
    data: {
      id,
      same: false,
      head,
      fingerprint: now.fingerprint,
      previousFingerprint: before.fingerprint,
      recorded: false,
      files,
    },
  };
};
