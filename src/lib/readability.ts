/** 設計書（9.3）が人に読みやすい形かを確かめる。警告を返すだけで、落とさない */

/** 「要点」の空でない行の上限 */
export const MAX_SUMMARY_LINES = 10;
/** 箇条書きの1項目の文字数の上限 */
export const MAX_BULLET_CHARS = 150;
/** 表のセルの文字数の上限 */
export const MAX_TABLE_CELL_CHARS = 60;
/** コードブロックの行数の上限 */
export const MAX_CODE_LINES = 5;
/** 「作るもの」の一番上の番号つきの項目がこの数以上なら、タスクを分けることを考える */
export const SPLIT_TASK_ITEMS = 8;

/** 要点の最初の箇条書きが始まるべき見出しの文字（コロンは全角・半角どちらも認める） */
export const PURPOSE_LABEL = "目的";

/** 警告に入れる、項目の先頭の文字数 */
const HEAD_CHARS = 20;

const SECTION_SUMMARY = "要点";
const SECTION_ITEMS = "作るもの";
/** 最初の「## 見出し」より前の行の節の名前 */
const BEFORE_SECTIONS = "見出しの前";

/** 見た目の1文字を1つと数える */
const length = (text: string) => [...text].length;

const head = (text: string) => {
  const chars = [...text];
  return chars.length > HEAD_CHARS
    ? `${chars.slice(0, HEAD_CHARS).join("")}…`
    : text;
};

/** 表の行をセルに分ける。「\|」はセルの区切りにしない */
function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const isTableSeparator = (cells: string[]) =>
  cells.every((cell) => /^:?-+:?$/.test(cell));

interface Section {
  name: string;
  lines: string[];
}

export function readabilityWarnings(text: string): string[] {
  const warnings: string[] = [];
  const sections: Section[] = [];
  let current: Section = { name: BEFORE_SECTIONS, lines: [] };
  let fence: { section: string; lines: number } | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence) {
        if (fence.lines > MAX_CODE_LINES)
          warnings.push(
            `「${fence.section}」のコードブロックが${fence.lines}行あります（${MAX_CODE_LINES}行以内にする。コードは貼らず、文で書く）`,
          );
        fence = null;
      } else {
        fence = { section: current.name, lines: 0 };
      }
      continue;
    }
    if (fence) {
      fence.lines++;
      continue;
    }

    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && !line.startsWith("###")) {
      current = { name: heading[1]!.trim(), lines: [] };
      sections.push(current);
      continue;
    }
    current.lines.push(line);

    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const body = bullet[1]!.trim();
      const n = length(body);
      if (n > MAX_BULLET_CHARS)
        warnings.push(
          `「${current.name}」の箇条書き「${head(body)}」が${n}文字あります（${MAX_BULLET_CHARS}文字以内にする。分けるか、細部を担当に任せる）`,
        );
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const cells = tableCells(line);
      if (isTableSeparator(cells)) continue;
      for (const cell of cells) {
        const n = length(cell);
        if (n > MAX_TABLE_CELL_CHARS)
          warnings.push(
            `「${current.name}」の表のセル「${head(cell)}」が${n}文字あります（${MAX_TABLE_CELL_CHARS}文字以内にする。説明は表の下に書く）`,
          );
      }
    }
  }
  if (fence && fence.lines > MAX_CODE_LINES)
    warnings.push(
      `「${fence.section}」のコードブロックが${fence.lines}行あります（${MAX_CODE_LINES}行以内にする。コードは貼らず、文で書く）`,
    );

  const find = (name: string) =>
    sections.find((s) => s.name === name) ??
    sections.find((s) => s.name.startsWith(name));

  const summary = find(SECTION_SUMMARY);
  if (!summary) {
    warnings.unshift(
      `「${SECTION_SUMMARY}」の節がありません（設計書の最初に書く。人はここだけ読んで承認するかを決める）`,
    );
  } else {
    const n = summary.lines.filter((line) => line.trim() !== "").length;
    if (n > MAX_SUMMARY_LINES)
      warnings.unshift(
        `「${SECTION_SUMMARY}」が${n}行あります（${MAX_SUMMARY_LINES}行以内にする）`,
      );
    const firstBullet = summary.lines.find((line) =>
      /^\s*(?:[-*+]|\d+[.)])\s+/.test(line),
    );
    const startsWithPurpose =
      firstBullet !== undefined &&
      new RegExp(`^\\s*(?:[-*+]|\\d+[.)])\\s+${PURPOSE_LABEL}[：:]`).test(
        firstBullet,
      );
    if (!startsWithPurpose)
      warnings.push(
        `「${SECTION_SUMMARY}」の最初の箇条書きが「${PURPOSE_LABEL}：」で始まっていません（このタスクをなぜやるのかを1〜2文で、1行目に書く）`,
      );
  }

  const items = find(SECTION_ITEMS);
  if (items) {
    const n = items.lines.filter((line) => /^\d+[.)]\s/.test(line)).length;
    if (n >= SPLIT_TASK_ITEMS)
      warnings.push(
        `「${SECTION_ITEMS}」の番号つきの項目が${n}個あります（${SPLIT_TASK_ITEMS}個以上あるので、タスクを分けることを考える）`,
      );
  }
  return warnings;
}
