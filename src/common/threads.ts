// GraphQL の答えの reviewThreads から、スレッドの数えを読む共通の部品（純粋な部分だけ。問い合わせの文と呼び出しは呼ぶ側）。
// Node の標準以外を読み込まない（test/common/common.test.ts が確かめる）。中身を変えたら manifest.json の版と要約値を直す。

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 新しい側のスレッドの読みの件数（問い合わせの reviewThreads(last: …) と合わせる） */
export const THREAD_PAGE = 30;
/** 古いスレッドを1回にめくる件数 */
export const OLDER_THREAD_PAGE = 100;
/** 1回の取得でめくる回数の上限（古いスレッド300件、新しい30件と合わせて330件まで） */
export const MAX_THREAD_FLIPS = 3;

/** 古い側の数え（めくって読んだ分だけ。complete は最後まで読めた印） */
export interface OlderThreads {
  read: number;
  unresolved: number;
  complete: boolean;
}

/**
 * 新しい側の読み。reviewThreads は `totalCount`・`pageInfo { hasPreviousPage startCursor }`・`nodes` を持つ答え（欠けていてもよい）。
 * nodes はオブジェクトのものだけ。total は合計（読めた件数より小さくしない。読めなければ null）。
 * older は古い側の数えの初期値（complete は前のページがある、または合計が分からず満杯のとき false）。
 * before は前があるときのめくりの起点（なければ null）
 */
export function readNewerThreads(reviewThreads: unknown): {
  nodes: Record<string, unknown>[];
  total: number | null;
  older: OlderThreads;
  before: string | null;
} {
  const rt = isObject(reviewThreads) ? reviewThreads : {};
  const raw = Array.isArray(rt.nodes) ? rt.nodes : [];
  const info = isObject(rt.pageInfo) ? rt.pageInfo : {};
  const cursor = typeof info.startCursor === "string" ? info.startCursor : null;
  const total =
    typeof rt.totalCount === "number"
      ? Math.max(rt.totalCount, raw.length)
      : null;
  return {
    nodes: raw.filter(isObject),
    total,
    older: {
      read: 0,
      unresolved: 0,
      // 前のページがある、または合計が分からず新しい側が満杯（前がないと言い切れない）ときは、まだ読みきれていない
      complete:
        info.hasPreviousPage !== true &&
        !(total === null && raw.length >= THREAD_PAGE),
    },
    before: info.hasPreviousPage === true ? cursor : null,
  };
}

/**
 * 古い側の1ページを older に足し込み（older を書き換える）、次のめくりの起点を返す（なければ null）。
 * reviewThreads は古い側の問い合わせの答え（`pageInfo { hasPreviousPage startCursor }`・`nodes { isResolved }`）。
 * 答えに PR がないときは null を渡す。
 * 最後まで読めた印は、前がもうないと答えが言ったときだけ立てる（答えに PR がない・印がない・起点がないときは残す）
 */
export function addOlderThreadsPage(
  older: OlderThreads,
  reviewThreads: unknown,
): string | null {
  const rt = isObject(reviewThreads) ? reviewThreads : null;
  const nodes = rt && Array.isArray(rt.nodes) ? rt.nodes.filter(isObject) : [];
  older.read += nodes.length;
  older.unresolved += nodes.filter((t) => t.isResolved !== true).length;
  const info = rt && isObject(rt.pageInfo) ? rt.pageInfo : {};
  const next = typeof info.startCursor === "string" ? info.startCursor : null;
  if (nodes.length > 0 && info.hasPreviousPage === true && next !== null)
    return next;
  if (rt !== null && info.hasPreviousPage === false) older.complete = true;
  return null;
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
