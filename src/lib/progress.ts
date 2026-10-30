import type { ProgressConfig } from "../config.ts";

/** 進捗表の書き換え（8章）。ほかの行と表の外は1文字も変えない */

type ColumnKey = keyof ProgressConfig["columns"];

interface Table {
  /** 見出しの行の番号 */
  header: number;
  /** 最後の行の番号（見出しと区切りだけなら区切りの行） */
  last: number;
  /** 列の名前 → 列の位置 */
  index: Record<ColumnKey, number | undefined>;
  width: number;
}

/** 表の行を「|」の位置で分ける。`\|` は区切りにしない */
function pipePositions(line: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\") positions.push(i);
  }
  return positions;
}

function cells(line: string): string[] {
  const pipes = pipePositions(line);
  const out: string[] = [];
  const trimmed = line.trim();
  const leading = trimmed.startsWith("|");
  const bounds = leading ? pipes : [-1, ...pipes];
  for (let i = 0; i < bounds.length - 1; i++) {
    out.push(line.slice(bounds[i]! + 1, bounds[i + 1]).trim());
  }
  const lastPipe = pipes[pipes.length - 1];
  if (lastPipe !== undefined && line.slice(lastPipe + 1).trim() !== "")
    out.push(line.slice(lastPipe + 1).trim());
  return out;
}

const isTableLine = (line: string) => line.trim().startsWith("|");
const isSeparator = (line: string) =>
  /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);

/** セルの中身を比べる形にする（バッククォートと太字を取る） */
const bare = (cell: string) => cell.replace(/[`*]/g, "").trim();

function findTable(lines: string[], config: ProgressConfig): Table | null {
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableLine(lines[i]!) || !isSeparator(lines[i + 1]!)) continue;
    const head = cells(lines[i]!).map(bare);
    const idCol = head.indexOf(config.columns.id);
    if (idCol < 0) continue;
    const index = {} as Record<ColumnKey, number | undefined>;
    for (const key of Object.keys(config.columns) as ColumnKey[]) {
      const at = head.indexOf(config.columns[key]);
      index[key] = at < 0 ? undefined : at;
    }
    let last = i + 1;
    while (last + 1 < lines.length && isTableLine(lines[last + 1]!)) last++;
    return { header: i, last, index, width: head.length };
  }
  return null;
}

const escapeCell = (value: string) =>
  value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

/** 改行の形を保ったまま行に分ける */
function splitKeep(text: string): { lines: string[]; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(eol), eol };
}

export class ProgressError extends Error {}

/** 表の ID の列の値 */
export function progressIds(text: string, config: ProgressConfig): string[] {
  const { lines } = splitKeep(text);
  const table = findTable(lines, config);
  if (!table) return [];
  const idCol = table.index.id!;
  const ids: string[] = [];
  for (let i = table.header + 2; i <= table.last; i++) {
    const id = bare(cells(lines[i]!)[idCol] ?? "");
    if (id !== "") ids.push(id);
  }
  return ids;
}

/** ID の行の、指定の列だけを書き換える。表・行・列がなければ ProgressError */
export function setCell(
  text: string,
  config: ProgressConfig,
  id: string,
  column: ColumnKey,
  value: string,
): string {
  const { lines, eol } = splitKeep(text);
  const table = findTable(lines, config);
  if (!table)
    throw new ProgressError(
      `進捗表 ${config.file} に「${config.columns.id}」の列のある表が見つかりません`,
    );
  const col = table.index[column];
  if (col === undefined)
    throw new ProgressError(
      `進捗表 ${config.file} に「${config.columns[column]}」の列がありません`,
    );
  const idCol = table.index.id!;
  for (let i = table.header + 2; i <= table.last; i++) {
    const line = lines[i]!;
    if (bare(cells(line)[idCol] ?? "") !== id) continue;
    const pipes = pipePositions(line);
    const leading = line.trim().startsWith("|");
    const bounds = leading ? pipes : [-1, ...pipes];
    const start = bounds[col];
    const end = bounds[col + 1];
    if (start === undefined) break;
    const stop = end ?? line.length;
    const cell = line.slice(start + 1, stop);
    const blank = cell.trim() === "";
    const before = blank ? " " : /^\s*/.exec(cell)![0] || " ";
    const after = blank
      ? " "
      : /\s*$/.exec(cell)![0] || (end === undefined ? "" : " ");
    lines[i] =
      line.slice(0, start + 1) +
      before +
      escapeCell(value) +
      after +
      line.slice(stop);
    return lines.join(eol);
  }
  throw new ProgressError(`進捗表 ${config.file} に ${id} の行がありません`);
}

/** 表の最後に行を足す。書いていない列は空にする */
export function addRow(
  text: string,
  config: ProgressConfig,
  values: Partial<Record<ColumnKey, string>>,
): string {
  const { lines, eol } = splitKeep(text);
  const table = findTable(lines, config);
  if (!table)
    throw new ProgressError(
      `進捗表 ${config.file} に「${config.columns.id}」の列のある表が見つかりません`,
    );
  const row: string[] = Array.from({ length: table.width }, () => "");
  for (const key of Object.keys(values) as ColumnKey[]) {
    const col = table.index[key];
    if (col !== undefined) row[col] = escapeCell(values[key] ?? "");
  }
  const line = `| ${row.join(" | ")} |`.replace(/ {2}\|/g, " |");
  lines.splice(table.last + 1, 0, line);
  return lines.join(eol);
}
