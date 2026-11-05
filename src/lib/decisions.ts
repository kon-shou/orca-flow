import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Runner } from "./exec.ts";
import type { FlowConfig } from "../config.ts";
import { commitFile, showFile } from "./git.ts";
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

export interface AppendOnlyCheck {
  id: string;
  /** 比べる先（verify は HEAD、integrate と push はタスクのブランチ） */
  against: string;
  /** どのコマンドから呼ぶか。止めるときの文が変わる */
  caller: "verify" | "integrate" | "push";
}

/**
 * 決定の記録が追記だけか：baseBranch の中身が、against の中身の先頭とそのまま同じ
 * （merge=union の rebase で行が消える・すでにある項を書き換えるのを止める）。
 * decisionsFile がないとき、baseBranch にその記録がないときは何もせず null を返す。
 * 比べる先に記録がないか先頭が違えば FlowError(1)。通ったら baseBranch の中身を返す
 */
export async function checkDecisionsAppendOnly(
  runner: Runner,
  config: FlowConfig,
  root: string,
  check: AppendOnlyCheck,
): Promise<string | null> {
  if (config.decisionsFile === null) return null;
  const file = config.decisionsFile;
  const base = config.baseBranch;
  const baseText = await showFile(runner, root, base, file);
  if (baseText === null) return null;
  const againstText = await showFile(runner, root, check.against, file);
  if (againstText !== null && startsWithBase(baseText, againstText))
    return baseText;
  const head = `${base} の ${file} が、タスクのブランチの ${file} の先頭と同じではありません（rebase で記録の行が消えたか、すでにある項を書き換えています）。`;
  if (check.caller === "verify")
    throw new FlowError(
      1,
      `${head}行を戻し、自分の項を末尾に足し直してコミットしてから、orca-flow verify をやり直してください`,
    );
  const verb = check.caller;
  throw new FlowError(
    1,
    `${check.id}：${head}タスクのブランチで ${base} の ${file} の行を戻し、自分の項を末尾に足し直してコミットし、orca-flow verify をやり直してから、もう一度 ${verb} してください。${verb === "integrate" ? "マージしていません" : "push も PR もしていません"}`,
  );
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

export type RestoreResult =
  { ok: true; text: string } | { ok: false; reason: string };

/**
 * integrate が rebase したあとに欠けた記録の行を、文字列だけで組み直す（7章の2）。
 * main の中身のあとに、rebase の前のタスクが分かれ目（base）から足した部分を置く。
 * 組み直せないとき（分かれ目からの追記でない・足しが空か見出しがない・足す項の見出しが main にすでにある）は理由を返す
 */
export function restoreLostLines(
  main: string,
  base: string,
  before: string,
): RestoreResult {
  if (!before.startsWith(base))
    return { ok: false, reason: "分かれ目からの追記ではありません" };
  const added = before.slice(base.length);
  if (added.trim() === "")
    return { ok: false, reason: "タスクが足した部分が空です" };
  const headings: string[] = [];
  let inFence = false;
  for (const raw of added.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,6}\s/.test(raw)) headings.push(raw.trimEnd());
  }
  if (headings.length === 0)
    return { ok: false, reason: "タスクが足した部分に見出しがありません" };
  const level = (h: string) => /^#+/.exec(h)![0].length;
  const top = Math.min(...headings.map(level));
  const mainLines = new Set(main.split("\n").map((l) => l.trimEnd()));
  const dup = headings.find((h) => level(h) === top && mainLines.has(h));
  if (dup !== undefined)
    return {
      ok: false,
      reason: `足す項の見出し「${dup}」が main にすでにあります`,
    };
  // main の末尾に改行がなく足しが改行で始まらないときは、見出しが前の行にくっつかないよう改行を挟む
  const glue = main !== "" && !main.endsWith("\n") && !added.startsWith("\n");
  return {
    ok: true,
    text: restoreBlankBeforeHeadings(main, main + (glue ? "\n" : "") + added),
  };
}

/**
 * integrate が worktree cwd を rebase した直後に呼ぶ。作業ツリーの記録が main の先頭と同じでなければ、
 * rebase の前の先頭 beforeHead から restoreLostLines で組み直し、記録のファイルだけをコミットする。
 * 件名は「〈subjectPrefix〉: 取り込みで欠けた決定の記録の行を戻す」。戻してコミットしたら true。
 * 組み直せないときは warn に理由を渡して false（止めるのはそのあとの追記だけの確かめ）。
 * beforeHead がすでに baseBranch の先頭を含む（rebase で何も動かなかった）ときは、何もせず false
 */
export async function restoreDecisionsAfterRebase(
  runner: Runner,
  cwd: string,
  file: string,
  baseBranch: string,
  beforeHead: string,
  id: string,
  subjectPrefix: string,
  warn: (message: string) => void,
): Promise<boolean> {
  const target = path.join(cwd, file);
  const mainText = await showFile(runner, cwd, baseBranch, file);
  if (mainText === null) return false;
  let current: string;
  try {
    current = await readFile(target, "utf8");
  } catch {
    return false;
  }
  if (current.startsWith(mainText)) return false;
  const fail = (reason: string) => {
    warn(`警告：決定の記録の行を戻せませんでした（${reason}）`);
    return false;
  };
  const mergeBase = await runner(
    "git",
    ["merge-base", baseBranch, beforeHead],
    {
      cwd,
    },
  );
  if (mergeBase.code !== 0) return fail("分かれ目が見つかりません");
  const baseHead = await runner("git", ["rev-parse", baseBranch], { cwd });
  if (baseHead.code === 0 && baseHead.stdout.trim() === mergeBase.stdout.trim())
    return false;
  const baseText = await showFile(runner, cwd, mergeBase.stdout.trim(), file);
  const beforeText = await showFile(runner, cwd, beforeHead, file);
  if (baseText === null || beforeText === null)
    return fail("rebase の前か分かれ目に記録がありません");
  const result = restoreLostLines(mainText, baseText, beforeText);
  if (!result.ok) return fail(result.reason);
  await writeFile(target, result.text);
  try {
    await commitFile(
      runner,
      cwd,
      file,
      `${subjectPrefix}: 取り込みで欠けた決定の記録の行を戻す`,
    );
  } catch (error) {
    await runner("git", ["reset", "-q", "--", file], { cwd });
    await writeFile(target, current);
    const reason = error instanceof Error ? error.message : String(error);
    throw new FlowError(
      error instanceof FlowError ? error.code : 1,
      `${id}：決定の記録の行の戻しをコミットできませんでした（記録のファイルを元に戻しました。worktree は rebase したままです。rebase の前の先頭 ${beforeHead}）：${reason}`,
    );
  }
  return true;
}
