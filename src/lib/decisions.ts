/** 決定の記録（設定の decisionsFile）の確かめに使う、文字列からの関数（6章・8章 integrate） */

export const DRAFT_HEADING = "決定の記録の文案";

/** missing：節がない（中身が空も同じ）／none：「なし」だけ／present：中身がある */
export type DraftState = "missing" | "none" | "present";

/** 設計書の「決定の記録の文案」の節を読む */
export function readDecisionDraft(text: string): DraftState {
  const body: string[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && !line.startsWith("###")) {
      inSection = heading[1]!.trim().startsWith(DRAFT_HEADING);
      continue;
    }
    if (inSection) body.push(line);
  }
  if (body.join("\n").trim() === "") return "missing";
  // 行ごとに見る。src/lib/task-doc.ts の parsePrechanges の isNone と同じ決まりを写した
  // （なし・無し・ない・特になし、`<!--` の行は除く）。違い：「なし（…）」のかっこの書き添えも none にする
  const items: string[] = [];
  for (const line of body) {
    const item = line
      .trim()
      .replace(/^[-*+]\s+/, "")
      .trim();
    if (item === "" || item.startsWith("<!--")) continue;
    items.push(item.replace(/[*_`\s]/g, ""));
  }
  if (items.length === 0) return "missing";
  const isNone = (item: string) =>
    /^(なし|無し|ない|特になし)([。.]|[（(][^）)]*[）)][。.]?)?$/.test(item);
  return items.every(isNone) ? "none" : "present";
}

/** 記録のファイルが追記だけか：ブランチの中身の先頭が、base の中身とそのまま同じ */
export function startsWithBase(base: string, branch: string): boolean {
  return branch.startsWith(base);
}

/** git diff の出力から、足した行（「+」を除いたもの）を取り出す */
export function addedLinesOf(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split(/\r?\n/))
    if (line.startsWith("+") && !line.startsWith("+++"))
      out.push(line.slice(1));
  return out;
}

/** idPrefix と数字（英小文字が0〜1個）の形がある行。前後が ASCII の英数字なら当てない */
export function idLikeLines(
  lines: readonly string[],
  idPrefix: string,
): string[] {
  const escaped = idPrefix.replace(/[\\^$.*+?()[\]{}|/-]/g, (c) => `\\${c}`);
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])${escaped}[0-9]+[a-z]?(?![A-Za-z0-9])`,
  );
  return lines.filter((line) => pattern.test(line));
}
