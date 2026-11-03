import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandContext } from "../types.ts";
import { gitCommonDir } from "./git.ts";

// 段の記録：状態が変わるたびに1行足す。`〈git の共通ディレクトリ〉/orca-flow/stages/〈ID〉.jsonl` に置く。

/** 記録の1行（状態が変わったときの時刻・状態・一言・書いたコマンド） */
export interface StageEntry {
  /** 状態が変わった時刻（ISO） */
  at: string;
  state: string;
  note: string | null;
  /** 書いたコマンド（status・approve・new・integrate など） */
  command: string;
}

export const stagesDir = (common: string) =>
  path.join(common, "orca-flow", "stages");

export const stagesPath = (common: string, id: string) =>
  path.join(stagesDir(common), `${id}.jsonl`);

/** 一言を空白を1つにまとめて整える。空なら null */
function cleanNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const text = note.replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** 記録の1行を末尾に足す（ロックは取らない） */
export async function appendStage(
  common: string,
  id: string,
  entry: StageEntry,
): Promise<void> {
  await mkdir(stagesDir(common), { recursive: true });
  await appendFile(
    stagesPath(common, id),
    `${JSON.stringify({ ...entry, note: cleanNote(entry.note) })}\n`,
  );
}

/**
 * 状態の変化を記録する。失敗しても警告だけで、呼び出し元の処理は止めない
 */
export async function recordStage(
  ctx: CommandContext,
  root: string,
  id: string,
  state: string,
  note: string | null | undefined,
  command: string,
): Promise<void> {
  try {
    const common = await gitCommonDir(ctx.runner, root);
    await appendStage(common, id, {
      at: ctx.now().toISOString(),
      state,
      note: cleanNote(note),
      command,
    });
  } catch (error) {
    ctx.stderr(
      `警告：段の記録を書けませんでした（${error instanceof Error ? error.message : String(error)}）。状態の更新は続けます`,
    );
  }
}

export interface ParsedStages {
  /** 時刻の順（同じ時刻は書かれた順）。最後の new の行から後ろだけ */
  entries: StageEntry[];
  /** 読めなかった行の数（最後の new より前の行も数える） */
  broken: number;
}

/** 記録を読む。壊れた行は飛ばして数える。時刻の順に並べ、最後の new の行より前は捨てる */
export function parseStages(text: string): ParsedStages {
  const all: StageEntry[] = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      const v = value as Record<string, unknown>;
      if (
        typeof value !== "object" ||
        value === null ||
        typeof v.at !== "string" ||
        Number.isNaN(Date.parse(v.at)) ||
        typeof v.state !== "string" ||
        typeof v.command !== "string" ||
        (v.note !== null && typeof v.note !== "string")
      ) {
        broken++;
        continue;
      }
      all.push({
        at: v.at,
        state: v.state,
        note: v.note as string | null,
        command: v.command,
      });
    } catch {
      broken++;
    }
  }
  const sorted = all
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Date.parse(a.entry.at) - Date.parse(b.entry.at) || a.index - b.index,
    )
    .map((x) => x.entry);
  const lastNew = sorted.map((e) => e.command).lastIndexOf("new");
  return { entries: lastNew > 0 ? sorted.slice(lastNew) : sorted, broken };
}

/** 記録のファイルを読む。なければ null */
export async function readStages(
  common: string,
  id: string,
): Promise<ParsedStages | null> {
  let text: string;
  try {
    text = await readFile(stagesPath(common, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseStages(text);
}

/** 記録のあるタスクの ID（並べ替え済み）。ディレクトリがなければ空 */
export async function listStageIds(common: string): Promise<string[]> {
  try {
    return (await readdir(stagesDir(common)))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// 番の分け方
export type Turn = "タスク長" | "待ち" | "そのほか";

const LEAD_STATES = ["designing", "working"];
const WAIT_STATES = ["spec-review", "question", "integrate-wait"];

export function turnOf(state: string): Turn {
  if (LEAD_STATES.includes(state)) return "タスク長";
  if (WAIT_STATES.includes(state)) return "待ち";
  return "そのほか";
}

/** working の一言の数字を「〈数〉」にまとめる。一言がなければ「（一言なし）」 */
export function noteKey(note: string | null): string {
  return note === null ? "（一言なし）" : note.replace(/\d+/g, "〈数〉");
}

export interface Segment {
  at: string;
  state: string;
  note: string | null;
  seconds: number;
  /** 統合前で、今の時刻まで数えた段 */
  open: boolean;
}

export interface TaskTiming {
  segments: Segment[];
  integrated: boolean;
  /** 統合した時刻（ISO）。統合前は null */
  integratedAt: string | null;
  /** 最初の行から統合まで（統合前は今まで）の秒 */
  totalSeconds: number;
  byState: Map<string, number>;
  /** working の一言ごと */
  byNote: Map<string, number>;
  byTurn: Map<Turn, number>;
}

const add = <K>(map: Map<K, number>, key: K, value: number) =>
  map.set(key, (map.get(key) ?? 0) + value);

/** 各行から次の行までをその段の時間にする。integrated の行は終わりの印で、段には数えない */
export function computeTiming(entries: StageEntry[], now: Date): TaskTiming {
  const end = entries.findIndex((e) => e.state === "integrated");
  const used = end >= 0 ? entries.slice(0, end) : entries;
  const endTime = end >= 0 ? Date.parse(entries[end]!.at) : now.getTime();
  const segments: Segment[] = [];
  const byState = new Map<string, number>();
  const byNote = new Map<string, number>();
  const byTurn = new Map<Turn, number>();
  used.forEach((entry, i) => {
    const start = Date.parse(entry.at);
    const next = i + 1 < used.length ? Date.parse(used[i + 1]!.at) : endTime;
    const seconds = Math.max(0, Math.round((next - start) / 1000));
    const open = end < 0 && i === used.length - 1;
    segments.push({
      at: entry.at,
      state: entry.state,
      note: entry.note,
      seconds,
      open,
    });
    add(byState, entry.state, seconds);
    if (entry.state === "working") add(byNote, noteKey(entry.note), seconds);
    add(byTurn, turnOf(entry.state), seconds);
  });
  const first = entries[0] ? Date.parse(entries[0].at) : endTime;
  return {
    segments,
    integrated: end >= 0,
    integratedAt: end >= 0 ? entries[end]!.at : null,
    totalSeconds: Math.max(0, Math.round((endTime - first) / 1000)),
    byState,
    byNote,
    byTurn,
  };
}

export interface Stat {
  key: string;
  count: number;
  totalSeconds: number;
  medianSeconds: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** タスクごとの合計を集めて、件数（その段のあったタスクの数）・合計・中央値にする */
export function aggregate(maps: Map<string, number>[]): Stat[] {
  const per = new Map<string, number[]>();
  for (const m of maps)
    for (const [key, v] of m) per.set(key, [...(per.get(key) ?? []), v]);
  return [...per.entries()]
    .map(([key, values]) => ({
      key,
      count: values.length,
      totalSeconds: values.reduce((a, b) => a + b, 0),
      medianSeconds: median(values),
    }))
    .sort(
      (a, b) => b.totalSeconds - a.totalSeconds || a.key.localeCompare(b.key),
    );
}

/** 手元の日付（YYYY-MM-DD） */
export function localDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** 秒を「12.5分」「1時間05分」にする */
export function formatDuration(seconds: number): string {
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}分`;
  const whole = Math.round(minutes);
  return `${Math.floor(whole / 60)}時間${String(whole % 60).padStart(2, "0")}分`;
}
