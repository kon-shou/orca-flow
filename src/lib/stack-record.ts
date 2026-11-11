import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../types.ts";
import { commonRecordPath, hasIdShape } from "./task-id.ts";

// 乗せる記録の読み書きだけ。git.ts の作業中の見分けからも読むので、git.ts を読み込まない

/** 乗せる記録。`〈共通〉/orca-flow/stack/〈ID〉.json` に置く（作業ツリーの外） */
export interface StackRecord {
  id: string;
  /** 乗せた先の ID */
  on: string;
  /** 乗せたときの乗せた先の枝 */
  branch: string;
  /** 書いた時刻（ISO） */
  at: string;
}

export const stackFile = (common: string, id: string) =>
  commonRecordPath(common, "stack", id, ".json");

// 土台の名前はスキルが git merge に渡し、知らせの文にも入るので、引数や指示として読まれる文字を通さない
// （review-local の REF と同じ形）
const SAFE_BRANCH = /^[A-Za-z0-9/._-]+$/;

export const safeShape = (branch: string) =>
  SAFE_BRANCH.test(branch) && !branch.startsWith("-");

const broken = (id: string) =>
  new FlowError(
    1,
    `乗せる記録が壊れています：stack/${id}.json。直すか、統括役の場所で orca-flow depends ${id} --unstack で消してからもう一度流してください`,
  );

function parse(text: string, id: string): StackRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw broken(id);
  }
  if (typeof raw !== "object" || raw === null) throw broken(id);
  const r = raw as Record<string, unknown>;
  if (
    r.id !== id ||
    typeof r.on !== "string" ||
    !hasIdShape(r.on) ||
    typeof r.branch !== "string" ||
    !safeShape(r.branch) ||
    typeof r.at !== "string"
  )
    throw broken(id);
  return { id, on: r.on, branch: r.branch, at: r.at };
}

/** 共通ディレクトリを渡して記録を書く（一時ファイルと rename）。on が null なら同じ ID の記録を消す */
export async function writeStackAt(
  common: string,
  id: string,
  on: { id: string; branch: string } | null,
  now: Date,
): Promise<void> {
  const file = stackFile(common, id);
  if (on === null) {
    await rm(file, { force: true });
    return;
  }
  const record: StackRecord = {
    id,
    on: on.id,
    branch: on.branch,
    at: now.toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
}

/** 共通ディレクトリを渡して記録を読む。ない（ENOENT）・ID の形が違うなら null。読めない・壊れていれば FlowError(1) */
export async function readStackAt(
  common: string,
  id: string,
): Promise<StackRecord | null> {
  if (!hasIdShape(id)) return null;
  let text: string;
  try {
    text = await readFile(stackFile(common, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw broken(id);
  }
  return parse(text, id);
}
