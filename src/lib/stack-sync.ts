import type { FlowConfig } from "../config.ts";
import type { CommandContext } from "../types.ts";
import type { ActiveTask } from "./git.ts";
import { createOrca } from "./orca.ts";
import { isSafeStackBranch, stackTargetMerged } from "./stack.ts";
import { readStackAt } from "./stack-record.ts";
import {
  claimStackNotice,
  retryWarning,
  sendStackedQuietly,
  settleStackNotice,
} from "./stack-notice.ts";
import { readRecord } from "./verified.ts";

export { STACK_RETRY_ENV, STACK_RETRY_MS } from "./stack-notice.ts";

// 前の直しの見張り：待ち受けの見直しのたび、乗せたタスクの枝が乗せた先の verify の通った先頭を
// 含むまで「前の枝が進んだ」を送り直す。途中のコミットを取り込ませないため、枝の先頭ではなく verify の記録を見る

export interface StackSyncDeps {
  ctx: CommandContext;
  config: FlowConfig;
  /** メインの作業ツリー */
  root: string;
  common: string;
  now: Date;
  retryMs: number;
}

export interface StackSyncResult {
  sent: string[];
  failed: string[];
}

/**
 * 乗せたタスク ids のうち、乗せた先が作業中で、乗せた先の verify の記録の先頭を枝が含まず、
 * その先頭をまだ送れていない（ほかが送り中でもない）ものに「前の枝が進んだ」を送る。
 * 送れなかった先頭は retryMs を置いてから送り直し、警告は同じ先頭で最初の1回だけ出す。
 * active は同じ見直しで求めた作業中のタスク（見直しのたびに作業中の一覧を何度も求めないため）。
 * 1つ読めなくても、ほかは続ける（待ち受けを止めない）
 */
export async function syncStackNotices(
  deps: StackSyncDeps,
  ids: readonly string[],
  active: readonly ActiveTask[],
): Promise<StackSyncResult> {
  const { ctx, config, root, common, now } = deps;
  const result: StackSyncResult = { sent: [], failed: [] };
  if (ids.length === 0) return result;
  const tasks = new Map(active.map((t) => [t.id, t]));
  const orca = createOrca(ctx.runner, root);
  for (const id of ids) {
    try {
      const task = tasks.get(id);
      if (!task) continue;
      const record = await readStackAt(common, id);
      if (!record) continue;
      const on = record.on;
      // stackState の open と同じ見分け（乗せた先が作業中で、安全な枝の名前で、まだ入っていない）
      const onTask = tasks.get(on);
      if (!onTask || !isSafeStackBranch(config, on, onTask.branch)) continue;
      if (await stackTargetMerged(ctx.runner, root, config, on, record.branch))
        continue;
      const head = (await readRecord(ctx.runner, root, on))?.head;
      if (!head) continue;
      const contains = await ctx.runner(
        "git",
        ["merge-base", "--is-ancestor", head, task.branch],
        { cwd: root },
      );
      // 0：含む。1：含まない。それ以外（先頭が見つからないなど）は送らない
      if (contains.code !== 1) continue;
      const claim = await claimStackNotice(
        common,
        id,
        on,
        head,
        now,
        deps.retryMs,
      );
      if (claim.kind === "skip") continue;
      const outcome = await sendStackedQuietly(
        config,
        orca,
        task,
        on,
        "advanced",
      );
      await settleStackNotice(common, id, on, head, now, outcome.sent);
      if (outcome.sent) {
        result.sent.push(id);
        continue;
      }
      result.failed.push(id);
      if (claim.previous?.failedHead !== head)
        ctx.stderr(retryWarning(id, "advanced", outcome.reason));
    } catch {
      // 記録が壊れている・git が読めないときは、次の見直しで読み直す
    }
  }
  return result;
}
