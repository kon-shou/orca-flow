import type { FlowConfig } from "../../config.ts";
import { FlowError, type CommandContext } from "../../types.ts";
import { findPushTask, readPushRecord } from "../finish.ts";
import { envSecrets, redactSecrets } from "../github.ts";
import { createOrca, type SendBlock } from "../orca.ts";
import { readState, updateState } from "./store.ts";
import type {
  LaunchedConversation,
  WaitReason,
  WakeEntry,
  WatchFile,
  WorkItem,
} from "./types.ts";

// 見張りが動きを見つけたときの起こし方（背景から呼ぶ）。
// 起こす動きは、他人のレビュー・コメント（書いた人が持ち主・メンバー・共同作業者のものと、許す3つの bot のものだけ。外の人とそのほかの bot は起こさない）と、CI が赤に変わったときだけ（スレッドの解決・他人の push・CI の緑はカードの未読で足りる）。
// 自分の書き込みと send が送った push は、classify が数えないので、ここへ来ない。
// 生きたタスク長がいれば /orca-flow:respond 〈ID〉 を送り、いなければ新しい会話を立てて同じものを渡す。
// 送る文と prompt はこれだけ。他人の文章・件数・打ちかけの文は、送る文・カード・記録に入れない。

/** 同じ PR を続けて起こさない間隔：見張りの間隔のこの回数分 */
export const WAKE_INTERVAL_ROUNDS = 3;
/** 立てた直後でターミナルがまだ見えない間も、上限の数に入れる長さ */
export const LAUNCH_GRACE_MS = 2 * 60_000;
/** ターミナルを確かめられない状態がこれだけ続いた会話は、数から外して記録を消す（背景のやり直しの上限と同じ長さ） */
export const UNVERIFIABLE_LIMIT_MS = 60 * 60_000;
/** 送ったあとの確認を待つ秒数（approve と同じ） */
const WAIT_SUBMIT_SECONDS = 5;

export const wakePrompt = (id: string) => `/orca-flow:respond ${id}`;

/** 待ちの理由の言葉（カードの一言に出す。固定の文だけ） */
export function waitText(reason: WaitReason, maxLaunches: number): string {
  switch (reason) {
    case "draft":
      return "入力欄に打ちかけがあります";
    case "bash":
      return "入力欄が bash モードです";
    case "unverifiable":
      return "入力欄を確かめられません";
    case "ambiguous":
      return "ターミナルが1つに決まりません";
    case "failed":
      return "Orca の呼び出しに失敗しました";
    case "limit":
      return `同時に起こす会話の上限（${maxLaunches}）に届いています`;
    case "interval":
      return "前に起こしてから間隔の中です";
  }
}

const noted = (base: string, reason: WaitReason, maxLaunches: number) =>
  `${base}（起こせていません：${waitText(reason, maxLaunches)}）`;

/** 手で開いた PR（push の記録の PR でない）で起こさなかったとき、カードの一言の後ろに足す固定の文 */
export const MANUAL_PR_NOTE = "（起こしません：手で開いた PR です）";

/** 起こす動きか：起こす分のレビュー・コメント（合計から外の人と許す3つの bot を除く bot の分を引く。古い記録は引かない）、または CI が赤に変わった */
export function wakeWorthy(item: WorkItem): boolean {
  if (item.end !== null) return false;
  return (
    item.counts.review + item.counts.comment - (item.counts.quiet ?? 0) > 0 ||
    (item.ciChanged && item.ci === "failed")
  );
}

/** 仕事が済んだとき、待ちの起こしに重ねる（記録の中で呼ぶ）。同じ仕事は1回しか重ねない */
export function registerWake(
  st: WatchFile,
  item: WorkItem,
  baseComment: string | null,
  now: Date,
): void {
  const key = `${item.since ?? item.at}#${item.rev}`;
  const before = st.wakes[String(item.number)];
  if (before?.registeredKey === key) return;
  st.wakes[String(item.number)] = {
    number: item.number,
    taskId: item.taskId,
    pending: true,
    wait: before?.wait ?? null,
    lastWokeAt: before?.lastWokeAt ?? null,
    registeredKey: key,
    baseComment,
    // 新しいカードで一言を書き直したので、前の待ちの言葉は残っていない
    noteReason: null,
    since: before?.pending ? before.since : now.toISOString(),
  };
}

export const hasPendingWake = (st: WatchFile) =>
  Object.values(st.wakes).some((w) => w.pending);

type Verdict =
  | { kind: "woke"; launched?: LaunchedConversation }
  | { kind: "wait"; reason: WaitReason; launched?: LaunchedConversation }
  | { kind: "drop" };

const blockReason = (block: SendBlock): WaitReason | null =>
  block.kind === "none" ? null : block.kind;

/** findPushTask が「タスクがない」と返した失敗か（git などの一時的な失敗と分ける） */
const isTaskGone = (error: unknown) =>
  error instanceof FlowError && error.message.startsWith("作業中のタスクに ");

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** 待ちの起こしが1つも残っていないタスクの、会話の記録の ID */
const orphanedLaunches = (
  st: WatchFile,
  skip: ReadonlySet<number> = new Set(),
) => {
  const kept = new Set(
    Object.values(st.wakes)
      .filter((w) => !skip.has(w.number))
      .map((w) => w.taskId),
  );
  return Object.keys(st.launched).filter((id) => !kept.has(id));
};

/**
 * 待ちの起こしを順に試す。起こせなければ理由をカードの一言に足して次の回に回す。
 * 返すのは、起こした数と待ちに回した数
 */
export async function processWakes(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  dir: string,
): Promise<{ woke: number; waiting: number }> {
  const state = await readState(dir);
  const pending = Object.values(state.wakes)
    .filter((w) => w.pending)
    .sort((a, b) => a.number - b.number);
  if (pending.length === 0) {
    // 待ちがなくても、待ちの起こしが残っていないタスクの会話の記録は消す（書くのは消すものがあるときだけ）
    if (orphanedLaunches(state).length > 0)
      await updateState(dir, (st) => {
        for (const id of orphanedLaunches(st)) delete st.launched[id];
      });
    return { woke: 0, waiting: 0 };
  }

  const orca = createOrca(ctx.runner, root);
  const agent = config.lead.agent;
  const max = config.prWatch.maxLaunches;
  const now = ctx.now();
  const redact = (t: string) => redactSecrets(t, envSecrets(ctx.env));
  const intervalMs =
    WAKE_INTERVAL_ROUNDS * config.prWatch.intervalMinutes * 60_000;

  // 見張りが立てた会話のうち生きている数（必要になったときに1回だけ数える）
  let live: Map<string, LaunchedConversation> | null = null;
  const dead: string[] = [];
  // 確かめられない時刻の書き換え（null は消す）
  const since = new Map<string, string | null>();
  // 待ちの起こしがなくなったタスク（数に入れない）
  const droppedWakes = new Set<number>();
  const forgotten = new Set(orphanedLaunches(state));
  const liveConversations = async () => {
    if (live) return live;
    live = new Map();
    for (const [taskId, conv] of Object.entries(state.launched)) {
      if (forgotten.has(taskId)) continue;
      let alive = now.getTime() - Date.parse(conv.at) < LAUNCH_GRACE_MS;
      if (!alive) {
        try {
          alive = (await orca.listTerminals(conv.worktreePath)).some(
            (t) =>
              t.handle !== "" &&
              t.connected &&
              !t.orphaned &&
              t.agentIdentity === agent,
          );
          if (conv.unverifiableSince) since.set(taskId, null);
        } catch {
          // 確かめられないものは、最初の失敗から1時間は数に入れる（立てすぎないため）。過ぎたら外す
          const first = Date.parse(conv.unverifiableSince ?? "");
          const from = Number.isFinite(first) ? first : now.getTime();
          alive = now.getTime() - from <= UNVERIFIABLE_LIMIT_MS;
          if (alive && !conv.unverifiableSince)
            since.set(taskId, now.toISOString());
        }
      }
      if (alive) live.set(taskId, conv);
      else dead.push(taskId);
    }
    return live;
  };

  // 待ちの起こしを捨てる。そのタスクの待ちがほかになければ、会話も数から外す
  const drop = (wake: WakeEntry) => {
    results.set(wake.number, { kind: "drop" });
    droppedWakes.add(wake.number);
    for (const id of orphanedLaunches(state, droppedWakes)) {
      forgotten.add(id);
      live?.delete(id);
    }
  };

  const results = new Map<number, Verdict>();
  const cards = new Map<number, { path: string; comment: string }>();
  for (const wake of pending) {
    const key = String(wake.number);
    const pr = state.prs[key];
    if (pr && pr.final !== null) {
      drop(wake);
      continue;
    }
    let verdict: Verdict;
    let attempt: LaunchedConversation | undefined;
    let taskPath: string | null = null;
    try {
      const record = await readPushRecord(ctx.runner, root, wake.taskId);
      try {
        taskPath = (
          await findPushTask(ctx.runner, root, config, wake.taskId, record)
        ).path;
      } catch (error) {
        // 「作業中のタスクに見つからない」だけが、後始末が済んでいて起こす先がない。
        // git の一時的な失敗などは外側へ流し、待ちに回して次の回にやり直す
        if (!isTaskGone(error)) throw error;
        drop(wake);
        continue;
      }
      // 起こすのは、push の記録の PR と同じ番号の PR だけ（記録がない・記録に PR がないも起こさない）
      if (record?.pr?.number !== wake.number) {
        drop(wake);
        if (wake.baseComment)
          cards.set(wake.number, {
            path: taskPath,
            comment: `${wake.baseComment}${MANUAL_PR_NOTE}`,
          });
        continue;
      }
      // 間隔は、最後に起こした（立てる呼び出しが落ちたときは試した）時刻から数える
      const last = wake.lastWokeAt ? Date.parse(wake.lastWokeAt) : NaN;
      if (Number.isFinite(last) && now.getTime() - last < intervalMs) {
        verdict = { kind: "wait", reason: "interval" };
      } else {
        const target = await orca.findSendTarget(taskPath, agent);
        if (target.kind === "found") {
          await orca.sendText(target.terminal.handle, wakePrompt(wake.taskId), {
            waitSubmit: WAIT_SUBMIT_SECONDS,
          });
          verdict = { kind: "woke" };
        } else {
          const reason = blockReason(target);
          if (reason) {
            verdict = { kind: "wait", reason };
          } else if ((await liveConversations()).size >= max) {
            verdict = { kind: "wait", reason: "limit" };
          } else {
            const conv: LaunchedConversation = {
              taskId: wake.taskId,
              worktreePath: taskPath,
              at: now.toISOString(),
            };
            try {
              await orca.launchAgent({
                worktreePath: taskPath,
                lead: config.lead,
                prompt: wakePrompt(wake.taskId),
              });
            } catch (error) {
              // 落ちても（時間切れを含む）Orca の側では立っているかもしれない。立てたかもしれない会話として残す
              attempt = conv;
              (await liveConversations()).set(wake.taskId, conv);
              throw error;
            }
            (await liveConversations()).set(wake.taskId, conv);
            verdict = { kind: "woke", launched: conv };
          }
        }
      }
    } catch (error) {
      ctx.stderr(
        `警告：PR #${wake.number} のタスク長を起こせませんでした（${redact(message(error))}）。次の回にやり直します`,
      );
      verdict = { kind: "wait", reason: "failed", launched: attempt };
    }
    results.set(wake.number, verdict);

    // カードの一言：待ちの理由が変わったときだけ書く。起こせたら元に戻す
    if (taskPath && wake.baseComment) {
      const want =
        verdict.kind === "wait"
          ? noted(wake.baseComment, verdict.reason, max)
          : verdict.kind === "woke" && wake.noteReason !== null
            ? wake.baseComment
            : null;
      const had = wake.noteReason;
      if (want !== null && (verdict.kind !== "wait" || verdict.reason !== had))
        cards.set(wake.number, { path: taskPath, comment: want });
    }
  }

  // カードを書く（失敗しても待ちは残る。一言の理由は書けたときだけ記録する）
  const written = new Set<number>();
  for (const [number, card] of cards) {
    try {
      await orca.setCard(card.path, { comment: card.comment });
      written.add(number);
    } catch (error) {
      ctx.stderr(
        `警告：PR #${number} のカードの一言を書けませんでした（${redact(message(error))}）`,
      );
    }
  }

  let woke = 0;
  let waiting = 0;
  await updateState(dir, (st) => {
    for (const id of dead) delete st.launched[id];
    for (const [id, value] of since) {
      const conv = st.launched[id];
      if (!conv) continue;
      if (value === null) delete conv.unverifiableSince;
      else conv.unverifiableSince = value;
    }
    for (const [number, verdict] of results) {
      const key = String(number);
      if (verdict.kind !== "drop" && verdict.launched)
        st.launched[verdict.launched.taskId] = verdict.launched;
      const entry: WakeEntry | undefined = st.wakes[key];
      if (!entry) continue; // 読んだあとに PR が終わって消えた
      if (verdict.kind === "drop") {
        delete st.wakes[key];
        continue;
      }
      if (verdict.kind === "woke") {
        woke++;
        // 読んだあとに新しい動きが重なっていたら（版が違えば）待ちを残す
        const fresh = entry.registeredKey === state.wakes[key]?.registeredKey;
        entry.pending = !fresh;
        entry.wait = null;
        entry.lastWokeAt = now.toISOString();
        if (written.has(number)) entry.noteReason = null;
        continue;
      }
      waiting++;
      entry.wait = verdict.reason;
      // 立てる呼び出しが落ちたときも、試した時刻から間隔を数える（会話の記録が先に消えても残る）
      if (verdict.launched) entry.lastWokeAt = now.toISOString();
      if (written.has(number)) entry.noteReason = verdict.reason;
    }
    // 待ちの起こしが1つも残っていないタスクの会話の記録も消す
    for (const id of orphanedLaunches(st)) delete st.launched[id];
  });
  if (!ctx.json && (woke > 0 || waiting > 0))
    ctx.stdout(`起こし：${woke}件を起こし、${waiting}件を次の回に回しました`);
  return { woke, waiting };
}
