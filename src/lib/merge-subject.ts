/**
 * 統合のマージの件名「〈integratorName〉: 〈ID〉 をマージする」を作る・見分ける（8章 integrate）。
 * ほかを読み込まない。Mac への束の道具（scripts/mac-patch/pack.ts）はこのファイルを写すが、その先の読み込みは写さないためと、
 * 後始末（finish.ts）と知らせ（main-check.ts）の読み込みの循環を避けるため */

const TAIL = " をマージする";

/** 統合のマージの件名を作る */
export function mergeSubject(integratorName: string, id: string): string {
  return `${integratorName}: ${id}${TAIL}`;
}

/** 件名の全体が統合のマージの件名なら ID（空白を含まない1語）を返す。当たらなければ null */
export function idFromMergeSubject(
  integratorName: string,
  subject: string,
): string | null {
  const escaped = integratorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}: (\\S+)${TAIL}$`).exec(subject);
  return match?.[1] ?? null;
}
