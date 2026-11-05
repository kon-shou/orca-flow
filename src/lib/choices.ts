import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { lessonsDir, parseLessons, type LessonItem } from "./lessons.ts";
import { acquireLock, releaseOrWarn } from "./lock.ts";
import { FlowError } from "../types.ts";

// 人の選択のファイル：〈git の共通ディレクトリ〉/orca-flow/choices.md
// 1項の形：
//   ## 見出し
//   - 選んだこと：…
//   - 理由：…
//   - 効く所：…
//   - 出どころ：〈日付〉 〈仕様のページの題〉
// 読み書きの形は教訓のファイルと同じ（項は「## 」から次の「## 」の前まで）。

export { LESSONS_LINE_LIMIT as CHOICES_LINE_LIMIT } from "./lessons.ts";
export {
  countLines,
  parseLessons as parseChoices,
  renderLessons as renderChoices,
} from "./lessons.ts";
export type { LessonItem as ChoiceItem } from "./lessons.ts";

export const CHOICE_FIELDS = [
  "選んだこと",
  "理由",
  "効く所",
  "出どころ",
] as const;

export const choicesDir = lessonsDir;

export const choicesPath = async (
  ...args: Parameters<typeof lessonsDir>
): Promise<string> => path.join(await lessonsDir(...args), "choices.md");

const errText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** ファイルを読む。なければ null */
export async function readChoices(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FlowError(
      1,
      `人の選択のファイルを読めません（${file}：${errText(error)}）`,
    );
  }
}

/** 一時ファイルに書いて置き換える */
export async function writeChoices(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw new FlowError(
      1,
      `人の選択のファイルに書けません（${file}：${errText(error)}）`,
    );
  }
}

const fieldValue = (lines: string[], name: string): string | null => {
  for (const line of lines) {
    const m = new RegExp(`^\\s*[-*]\\s*${name}\\s*[：:]\\s*(.*)$`).exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
};

/** 足す1項の確かめ。問題があれば FlowError(1) */
export function checkNewChoice(text: string): LessonItem {
  const { preamble, items } = parseLessons(text);
  if (items.length !== 1 || preamble.some((l) => l.trim() !== ""))
    throw new FlowError(
      1,
      "足せるのは「## 見出し」で始まる1項だけです（見出しの前に文を置かず、項は1つにしてください）",
    );
  const item = items[0]!;
  const missing = CHOICE_FIELDS.filter((name) => !fieldValue(item.lines, name));
  if (missing.length > 0)
    throw new FlowError(
      1,
      `項に次の欄がありません：${missing.join("、")}（「- 選んだこと：…」の形で、選んだこと・理由・効く所・出どころを書いてください）`,
    );
  if (/notion\.(?:so|com)/i.test(item.lines.join("\n")))
    throw new FlowError(
      1,
      "項に Notion の URL が入っています。出どころは日付と仕様のページの題だけにして、URL を消してください",
    );
  return item;
}

/** 同じ中身かを、行ごとの前後の空白を除いて比べる */
export const sameChoice = (a: LessonItem, b: LessonItem): boolean =>
  a.lines.map((l) => l.trim()).join("\n") ===
  b.lines.map((l) => l.trim()).join("\n");

/** 同時に足す・消すのを順に並べるロックの中で fn を流す */
export async function withChoicesLock<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = await acquireLock(path.join(dir, "choices.lock"), {
    waitMs: 15_000,
    failed: (file, detail) =>
      `人の選択のロックを読み書きできません（${file}：${detail}）`,
    releaseFailed: (file, detail) =>
      `人の選択のロックを外せませんでした（${file}：${detail}）。残っていれば ${file} を消してください`,
  });
  if (lock.kind === "held")
    throw new FlowError(
      1,
      `ほかの人の選択の足しか消しが続いています（${lock.lockPath}）。少し待って、もう一度流してください`,
    );
  try {
    return await fn();
  } finally {
    await releaseOrWarn(lock.release);
  }
}
