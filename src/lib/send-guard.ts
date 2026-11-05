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

// 送る前の確かめ（8章『送る前の確かめ』）：許可リスト・束の指紋・先頭・間隔・二重・秘密。
// send の入口がある。GitHub に書く関数は、ここを通った案にだけ呼ばれる。

// 送る関数が「何も書かずに落ちた」と言うときの NotSentError は outbox.ts（種類の表）にある
export { NotSentError };

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
 * send の入口の確かめ（1・2・3）。落ちたら FlowError(1)。
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
  /** 落ちた案（なければ null）。落ちたら残りは送らない */
  failed: SendFailure | null;
  /** 落ちたために送らなかった残り（積んだまま） */
  remaining: string[];
}

export interface SendDeps {
  common: string;
  outbound: OutboundConfig;
  env: NodeJS.ProcessEnv;
  /** 種類ごとの送る関数 */
  senders: Senders;
  clock?: Clock;
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
  return withOutboxLock(deps.common, () => sendItemsLocked(deps, items), {
    kind: "send",
  });
}

async function sendItemsLocked(
  deps: SendDeps,
  items: readonly OutboxItem[],
): Promise<SendOutcome> {
  const clock = deps.clock ?? realClock;
  const from: OutboxState = "queued";
  const outcome: SendOutcome = {
    sent: [],
    failed: null,
    remaining: [],
  };
  const stamp = () => new Date(clock.now());

  // 送る関数がない種類があれば、何も書く前に断る
  for (const item of items)
    if (!deps.outbound.allow.includes(item.kind) || !deps.senders[item.kind])
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

    // 5. 間隔
    const last = await readLastWrite(deps.common);
    if (last !== null) {
      const gap = deps.outbound.interval.seconds * 1000;
      // 前の書き込みの時刻が未来にずれていても、間の長さを越えては待たない
      const wait = Math.min(last + gap - clock.now(), gap);
      if (wait > 0) {
        await clock.sleep(wait);
      }
    }

    // 待ちの間にロックを通らずに書き換えられたかもしれないので、読み直して照らし直す。
    // 「送っている」は、読み直した写しから書く（待つ前の古い写しで上書きしない）
    const item = await recheck();
    if (!item) break;

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
