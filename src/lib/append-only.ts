import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import type { Runner } from "./exec.ts";
import { lastBaseMergeParent, type RestoreResult } from "./decisions.ts";
import { commitFile, showFile } from "./git.ts";
import { FlowError } from "../types.ts";

/**
 * 決定の記録でない追記だけのファイル（設定の appendOnlyFiles）の行の並びの戻し（7章の2・8章 integrate）。
 * 見出しを前提にしないので、見出しの確かめと空行の戻しはしない
 */

/** 戻す対象のファイル：appendOnlyFiles から decisionsFile を除いたもの */
export function otherAppendOnlyFiles(config: FlowConfig): string[] {
  return config.appendOnlyFiles.filter((f) => f !== config.decisionsFile);
}

/**
 * 取り込みのあとの並びを文字列だけで組み直す。
 * main の中身のあとに、取り込みの前のタスクが分かれ目（base）から足した部分を置く。
 * 組み直せないとき（取り込みの前か main が分かれ目で始まらない・足しが空・足した行が main の足しにもある）は理由を返す
 */
export function restoreAppendedLines(
  main: string,
  base: string,
  before: string,
): RestoreResult {
  if (!before.startsWith(base))
    return {
      ok: false,
      reason: "取り込みの前の中身が分かれ目の中身で始まりません",
    };
  if (!main.startsWith(base))
    return { ok: false, reason: "main の中身が分かれ目の中身で始まりません" };
  const added = before.slice(base.length);
  if (added.trim() === "")
    return { ok: false, reason: "タスクが足した部分が空です" };
  const mainAdded = new Set(
    main
      .slice(base.length)
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== ""),
  );
  const dup = added
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .find((l) => l.trim() !== "" && mainAdded.has(l));
  if (dup !== undefined)
    return {
      ok: false,
      reason: `タスクが足した行「${dup}」が main の足した部分にもあります`,
    };
  const glue = main !== "" && !main.endsWith("\n") && !added.startsWith("\n");
  return { ok: true, text: main + (glue ? "\n" : "") + added };
}

/**
 * 1つのファイルを戻す。作業ツリー cwd の中身が main の中身で始まらないときだけ、
 * 取り込みの前の先頭 beforeHead から組み直し、そのファイルだけをコミットする。
 * 件名は「〈subjectPrefix〉: 取り込みで変わった〈file〉の行の並びを戻す」。戻してコミットしたら true。
 * 戻せないときは warn に理由を渡して false。main にそのファイルがない・取り込みで main が動いていないときは何もしない
 */
export async function restoreAppendOnlyFile(
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
    warn(`警告：${file} の行の並びを戻せませんでした（${reason}）`);
    return false;
  };
  const mergeBase = await runner(
    "git",
    ["merge-base", baseBranch, beforeHead],
    { cwd },
  );
  if (mergeBase.code !== 0) return fail("分かれ目が見つかりません");
  const baseHead = await runner("git", ["rev-parse", baseBranch], { cwd });
  if (baseHead.code === 0 && baseHead.stdout.trim() === mergeBase.stdout.trim())
    return false;
  const baseText = await showFile(runner, cwd, mergeBase.stdout.trim(), file);
  const beforeText = await showFile(runner, cwd, beforeHead, file);
  if (baseText === null || beforeText === null)
    return fail("取り込みの前か分かれ目にそのファイルがありません");
  const result = restoreAppendedLines(mainText, baseText, beforeText);
  if (!result.ok) return fail(result.reason);
  await writeFile(target, result.text);
  try {
    await commitFile(
      runner,
      cwd,
      file,
      `${subjectPrefix}: 取り込みで変わった${file}の行の並びを戻す`,
    );
  } catch (error) {
    await runner("git", ["reset", "-q", "--", file], { cwd });
    await writeFile(target, current);
    const reason = error instanceof Error ? error.message : String(error);
    throw new FlowError(
      error instanceof FlowError ? error.code : 1,
      `${id}：${file} の行の並びの戻しをコミットできませんでした（ファイルを元に戻しました。worktree は取り込んだままです。取り込みの前の先頭 ${beforeHead}）：${reason}`,
    );
  }
  return true;
}

/**
 * 決定の記録でない追記だけのファイルをすべて戻す。戻したファイルを返す。
 * beforeHead が null のときは、ファイルごとに lastBaseMergeParent で探した先頭から戻す（見つからなければ戻さない）
 */
export async function restoreAppendOnlyFiles(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  beforeHead: string | null,
  id: string,
  subjectPrefix: string,
  warn: (message: string) => void,
): Promise<string[]> {
  const restored: string[] = [];
  for (const file of otherAppendOnlyFiles(config)) {
    const head =
      beforeHead ??
      (await lastBaseMergeParent(runner, cwd, config.baseBranch, file));
    if (head === null) continue;
    if (
      await restoreAppendOnlyFile(
        runner,
        cwd,
        file,
        config.baseBranch,
        head,
        id,
        subjectPrefix,
        warn,
      )
    )
      restored.push(file);
  }
  return restored;
}

/**
 * 戻したあとも、against（verify は HEAD、integrate はタスクのブランチ）の中身が baseBranch の中身で
 * 始まらないファイルに警告を出す。baseBranch にないファイルは見ない。止めない
 */
export async function warnAppendOnlyOrder(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  against: string,
  warn: (message: string) => void,
): Promise<void> {
  for (const file of otherAppendOnlyFiles(config)) {
    const mainText = await showFile(runner, cwd, config.baseBranch, file);
    if (mainText === null) continue;
    const text = await showFile(runner, cwd, against, file);
    if (text !== null && text.startsWith(mainText)) continue;
    warn(
      `警告：${config.baseBranch} の ${file} が、タスクのブランチの ${file} の先頭と同じではありません（行の並びが変わっています。手で ${config.baseBranch} の行のあとにタスクの行が続く形に戻してください）`,
    );
  }
}
