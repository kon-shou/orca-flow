import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import type { Runner } from "./exec.ts";
import { isIgnored } from "./git.ts";
import { FlowError } from "../types.ts";

/**
 * 決定の記録（decisionsFile）がメインの作業ツリーで無視されているときの扱い（6章・8章 integrate）。
 * 項は git に載せず、報告の「決定の記録の項」の節に書かれ、統合のときにメインの記録の末尾へ足される
 */

export const LOCAL_SECTION_HEADING = "決定の記録の項";

/** decisionsFile があり、メインの作業ツリーで無視されていて追跡されていない（追跡中のファイルは無視に当たらない） */
export async function decisionsIgnored(
  runner: Runner,
  root: string,
  config: Pick<FlowConfig, "decisionsFile">,
): Promise<boolean> {
  if (config.decisionsFile === null) return false;
  return isIgnored(runner, root, config.decisionsFile);
}

const DATE_HEADING = /^(#{1,6})\s+(\d{4}-\d{2}-\d{2})\s+(\S.*?)\s*#*\s*$/;
const ANY_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

export interface LocalEntry {
  /** 記録に足すときの見出しの行（「## 〈日付〉 〈見出し〉」） */
  heading: string;
  /** 見出しの行を含む、記録に足す項の全文（末尾の空行は除く） */
  text: string;
}

/**
 * 報告の「決定の記録の項」の節から、記録に足す項を取り出す。
 * 読み方：
 * - 節は、見出しの文字が「決定の記録の項」で始まる行（# の数は問わない。コードの囲みの中は除く）から、
 *   日付で始まらない見出しで、節の見出しと同じかそれより浅いものの手前まで。
 * - 項は、節の中の「日付（YYYY-MM-DD）で始まる見出し」から、次の日付つきの見出しで、同じかそれより浅いものの手前まで
 *   （# の数は問わない。報告の中では深くなっていてよい）。日付つきの見出しより前の行は読み飛ばす。
 * - 項は「## 〈日付〉 〈見出し〉」に書き直す。項の中の見出しは、同じ幅だけ浅くする（最も浅くても「###」）。
 * 節がない・項がないときは空の配列
 */
export function readLocalEntries(report: string): LocalEntry[] {
  const entries: LocalEntry[] = [];
  let sectionLevel: number | null = null;
  let current: { level: number; delta: number; lines: string[] } | null = null;
  let heading = "";
  let inFence = false;
  const flush = () => {
    if (current === null) return;
    const text = current.lines.join("\n").replace(/\s+$/, "");
    entries.push({ heading, text });
    current = null;
  };
  for (const line of report.split(/\r?\n/)) {
    const fence = /^\s*(```|~~~)/.test(line);
    const match = inFence || fence ? null : ANY_HEADING.exec(line);
    if (fence) inFence = !inFence;
    if (match === null) {
      if (current !== null) current.lines.push(line);
      continue;
    }
    const level = match[1]!.length;
    const dated = DATE_HEADING.exec(line);
    if (sectionLevel === null) {
      if (match[2]!.startsWith(LOCAL_SECTION_HEADING)) sectionLevel = level;
      continue;
    }
    if (dated === null && level <= sectionLevel) {
      flush();
      sectionLevel = match[2]!.startsWith(LOCAL_SECTION_HEADING) ? level : null;
      continue;
    }
    if (dated !== null && level >= sectionLevel) {
      if (current === null || level <= current.level) {
        flush();
        heading = `## ${dated[2]} ${dated[3]}`;
        current = { level, delta: level - 2, lines: [heading] };
        continue;
      }
    }
    if (current !== null) {
      current.lines.push(
        current.delta > 0 && level - current.delta >= 3
          ? `${"#".repeat(level - current.delta)}${line.slice(level)}`
          : line,
      );
    }
  }
  flush();
  return entries;
}

/**
 * メインの decisionsFile の末尾に、報告の節の項を足す（コミットはしない）。
 * 前に空行を1行置く。ファイルがなければ作る。同じ見出しの行がすでにあれば、その項は足さない。
 * 足した項の見出しの行を返す。書けなければ FlowError(1)
 */
export async function appendLocalDecisions(
  root: string,
  file: string,
  report: string | null,
  after: string,
): Promise<string[]> {
  if (report === null) return [];
  const entries = readLocalEntries(report);
  if (entries.length === 0) return [];
  const target = path.join(root, file);
  try {
    let text = "";
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lines = new Set(text.split(/\r?\n/).map((l) => l.trimEnd()));
    const added: string[] = [];
    for (const entry of entries) {
      if (lines.has(entry.heading) || added.includes(entry.heading)) continue;
      if (text.trim() !== "") {
        if (!text.endsWith("\n")) text += "\n";
        if (!text.endsWith("\n\n")) text += "\n";
      } else text = "";
      text += `${entry.text}\n`;
      added.push(entry.heading);
    }
    if (added.length === 0) return [];
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
    return added;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FlowError(
      1,
      `${file} に決定の記録の項を足せませんでした（${reason}）。${after}`,
    );
  }
}
