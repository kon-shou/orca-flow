import { requireFlowConfig } from "../lib/flow-config.ts";
import { parseArgs } from "../lib/args.ts";
import { activeTasks, isMainWorktree, requireRoot } from "../lib/git.ts";
import {
  addChain,
  readMergeOrder,
  removeId,
  chainOf,
  withOrderLock,
  writeMergeOrder,
  type MergeOrder,
} from "../lib/merge-order.ts";
import { idFromTaskFile } from "../lib/task-id.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE =
  "使い方：orca-flow order [〈ID〉,〈ID〉,…] [--remove 〈ID〉] [--clear]";

const NOT_MAIN =
  "ここはタスクの worktree です。マージの順を変えるのは、メインのチェックアウト（統括役のタブ）で呼んでください";

const chainLine = (chain: MergeOrder["chains"][number]) =>
  chain.map((i) => (i.integrated ? `${i.id}（統合済み）` : i.id)).join(" → ");

/** 自動で足した項目の行（overlap がつけた印）。なければ空 */
export const autoLines = (chain: MergeOrder["chains"][number]): string[] =>
  chain.flatMap((i) =>
    i.auto
      ? [
          i.auto.by && i.auto.by !== i.id
            ? `自動で足した（${i.id}。${i.auto.by} の overlap・${i.auto.at}）`
            : `自動で足した（${i.id} の overlap・${i.auto.at}）`,
        ]
      : [],
  );

/** マージの順を決める・見る・消す（8章 order）。足す・外す・消すはメインの作業ツリーでだけ */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["remove"], ["clear"]);
  const remove = args.values.get("remove");
  const clear = args.flags.has("clear");
  const [list, ...rest] = args.positionals;
  const modes = [list !== undefined, remove !== undefined, clear].filter(
    Boolean,
  ).length;
  if (rest.length > 0 || modes > 1) throw new FlowError(1, USAGE);

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);

  // --clear は壊れたファイルの直し方なので、読まずに消す
  if (clear) {
    if (!(await isMainWorktree(ctx.runner, root)))
      throw new FlowError(2, NOT_MAIN);
    await withOrderLock(ctx.runner, root, () =>
      writeMergeOrder(ctx.runner, root, { chains: [] }),
    );
    if (!ctx.json) ctx.stdout("マージの順を全部消しました");
    return { code: 0, data: { chains: [] } };
  }

  if (modes === 0) {
    const order = await readMergeOrder(ctx.runner, root);
    if (!ctx.json)
      ctx.stdout(
        order.chains.length === 0
          ? "マージの順はありません"
          : order.chains
              .map((chain) =>
                [
                  chainLine(chain),
                  ...autoLines(chain).map((l) => `  ${l}`),
                ].join("\n"),
              )
              .join("\n"),
      );
    return { code: 0, data: order };
  }

  if (!(await isMainWorktree(ctx.runner, root)))
    throw new FlowError(2, NOT_MAIN);

  // 読んで書くあいだは、ほかの orca-flow（overlap・integrate）に書かせない
  return withOrderLock(ctx.runner, root, async () => {
    const order = await readMergeOrder(ctx.runner, root);
    if (remove !== undefined) {
      if (!chainOf(order, remove))
        throw new FlowError(1, `${remove} はマージの順にありません`);
      const next = removeId(order, remove);
      await writeMergeOrder(ctx.runner, root, next);
      if (!ctx.json) ctx.stdout(`${remove} をマージの順から外しました`);
      return { code: 0, data: next };
    }

    const ids = list!.split(",").map((s) => s.trim());
    const bad = ids.find(
      (id) => idFromTaskFile(`${id}.md`, config.idPrefix) !== id,
    );
    if (bad !== undefined)
      throw new FlowError(
        1,
        `ID は「${config.idPrefix}」と数（例：${config.idPrefix}12）にしてください：${bad || "（空）"}`,
      );
    const result = addChain(order, ids);
    if (!result.ok) throw new FlowError(1, result.message);
    const active = (await activeTasks(ctx.runner, root, config)).map(
      (t) => t.id,
    );
    // 今ある鎖で統合済みの ID は、作業中でなくてよい
    const integrated = new Set(
      order.chains
        .flat()
        .filter((i) => i.integrated)
        .map((i) => i.id),
    );
    const missing = ids.filter(
      (id) => !active.includes(id) && !integrated.has(id),
    );
    if (missing.length > 0)
      throw new FlowError(
        1,
        `作業中のタスクではありません：${missing.join("、")}`,
      );
    await writeMergeOrder(ctx.runner, root, result.order);
    if (!ctx.json)
      ctx.stdout(
        `マージの順を${result.replaced ? "置き換えました" : "足しました"}：${ids.join(" → ")}`,
      );
    return { code: 0, data: result.order };
  });
};
