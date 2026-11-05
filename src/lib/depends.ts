import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { commonRecordPath, hasIdShape } from "./task-id.ts";
import { gitCommonDir } from "./git.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";

/** 依存の記録。`〈共通〉/orca-flow/depends/〈ID〉.json` に置く（作業ツリーの外） */
export interface DependsRecord {
  id: string;
  depends: string[];
  /** 書いた時刻（ISO） */
  at: string;
}

const dependsFile = (common: string, id: string) =>
  commonRecordPath(common, "depends", id, ".json");

const commonDirOf = gitCommonDir;

function parse(text: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const list = (raw as { depends?: unknown }).depends;
  if (!Array.isArray(list)) return null;
  return list.filter((d): d is string => typeof d === "string" && d !== "");
}

/** 共通ディレクトリを渡して記録を書く（一時ファイルと rename）。依存が空なら記録を消す */
export async function writeDependsAt(
  common: string,
  id: string,
  depends: readonly string[],
  now: Date,
): Promise<void> {
  const file = dependsFile(common, id);
  if (depends.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const record: DependsRecord = {
    id,
    depends: [...new Set(depends)],
    at: now.toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
}

/** 依存の ID の並び。記録がない（ENOENT）・ID の形が違うときは空。読めない・形が違う記録は FlowError */
export async function readDepends(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<string[]> {
  if (!hasIdShape(id)) return [];
  const common = await commonDirOf(runner, cwd);
  let text: string;
  try {
    text = await readFile(dependsFile(common, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw broken(id);
  }
  const list = parse(text);
  if (list === null) throw broken(id);
  return list;
}

const broken = (id: string) =>
  new FlowError(
    1,
    `依存の記録が壊れています：depends/${id}.json。直すか消してからもう一度流してください`,
  );

/** 記録から ids を外し、残りを返す。記録がなければ何もしない（空を返す） */
export async function dropDepends(
  runner: Runner,
  cwd: string,
  id: string,
  ids: readonly string[],
  now: Date = new Date(),
): Promise<string[]> {
  const current = await readDepends(runner, cwd, id);
  if (current.length === 0) return [];
  const rest = current.filter((d) => !ids.includes(d));
  if (rest.length === current.length) return rest;
  const common = await commonDirOf(runner, cwd);
  await writeDependsAt(common, id, rest, now);
  return rest;
}
