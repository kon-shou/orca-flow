// GitHub の「マージできるか」の判定の共通の部品。Node の標準以外を読み込まない（test/common/common.test.ts が確かめる）。
// 日本語の文は返さず、理由の種類だけ返す。中身を変えたら manifest.json の版と要約値を直す。

/** マージできない理由の種類 */
export type MergeBlockReason =
  /** 衝突している（mergeable が CONFLICTING、または mergeStateStatus が DIRTY） */
  | "conflict"
  /** GitHub がまだ計算中（UNKNOWN）。時間をおいて読み直す */
  | "computing"
  /** ブランチの保護の条件を満たしていない（BLOCKED） */
  | "protected"
  /** ベースより古い（BEHIND） */
  | "behind"
  /** 下書き（DRAFT） */
  | "draft"
  /** CI が通っていない（UNSTABLE） */
  | "ci"
  /** 値が無い・知らない値で決められない */
  | "unknown";

export type MergeStateJudgement =
  { ok: true } | { ok: false; reason: MergeBlockReason };

/**
 * mergeable と mergeStateStatus（どちらも GitHub の値のまま。省いてよい）から、マージできるかを返す。
 * mergeable を先に見る：CONFLICTING は衝突、UNKNOWN は計算中。そうでなければ mergeStateStatus を見る
 * （CLEAN・HAS_HOOKS が OK）。mergeStateStatus がなく mergeable が MERGEABLE なら OK、どちらもなければ分からない
 */
export function judgeMergeState(input: {
  mergeable?: string | null;
  mergeStateStatus?: string | null;
}): MergeStateJudgement {
  const { mergeable, mergeStateStatus: status } = input;
  if (mergeable === "CONFLICTING") return { ok: false, reason: "conflict" };
  if (mergeable === "UNKNOWN") return { ok: false, reason: "computing" };
  if (status === null || status === undefined) {
    return mergeable === "MERGEABLE"
      ? { ok: true }
      : { ok: false, reason: "unknown" };
  }
  switch (status) {
    case "CLEAN":
    case "HAS_HOOKS":
      return { ok: true };
    case "DIRTY":
      return { ok: false, reason: "conflict" };
    case "BLOCKED":
      return { ok: false, reason: "protected" };
    case "BEHIND":
      return { ok: false, reason: "behind" };
    case "DRAFT":
      return { ok: false, reason: "draft" };
    case "UNSTABLE":
      return { ok: false, reason: "ci" };
    case "UNKNOWN":
      return { ok: false, reason: "computing" };
    default:
      return { ok: false, reason: "unknown" };
  }
}
