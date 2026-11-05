import type { CommandContext, CommandResult } from "../../types.ts";
import { findWatchAutomation, watchStuckNote } from "../watch-automation.ts";
import { readState, readUsage, usageDates, watchDir } from "./store.ts";

/** 日ごとの集計に出す日数 */
const SHOW_DAYS = 3;

/** `orca-flow pr-watch usage`：回数・点数・最後に成功した時刻・失敗の理由 */
export async function runUsage(
  ctx: CommandContext,
  root: string,
  intervalMinutes: number,
): Promise<CommandResult> {
  const lookup = await findWatchAutomation(ctx.runner, root).catch(
    (error): Awaited<ReturnType<typeof findWatchAutomation>> => ({
      state: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  const stuck = await watchStuckNote(ctx.runner, root, lookup, intervalMinutes);
  const dir = await watchDir(ctx.runner, root);
  const state = await readState(dir);
  const dates = (await usageDates(dir)).slice(-SHOW_DAYS);
  const days = [];
  for (const date of dates) {
    const lines = await readUsage(dir, date);
    const count = (r: string) => lines.filter((l) => l.result === r).length;
    days.push({
      date,
      runs: lines.length,
      success: count("success"),
      skipped: count("skipped"),
      failed: count("failed"),
      rateLimited: count("rate-limited"),
      calls: lines.reduce((sum, l) => sum + l.calls, 0),
      cost: lines.reduce((sum, l) => sum + l.cost, 0),
    });
  }
  const data = {
    lastRun: state.lastRun,
    lastSuccessAt: state.lastSuccessAt,
    lastFailure: state.lastFailure,
    rateLimitedUntil: state.rateLimitedUntil,
    lastBackground: state.lastBackground,
    watching: Object.values(state.prs).filter((p) => p.final === null).length,
    pendingWork: Object.keys(state.work).length,
    days,
    automation: { state: lookup.state, stuck },
  };
  if (!ctx.json) {
    ctx.stdout(
      lookup.state === "found"
        ? "見張りの automation：あります"
        : lookup.state === "missing"
          ? "見張りの automation：ありません（orca-flow pr-watch install で作ってください）"
          : `見張りの automation：確かめられません（${lookup.reason}）`,
    );
    if (stuck) ctx.stdout(stuck);
    ctx.stdout(`最後に成功した回：${state.lastSuccessAt ?? "まだありません"}`);
    ctx.stdout(
      `直近の回：${state.lastRun ? `${state.lastRun.at} ${state.lastRun.result}${state.lastRun.reason ? `（${state.lastRun.reason}）` : ""}` : "まだありません"}`,
    );
    if (state.lastFailure)
      ctx.stdout(
        `最後の失敗：${state.lastFailure.at}（${state.lastFailure.reason ?? "理由なし"}）`,
      );
    if (state.rateLimitedUntil)
      ctx.stdout(`上限の印：${state.rateLimitedUntil} まで問い合わせません`);
    ctx.stdout(
      `見ている PR：${data.watching} 本、背景に渡した仕事：${data.pendingWork} 件${state.lastBackground ? `、背景の最後：${state.lastBackground.at}（${state.lastBackground.ok ? "済み" : (state.lastBackground.reason ?? "止まった")}）` : ""}`,
    );
    for (const d of days)
      ctx.stdout(
        `${d.date}：${d.runs} 回（成功 ${d.success}・飛ばした ${d.skipped}・失敗 ${d.failed}・上限の印 ${d.rateLimited}）、GraphQL ${d.calls} 回、${d.cost} 点`,
      );
    if (days.length === 0) ctx.stdout("使った回数の記録はまだありません");
  }
  return { code: 0, data };
}
