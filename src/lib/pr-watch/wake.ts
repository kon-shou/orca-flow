import type { FlowConfig } from "../../config.ts";
import { FlowError, type CommandContext } from "../../types.ts";
import { gitCommonDir } from "../git.ts";
import { samePath } from "../paths.ts";
import { readStages } from "../stage-log.ts";
import { findPushTask, readPushRecord } from "../finish.ts";
import { envSecrets, redactSecrets } from "../github.ts";
import { createOrca, type Orca, type SendBlock } from "../orca.ts";
import { planAppBump } from "../app-bump.ts";
import { readState, updateState } from "./store.ts";
import type {
  BumpWake,
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
/** 共通の版上げ・取り込み直しで起こすときに渡す文（鍵や版は入れない。タスク長が app-bump で読む） */
export const bumpPrompt = (id: string) => `/orca-flow:bump ${id}`;
/** 起こした鍵を覚えておく数の上限 */
const WOKEN_KEEP = 50;

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
    case "live":
      return "前に立てた会話がまだ動いています";
    case "question":
      return "人の答えを待っています";
  }
}

/** 版上げの待ちの文（カードの一言の末尾に足す。固定の形だけ） */
export const bumpNote = (reason: WaitReason, maxLaunches: number) =>
  `（版上げを起こせていません：${waitText(reason, maxLaunches)}）`;

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 全部の待ちの理由（理由を足して入れ忘れると型チェックで落ちる） */
const ALL_REASONS: Record<WaitReason, true> = {
  draft: true,
  bash: true,
  unverifiable: true,
  ambiguous: true,
  failed: true,
  limit: true,
  interval: true,
  live: true,
  question: true,
};
/** 理由の言葉の並び（limit は数の部分を \d+ にする） */
const REASON_TEXTS = (Object.keys(ALL_REASONS) as WaitReason[])
  .map((r) =>
    r === "limit"
      ? `${escapeRe("同時に起こす会話の上限（")}\\d+${escapeRe("）に届いています")}`
      : escapeRe(waitText(r, 0)),
  )
  .join("|");
const BUMP_NOTE_TAIL = new RegExp(
  `${escapeRe("（版上げを起こせていません：")}(?:${REASON_TEXTS})${escapeRe("）")}$`,
);
/** 更新の前の版が書いた共通の版上げの一言（決まった形の全体だけ） */
const OLD_BUMP_COMMENT = new RegExp(
  `^${escapeRe("共通の版上げを待っています：PR #")}\\d+(?:${escapeRe("（起こせていません：")}(?:${REASON_TEXTS})${escapeRe("）")})?$`,
);

/** 一言の末尾の版上げの文を1つだけ外す（決まった形の文だけ。ほかの文字は読まない）。
 * 前の版の固定の一言（共通の版上げを待っています：PR #N…）は全体がその形のときだけ空とみなす */
export const stripBumpNote = (comment: string) =>
  OLD_BUMP_COMMENT.test(comment) ? "" : comment.replace(BUMP_NOTE_TAIL, "");

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

export const hasPendingBumpWake = (st: WatchFile) =>
  Object.values(st.bumpWakes ?? {}).some((w) => w.pending);

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

/** 段の記録の最後が question か。記録がない・読めないときは question でないとみなす */
async function isAwaitingAnswer(
  ctx: CommandContext,
  root: string,
  taskId: string,
): Promise<boolean> {
  try {
    const parsed = await readStages(
      await gitCommonDir(ctx.runner, root),
      taskId,
    );
    return parsed?.entries.at(-1)?.state === "question";
  } catch {
    return false;
  }
}

/** 待ちの起こしが1つも残っていないタスクの、会話の記録の ID */
const orphanedLaunches = (
  st: WatchFile,
  skip: ReadonlySet<number> = new Set(),
) => {
  const kept = new Set([
    ...Object.values(st.wakes)
      .filter((w) => !skip.has(w.number))
      .map((w) => w.taskId),
    ...Object.keys(st.bumpWakes ?? {}),
  ]);
  return Object.keys(st.launched).filter((id) => !kept.has(id));
};

/** 見張りが立てた会話のうち生きているものを数える（ターミナルの一覧が確かめられないものの扱いは UNVERIFIABLE_LIMIT_MS） */
async function surveyLaunched(
  orca: Orca,
  agent: string,
  launched: Record<string, LaunchedConversation>,
  now: Date,
  skip: ReadonlySet<string>,
): Promise<{
  live: Map<string, LaunchedConversation>;
  dead: string[];
  since: Map<string, string | null>;
}> {
  const live = new Map<string, LaunchedConversation>();
  const dead: string[] = [];
  const since = new Map<string, string | null>();
  for (const [taskId, conv] of Object.entries(launched)) {
    if (skip.has(taskId)) continue;
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
  return { live, dead, since };
}

interface AttemptEnv {
  ctx: CommandContext;
  root: string;
  orca: Orca;
  agent: string;
  lead: FlowConfig["lead"];
  max: number;
  now: Date;
  intervalMs: number;
  /** 見張りが立てた会話のうち生きているもの（必要になったときに数える） */
  live: () => Promise<Map<string, LaunchedConversation>>;
}

/**
 * 1つの起こしを試す（respond の待ちも版上げの待ちも同じ道）。
 * 間隔 → 生きたタスク長へ送る（question なら待つ）→ 打ちかけ等で待つ → 立てたばかり・上限で待つ → 新しい会話を立てる。
 * Orca の失敗は warn で知らせて、failed の待ちを返す
 */
async function attemptWake(
  env: AttemptEnv,
  wake: {
    taskId: string;
    taskPath: string;
    prompt: string;
    lastWokeAt: string | null;
    warn: (error: unknown) => void;
  },
): Promise<Verdict> {
  const { ctx, orca, now } = env;
  let attempt: LaunchedConversation | undefined;
  try {
    // 間隔は、最後に起こした（立てる呼び出しが落ちたときは試した）時刻から数える
    const last = wake.lastWokeAt ? Date.parse(wake.lastWokeAt) : NaN;
    if (Number.isFinite(last) && now.getTime() - last < env.intervalMs)
      return { kind: "wait", reason: "interval" };
    const target = await orca.findSendTarget(wake.taskPath, env.agent);
    if (target.kind === "found") {
      if (await isAwaitingAnswer(ctx, env.root, wake.taskId))
        return { kind: "wait", reason: "question" };
      await orca.sendText(target.terminal.handle, wake.prompt, {
        waitSubmit: WAIT_SUBMIT_SECONDS,
      });
      return { kind: "woke" };
    }
    const reason = blockReason(target);
    if (reason) return { kind: "wait", reason };
    // ターミナルが見えなくても、このタスクの会話が生きている（立てたばかりを含む）なら、二つ目を立てずに待つ
    const live = await env.live();
    if (live.has(wake.taskId)) return { kind: "wait", reason: "live" };
    if (live.size >= env.max) return { kind: "wait", reason: "limit" };
    const conv: LaunchedConversation = {
      taskId: wake.taskId,
      worktreePath: wake.taskPath,
      at: now.toISOString(),
    };
    try {
      await orca.launchAgent({
        worktreePath: wake.taskPath,
        lead: env.lead,
        prompt: wake.prompt,
      });
    } catch (error) {
      // 落ちても（時間切れを含む）Orca の側では立っているかもしれない。立てたかもしれない会話として残す
      attempt = conv;
      live.set(wake.taskId, conv);
      throw error;
    }
    live.set(wake.taskId, conv);
    return { kind: "woke", launched: conv };
  } catch (error) {
    wake.warn(error);
    return { kind: "wait", reason: "failed", launched: attempt };
  }
}

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
    const survey = await surveyLaunched(
      orca,
      agent,
      state.launched,
      now,
      forgotten,
    );
    live = survey.live;
    dead.push(...survey.dead);
    for (const [id, value] of survey.since) since.set(id, value);
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

  const env: AttemptEnv = {
    ctx,
    root,
    orca,
    agent,
    lead: config.lead,
    max,
    now,
    intervalMs,
    live: liveConversations,
  };
  const results = new Map<number, Verdict>();
  const cards = new Map<number, { path: string; comment: string }>();
  const bumpTail = (taskId: string) => {
    const reason = state.bumpWakes?.[taskId]?.noteReason;
    return reason ? bumpNote(reason, max) : "";
  };
  for (const wake of pending) {
    const key = String(wake.number);
    const pr = state.prs[key];
    if (pr && pr.final !== null) {
      drop(wake);
      continue;
    }
    let verdict: Verdict;
    let taskPath: string | null = null;
    const warn = (error: unknown) =>
      ctx.stderr(
        `警告：PR #${wake.number} のタスク長を起こせませんでした（${redact(message(error))}）。次の回にやり直します`,
      );
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
            comment: `${wake.baseComment}${MANUAL_PR_NOTE}${bumpTail(wake.taskId)}`,
          });
        continue;
      }
      verdict = await attemptWake(env, {
        taskId: wake.taskId,
        taskPath,
        prompt: wakePrompt(wake.taskId),
        lastWokeAt: wake.lastWokeAt,
        warn,
      });
    } catch (error) {
      warn(error);
      verdict = { kind: "wait", reason: "failed" };
    }
    results.set(wake.number, verdict);

    // カードの一言：待ちの理由が変わったときだけ書く。起こせたら元に戻す
    if (taskPath && wake.baseComment) {
      // 同じタスクで版上げの理由が一言に出ていれば、後ろに足す（互いに消さない）
      const tail = bumpTail(wake.taskId);
      const want =
        verdict.kind === "wait"
          ? `${noted(wake.baseComment, verdict.reason, max)}${tail}`
          : verdict.kind === "woke" && wake.noteReason !== null
            ? `${wake.baseComment}${tail}`
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

/**
 * 共通の版上げ・取り込み直しの判定を、確かめるタスク（state.appBumpCheck）ごとに行い、起こす鍵を記録する。
 * 時間のかかる判定（共通のタグの取得）は、時間切れのない背景でだけ行う。読むだけで、GitHub にも書かない。
 * 判定を出せないタスク（記録が壊れている・タスクがない）は飛ばして、ほかを続ける
 */
export async function planBumpWakes(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  dir: string,
): Promise<void> {
  const state = await readState(dir);
  const ids = state.appBumpCheck ?? [];
  if (ids.length === 0) return;
  const redact = (t: string) => redactSecrets(t, envSecrets(ctx.env));
  const planned = new Map<string, { number: number; keys: string[] }>();
  for (const id of ids) {
    try {
      const record = await readPushRecord(ctx.runner, root, id);
      if (!record?.pr) continue;
      const task = await findPushTask(ctx.runner, root, config, id, record);
      const items = await planAppBump(ctx.runner, root, id, task.branch);
      if (items === null) continue;
      const keys = items
        .filter((i) => i.verdict === "bump" || i.verdict === "reimport")
        .flatMap((i) => (i.key === null ? [] : [i.key]));
      planned.set(id, { number: record.pr.number, keys });
    } catch (error) {
      ctx.stderr(
        `警告：${id} の共通の版上げを確かめられませんでした（${redact(message(error))}）`,
      );
    }
  }
  if (planned.size === 0) return;
  const now = ctx.now().toISOString();
  await updateState(dir, (st) => {
    for (const [id, { number, keys }] of planned) {
      const before = st.bumpWakes?.[id];
      const fresh = keys.filter((k) => !before?.woken.includes(k));
      if (!before && fresh.length === 0) continue;
      (st.bumpWakes ??= {})[id] = {
        taskId: id,
        number,
        pending: fresh.length > 0,
        wait: fresh.length > 0 ? (before?.wait ?? null) : null,
        keys: fresh,
        woken: before?.woken ?? [],
        lastWokeAt: before?.lastWokeAt ?? null,
        noteReason: before?.noteReason ?? null,
        since: before?.pending ? before.since : now,
      };
    }
  });
}

/** Orca の一覧にある、worktree の今の一言。同じ場所を指すパスで探し、一覧に見つからなければ（空とみなさず）投げる。読めなければ投げる */
async function currentComment(orca: Orca, worktreePath: string) {
  const hit = (await orca.listWorktrees()).find((w) =>
    samePath(w.path, worktreePath),
  );
  if (!hit) throw new Error("Orca の一覧にタスクの worktree が見つかりません");
  return hit.comment ?? "";
}

/** 起こす先を見つけて `/orca-flow:bump 〈ID〉` を渡す。processWakes と同じ道（attemptWake）で、生きたタスク長へ送り、いなければ新しい会話を立てる */
export async function processBumpWakes(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  dir: string,
): Promise<{ woke: number; waiting: number }> {
  const state = await readState(dir);
  // 待っているもののほか、待ちが終わって版上げの文だけが一言に残っているものも見る（文を外すため）
  const pending = Object.values(state.bumpWakes ?? {})
    .filter((w) => w.pending || w.noteReason)
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (pending.length === 0) return { woke: 0, waiting: 0 };

  const orca = createOrca(ctx.runner, root);
  const max = config.prWatch.maxLaunches;
  const now = ctx.now();
  const redact = (t: string) => redactSecrets(t, envSecrets(ctx.env));

  let survey: Awaited<ReturnType<typeof surveyLaunched>> | null = null;
  const surveyed = async () =>
    (survey ??= await surveyLaunched(
      orca,
      config.lead.agent,
      state.launched,
      now,
      new Set(orphanedLaunches(state)),
    ));
  const env: AttemptEnv = {
    ctx,
    root,
    orca,
    agent: config.lead.agent,
    lead: config.lead,
    max,
    now,
    intervalMs: WAKE_INTERVAL_ROUNDS * config.prWatch.intervalMinutes * 60_000,
    live: async () => (await surveyed()).live,
  };

  const results = new Map<string, Verdict>();
  // 一言を書いた（または書かなくてよいと分かった）タスクの、一言に出している理由
  const written = new Map<string, WaitReason | null>();
  // カードの一言：今の一言（Orca の一覧）の末尾の版上げの文だけを、want（null なら外す）に替える。
  // 出している理由と同じなら読み書きしない。一覧を読めない・書けないときは書かず、記録も変えずに次の回にやり直す
  const updateNote = async (
    wake: BumpWake,
    taskPath: string,
    want: WaitReason | null,
  ) => {
    if (want === (wake.noteReason ?? null)) return;
    try {
      const current = await currentComment(orca, taskPath);
      const next = `${stripBumpNote(current)}${want === null ? "" : bumpNote(want, max)}`;
      if (next !== current) await orca.setCard(taskPath, { comment: next });
      written.set(wake.taskId, want);
    } catch (error) {
      ctx.stderr(
        `警告：${wake.taskId} のカードの一言を書けませんでした（${redact(message(error))}）`,
      );
    }
  };
  for (const wake of pending) {
    const pr = state.prs[String(wake.number)];
    if (pr && pr.final !== null) {
      results.set(wake.taskId, { kind: "drop" });
      continue;
    }
    let verdict: Verdict;
    let taskPath: string | null = null;
    const warn = (error: unknown) =>
      ctx.stderr(
        `警告：${wake.taskId} の共通の版上げでタスク長を起こせませんでした（${redact(message(error))}）。次の回にやり直します`,
      );
    try {
      const record = await readPushRecord(ctx.runner, root, wake.taskId);
      try {
        taskPath = (
          await findPushTask(ctx.runner, root, config, wake.taskId, record)
        ).path;
      } catch (error) {
        if (!isTaskGone(error)) throw error;
        results.set(wake.taskId, { kind: "drop" });
        continue;
      }
      if (record?.pr?.number !== wake.number) {
        results.set(wake.taskId, { kind: "drop" });
        continue;
      }
      // 待ちが終わって版上げの文だけが残っているときは、起こさずに文を外す
      if (!wake.pending) {
        await updateNote(wake, taskPath, null);
        continue;
      }
      verdict = await attemptWake(env, {
        taskId: wake.taskId,
        taskPath,
        prompt: bumpPrompt(wake.taskId),
        lastWokeAt: wake.lastWokeAt,
        warn,
      });
    } catch (error) {
      warn(error);
      verdict = { kind: "wait", reason: "failed" };
    }
    results.set(wake.taskId, verdict);

    // 待ちの一言を替える（起こせたら外す）
    if (taskPath)
      await updateNote(
        wake,
        taskPath,
        verdict.kind === "wait" ? verdict.reason : null,
      );
  }

  let woke = 0;
  let waiting = 0;
  await updateState(dir, (st) => {
    if (survey) {
      for (const id of survey.dead) delete st.launched[id];
      for (const [id, value] of survey.since) {
        const conv = st.launched[id];
        if (!conv) continue;
        if (value === null) delete conv.unverifiableSince;
        else conv.unverifiableSince = value;
      }
    }
    for (const [id, verdict] of results) {
      if (verdict.kind !== "drop" && verdict.launched)
        st.launched[verdict.launched.taskId] = verdict.launched;
      const entry: BumpWake | undefined = st.bumpWakes?.[id];
      if (!entry) continue;
      if (verdict.kind === "drop") {
        delete st.bumpWakes?.[id];
        continue;
      }
      if (verdict.kind === "woke") {
        woke++;
        entry.woken = [...entry.woken, ...entry.keys].slice(-WOKEN_KEEP);
        entry.keys = [];
        entry.pending = false;
        entry.wait = null;
        entry.lastWokeAt = now.toISOString();
        if (written.has(id)) entry.noteReason = written.get(id) ?? null;
        continue;
      }
      waiting++;
      entry.wait = verdict.reason;
      if (verdict.launched) entry.lastWokeAt = now.toISOString();
      if (written.has(id)) entry.noteReason = written.get(id) ?? null;
    }
    // 待ちが終わって文だけを外したもの
    for (const [id, value] of written) {
      const entry = st.bumpWakes?.[id];
      if (entry && !results.has(id)) entry.noteReason = value;
    }
    for (const id of orphanedLaunches(st)) delete st.launched[id];
  });
  if (!ctx.json && (woke > 0 || waiting > 0))
    ctx.stdout(
      `版上げの起こし：${woke}件を起こし、${waiting}件を次の回に回しました`,
    );
  return { woke, waiting };
}
