import { parseArgs } from "../lib/args.ts";
import { mainWorktreePath, requireRoot } from "../lib/git.ts";
import { DEFAULT_CONFIG, requireConfig } from "../config.ts";
import { runBackground } from "../lib/pr-watch/background.ts";
import { runRound } from "../lib/pr-watch/round.ts";
import { runUsage } from "../lib/pr-watch/usage.ts";
import {
  installWatchAutomation,
  removeWatchAutomation,
} from "../lib/watch-automation.ts";
import { FlowError, type Command } from "../types.ts";

/**
 * pr-watch
 *   （なし）  見張りの1回（automation の precheck が流す。いつも0以外で終わる）
 *   background  背景の仕事（precheck が起こす。使い方には出さない）
 *   usage / install / uninstall
 * --root 〈パス〉：メインの作業ツリー。precheck は作業の場所が分からないので、automation の文が渡す
 */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["root"]);
  const [sub, ...extra] = args.positionals;
  if (extra.length > 0)
    throw new FlowError(1, `余分な引数です：${extra.join(" ")}`);
  const from = args.values.get("root") ?? ctx.cwd;
  // タスクの worktree の中で打っても、メインの作業ツリーを見る（install・uninstall と同じ）
  const root = await mainWorktreePath(
    ctx.runner,
    await requireRoot(ctx.runner, from),
  );

  switch (sub) {
    case undefined:
      return runRound(ctx, root);
    case "background":
      return runBackground(ctx, root);
    case "usage":
      return runUsage(
        ctx,
        root,
        (await requireConfig(root).catch(() => DEFAULT_CONFIG)).prWatch
          .intervalMinutes,
      );
    case "install": {
      const config = await requireConfig(root);
      const done = await installWatchAutomation(ctx.runner, {
        root,
        intervalMinutes: config.prWatch.intervalMinutes,
      });
      if (!ctx.json)
        ctx.stdout(
          done.action === "created"
            ? "見張りの automation を作りました"
            : "見張りの automation の中身を今のものに直しました",
        );
      return { code: 0, data: done };
    }
    case "uninstall": {
      const done = await removeWatchAutomation(ctx.runner, root);
      if (!ctx.json)
        ctx.stdout(
          done.id === null
            ? "見張りの automation はありません"
            : "見張りの automation を消しました",
        );
      return { code: 0, data: done };
    }
    default:
      throw new FlowError(
        1,
        `知らない使い方です：${sub}（orca-flow pr-watch [usage|install|uninstall]）`,
      );
  }
};
