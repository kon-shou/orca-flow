import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { idLikeLines } from "./decisions.ts";
import { gitCommonDir } from "./git.ts";
import { acquireLock, releaseOrWarn } from "./lock.ts";
import type { Runner } from "./exec.ts";
import { FlowError } from "../types.ts";

// 教訓のファイル：〈git の共通ディレクトリ〉/orca-flow/lessons.md
// 1項の形：
//   ## 見出し
//   - 決まり：…
//   - 理由：…
//   - 見分け方：…
//   - 観点：…
// 項は「## 」で始まる行から次の「## 」の前まで。番号は上からの順（1 から）。

/** 毎回読む量の目安（公式の CLAUDE.md の目安にそろえる）。越えても断らず警告だけ */
export const LESSONS_LINE_LIMIT = 200;

export const LESSON_FIELDS = ["決まり", "理由", "見分け方", "観点"] as const;

export interface LessonItem {
  heading: string;
  /** 見出しの行を含む、項の行 */
  lines: string[];
}

export const lessonsDir = async (runner: Runner, cwd: string) =>
  path.join(await gitCommonDir(runner, cwd), "orca-flow");

export const lessonsPath = async (runner: Runner, cwd: string) =>
  path.join(await lessonsDir(runner, cwd), "lessons.md");

/** ファイルを読む。なければ null */
export async function readLessons(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FlowError(
      1,
      `教訓のファイルを読めません（${file}：${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

const isHeading = (line: string) => /^##\s+\S/.test(line);

/** 文を、前置き（最初の項より前の行）と項に分ける */
export function parseLessons(text: string): {
  preamble: string[];
  items: LessonItem[];
} {
  const preamble: string[] = [];
  const items: LessonItem[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (isHeading(line))
      items.push({ heading: line.replace(/^##\s+/, "").trim(), lines: [line] });
    else if (items.length > 0) items[items.length - 1]!.lines.push(line);
    else preamble.push(line);
  }
  for (const item of items)
    while (
      item.lines.length > 1 &&
      item.lines[item.lines.length - 1]!.trim() === ""
    )
      item.lines.pop();
  while (preamble.length > 0 && preamble[preamble.length - 1]!.trim() === "")
    preamble.pop();
  return { preamble, items };
}

export function renderLessons(parsed: {
  preamble: string[];
  items: LessonItem[];
}): string {
  const blocks: string[] = [];
  if (parsed.preamble.length > 0) blocks.push(parsed.preamble.join("\n"));
  for (const item of parsed.items) blocks.push(item.lines.join("\n"));
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

/** 欄の行「- 決まり：値」から値を取る。なければ null */
const fieldValue = (lines: string[], name: string): string | null => {
  for (const line of lines) {
    const m = new RegExp(`^\\s*[-*]\\s*${name}\\s*[：:]\\s*(.*)$`).exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
};

/**
 * 足す1項の確かめ。問題があれば FlowError(1)。
 * 形（見出し1つと4つの欄）、ID の形（idPrefix と数字）、手元の絶対パスがないこと
 */
export function checkNewLesson(
  text: string,
  options: { idPrefix: string; root: string; env: NodeJS.ProcessEnv },
): LessonItem {
  const { preamble, items } = parseLessons(text);
  if (items.length !== 1 || preamble.some((l) => l.trim() !== ""))
    throw new FlowError(
      1,
      "足せるのは「## 見出し」で始まる1項だけです（見出しの前に文を置かず、項は1つにしてください）",
    );
  const item = items[0]!;
  const missing = LESSON_FIELDS.filter((name) => !fieldValue(item.lines, name));
  if (missing.length > 0)
    throw new FlowError(
      1,
      `項に次の欄がありません：${missing.join("、")}（「- 決まり：…」の形で、決まり・理由・見分け方・観点を書いてください）`,
    );
  const body = item.lines.join("\n");
  const [idLine] = idLikeLines(item.lines, options.idPrefix);
  if (idLine !== undefined)
    throw new FlowError(
      1,
      `項にタスクの ID らしいもの（${options.idPrefix}＋数字、英字つきも含む）が入っています：「${idLine.trim()}」。誤りを一般化して、ID を消してください`,
    );
  const homes = [options.env.HOME, options.env.USERPROFILE, os.homedir()];
  const local = [options.root, ...homes].filter(
    (p): p is string => !!p && p.length > 1 && body.includes(p),
  );
  const abs =
    local.length > 0
      ? local[0]!
      : (LOCAL_ABS_PATH.exec(body)?.[0] ??
        /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s]*/.exec(body)?.[0] ??
        /(?<![\w.])~\/[^\s]*/.exec(body)?.[0]);
  if (abs)
    throw new FlowError(
      1,
      `項に手元の絶対パスらしいもの（${abs}）が入っています。パスを消して、一般化してください`,
    );
  return item;
}

/** 手元のものとみなす絶対パスの頭。/dev/null や /api/users のような手元でないパスは当てない */
const LOCAL_ABS_PATH =
  /(?<![\w./-])\/(?:home|Users|tmp|private|mnt|root|var\/folders|Volumes|media|workspaces?)\/[^\s]*/;

/** 行数（末尾の改行は数えない） */
export const countLines = (text: string) =>
  text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;

/** 同時に足す・消すのを順に並べるロックの中で fn を流す */
export async function withLessonsLock<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = await acquireLock(path.join(dir, "lessons.lock"), {
    waitMs: 15_000,
    failed: (file, detail) =>
      `教訓のロックを読み書きできません（${file}：${detail}）`,
    releaseFailed: (file, detail) =>
      `教訓のロックを外せませんでした（${file}：${detail}）。残っていれば ${file} を消してください`,
  });
  if (lock.kind === "held")
    throw new FlowError(
      1,
      `ほかの教訓の足しか消しが続いています（${lock.lockPath}）。少し待って、もう一度流してください`,
    );
  try {
    return await fn();
  } finally {
    await releaseOrWarn(lock.release);
  }
}

/** 一時ファイルに書いて置き換える（途中の形を見せない） */
export async function writeLessons(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw new FlowError(
      1,
      `教訓のファイルに書けません（${file}：${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}
