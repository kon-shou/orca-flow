import type { FlowConfig, OutboundConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import {
  STATE_LABEL,
  bundleFingerprint,
  computeFingerprint,
  KIND_TABLE,
  NotSentError,
  readItem,
  readLastWrite,
  redactBody,
  selectBundle,
  updateState,
  withOutboxLock,
  writeLastWrite,
  type OutboxItem,
  type OutboxState,
  type Senders,
} from "./outbox.ts";

// 送る前の確かめ（8章『送る前の確かめ』）：許可リスト・束の指紋・先頭・時間帯・間隔・二重・秘密。
// send の入口と見張りの入口がある。GitHub に書く関数は、ここを通った案にだけ呼ばれる。

// 送る関数が「何も書かずに落ちた」と言うときの NotSentError は outbox.ts（種類の表）にある
export { NotSentError };

const HHMM = /^(\d{2}):(\d{2})$/;

function minuteOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/**
 * 送る時間帯の中か（その機械の時刻）。from 以上 to 未満。days は 0＝日曜〜6＝土曜。
 * from が to より後なら日をまたぐ窓で、曜日は始まる日で数える。from と to が同じなら外
 */
export function inSendWindow(
  now: Date,
  window: OutboundConfig["window"],
): boolean {
  const day = now.getDay();
  const minute = now.getHours() * 60 + now.getMinutes();
  const from = minuteOf(window.from);
  const to = minuteOf(window.to);
  if (from === to) return false;
  if (from < to)
    return window.days.includes(day) && minute >= from && minute < to;
  const prev = (day + 6) % 7;
  return (
    (window.days.includes(day) && minute >= from) ||
    (window.days.includes(prev) && minute < to)
  );
}

// ---- 1. 許可リスト ----

/** 許可リストにない種類の案の一覧 */
export function notAllowed(
  items: readonly OutboxItem[],
  outbound: OutboundConfig,
): OutboxItem[] {
  return items.filter((i) => !outbound.allow.includes(i.kind));
}

// ---- send の入口 ----

export interface SendEntryInput {
  config: FlowConfig;
  /** タスクの案すべて（置き場から読み直したもの） */
  items: readonly OutboxItem[];
  /** `--expect` */
  expect: string;
  /** `--head` */
  head: string;
  /** タスクのブランチの今の先頭 */
  currentHead: string;
  /** 今のタスクの送り先。案の送り先がこれと違えば止める */
  expectedTarget: { remote: string; branch: string; base: string };
}

/**
 * send の入口の確かめ（1・2・3。時間帯は見ない）。落ちたら FlowError(1)。
 * 通れば、今回送る案を送る順に返す
 */
export function checkSendEntry(input: SendEntryInput): OutboxItem[] {
  const { outbound } = input.config;
  const { selected } = selectBundle(input.items, outbound.interval.perBatch);
  if (selected.length === 0)
    throw new FlowError(1, "送る案がありません（積んだ案がありません）");

  const blocked = notAllowed(selected, outbound);
  if (blocked.length > 0)
    throw new FlowError(
      1,
      `許可リスト（outbound.allow）にない種類の案があるので送りません：${blocked.map((i) => `${i.id}（${i.kind}）`).join("、")}。許可リストに足すか、outbox withdraw で取り下げてください`,
    );

  if (bundleFingerprint(selected) !== input.expect)
    throw new FlowError(
      1,
      "束の指紋が違います（見せたあとに案が変わったか、足されました）。outbox show をやり直して、見せ直してください",
    );

  if (input.currentHead !== input.head)
    throw new FlowError(
      1,
      `先頭が違います（見せた ${input.head.slice(0, 8)}、今 ${input.currentHead.slice(0, 8)}）。outbox show をやり直して、見せ直してください`,
    );
  const moved = selected.filter((i) => i.head !== input.head);
  if (moved.length > 0)
    throw new FlowError(
      1,
      `案の先頭が見せた先頭と違います：${moved.map((i) => i.id).join("、")}。積み直して、見せ直してください`,
    );

  const { expectedTarget: want } = input;
  const elsewhere = selected.filter(
    (i) =>
      i.target.remote !== want.remote ||
      i.target.branch !== want.branch ||
      i.target.base !== want.base,
  );
  if (elsewhere.length > 0)
    throw new FlowError(
      1,
      `案の送り先が今のタスクと違います：${elsewhere.map((i) => `${i.id}（${i.target.remote}/${i.target.branch} → ${i.target.base}）`).join("、")}。今は ${want.remote}/${want.branch} → ${want.base} です。取り下げて積み直してください`,
    );
  return selected;
}

// ---- 見張りの入口 ----

export interface WatchEntryInput {
  config: FlowConfig;
  /** 置き場から読み直した、CI 待ちの案 */
  item: OutboxItem;
  /** タスクのブランチの今の先頭 */
  currentHead: string;
  now: Date;
}

export type WatchEntryResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /** 送る時間帯の外で断った（案は残して次の回に回す） */
      outsideWindow?: true;
    };

/**
 * 見張りの入口の確かめ：send で承認済みにした CI 待ちの pr-ready を、承認した先頭と今の先頭・許可リスト・時間帯で照らす。
 * 落ちても案は残す（状態は書き換えない）。呼ぶ側は、断られたら次の回に回す
 */
export function checkWatchEntry(input: WatchEntryInput): WatchEntryResult {
  const { item } = input;
  const { outbound } = input.config;
  if (item.state !== "ci-wait" || item.kind !== "pr-ready")
    return {
      ok: false,
      reason: `${item.id} は承認済み・CI 待ちの pr-ready ではありません（${STATE_LABEL[item.state]}）`,
    };
  if (!outbound.allow.includes(item.kind))
    return { ok: false, reason: `${item.kind} は許可リストにありません` };
  if (
    item.approvedHead === null ||
    item.approvedFingerprint === null ||
    computeFingerprint(item) !== item.approvedFingerprint
  )
    return {
      ok: false,
      reason: `${item.id} の中身が承認したときと違います`,
    };
  if (
    item.approvedHead !== input.currentHead ||
    item.head !== input.currentHead
  )
    return {
      ok: false,
      reason: `先頭が承認したときと違います（承認 ${item.approvedHead.slice(0, 8)}、今 ${input.currentHead.slice(0, 8)}）。送る前の確認に戻してください`,
    };
  if (!inSendWindow(input.now, outbound.window))
    return {
      ok: false,
      reason: "送る時間帯の外です（次の回に回します）",
      outsideWindow: true,
    };
  return { ok: true };
}

// ---- 送る（4〜7 と状態の更新） ----

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SendFailure {
  id: string;
  reason: string;
  /** 案に書いた状態 */
  state: OutboxState;
}

export interface SendOutcome {
  /** 送った案 */
  sent: string[];
  /** 送らずに承認済み・CI 待ちにした案 */
  deferred: string[];
  /** 落ちた案（なければ null）。落ちたら残りは送らない */
  failed: SendFailure | null;
  /** 落ちたために送らなかった残り（積んだまま） */
  remaining: string[];
  /** 送る直前の確かめ（SendDeps.verify）が止めた案（なければ null）。案は書き換えていない */
  held: { id: string; reason: string; why: HeldWhy } | null;
}

/** 送らずに止めた理由の種類 */
export type HeldWhy = "window" | "pr" | "head" | "ci";

/** 送る直前の確かめの結果。ok でなければ送らず、why を呼び手に返す（案は書き換えない） */
export type VerifyResult =
  { ok: true } | { ok: false; why: HeldWhy; reason: string };

export interface SendDeps {
  common: string;
  outbound: OutboundConfig;
  env: NodeJS.ProcessEnv;
  /** 種類ごとの送る関数 */
  senders: Senders;
  clock?: Clock;
  /**
   * send＝人が承認した send（積んだ案を送る。CI 待ちの印のついた pr-ready は送らずに CI 待ちにする）／
   * watch＝見張りの入口を通した CI 待ちの案を送る
   */
  mode: "send" | "watch";
  /** 承認した先頭（CI 待ちにするとき案に書く） */
  head: string;
  /**
   * 送りのロックの中で、送る関数を呼ぶ直前に案ごとに流す確かめ（見張りの形で GitHub の今を見る）。
   * ok でなければ、その案とあとの案は送らず、案の状態も変えずに held で返す
   */
  verify?: (item: OutboxItem) => Promise<VerifyResult>;
}

/**
 * 入口の確かめを通った案を、順に送る。案の状態を送る前と後に書く。
 * 送る前の確かめの残り：5（間隔）・6（二重）・7（秘密）。1件落ちたら残りは送らず止まる（投げずに結果を返す）。
 * 送る前に落ちたら「確かでない」として残し、自動では送り直さない
 */
export async function sendItems(
  deps: SendDeps,
  items: readonly OutboxItem[],
): Promise<SendOutcome> {
  // 置き場全体のロック：読み直して送る状態を確かめてから送った印を書くまで、ほかの send を入れない
  // 見張りが送るときはロックの種類を watch にし、send が来たら「見張りが動いています」と分かるようにする
  return withOutboxLock(deps.common, () => sendItemsLocked(deps, items), {
    kind: deps.mode === "watch" ? "watch" : "send",
  });
}

async function sendItemsLocked(
  deps: SendDeps,
  items: readonly OutboxItem[],
): Promise<SendOutcome> {
  const clock = deps.clock ?? realClock;
  const from: OutboxState = deps.mode === "send" ? "queued" : "ci-wait";
  const outcome: SendOutcome = {
    sent: [],
    deferred: [],
    failed: null,
    remaining: [],
    held: null,
  };
  const stamp = () => new Date(clock.now());

  // 送る関数がない種類があれば、何も書く前に断る（CI 待ちにするだけの案は送る関数を使わない）
  const defers = (item: OutboxItem) =>
    deps.mode === "send" && item.kind === "pr-ready" && item.afterCi;
  for (const item of items)
    if (
      !deps.outbound.allow.includes(item.kind) ||
      (!defers(item) && !deps.senders[item.kind])
    )
      throw new FlowError(
        1,
        `${item.id}（${item.kind}）を送る手段がありません。許可リストと送る関数を確かめてください`,
      );

  for (const [index, queued] of items.entries()) {
    const fail = (failure: SendFailure) => {
      outcome.failed = failure;
      outcome.remaining = items.slice(index + 1).map((i) => i.id);
    };

    // 6. 二重：ファイルを読み直し、送る状態でなく・中身が見せたときと違えばやり直さない
    const recheck = async (): Promise<OutboxItem | null> => {
      const now = await readItem(deps.common, queued.taskId, queued.id);
      if (!now || now.state !== from) {
        fail({
          id: queued.id,
          reason: now
            ? `${queued.id} は「${STATE_LABEL[now.state]}」なので送りません（二重には送りません）`
            : `${queued.id} が置き場にありません`,
          state: now?.state ?? "withdrawn",
        });
        return null;
      }
      // 指紋は今の中身から作り直す（ファイルが書き換えられていないか）
      if (computeFingerprint(now) !== computeFingerprint(queued)) {
        fail({
          id: now.id,
          reason: `${now.id} の中身が見せたときと違います`,
          state: now.state,
        });
        return null;
      }
      return now;
    };
    const first = await recheck();
    if (!first) break;

    if (defers(first)) {
      await updateState(deps.common, first, "ci-wait", stamp(), {
        approvedHead: deps.head,
        approvedFingerprint: computeFingerprint(first),
        note: "承認済み。CI が通ったら見張りが外す",
      });
      outcome.deferred.push(first.id);
      continue;
    }

    // 5. 間隔
    const last = await readLastWrite(deps.common);
    if (last !== null) {
      const gap = deps.outbound.interval.seconds * 1000;
      // 前の書き込みの時刻が未来にずれていても、間の長さを越えては待たない
      const wait = Math.min(last + gap - clock.now(), gap);
      if (wait > 0) {
        await clock.sleep(wait);
        // 見張りが送る案は、待つ間に時間帯の終わりを越えたかもしれない。外なら送らず、案も変えずに次の回に回す
        // （send は人が承認して流すので、入口と同じく時間帯を見ない）
        if (
          deps.mode === "watch" &&
          !inSendWindow(stamp(), deps.outbound.window)
        ) {
          outcome.held = {
            id: queued.id,
            reason: "送る時間帯の外です（次の回に回します）",
            why: "window",
          };
          outcome.remaining = items.slice(index + 1).map((i) => i.id);
          break;
        }
      }
    }

    // 待ちの間にロックを通らずに書き換えられたかもしれないので、読み直して照らし直す。
    // 「送っている」は、読み直した写しから書く（待つ前の古い写しで上書きしない）
    const item = await recheck();
    if (!item) break;

    // 送りのロックの中で、送る直前の確かめ（GitHub の今の先頭・CI など）
    if (deps.verify) {
      const checked = await deps.verify(item);
      if (!checked.ok) {
        outcome.held = {
          id: item.id,
          reason: checked.reason,
          why: checked.why,
        };
        outcome.remaining = items.slice(index + 1).map((i) => i.id);
        break;
      }
    }

    // 7. 秘密：送る直前にもう一度伏せる
    const body = redactBody(item.body, deps.env);

    // 送った印は送る前に書く。ここで落ちたら「送っている」のまま残り、確かでないとして扱う
    let sending: OutboxItem;
    try {
      sending = await updateState(deps.common, item, "sending", stamp());
    } catch (error) {
      const reason = `${item.id} の状態を書けませんでした：${messageOf(error)}`;
      try {
        await updateState(deps.common, item, "uncertain", stamp(), {
          note: reason,
        });
      } catch {
        // 書けないなら、そのまま止める
      }
      fail({ id: item.id, reason, state: "uncertain" });
      break;
    }

    try {
      await writeLastWrite(deps.common, clock.now());
      await deps.senders[item.kind]!(sending, body);
      await writeLastWrite(deps.common, clock.now());
    } catch (error) {
      const notSent = error instanceof NotSentError;
      const state: OutboxState = notSent ? "skipped" : "uncertain";
      const reason = `${item.id}（${KIND_TABLE[item.kind].label}）が落ちました：${messageOf(error)}`;
      await updateState(deps.common, sending, state, stamp(), { note: reason });
      await writeLastWrite(deps.common, clock.now()).catch(() => {});
      fail({ id: item.id, reason, state });
      break;
    }
    await updateState(deps.common, sending, "sent", stamp(), { note: null });
    outcome.sent.push(item.id);
  }
  return outcome;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
