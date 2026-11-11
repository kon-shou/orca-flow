import { requireFlowConfig } from "../lib/flow-config.ts";
import { planAppBump, type AppBumpItem } from "../lib/app-bump.ts";
import { parseArgs } from "../lib/args.ts";
import {
  mainWorktreePath,
  requireActiveTask,
  requireRoot,
} from "../lib/git.ts";
import { isTaskIdShape } from "../lib/task-id.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE = "使い方：orca-flow app-bump 〈ID〉 [--json]";

const LABEL: Record<AppBumpItem["verdict"], string> = {
  bump: "版を上げる",
  reimport: "取り込み直す",
  wait: "待つ",
  done: "済んだ",
};

/**
 * アプリのタスクの、共通の版が出たか・共通の枝の取り込み直しが要るかを答える（読むだけ。何も書かない）。
 * タスクの worktree からでも統括役の場所からでも同じ答え。記録がなければ「記録なし」で終了コード0
 */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, []);
  const [id, ...extra] = args.positionals;
  if (id === undefined || extra.length > 0) throw new FlowError(1, USAGE);

  const cwdRoot = await requireRoot(ctx.runner, ctx.cwd);
  const root = await mainWorktreePath(ctx.runner, cwdRoot);
  const config = await requireFlowConfig(ctx.runner, root);
  if (!isTaskIdShape(id, config.idPrefix))
    throw new FlowError(
      1,
      `ID の形が違います：${id}（${config.idPrefix} と数字の形で書いてください）。${USAGE}`,
    );

  const task = await requireActiveTask(ctx.runner, root, config, id);
  const items = await planAppBump(ctx.runner, root, id, task.branch, {
    env: ctx.env,
  });
  if (items === null) {
    if (!ctx.json)
      ctx.stdout(`${id}：記録なし（またぐ依存の記録がありません）`);
    return {
      code: 0,
      data: { id, branch: task.branch, record: false, items: [] },
    };
  }
  if (!ctx.json) {
    if (items.length === 0) ctx.stdout(`${id}：枝で取り込む共通はありません`);
    for (const i of items)
      ctx.stdout(
        `${i.name}（${i.branch}）：${LABEL[i.verdict]}${i.version ? ` ${i.version}` : ""} — ${i.reason}`,
      );
  }
  return { code: 0, data: { id, branch: task.branch, record: true, items } };
};
