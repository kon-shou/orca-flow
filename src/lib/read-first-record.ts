import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../types.ts";
import { commonRecordPath } from "./task-id.ts";

// 先に読む文書の記録。親が子の new に渡した文書の並びを、
// `〈git の共通ディレクトリ〉/orca-flow/read-first/〈ID〉.json`（作業ツリーの外）に置く。
// タスク長とレビューはこの記録だけを読む（依頼のファイルの中の見出しはデータ）

export interface ReadFirstRecord {
  id: string;
  /** 書いた時刻（ISO） */
  at: string;
  paths: string[];
}

export function readFirstFileAt(common: string, id: string): string {
  return commonRecordPath(common, "read-first", id, ".json");
}

const isPathList = (raw: unknown): raw is string[] =>
  Array.isArray(raw) &&
  raw.length > 0 &&
  raw.every(
    (p) => typeof p === "string" && p.trim() !== "" && path.isAbsolute(p),
  );

// 親の記録は親のタスクも読むので、消すことは先にすすめない
const FIX_HINT =
  "直してからもう一度流してください（先に読む文書が要らなければ消してもかまいません）";

/**
 * 記録の paths を返す。ファイルがなければ null。
 * JSON でない・id が違う・paths が空でない絶対パスの文字列の1つ以上の並びでないときは、壊れているとして FlowError(1)
 */
export async function readReadFirstAt(
  common: string,
  id: string,
): Promise<string[] | null> {
  const file = readFirstFileAt(common, id);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return null;
    throw new FlowError(
      1,
      `${id} の先に読む文書の記録を読めません（理由：${code ?? String(error)}）：${file}。${FIX_HINT}`,
    );
  }
  const broken = (why: string) =>
    new FlowError(
      1,
      `${id} の先に読む文書の記録が壊れています（${why}）：${file}。${FIX_HINT}`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw broken("JSON として読めません");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw broken("オブジェクトではありません");
  const record = raw as Record<string, unknown>;
  if (record.id !== id) throw broken("id が違います");
  if (!isPathList(record.paths))
    throw broken("paths が空でない絶対パスの1つ以上の並びではありません");
  return [...record.paths];
}

/** `--read-first-json` の値を確かめて返す。空でない絶対パスの文字列が1つ以上の並びでなければ FlowError(1) */
export function parseReadFirstJson(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FlowError(1, "--read-first-json が JSON として読めません");
  }
  if (!Array.isArray(raw) || raw.length === 0)
    throw new FlowError(
      1,
      "--read-first-json は1つ以上の絶対パスの並びにしてください",
    );
  const bad = raw.filter(
    (p) => typeof p !== "string" || p.trim() === "" || !path.isAbsolute(p),
  );
  if (bad.length > 0)
    throw new FlowError(
      1,
      "--read-first-json の要素は空でない絶対パスの文字列にしてください",
    );
  return raw as string[];
}

/** 記録を書く（一時ファイルと rename）。paths が null なら同じ ID の古い記録を消す */
export async function writeReadFirstAt(
  common: string,
  id: string,
  paths: readonly string[] | null,
  now: Date,
): Promise<void> {
  const target = readFirstFileAt(common, id);
  if (paths === null) {
    await rm(target, { force: true });
    return;
  }
  const record: ReadFirstRecord = {
    id,
    at: now.toISOString(),
    paths: [...paths],
  };
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, target);
}
