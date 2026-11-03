import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { mainWorktreePath, requireRoot } from "../lib/git.ts";
import { taskMergedInto, type MergedBy } from "../lib/merged.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE = "使い方：orca-flow merged 〈ID〉… [--ref 〈ref〉] [--json]";

const BY_LABEL: Record<MergedBy, string> = {
  subject: "件名の行",
  "push-record": "push の記録",
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 依存のタスクが ref（既定は baseBranch）に入ったかを答える（10.1）。どの作業ツリーから流しても同じ答え */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["ref"]);
  const ids = args.positionals;
  if (ids.length === 0) throw new FlowError(1, USAGE);

  const cwdRoot = await requireRoot(ctx.runner, ctx.cwd);
  // 設定は、タスクの worktree からでもメインの作業ツリーのものを読む
  const root = await mainWorktreePath(ctx.runner, cwdRoot);
  const config = await requireConfig(root);

  const shape = new RegExp(`^${escapeRegExp(config.idPrefix)}\\d+[A-Za-z]*$`);
  const bad = ids.filter((id) => !shape.test(id));
  if (bad.length > 0)
    throw new FlowError(
      1,
      `ID の形が違います：${bad.join("、")}（${config.idPrefix} と数字の形で書いてください）。${USAGE}`,
    );

  const ref = args.values.get("ref") ?? config.baseBranch;
  const results = [];
  for (const id of ids) {
    const found = await taskMergedInto(ctx.runner, root, config, id, ref);
    results.push({ id, merged: found.merged, by: found.by });
  }
  if (!ctx.json)
    for (const r of results)
      ctx.stdout(
        r.by
          ? `${r.id}：${ref} に入っています（${BY_LABEL[r.by]}）`
          : `${r.id}：${ref} に入っていません`,
      );
  return {
    code: results.every((r) => r.merged) ? 0 : 1,
    data: { ref, results },
  };
};
