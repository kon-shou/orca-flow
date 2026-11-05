import type { CiResult } from "../github.ts";

// 見張りの記録（pr-watch/state.json）の形。他人の文章は入れない（件数・ID・種類だけ）。

/** 動きの種類。ci はカードの状態を変えるだけで、未読にはしない（落ちたときは別） */
export type EventKind =
  "review" | "comment" | "resolved" | "ci" | "push" | "merged" | "closed";

/** 動きの件数（review・comment・resolved・push） */
export interface Counts {
  review: number;
  comment: number;
  resolved: number;
  push: number;
  /**
   * review・comment のうち、起こさない分（外の人と、許す3つの bot を除く bot）の件数。合計は review・comment のまま。
   * 0 のときと古い記録では省く（省けば全部を起こす分として読む）。立場や bot の印は残さず件数だけ
   */
  quiet?: number;
}

export const NO_COUNTS: Counts = {
  review: 0,
  comment: 0,
  resolved: 0,
  push: 0,
};

/** 前回までに見た中身の ID（新しいものを見分けるため） */
export interface Seen {
  reviews: string[];
  comments: string[];
  /** 今解決されているスレッドの ID */
  resolved: string[];
}

/** 見ている PR の前回の値 */
export interface PrEntry {
  number: number;
  url: string;
  branch: string;
  taskId: string | null;
  /** まだ中身を読んでいない間は null */
  updatedAt: string | null;
  head: string | null;
  ci: CiResult | null;
  isDraft: boolean | null;
  seen: Seen | null;
  /** 初めて動かした回に見えていた PR。最初の中身は動きに数えない */
  baseline: boolean;
  /** 承認済み・CI 待ちの案があれば、見張りが下書きを外しに行く */
  releasePending: boolean;
  /** 前回の回で全員 OK（judgeAllOk が通る）と判定した。なければ false 扱い。変わった回はカードを書き直す */
  allOk?: boolean;
  /** 解除を断られた（断り・CI が通っていない）ときの先頭と CI。先頭か CI が変わるまで解除を立て直さない */
  releaseStop?: { head: string | null; ci: CiResult | null } | null;
  /** マージ・クローズ・見つからない、を見つけたあと。もう問い合わせない */
  final: "merged" | "closed" | "gone" | null;
  finalAt: string | null;
}

/** 背景に渡す仕事（PR ごと）。中身は件数と種類だけ */
export interface WorkItem {
  number: number;
  url: string;
  taskId: string;
  branch: string;
  /** 足されるたびに増える。背景は読んだ版のときだけ消す */
  rev: number;
  counts: Counts;
  ciChanged: boolean;
  ci: CiResult | null;
  isDraft: boolean | null;
  head: string | null;
  /** 下書きの解除を試す */
  release: boolean;
  /** send が置いた書き直しの印があった。カードを今の状態で書き直す */
  refresh: boolean;
  /** 今の回の判定が全員 OK。カードを「マージ待ち」にする（なければ false 扱い） */
  allOk?: boolean;
  end: "merged" | "closed" | null;
  mergeCommit: string | null;
  mergedAt: string | null;
  at: string;
  /** この仕事を最初に積んだ時刻（やり直しの上限に使う。足されても変えない） */
  since?: string;
  /** 背景が試して終わらなかった回数（やり直しの上限に使う） */
  tries?: number;
}

/** 起こせずに待っている理由（draft・bash・unverifiable・ambiguous は入力欄とターミナル、failed は Orca の失敗） */
export type WaitReason =
  | "draft"
  | "bash"
  | "unverifiable"
  | "ambiguous"
  | "failed"
  | "limit"
  | "interval";

/** 起こしの記録（PR ごと）。レビュー・コメント・CI の赤を見つけたときに立てる。中身は理由の種類と時刻だけ */
export interface WakeEntry {
  number: number;
  taskId: string;
  /** まだ起こせていない（次の回に回す） */
  pending: boolean;
  /** 待っている理由。pending でないときは null */
  wait: WaitReason | null;
  /** 最後に起こした時刻（同じ PR の間隔に使う）。会話を立てる呼び出しが落ちた回は、起こせていなくても試した時刻が入る */
  lastWokeAt: string | null;
  /** 最後に重ねた仕事（since#rev）。同じ仕事を2回読んでも1回しか数えない */
  registeredKey: string | null;
  /** カードの一言の元（件数と種類だけ。他人の文章は入れない） */
  baseComment: string | null;
  /** カードの一言に今出している待ちの理由 */
  noteReason: WaitReason | null;
  since: string;
}

/** 見張りが立てた会話。ターミナルが生きている数を上限に数える */
export interface LaunchedConversation {
  taskId: string;
  worktreePath: string;
  /** 立てた時刻（立てた直後でターミナルがまだ見えない間も数に入れる） */
  at: string;
  /** ターミナルの一覧を最初に確かめられなかった時刻（確かめられたら消す。前の版の記録にはない） */
  unverifiableSince?: string;
}

export type RunResult = "success" | "skipped" | "failed" | "rate-limited";

export interface RunRecord {
  at: string;
  result: RunResult;
  reason: string | null;
}

export interface WatchFile {
  version: 1;
  /** 初めての回を終えたか（最初の中身を動きに数えないため） */
  initialized: boolean;
  viewer: string | null;
  /** 上限の印のあと、この時刻まで gh を呼ばない */
  rateLimitedUntil: string | null;
  lastRun: RunRecord | null;
  lastSuccessAt: string | null;
  /** 最後に失敗した回（成功のあとも残す） */
  lastFailure: RunRecord | null;
  lastBackground: { at: string; ok: boolean; reason: string | null } | null;
  prs: Record<string, PrEntry>;
  work: Record<string, WorkItem>;
  /** 起こしの記録（PR の番号ごと） */
  wakes: Record<string, WakeEntry>;
  /** 見張りが立てた会話（タスクの ID ごと） */
  launched: Record<string, LaunchedConversation>;
}

export const emptyState = (): WatchFile => ({
  version: 1,
  initialized: false,
  viewer: null,
  rateLimitedUntil: null,
  lastRun: null,
  lastSuccessAt: null,
  lastFailure: null,
  lastBackground: null,
  prs: {},
  work: {},
  wakes: {},
  launched: {},
});

/** 使った回数の1行（usage-〈日付〉.jsonl） */
export interface UsageLine {
  at: string;
  result: RunResult;
  reason: string | null;
  /** 問い合わせた GraphQL の回数 */
  calls: number;
  /** 使った点数（rateLimit.cost の合計） */
  cost: number;
  /** 回のあとの残り */
  remaining: number | null;
  /** 2段目に入れた PR の数と、次の回に回した数 */
  moved: number;
  deferred: number;
  /** 背景を起こしたか */
  launched: boolean;
}
