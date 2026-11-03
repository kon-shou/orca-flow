import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Runner } from "./exec.ts";
import { commitFile } from "./git.ts";
import { FlowError } from "../types.ts";

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

/**
 * union のマージで欠けた見出しの前の空行を戻す（7章の2）。
 * main の中身のあとに足された部分だけを見て、見出しの行（# 1〜6個と空白で始まる。コードの囲みの中は除く）の
 * 前の行が空でなければ空行を1つ入れる。main の部分は変えない。merged が main で始まらないときは何も変えない
 */
export function restoreBlankBeforeHeadings(
  main: string,
  merged: string,
): string {
  if (!merged.startsWith(main)) return merged;
  const out: string[] = [];
  let offset = 0;
  let inFence = false;
  for (const raw of merged.split("\n")) {
    const start = offset;
    offset += raw.length + 1;
    const wasFence = inFence;
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    const added = start >= main.length;
    if (
      added &&
      !wasFence &&
      !inFence &&
      /^#{1,6}\s/.test(raw) &&
      out.length > 0 &&
      out[out.length - 1]!.trim() !== ""
    )
      out.push("");
    out.push(raw);
  }
  return out.join("\n");
}

/**
 * 作業ツリー cwd の decisionsFile を restoreBlankBeforeHeadings で直し、変わったときだけそのファイルだけをコミットする。
 * 件名は「〈subjectPrefix〉: マージで欠けた決定の記録の空行を戻す」。直してコミットしたら true
 */
export async function fixDecisionsBlankLines(
  runner: Runner,
  cwd: string,
  file: string,
  mainText: string,
  subjectPrefix: string,
): Promise<boolean> {
  const target = path.join(cwd, file);
  let current: string;
  try {
    current = await readFile(target, "utf8");
  } catch {
    return false;
  }
  const fixed = restoreBlankBeforeHeadings(mainText, current);
  if (fixed === current) return false;
  await writeFile(target, fixed);
  try {
    await commitFile(
      runner,
      cwd,
      file,
      `${subjectPrefix}: マージで欠けた決定の記録の空行を戻す`,
    );
  } catch (error) {
    // コミットできなかったら、ステージを外して中身を元に戻す（作業ツリーを汚したまま止めない）
    await runner("git", ["reset", "-q", "--", file], { cwd });
    await writeFile(target, current);
    const reason = error instanceof Error ? error.message : String(error);
    throw new FlowError(
      error instanceof FlowError ? error.code : 1,
      `決定の記録の空行の戻しをコミットできませんでした（元に戻しました）：${reason}`,
    );
  }
  return true;
}
