import { judgeMergeState } from "../../common/merge-state.ts";
import { countUnresolvedThreads } from "../../common/threads.ts";
import type { Person, PrDetail } from "../github-read.ts";
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

/** 時刻（ISO）を数に。読めなければ null */
const timeOf = (at: string | null | undefined): number | null => {
  if (typeof at !== "string") return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
};

/**
 * 初めての回の数え方：まだ答えていないものを数える（本文は見ず、書き手・時刻・ID だけ）。
 * - 解決されていないスレッドで最後の発言が自分でないとき、自分の最後の発言よりあとの、起こす書き手の発言
 * - PR のコメント・出したレビューのうち、起こす書き手のもので、自分の書き込みのいちばん新しい時刻よりあとのもの
 * 保留中（出していない）の発言は数えず、自分の書き込みの時刻にも入れない
 * 時刻が読めない他人のコメント・スレッドの発言は、答えていないとして数える（起こす側に倒す）
 */
function countUnanswered(
  viewer: string,
  detail: PrDetail,
): { review: number; comment: number } {
  const mine = (p: Person) => !isOther(p.author, viewer);
  // 保留中（出していない）の発言は、だれのものでも数えず、自分の書き込みの時刻にも入れない
  const published = (p: Person) => p.pending !== true;
  let lastMine: number | null = null;
  for (const p of [
    ...detail.reviews,
    ...detail.comments,
    ...detail.threads.flatMap((t) => t.comments),
  ]) {
    const t = mine(p) && published(p) ? timeOf(p.at) : null;
    if (t !== null && (lastMine === null || t > lastMine)) lastMine = t;
  }
  const unanswered = (p: Person) => {
    if (mine(p) || isQuiet(p) || !published(p)) return false;
    const t = timeOf(p.at);
    return t === null || lastMine === null || t > lastMine;
  };
  // 出していないレビュー（出した時刻がない）は数えない。時刻が読めない扱いにしない
  const submitted = (p: Person) => p.at != null && unanswered(p);
  let comment = 0;
  for (const thread of detail.threads) {
    const visible = thread.comments.filter(published);
    const last = visible.at(-1);
    if (thread.resolved || !last || mine(last)) continue;
    const myLast = visible.findLastIndex(mine);
    comment += visible
      .slice(myLast + 1)
      .filter((p) => isOther(p.author, viewer) && !isQuiet(p)).length;
  }
  comment += detail.comments.filter(unanswered).length;
  return { review: detail.reviews.filter(submitted).length, comment };
}

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

  const seen: Seen = {
    reviews: detail.reviews.map((r) => r.id),
    comments: [
      ...detail.comments,
      ...detail.threads.flatMap((t) => t.comments),
    ].map((c) => c.id),
    resolved: detail.threads.filter((t) => t.resolved).map((t) => t.id),
  };
  // 初めての回に見えていた PR の最初の中身：新しい ID でなく、まだ答えていないかで数える。CI は赤だけ
  if (prev?.baseline === true) {
    const { review, comment } = countUnanswered(viewer, detail);
    return {
      counts: { review, comment, resolved: 0, push: 0 },
      ciChanged: detail.ci === "failed",
      seen,
    };
  }

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
    seen,
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

// スレッドの数えは共通の部品に置く。今の名前で読めるよう、同じ名前で出し直す
export { countUnresolvedThreads };

/** 未解決のスレッドを数えないか：GitHub の判定が承認で、今の先頭に人の承認があるとき */
export const skipsThreads = (pr: {
  reviewDecision: string | null;
  headApproved?: boolean;
}) => pr.reviewDecision === "APPROVED" && pr.headApproved === true;

/**
 * 全員 OK の判定（実装8の merge-wait が使う）。レビューが承認され、マージできる状態（CLEAN か HAS_HOOKS）で、下書きでない。
 * GitHub が計算中（UNKNOWN）のときは OK にせず、読み直す案内を出す。マージできるかは共通の judgeMergeState が決める。
 * reviewDecision・mergeStateStatus は GitHub の値のまま。
 * reviewDecision が承認で、今の先頭に人の承認（headApproved）があるときは、未解決のスレッドの件数と数えきれないを外れの理由にせず、
 * 添え書き（note）に出す。
 * そのときほかの外れがマージできない状態だけで、その種類がブランチの保護（BLOCKED）なら、会話の解決の必須の旨を理由に添える
 * （衝突・古いベース・CI の落ちなどでは添えない）
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
  /** bot でない人が今の先頭に出した承認がある。省けば false */
  headApproved?: boolean;
}): { ok: boolean; reasons: string[]; note: string | null } {
  const reasons: string[] = [];
  const skip = skipsThreads(pr);
  const unresolved = pr.unresolvedThreads ?? 0;
  if (pr.isDraft === true) reasons.push("下書きのままです");
  if (pr.reviewDecision !== "APPROVED")
    reasons.push(
      `レビューが承認されていません（${pr.reviewDecision ?? "なし"}）`,
    );
  const merge = judgeMergeState({ mergeStateStatus: pr.mergeStateStatus });
  let mergeReasonAt = -1;
  if (!merge.ok) {
    mergeReasonAt = reasons.length;
    reasons.push(
      merge.reason === "computing"
        ? "GitHub がまだマージできるかを計算中です。少し待って、もう一度確かめてください"
        : `マージできる状態ではありません（${pr.mergeStateStatus ?? "不明"}）`,
    );
  }
  if (!skip && unresolved > 0)
    reasons.push(`未解決のスレッドが${unresolved}件あります`);
  if (!skip && pr.threadsTruncated === true)
    reasons.push(
      typeof pr.threadTotal === "number"
        ? `スレッドが${pr.threadTotal}件あり、古い未解決を数えきれません`
        : "スレッドの合計が分からず、古い未解決を数えきれません",
    );
  let note: string | null = null;
  if (skip && (unresolved > 0 || pr.threadsTruncated === true)) {
    // 数えきれないときの読めた数は下限なので、件数は出さない
    note =
      pr.threadsTruncated !== true && unresolved > 0
        ? `未解決のスレッドが${unresolved}件あるが、今の先頭に承認があるので数えない`
        : "未解決のスレッドがあるが、今の先頭に承認があるので数えない";
    // ブランチの保護（BLOCKED）だけが外れなら、会話の解決の必須が原因かもしれない。衝突・古いベースなどでは添えない
    if (
      unresolved > 0 &&
      reasons.length === 1 &&
      mergeReasonAt === 0 &&
      !merge.ok &&
      merge.reason === "protected"
    )
      reasons[0] +=
        "。ブランチの保護で会話の解決を必須にしていると、Resolve するまでマージできません";
  }
  return { ok: reasons.length === 0, reasons, note };
}
