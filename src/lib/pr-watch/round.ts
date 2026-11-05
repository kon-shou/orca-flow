import { readdir } from "node:fs/promises";
import path from "node:path";
import { requireConfig, type FlowConfig } from "../../config.ts";
import {
  FlowError,
  type CommandContext,
  type CommandResult,
} from "../../types.ts";
import { launchBackground } from "../background.ts";
import { readPushRecord, type PushRecord } from "../finish.ts";
import {
  fetchOpenTaskPrs,
  fetchPrDetails,
  readRateLimit,
  readRepoName,
  RateLimitedError,
  type PrDetail,
  type ReadContext,
  type Stage1Pr,
} from "../github-read.ts";
import { envSecrets, redactSecrets } from "../github.ts";
import { gitCommonDir } from "../git.ts";
import { inSendWindow } from "../send-guard.ts";
import { readItems } from "../outbox.ts";
import { CARD_RESET } from "../pr-finish.ts";
import { hasIdShape, idFromBranch } from "../task-id.ts";
import {
  classifyDetail,
  countUnresolvedThreads,
  hasEvents,
  judgeAllOk,
} from "./classify.ts";
import { hasPendingWake } from "./wake.ts";
import {
  appendUsage,
  pruneUsage,
  readState,
  tryLock,
  updateState,
  watchDir,
} from "./store.ts";
import {
  NO_COUNTS,
  type Counts,
  type PrEntry,
  type RunResult,
  type UsageLine,
  type WatchFile,
  type WorkItem,
} from "./types.ts";

// 見張りの1回（precheck の入口）。問い合わせと記録だけをして、いつも0以外で終わる。
// カードの更新・マージの後始末・下書きの解除・送る関数は、ここでは呼ばない（背景の仕事に渡す）。
// precheck には時間切れ（既定60秒）があり、重い仕事が途中で切られて半端に止まらないようにするため。

/** 2段目に入れる PR の上限。あふれた分は次の回に回す */
export const MAX_STAGE2 = 20;
/** 上限の印で、戻る時刻が分からないときに待つ長さ */
const RATE_LIMIT_WAIT_MS = 10 * 60_000;
/** マージ・クローズのあとの項目を記録に残す日数 */
const KEEP_FINAL_DAYS = 30;
/** 使った回数の記録を残す日数 */
const KEEP_USAGE_DAYS = 30;
/** 回の全体の締め切り（precheck の既定の時間切れ60秒より短く） */
export const ROUND_DEADLINE_MS = 45_000;

interface Outcome {
  result: RunResult;
  reason: string | null;
  calls: number;
  cost: number;
  remaining: number | null;
  moved: number;
  deferred: number;
  launched: boolean;
  until?: string;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** 1段目と前回を比べて、動いたか（更新の時刻・先頭・CI の要約・下書きのどれかが違う） */
export function isMoved(entry: PrEntry | undefined, s: Stage1Pr): boolean {
  if (!entry || entry.final !== null) return true;
  return (
    entry.updatedAt !== s.updatedAt ||
    entry.head !== s.head ||
    entry.ci !== s.ci ||
    entry.isDraft !== s.isDraft
  );
}

async function recordOnlyPrs(
  ctx: CommandContext,
  root: string,
  common: string,
  config: FlowConfig,
  state: WatchFile,
  open: ReadonlyMap<number, Stage1Pr>,
): Promise<{ number: number; id: string; branch: string; url: string }[]> {
  let files: string[] = [];
  try {
    files = await readdir(path.join(common, "orca-flow", "push"));
  } catch {
    return [];
  }
  const found: { number: number; id: string; branch: string; url: string }[] =
    [];
  for (const file of files.sort()) {
    const id = /^(.+)\.json$/.exec(file)?.[1];
    if (!id || !hasIdShape(id)) continue;
    const record = await readPushRecord(ctx.runner, root, id);
    if (!record?.pr) continue;
    const status = (record.watch as { status?: unknown } | undefined)?.status;
    if (
      record.mergeCommit ||
      status === "merged" ||
      status === "closed" ||
      // 後始末が上限で止まった PR：30日で項が消えても、急に後始末を走らせない（push の打ち直しだけがやり直し）
      status === "cleanup-stopped" ||
      !record.branch.startsWith(config.branchPrefix)
    )
      continue;
    const n = record.pr.number;
    if (open.has(n) || state.prs[String(n)] !== undefined) continue;
    found.push({ number: n, id, branch: record.branch, url: record.pr.url });
  }
  return found;
}

/** 自分が送った先頭（push の記録の先頭と、送った案の先頭）。ここへの先頭の変化は動きに数えない */
async function ownHeadsOf(
  common: string,
  taskId: string,
  record: PushRecord | null,
): Promise<Set<string>> {
  const heads = new Set<string>();
  if (record?.pushedHead) heads.add(record.pushedHead);
  try {
    for (const item of await readItems(common, taskId)) {
      if (
        (item.kind === "push" || item.kind === "pr-create") &&
        ["sent", "sending", "uncertain"].includes(item.state)
      )
        heads.add(item.approvedHead ?? item.head);
    }
  } catch {
    // 案がなければ記録の先頭だけ
  }
  return heads;
}

/** 前回、解除を断られたときと同じ先頭・CI か（同じなら立て直さない） */
const sameStop = (
  stop: PrEntry["releaseStop"],
  head: string | null,
  ci: PrEntry["ci"],
) => !!stop && stop.head === head && stop.ci === ci;

async function hasApprovedRelease(
  common: string,
  taskId: string,
): Promise<boolean> {
  try {
    return (await readItems(common, taskId)).some(
      (i) => i.kind === "pr-ready" && i.state === "ci-wait",
    );
  } catch {
    return false;
  }
}

/** 記録に足す変更（問い合わせのあと、ロックの中で重ねる） */
interface Patch {
  viewer: string;
  entries: Map<number, PrEntry>;
  work: WorkItem[];
}

function newEntry(
  n: number,
  over: Partial<PrEntry> & Pick<PrEntry, "branch">,
): PrEntry {
  return {
    number: n,
    url: "",
    taskId: null,
    updatedAt: null,
    head: null,
    ci: null,
    isDraft: null,
    seen: null,
    baseline: false,
    releasePending: false,
    final: null,
    finalAt: null,
    ...over,
  };
}

function workItem(
  entry: PrEntry,
  over: Partial<WorkItem>,
  now: Date,
): WorkItem {
  return {
    number: entry.number,
    url: entry.url,
    taskId: entry.taskId ?? "",
    branch: entry.branch,
    rev: 1,
    counts: { ...NO_COUNTS },
    ciChanged: false,
    ci: entry.ci,
    isDraft: entry.isDraft,
    head: entry.head,
    release: false,
    refresh: false,
    allOk: entry.allOk === true,
    end: null,
    mergeCommit: null,
    mergedAt: null,
    at: now.toISOString(),
    since: now.toISOString(),
    tries: 0,
    ...over,
  };
}

const addCounts = (a: Counts, b: Counts): Counts => ({
  review: a.review + b.review,
  comment: a.comment + b.comment,
  resolved: a.resolved + b.resolved,
  push: a.push + b.push,
  ...((a.quiet ?? 0) + (b.quiet ?? 0) > 0
    ? { quiet: (a.quiet ?? 0) + (b.quiet ?? 0) }
    : {}),
});

/** すでにある仕事（背景がまだ済ませていない）に重ねる */
function mergeWork(before: WorkItem | undefined, next: WorkItem): WorkItem {
  if (!before) return next;
  return {
    ...next,
    rev: before.rev + 1,
    counts: addCounts(before.counts, next.counts),
    ciChanged: before.ciChanged || next.ciChanged,
    release: before.release || next.release,
    refresh: before.refresh || next.refresh,
    end: next.end ?? before.end,
    mergeCommit: next.mergeCommit ?? before.mergeCommit,
    mergedAt: next.mergedAt ?? before.mergedAt,
    since: before.since ?? before.at,
    tries: before.tries ?? 0,
  };
}

function applyPatch(state: WatchFile, patch: Patch, now: Date): boolean {
  state.viewer = patch.viewer;
  state.initialized = true;
  for (const [n, entry] of patch.entries) {
    state.prs[String(n)] = entry;
    // マージかクローズになった PR の待ちの起こしは捨てる
    if (entry.final !== null) delete state.wakes[String(n)];
  }
  for (const item of patch.work)
    state.work[String(item.number)] = mergeWork(
      state.work[String(item.number)],
      item,
    );
  const cutoff = now.getTime() - KEEP_FINAL_DAYS * 86_400_000;
  for (const [key, entry] of Object.entries(state.prs))
    if (
      entry.final !== null &&
      entry.finalAt !== null &&
      Date.parse(entry.finalAt) < cutoff
    )
      delete state.prs[key];
  // 仕事がある、または待ちの起こしが残っていれば、背景を起こす
  return Object.keys(state.work).length > 0 || hasPendingWake(state);
}

const newOutcome = (): Outcome => ({
  result: "success",
  reason: null,
  calls: 0,
  cost: 0,
  remaining: null,
  moved: 0,
  deferred: 0,
  launched: false,
});

/** 見張りの1回の中身。回数と点数は out に足していくので、途中で落ちても1段目の分が残る */
async function execute(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  dir: string,
  common: string,
  out: Outcome,
  deadline: number,
): Promise<void> {
  const now = ctx.now();
  const state = await readState(dir);
  if (
    state.rateLimitedUntil !== null &&
    Date.parse(state.rateLimitedUntil) > now.getTime()
  ) {
    out.result = "skipped";
    out.reason = `GitHub の上限の印のため、${state.rateLimitedUntil} まで問い合わせません`;
    return;
  }

  const g: ReadContext = {
    runner: ctx.runner,
    cwd: root,
    env: ctx.env,
    timeLeftMs: () => deadline - ctx.now().getTime(),
  };
  const overtime = () =>
    deadline - ctx.now().getTime() <= 0
      ? new FlowError(
          1,
          `見張りの回が締め切り（${ROUND_DEADLINE_MS / 1000}秒）を超えたため、時間切れで止めました。次の回にやり直します`,
        )
      : null;
  try {
    const limit = await readRateLimit(g);
    if (limit.remaining < config.prWatch.minRemaining) {
      out.result = "skipped";
      out.remaining = limit.remaining;
      out.reason = `GraphQL の残り（${limit.remaining}）が prWatch.minRemaining（${config.prWatch.minRemaining}）を切っているため飛ばしました`;
      return;
    }
    const repo = await readRepoName(ctx.runner, root);
    const s1 = await fetchOpenTaskPrs(g, repo, config.branchPrefix);
    out.calls += s1.calls;
    out.cost += s1.cost;
    out.remaining = s1.remaining;
    const late = overtime();
    if (late) throw late;
    const open = new Map(s1.prs.map((p) => [p.number, p]));
    const baseline = !state.initialized;

    // 2段目に入れる PR：消えた PR・記録の番号だけの PR（先）→ 動いた PR
    const vanished = Object.values(state.prs)
      .filter((e) => e.final === null && !open.has(e.number))
      .map((e) => e.number);
    const recordOnly = await recordOnlyPrs(
      ctx,
      root,
      common,
      config,
      state,
      open,
    );
    // ID の形でないブランチ（task/fix-typo）の PR は、タスクの PR ではない：2段目に入れない
    const isTask = (p: Stage1Pr) =>
      idFromBranch(p.branch, config.branchPrefix, config.idPrefix) !== null;
    const movedNow = s1.prs
      .filter((p) => isTask(p) && isMoved(state.prs[String(p.number)], p))
      .map((p) => p.number);
    const ordered = [
      ...new Set([
        ...vanished,
        ...recordOnly.map((r) => r.number),
        ...movedNow,
      ]),
    ];
    const picked = ordered.slice(0, MAX_STAGE2);
    // 次の回に回した PR：前回の値のままにして、解除の仕事も立てない
    const deferredSet = new Set(ordered.slice(MAX_STAGE2));
    out.moved = picked.length;
    out.deferred = ordered.length - picked.length;

    const patch: Patch = { viewer: s1.viewer, entries: new Map(), work: [] };
    const recordInfo = new Map(recordOnly.map((r) => [r.number, r]));

    // 初めての回は、見えている PR の最初の中身を動きに数えない（次の回に回した PR も同じ）
    if (baseline)
      for (const p of s1.prs)
        if (!state.prs[String(p.number)] && isTask(p))
          patch.entries.set(
            p.number,
            newEntry(p.number, {
              branch: p.branch,
              url: p.url,
              taskId: idFromBranch(
                p.branch,
                config.branchPrefix,
                config.idPrefix,
              ),
              baseline: true,
            }),
          );

    let details = new Map<number, PrDetail>();
    if (picked.length > 0) {
      // めくる問い合わせが投げても、それまでに通った分の回数と点数は記録に残す
      const used = { calls: 0, cost: 0 };
      try {
        const s2 = await fetchPrDetails(g, repo, picked, used);
        details = s2.details;
        out.remaining = s2.remaining ?? out.remaining;
      } finally {
        out.calls += used.calls;
        out.cost += used.cost;
      }
    }
    const inWindow = inSendWindow(now, config.outbound.window);

    const stamp = now.toISOString();
    for (const n of picked) {
      const detail = details.get(n);
      const prev = patch.entries.get(n) ?? state.prs[String(n)];
      const info = recordInfo.get(n);
      const branch = detail?.branch || prev?.branch || info?.branch || "";
      const taskId =
        prev?.taskId ??
        info?.id ??
        idFromBranch(branch, config.branchPrefix, config.idPrefix);
      const url = detail?.url || prev?.url || info?.url || "";
      const entry = newEntry(n, { ...prev, branch, url, taskId });
      if (!detail || taskId === null) {
        patch.entries.set(n, { ...entry, final: "gone", finalAt: stamp });
        continue;
      }
      if (detail.state !== "open") {
        const record = await readPushRecord(ctx.runner, root, taskId);
        const done = detail.state === "merged" && !!record?.mergeCommit;
        const end = detail.state === "merged" ? "merged" : "closed";
        patch.entries.set(n, {
          ...entry,
          head: detail.head,
          updatedAt: detail.updatedAt,
          final: end,
          finalAt: stamp,
          releasePending: false,
        });
        // 後始末が済んだ PR（push の記録に mergeCommit がある）は、二重に後始末しない
        if (!done)
          patch.work.push(
            workItem(
              entry,
              {
                end,
                mergeCommit: detail.mergeCommit,
                mergedAt: detail.mergedAt,
                head: detail.head,
              },
              now,
            ),
          );
        continue;
      }
      const record = await readPushRecord(ctx.runner, root, taskId);
      const classified = classifyDetail({
        viewer: s1.viewer,
        prev,
        detail,
        ownHeads: await ownHeadsOf(common, taskId, record),
      });
      const suppress = prev?.baseline === true;
      const counts = suppress ? { ...NO_COUNTS } : classified.counts;
      const ciChanged = suppress ? false : classified.ciChanged;
      const wantsRelease =
        config.prReady === "after-ci" &&
        detail.isDraft &&
        detail.ci === "passed";
      const stopped = sameStop(prev?.releaseStop, detail.head, detail.ci);
      // 全員 OK の判定（merge と同じ judgeAllOk）。変わった回は、動きの件数が0でもカードを書き直す
      const threadCount = countUnresolvedThreads(detail);
      const allOk = judgeAllOk({
        reviewDecision: detail.reviewDecision,
        mergeStateStatus: detail.mergeStateStatus,
        isDraft: detail.isDraft,
        unresolvedThreads: threadCount.unresolved,
        threadsTruncated: threadCount.truncated,
        threadTotal: threadCount.total,
      }).ok;
      const judgeChanged = allOk !== (prev?.allOk === true);
      const next: PrEntry = {
        ...entry,
        final: null,
        finalAt: null,
        updatedAt: detail.updatedAt,
        head: detail.head,
        ci: detail.ci,
        isDraft: detail.isDraft,
        seen: classified.seen,
        baseline: false,
        releasePending: wantsRelease && !stopped,
        releaseStop: stopped ? prev?.releaseStop : null,
        allOk,
      };
      patch.entries.set(n, next);
      // 断られた直後・時間帯の外では立てない（背景が毎回起きないように）
      const release =
        next.releasePending &&
        inWindow &&
        (await hasApprovedRelease(common, taskId));
      if (hasEvents(counts) || ciChanged || release || judgeChanged)
        patch.work.push(
          workItem(
            next,
            {
              counts,
              ciChanged,
              ci: detail.ci,
              release,
              refresh: judgeChanged,
            },
            now,
          ),
        );
    }

    // 動いていない PR：CI がなく下書きのまま2回続けて見えたら（約1間隔）、下書きの解除の対象にする。
    // 解除を待っている PR と、send が置いた書き直しの印のある PR も、ここで拾う
    for (const p of s1.prs) {
      if (picked.includes(p.number) || deferredSet.has(p.number)) continue;
      const entry = patch.entries.get(p.number) ?? state.prs[String(p.number)];
      if (!entry || entry.final !== null || entry.taskId === null) continue;
      if (entry.updatedAt === null) continue;
      const wantsRelease =
        config.prReady === "after-ci" &&
        entry.isDraft === true &&
        (entry.ci === "passed" || entry.ci === "none") &&
        !sameStop(entry.releaseStop, entry.head, entry.ci);
      const release =
        wantsRelease &&
        inWindow &&
        (await hasApprovedRelease(common, entry.taskId));
      const record = await readPushRecord(ctx.runner, root, entry.taskId);
      const refresh =
        (record?.watch as { reason?: unknown } | undefined)?.reason ===
        CARD_RESET;
      if (wantsRelease !== entry.releasePending)
        patch.entries.set(p.number, { ...entry, releasePending: wantsRelease });
      if (release || refresh)
        patch.work.push(workItem(entry, { release, refresh }, now));
    }

    const pending = await updateState(dir, (st) => applyPatch(st, patch, now));
    if (pending) {
      await launchBackground(
        ctx.runner,
        {
          cwd: root,
          log: path.join(dir, "background.log"),
          args: ["pr-watch", "background", "--root", root],
          failure: (reason) =>
            `背景の仕事を起動できませんでした：${reason}。次の回に起こし直します`,
        },
        (t) => redactSecrets(t, envSecrets(ctx.env)),
      );
      out.launched = true;
    }
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
    // 戻る時刻まで問い合わせない（残りの確認は回数に数えない）
    let until = new Date(now.getTime() + RATE_LIMIT_WAIT_MS);
    try {
      const limit = await readRateLimit(g);
      if (limit.remaining <= 0 && Date.parse(limit.resetAt) > now.getTime())
        until = new Date(limit.resetAt);
    } catch {
      // 分からなければ既定の長さ
    }
    out.result = "rate-limited";
    out.reason = error.message;
    out.until = until.toISOString();
  }
}

/** 見張りの1回。結果は state.json と usage に記録し、いつも終了コード1（0以外）で終わる */
export async function runRound(
  ctx: CommandContext,
  root: string,
): Promise<CommandResult> {
  const dir = await watchDir(ctx.runner, root);
  const redact = (t: string) => redactSecrets(t, envSecrets(ctx.env));
  const at = ctx.now().toISOString();
  const deadline = ctx.now().getTime() + ROUND_DEADLINE_MS;
  const outcome = newOutcome();
  let lock: { release: () => Promise<void> } | null = null;
  try {
    const config = await requireConfig(root);
    const common = await gitCommonDir(ctx.runner, root);
    lock = await tryLock(dir, "round.lock", "round");
    if (!lock) {
      outcome.result = "skipped";
      outcome.reason = "ほかの見張りの回が動いているため飛ばしました";
    } else {
      await execute(ctx, root, config, dir, common, outcome, deadline);
    }
  } catch (error) {
    outcome.result = "failed";
    outcome.reason = redact(message(error));
  } finally {
    await lock?.release().catch(() => {});
  }

  const line: UsageLine = {
    at,
    result: outcome.result,
    reason: outcome.reason,
    calls: outcome.calls,
    cost: outcome.cost,
    remaining: outcome.remaining,
    moved: outcome.moved,
    deferred: outcome.deferred,
    launched: outcome.launched,
  };
  try {
    await appendUsage(dir, line);
    await pruneUsage(dir, ctx.now(), KEEP_USAGE_DAYS);
    await updateState(dir, (st) => {
      st.lastRun = { at, result: outcome.result, reason: outcome.reason };
      if (outcome.result === "success") st.lastSuccessAt = at;
      if (outcome.result === "failed" || outcome.result === "rate-limited")
        st.lastFailure = st.lastRun;
      if (outcome.result === "rate-limited" && outcome.until)
        st.rateLimitedUntil = outcome.until;
      else if (
        st.rateLimitedUntil !== null &&
        Date.parse(st.rateLimitedUntil) <= ctx.now().getTime()
      )
        st.rateLimitedUntil = null;
    });
  } catch (error) {
    ctx.stderr(
      `警告：見張りの記録を書けませんでした（${redact(message(error))}）`,
    );
  }
  if (!ctx.json)
    ctx.stdout(
      `見張り：${outcome.result}${outcome.reason ? `（${outcome.reason}）` : ""}`,
    );
  // precheck はいつも0以外で終わる（Orca がその回の会話を立てないため）。成否は pr-watch usage で見る
  return { code: 1, data: { ...line } };
}
