import type { PrDetail } from "../github-read.ts";
import type { Counts, PrEntry, Seen } from "./types.ts";

// 動きの見分け。自分のアカウント（GraphQL の viewer）の書き込みと、send が送った push の先頭は、
// PR の更新の時刻を動かしても動きに数えない（自分の返信で自分を起こし続ける輪を作らないため）。

export interface Classified {
  counts: Counts;
  /** CI の結果が前回と違う */
  ciChanged: boolean;
  /** 今回見た中身の ID（次の回の前回の値） */
  seen: Seen;
}

const isOther = (author: string | null, viewer: string) => author !== viewer;

/** 起こす立場：リポジトリの持ち主・組織のメンバー・共同作業者だけ */
const WAKING_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** 立場によらず起こす bot の名前（コードの定数。設定にしない）。大小を区別せず、末尾の [bot] を外して比べる */
const WAKING_BOTS: ReadonlySet<string> = new Set([
  "coderabbitai",
  "copilot-pull-request-reviewer",
  "github-actions",
]);

const isWakingBot = (author: string | null | undefined) =>
  typeof author === "string" &&
  WAKING_BOTS.has(author.toLowerCase().replace(/\[bot\]$/, ""));

/** 起こさない書き手か：許す3つの bot を除く Bot は立場によらず、そうでなければ立場が分かっていて起こす立場でないとき。立場が読めないときは起こす */
const isQuiet = (p: {
  author?: string | null;
  association?: string | null;
  bot?: boolean;
}) =>
  p.bot === true
    ? !isWakingBot(p.author)
    : typeof p.association === "string" &&
      p.association !== "" &&
      !WAKING_ASSOCIATIONS.has(p.association);

/**
 * 前回の値と今の中身から、動きの件数を出す。
 * ownHeads は、自分が送った（send の push・PR の作成・push の記録の）先頭。そこへの先頭の変化は数えない
 */
export function classifyDetail(input: {
  viewer: string;
  prev: PrEntry | undefined;
  detail: PrDetail;
  ownHeads: ReadonlySet<string>;
}): Classified {
  const { viewer, prev, detail, ownHeads } = input;
  const before = prev?.seen ?? { reviews: [], comments: [], resolved: [] };
  const knownReviews = new Set(before.reviews);
  const knownComments = new Set(before.comments);
  const knownResolved = new Set(before.resolved);

  const threadComments = detail.threads.flatMap((t) => t.comments);
  const newReviews = detail.reviews.filter(
    (r) => isOther(r.author, viewer) && !knownReviews.has(r.id),
  );
  const newComments = [...detail.comments, ...threadComments].filter(
    (c) => isOther(c.author, viewer) && !knownComments.has(c.id),
  );
  const review = newReviews.length;
  const comment = newComments.length;
  const quiet =
    newReviews.filter(isQuiet).length + newComments.filter(isQuiet).length;
  const resolved = detail.threads.filter(
    (t) =>
      t.resolved && isOther(t.resolvedBy, viewer) && !knownResolved.has(t.id),
  ).length;
  const pushed =
    prev?.head != null &&
    detail.head !== null &&
    detail.head !== prev.head &&
    !ownHeads.has(detail.head)
      ? 1
      : 0;

  return {
    counts: {
      review,
      comment,
      resolved,
      push: pushed,
      ...(quiet > 0 ? { quiet } : {}),
    },
    ciChanged: prev?.ci !== detail.ci,
    seen: {
      reviews: detail.reviews.map((r) => r.id),
      comments: [...detail.comments, ...threadComments].map((c) => c.id),
      resolved: detail.threads.filter((t) => t.resolved).map((t) => t.id),
    },
  };
}

export const hasEvents = (c: Counts) =>
  c.review + c.comment + c.resolved + c.push > 0;

/** 一言に出す動きの内訳（件数と種類だけ。他人の文章は入れない） */
export function describeCounts(c: Counts): string[] {
  const parts: string[] = [];
  if (c.review > 0) parts.push(`レビュー${c.review}件`);
  if (c.comment > 0) parts.push(`コメント${c.comment}件`);
  if (c.resolved > 0) parts.push(`スレッドの解決${c.resolved}件`);
  if (c.push > 0) parts.push("新しい push");
  return parts;
}

/**
 * スレッドの並びから、未解決の数と「数えきれていないか」を出す。
 * 新しい側の読み・めくって読んだ古い側の数えの合計が、スレッドの合計に届かないとき、または最後まで読めた印がないとき数えきれない。
 * 合計が読めないときは total を null にする（誤った小さい数を出さない）
 */
export function countUnresolvedThreads(detail: {
  threads: { resolved: boolean }[];
  /** スレッドの合計。null は読めなかった（分からない） */
  threadTotal: number | null;
  olderThreads: { read: number; unresolved: number; complete?: boolean };
}): { unresolved: number; truncated: boolean; total: number | null } {
  const read = detail.threads.length + detail.olderThreads.read;
  return {
    unresolved:
      detail.threads.filter((t) => !t.resolved).length +
      detail.olderThreads.unresolved,
    truncated:
      (detail.threadTotal !== null && read < detail.threadTotal) ||
      detail.olderThreads.complete === false,
    total:
      detail.threadTotal === null
        ? null
        : Math.max(detail.threadTotal, detail.threads.length),
  };
}

/**
 * 全員 OK の判定（実装8の merge-wait が使う）。レビューが承認され、マージできる状態（CLEAN）で、下書きでない。
 * reviewDecision・mergeStateStatus は GitHub の値のまま
 */
export function judgeAllOk(pr: {
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  isDraft?: boolean;
  /** 未解決のレビューのスレッドの数。省けば0 */
  unresolvedThreads?: number;
  /** スレッドが読みの上限に達し、未解決を数えきれない。省けば false */
  threadsTruncated?: boolean;
  /** スレッドの合計の件数（数えきれない理由に出す） */
  threadTotal?: number | null;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (pr.isDraft === true) reasons.push("下書きのままです");
  if (pr.reviewDecision !== "APPROVED")
    reasons.push(
      `レビューが承認されていません（${pr.reviewDecision ?? "なし"}）`,
    );
  if (pr.mergeStateStatus !== "CLEAN")
    reasons.push(
      `マージできる状態ではありません（${pr.mergeStateStatus ?? "不明"}）`,
    );
  if ((pr.unresolvedThreads ?? 0) > 0)
    reasons.push(`未解決のスレッドが${pr.unresolvedThreads}件あります`);
  if (pr.threadsTruncated === true)
    reasons.push(
      typeof pr.threadTotal === "number"
        ? `スレッドが${pr.threadTotal}件あり、古い未解決を数えきれません`
        : "スレッドの合計が分からず、古い未解決を数えきれません",
    );
  return { ok: reasons.length === 0, reasons };
}
