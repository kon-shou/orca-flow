import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import type { Runner } from "./exec.ts";
import { gitCommonDir, runGit } from "./git.ts";
import { commonRecordPath } from "./task-id.ts";

/** 1ファイルの、タスク自身の変更（足した行と消した行。出てくる順） */
export interface FileChange {
  added: string[];
  removed: string[];
}

/** タスク自身の変更：ファイル名 → 変更 */
export type OwnChange = Map<string, FileChange>;

export interface OwnChangeResult {
  /** 分かれ目（git merge-base 〈base〉 〈コミット〉） */
  fork: string;
  change: OwnChange;
  fingerprint: string;
}

/** タスク自身の変更から除くファイル：設計書・報告・追記だけのファイル（決定の記録など。タスクが見直しのあとに足しても指紋を変えない） */
export const ownChangeExclude = (
  config: Pick<FlowConfig, "appendOnlyFiles">,
  docFile: string,
  reportFile: string,
): string[] => [docFile, reportFile, ...config.appendOnlyFiles];

/**
 * タスク自身の変更を求める：分かれ目からコミットまでの差分のうち、除くファイル（設計書・報告・追記だけのファイル）を除いた、
 * ファイルごとの足した行と消した行の並び。行番号と前後の行は見ない
 */
export async function ownChange(
  runner: Runner,
  cwd: string,
  base: string,
  commit: string,
  exclude: readonly string[],
): Promise<OwnChangeResult> {
  const fork = (
    await runGit(
      runner,
      cwd,
      ["merge-base", base, commit],
      `git merge-base ${base} ${commit}`,
    )
  ).trim();
  const out = await runGit(
    runner,
    cwd,
    [
      "-c",
      "core.quotepath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--full-index",
      "--no-renames",
      "--unified=0",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      fork,
      commit,
      "--",
      ".",
      ...exclude.map((file) => `:(exclude)${file}`),
    ],
    "git diff",
  );
  const change = parseDiff(out);
  return { fork, change, fingerprint: fingerprintOf(change) };
}

/** git diff の出力を、ファイルごとの足した行・消した行に分ける */
export function parseDiff(text: string): OwnChange {
  const change: OwnChange = new Map();
  let current: FileChange | null = null;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      // 名前の変わらない差分（--no-renames）なので、a/〈X〉 b/〈X〉 の X は同じ長さ
      const name = rest.slice(2, 2 + (rest.length - 5) / 2);
      current = { added: [], removed: [] };
      change.set(name, current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // 本文の前の行：モードの変更とバイナリの印だけ拾う
      if (/^(new file mode|deleted file mode|old mode|new mode) /.test(line))
        current.added.push(`@${line}`);
      else if (line.startsWith("Binary files ")) current.added.push(`@${line}`);
      else if (line.startsWith("index ")) current.added.push(`@${line}`);
      continue;
    }
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  // index の行は本文のある差分では要らない（バイナリのときだけ残す）
  for (const entry of change.values()) {
    const binary = entry.added.some((l) => l.startsWith("@Binary files "));
    if (!binary)
      entry.added = entry.added.filter((l) => !l.startsWith("@index "));
  }
  return change;
}

export function fingerprintOf(change: OwnChange): string {
  const files = [...change.entries()]
    .filter(([, c]) => c.added.length > 0 || c.removed.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, c]) => [file, c.added, c.removed]);
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

/** 前と今の違い：ファイルごとに前にだけある行・今にだけある行（足した行は「+」、消した行は「-」を頭につける） */
export interface FileDifference {
  file: string;
  onlyBefore: string[];
  onlyNow: string[];
  /** 行の集まりは同じで、並びだけが変わった */
  reordered: boolean;
}

const tokens = (c: FileChange | undefined) => [
  ...(c?.added ?? []).map((l) => `+${l}`),
  ...(c?.removed ?? []).map((l) => `-${l}`),
];

/** 数を数えて引く（同じ行が複数あっても数が合うように） */
function subtract(from: string[], minus: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of minus) counts.set(l, (counts.get(l) ?? 0) + 1);
  const rest: string[] = [];
  for (const l of from) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else rest.push(l);
  }
  return rest;
}

export function differences(
  before: OwnChange,
  now: OwnChange,
): FileDifference[] {
  const files = [...new Set([...before.keys(), ...now.keys()])].sort();
  const result: FileDifference[] = [];
  for (const file of files) {
    const b = before.get(file);
    const n = now.get(file);
    const same =
      JSON.stringify([b?.added ?? [], b?.removed ?? []]) ===
      JSON.stringify([n?.added ?? [], n?.removed ?? []]);
    if (same) continue;
    const onlyBefore = subtract(tokens(b), tokens(n));
    const onlyNow = subtract(tokens(n), tokens(b));
    result.push({
      file,
      onlyBefore,
      onlyNow,
      reordered: onlyBefore.length === 0 && onlyNow.length === 0,
    });
  }
  return result;
}

/** 見直しの記録（タスクごとに1つ） */
export interface ReviewedRecord {
  id: string;
  /** 見直したときのブランチの先頭 */
  head: string;
  /** そのときのタスク自身の変更の指紋 */
  fingerprint: string;
  /** 時刻（ISO 8601） */
  at: string;
}

async function reviewedFile(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<string> {
  return commonRecordPath(
    await gitCommonDir(runner, cwd),
    "reviewed",
    id,
    ".json",
  );
}

const isReviewed = (value: unknown): value is ReviewedRecord => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.head === "string" &&
    typeof v.fingerprint === "string" &&
    typeof v.at === "string"
  );
};

/** 見直しの記録を読む。なければ・壊れていれば null */
export async function readReviewed(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<ReviewedRecord | null> {
  const file = await reviewedFile(runner, cwd, id);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isReviewed(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeReviewed(
  runner: Runner,
  cwd: string,
  record: ReviewedRecord,
): Promise<void> {
  const file = await reviewedFile(runner, cwd, record.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}
