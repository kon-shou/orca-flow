import { loadFlowConfig } from "../lib/flow-config.ts";
import { requireRoot } from "../lib/git.ts";
import { FlowError, type Command } from "../types.ts";

/** 既定値を埋めた設定を出す */
export const run: Command = async (ctx) => {
  if (ctx.argv.length > 0)
    throw new FlowError(1, `知らない引数です：${ctx.argv.join(" ")}`);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const loaded = await loadFlowConfig(ctx.runner, root);
  if (!loaded.exists)
    throw new FlowError(
      2,
      "このリポジトリには orca-flow の設定がありません。メインのチェックアウトのタブで /orca-flow:init を流してください",
    );
  if (!ctx.json) ctx.stdout(JSON.stringify(loaded.config, null, 2));
  return { code: 0, data: loaded.config };
};
