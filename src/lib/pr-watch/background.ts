import { requireFlowConfig } from "../flow-config.ts";
import { type FlowConfig } from "../../config.ts";
import type { CommandContext, CommandResult } from "../../types.ts";
import { findPushTask, readPushRecord } from "../finish.ts";
import {
  envSecrets,
  redactSecrets,
  type GhContext,
  type PrInfo,
} from "../github.ts";
import {
  STATUS_LABEL,
  cleanupHolderLabel,
  cleanupMergedPr,
  saveWatchState,
  type WatchStatus,
} from "../pr-finish.ts";
import { cardForPushWatch, createOrca, type CardUpdate } from "../orca.ts";
import { describeCounts, hasEvents } from "./classify.ts";
import { readState, tryLock, updateState, watchDir } from "./store.ts";
import type { WorkItem } from "./types.ts";
import {
  planBumpWakes,
  processBumpWakes,
  processWakes,
  registerWake,
  wakeWorthy,
} from "./wake.ts";

// 見張りの背景の仕事（`orca-flow pr-watch background`）。precheck が記録した仕事を、時間切れなしで済ませる：
// カード・一言・未読の印（他人の文章は入れず、件数と種類だけ）、マージの後始末、クローズの扱い。

/** 終わらない仕事のやり直しの上限：試した回数と、最初に積んでからの時間 */
export const MAX_TRIES = 12;
export const MAX_WORK_AGE_MS = 60 * 60_000;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Phase = Extract<WatchStatus, "ci-wait" | "review-wait" | "ci-failed">;

/** CI の結果から、カードの状態の頭 */
function phaseOf(item: WorkItem): Phase {
  if (item.ci === "failed") return "ci-failed";
  if (item.ci === "pending") return "ci-wait";
  return "review-wait";
}

/** 動いた PR のカード。状態・一言（件数と種類だけ）・未読の印 */
export function cardForWork(item: WorkItem): {
  card: CardUpdate;
  phase: Phase;
  detail: string | null;
} {
  const phase = phaseOf(item);
  const parts = describeCounts(item.counts);
  // 全員 OK の PR は「マージ待ち」（未読の印つき）。外れたら下の今までの印に戻る
  if (item.allOk === true && item.isDraft !== true)
    return {
      card: cardForPushWatch("merge-wait", item.number),
      phase,
      detail:
        parts.length > 0 ? `マージ待ち（${parts.join("・")}）` : "マージ待ち",
    };
  const base = cardForPushWatch(phase, item.number, {
    draft: phase === "review-wait" && item.isDraft === true,
  });
  if (!hasEvents(item.counts)) return { card: base, phase, detail: null };
  return {
    card: {
      workspaceStatus: base.workspaceStatus,
      comment: `${STATUS_LABEL[phase]}：PR #${item.number}（${parts.join("・")}）`,
      unread: true,
    },
    phase,
    detail: parts.join("・"),
  };
}

interface Handled {
  done: boolean;
  /**
   * カードの一言のその後。未指定：カードに触れていない。string：背景が書いた一言。
   * null：背景でなく別の処理がカードを書いた（待ちの理由を足す元がない）
   */
  comment?: string | null;
  note: string;
}

async function putCard(
  ctx: CommandContext,
  root: string,
  item: WorkItem,
  taskPath: string,
  update: CardUpdate,
): Promise<boolean> {
  try {
    await createOrca(ctx.runner, root).setCard(taskPath, update);
    return true;
  } catch (error) {
    ctx.stderr(
      `警告：${item.taskId} のカードを更新できませんでした（${redactSecrets(message(error), envSecrets(ctx.env))}）`,
    );
    return false;
  }
}

async function handle(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  g: GhContext,
  item: WorkItem,
): Promise<Handled> {
  const id = item.taskId;
  const record = await readPushRecord(ctx.runner, root, id);
  let task;
  try {
    task = await findPushTask(ctx.runner, root, config, id, record);
  } catch {
    // タスクがもうない（後始末が済んでいる）：することがない
    return {
      done: true,
      note: `${id} のタスクが見つかりません`,
    };
  }

  if (item.end === "merged") {
    // 後始末が済んだ PR（push の記録に mergeCommit がある）は二重に後始末しない
    if (record?.mergeCommit)
      return {
        done: true,
        note: `${id} は後始末が済んでいます`,
      };
    const pr: PrInfo = {
      number: item.number,
      url: item.url,
      isDraft: false,
      state: "merged",
      headSha: item.head,
      ci: item.ci ?? "passed",
      ...(item.mergeCommit ? { mergeCommit: item.mergeCommit } : {}),
      ...(item.mergedAt ? { mergedAt: item.mergedAt } : {}),
    };
    const out = await cleanupMergedPr(ctx, root, config, task, pr, {
      holdingWatchLock: false,
    });
    if (out.kind === "watching")
      return {
        done: false,
        note: `${id}：${cleanupHolderLabel(out.holderKind)}（プロセス ${out.pid ?? "不明"}）。後始末を待ちます`,
      };
    if (out.kind === "busy")
      return {
        done: false,
        note: `${id} は main が使用中なので後始末を待ちます`,
      };
    return {
      done: true,
      note: `${id} の PR #${item.number} をマージとして扱いました`,
    };
  }

  if (item.end === "closed") {
    // マージされずに閉じられた：対象から外し、人に回す（後始末はしない）
    if (record) await saveWatchState(ctx, root, id, "closed");
    const ok = await putCard(
      ctx,
      root,
      item,
      task.path,
      cardForPushWatch("closed", item.number),
    );
    return {
      done: ok,
      note: `${id} の PR #${item.number} は閉じられました`,
    };
  }

  const needsCard = hasEvents(item.counts) || item.ciChanged || item.refresh;
  if (!needsCard)
    return {
      done: true,
      note: `${id} のカードは変えません`,
    };
  const view = cardForWork(item);
  const ok = await putCard(ctx, root, item, task.path, view.card);
  if (ok && record)
    await saveWatchState(ctx, root, id, view.phase, {
      ci: item.ci,
      draft: item.isDraft,
      detail: view.detail,
    }).catch(() => {});
  return {
    done: ok,
    ...(ok ? { comment: view.card.comment ?? null } : {}),
    note: `${id} のカードを更新しました`,
  };
}

/**
 * 後始末が上限で外れた：push の記録とカードを「後始末で止まった」にする（人が気づけるように）。
 * もう mergeCommit があれば（ほかの者が済ませた）書かない。書けなくても投げない
 */
async function markStopped(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  item: WorkItem,
): Promise<void> {
  const id = item.taskId;
  try {
    const record = await readPushRecord(ctx.runner, root, id);
    if (record?.mergeCommit) return;
    const task = await findPushTask(ctx.runner, root, config, id, record);
    const detail = "push をもう一度打つとやり直します";
    await saveWatchState(ctx, root, id, "cleanup-stopped", {
      reason: "limit",
      detail,
    });
    await putCard(
      ctx,
      root,
      item,
      task.path,
      cardForPushWatch("cleanup-stopped", item.number, { detail }),
    );
  } catch (error) {
    ctx.stderr(
      `警告：${id} を「後始末で止まった」にできませんでした（${redactSecrets(message(error), envSecrets(ctx.env))}）`,
    );
  }
}

const handledItem = (items: WorkItem[], number: number) =>
  items.find((i) => i.number === number);

/** `orca-flow pr-watch background`：記録された仕事を済ませる。同時には1つだけ動く */
export async function runBackground(
  ctx: CommandContext,
  root: string,
): Promise<CommandResult> {
  const config = await requireFlowConfig(ctx.runner, root);
  const dir = await watchDir(ctx.runner, root);
  const lock = await tryLock(dir, "background.lock", "background");
  if (!lock) {
    if (!ctx.json) ctx.stdout("見張りの背景の仕事はすでに動いています");
    return { code: 0, data: { running: true } };
  }
  const g: GhContext = { runner: ctx.runner, cwd: root, env: ctx.env };
  let failure: string | null = null;
  const handled: {
    number: number;
    rev: number;
    h: Handled;
    tries: number;
  }[] = [];
  try {
    const state = await readState(dir);
    const items = Object.values(state.work).sort((a, b) => a.number - b.number);
    const now = ctx.now().getTime();
    for (const item of items) {
      let h: Handled;
      try {
        h = await handle(ctx, root, config, g, item);
        if (!ctx.json) ctx.stdout(h.note);
        if (!h.done) failure = h.note;
      } catch (error) {
        const reason = redactSecrets(message(error), envSecrets(ctx.env));
        ctx.stderr(
          `警告：PR #${item.number} の仕事が止まりました（${reason}）`,
        );
        failure = reason;
        h = { done: false, note: reason };
      }
      const tries = (item.tries ?? 0) + 1;
      if (!h.done) {
        const since = Date.parse(item.since ?? item.at);
        const old = Number.isFinite(since) && now - since > MAX_WORK_AGE_MS;
        if (tries >= MAX_TRIES || old) {
          // 終わらない仕事は外す（毎回背景を起こし直さない）
          failure = `PR #${item.number} の仕事を、やり直しの上限（${MAX_TRIES}回か1時間）を超えたので外しました（最後の理由：${h.note}）`;
          ctx.stderr(`警告：${failure}`);
          h = { ...h, done: true };
          if (item.end === "merged") await markStopped(ctx, root, config, item);
        }
      }
      handled.push({ number: item.number, rev: item.rev, h, tries });
    }
    await updateState(dir, (st) => {
      for (const { number, rev, h, tries } of handled) {
        const key = String(number);
        const work = st.work[key];
        // 読んだあとに仕事が足されていたら（版が進んでいたら）残す
        if (h.done && work?.rev === rev) {
          delete st.work[key];
          // 済んだ仕事が起こす動きなら、待ちの起こしに重ねる。終わった PR の待ちは捨てる
          const item = handledItem(items, number);
          if (item?.end) delete st.wakes[key];
          else if (item) {
            const wake = st.wakes[key];
            // 背景がカードを書き直したので、待ちの一言の写しも新しいカードに合わせる
            // （理由は processWakes が足し直す）。起こす動きでない仕事でも同じ
            if (h.comment !== undefined) {
              if (wake) {
                wake.baseComment = h.comment;
                wake.noteReason = null;
              }
              // 書き直しで版上げの文も消えた。次の回に足し直す（respond の起こしの記録がなくても）
              const bump = st.bumpWakes?.[item.taskId];
              if (bump) bump.noteReason = null;
            }
            if (wakeWorthy(item))
              registerWake(st, item, h.comment ?? null, ctx.now());
          }
        } else if (work?.rev === rev) work.tries = tries;
      }
    });
    // カードを書いたあと、待ちの起こしを試す（仕事がなくても、待ちが残っていれば）
    try {
      await processWakes(ctx, root, config, dir);
    } catch (error) {
      failure = redactSecrets(message(error), envSecrets(ctx.env));
      ctx.stderr(`警告：タスク長を起こす道が止まりました（${failure}）`);
    }
    // 共通の版上げ・取り込み直し：判定（共通のタグの取得を含む）はここで行い、鍵が新しければ起こす
    try {
      await planBumpWakes(ctx, root, config, dir);
      await processBumpWakes(ctx, root, config, dir);
    } catch (error) {
      failure = redactSecrets(message(error), envSecrets(ctx.env));
      ctx.stderr(`警告：共通の版上げを起こす道が止まりました（${failure}）`);
    }
    // 結果の記録は、起こす道が済んでから書く（止まったのに「済み」と残さない）
    await updateState(dir, (st) => {
      st.lastBackground = {
        at: ctx.now().toISOString(),
        ok: failure === null,
        reason: failure,
      };
    });
  } finally {
    await lock.release().catch(() => {});
  }
  return {
    code: failure === null ? 0 : 1,
    data: { handled: handled.length, failure },
  };
}
