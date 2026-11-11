import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { FlowError, type CommandContext } from "../types.ts";
import { createOrca, isDefaultProfile, type Orca } from "./orca.ts";
import { commonRecordPath, hasIdShape } from "./task-id.ts";

// QA 項目の確かめ（qa-check）の部品。置き場はリポジトリの外（git の共通ディレクトリの下）で、コミットしない。
// 画面と QA 項目の中身は、置き場の外へ写さない。

/** 置き場：〈git の共通ディレクトリ〉/orca-flow/qa-checks/〈ID〉。ID の形が外れたら FlowError(1) */
export const qaChecksDir = (common: string, id: string) =>
  commonRecordPath(common, "qa-checks", id, "");

export const QA_RESULTS = ["pass", "fail", "unverified", "human"] as const;
export type QaResult = (typeof QA_RESULTS)[number];
export const QA_WEIGHTS = ["必須", "できれば"] as const;
export type QaWeight = (typeof QA_WEIGHTS)[number];
export const QA_KINDS = ["事実", "目で見る"] as const;
export type QaKind = (typeof QA_KINDS)[number];

/** 種類ごとに受ける結果。目で見る項目は AI が判定しないので pass・fail を受けない */
const RESULTS_FOR_KIND: Record<QaKind, readonly QaResult[]> = {
  事実: ["pass", "fail", "unverified"],
  目で見る: ["human", "unverified"],
};

export interface QaItem {
  text: string;
  weight: QaWeight;
  kind: QaKind;
  result: QaResult;
  reason?: string;
  /** 撮った名前（置き場の 〈名前〉-before.png） */
  before?: string;
  /** 撮った名前（置き場の 〈名前〉-after.png） */
  after?: string;
}

export interface QaNotice {
  text: string;
  /** 撮った名前。〈名前〉-after.png を先に、なければ 〈名前〉-before.png を指す */
  shot: string;
}

export interface QaRecord {
  id: string;
  at: string;
  items: QaItem[];
  notices: QaNotice[];
}

export type QaCounts = Record<QaResult, number>;

const SHOT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isShotName = (name: string) => SHOT_NAME.test(name);

export type Side = "before" | "after";
export const shotFile = (name: string, side: Side) => `${name}-${side}.png`;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function writeAtomic(file: string, data: string | Buffer) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, file);
}

/** 置き場にある撮った画像のファイル名 */
export async function listShots(dir: string): Promise<Set<string>> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return new Set(names.filter((n) => /-(?:before|after)\.png$/.test(n)));
}

/**
 * --record の入力を確かめる。外れがあれば全部を並べて FlowError(1)。
 * shots は置き場にある画像のファイル名
 */
export function parseRecordInput(
  raw: unknown,
  shots: ReadonlySet<string>,
): { items: QaItem[]; notices: QaNotice[] } {
  const problems: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(raw) || !Array.isArray(raw.items))
    throw new FlowError(
      1,
      "--record の入力は { items: [...], notices: [...] } の形にしてください",
    );
  if (raw.items.length === 0) problems.push("items が空です");

  const optionalText = (
    where: string,
    obj: Record<string, unknown>,
    key: string,
  ): string | undefined => {
    const v = obj[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") {
      problems.push(`${where}の ${key} は文字列にしてください`);
      return undefined;
    }
    return v;
  };
  const shotName = (
    where: string,
    obj: Record<string, unknown>,
    key: string,
    files: (name: string) => string[],
  ): string | undefined => {
    const v = optionalText(where, obj, key);
    if (v === undefined || v === "") return undefined;
    if (!isShotName(v)) {
      problems.push(
        `${where}の ${key}（${v}）は英小文字・数字・ハイフンだけの名前にしてください`,
      );
      return undefined;
    }
    if (!files(v).some((f) => shots.has(f)))
      problems.push(
        `${where}の ${key} の画像（${files(v).join(" か ")}）が置き場にありません`,
      );
    return v;
  };

  const items: QaItem[] = [];
  raw.items.forEach((rawItem, i) => {
    const where = `items[${i}]`;
    if (!isObject(rawItem)) {
      problems.push(`${where}がオブジェクトではありません`);
      return;
    }
    const text = typeof rawItem.text === "string" ? oneLine(rawItem.text) : "";
    if (text === "") problems.push(`${where}の text がありません`);
    const weight = rawItem.weight as QaWeight;
    if (!QA_WEIGHTS.includes(weight))
      problems.push(
        `${where}の weight は ${QA_WEIGHTS.join("・")} のどれかにしてください`,
      );
    const kind = rawItem.kind as QaKind;
    if (!QA_KINDS.includes(kind))
      problems.push(
        `${where}の kind は ${QA_KINDS.join("・")} のどれかにしてください`,
      );
    const result = rawItem.result as QaResult;
    if (!QA_RESULTS.includes(result))
      problems.push(
        `${where}の result は ${QA_RESULTS.join("・")} のどれかにしてください`,
      );
    else if (
      QA_KINDS.includes(kind) &&
      !RESULTS_FOR_KIND[kind].includes(result)
    )
      problems.push(
        `${where}は ${kind} の項目なので、result は ${RESULTS_FOR_KIND[kind].join("・")} のどれかにしてください`,
      );
    const reason = oneLine(optionalText(where, rawItem, "reason") ?? "");
    if ((result === "fail" || result === "unverified") && reason === "")
      problems.push(
        `${where}は ${result} なので、reason に理由を書いてください`,
      );
    const before = shotName(where, rawItem, "before", (n) => [
      shotFile(n, "before"),
    ]);
    const after = shotName(where, rawItem, "after", (n) => [
      shotFile(n, "after"),
    ]);
    items.push({
      text,
      weight,
      kind,
      result,
      ...(reason === "" ? {} : { reason }),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  });

  const notices: QaNotice[] = [];
  if (raw.notices !== undefined && !Array.isArray(raw.notices))
    problems.push("notices は配列にしてください");
  const rawNotices = Array.isArray(raw.notices) ? raw.notices : [];
  rawNotices.forEach((rawNotice, i) => {
    const where = `notices[${i}]`;
    if (!isObject(rawNotice)) {
      problems.push(`${where}がオブジェクトではありません`);
      return;
    }
    const text =
      typeof rawNotice.text === "string" ? oneLine(rawNotice.text) : "";
    if (text === "") problems.push(`${where}の text がありません`);
    const shot = shotName(where, rawNotice, "shot", (n) => [
      shotFile(n, "after"),
      shotFile(n, "before"),
    ]);
    if (
      shot === undefined &&
      !problems.some((p) => p.startsWith(`${where}の shot`))
    )
      problems.push(`${where}の shot に撮った名前を書いてください`);
    if (shot !== undefined) notices.push({ text, shot });
  });

  if (problems.length > 0)
    throw new FlowError(
      1,
      `--record の入力を受けられません。何も書いていません：\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
  return { items, notices };
}

export function countResults(items: readonly QaItem[]): QaCounts {
  const counts: QaCounts = { pass: 0, fail: 0, unverified: 0, human: 0 };
  for (const item of items) counts[item.result]++;
  return counts;
}

const RESULT_LABEL: Record<QaResult, string> = {
  pass: "通った",
  fail: "落ちた",
  unverified: "確かめられなかった",
  human: "人が見る",
};

export const describeCounts = (counts: QaCounts) =>
  QA_RESULTS.map((r) => `${RESULT_LABEL[r]}（${r}）${counts[r]}`).join("・");

/** 画像は result.md と同じ置き場に並ぶので、ファイル名だけの相対パスで書く */
export function renderResultMd(record: QaRecord): string {
  const counts = countResults(record.items);
  const lines = [
    `# QA の確かめの結果（${record.id}）`,
    "",
    `- 時刻：${record.at}`,
    `- 数：${describeCounts(counts)}`,
    "",
  ];
  record.items.forEach((item, i) => {
    lines.push(`## ${i + 1}. ${item.text}`, "");
    lines.push(`- 重さ：${item.weight}`);
    lines.push(`- 種類：${item.kind}`);
    lines.push(`- 結果：${RESULT_LABEL[item.result]}（${item.result}）`);
    if (item.reason) lines.push(`- 理由：${item.reason}`);
    lines.push("");
    if (item.before !== undefined || item.after !== undefined) {
      lines.push("| 前 | 後 |", "| --- | --- |");
      const cell = (name: string | undefined, side: Side, label: string) =>
        name === undefined
          ? "（なし）"
          : `![${label}](${shotFile(name, side)})`;
      lines.push(
        `| ${cell(item.before, "before", "前")} | ${cell(item.after, "after", "後")} |`,
        "",
      );
    }
  });
  if (record.notices.length > 0) {
    lines.push("## 崩れ", "");
    for (const notice of record.notices)
      lines.push(`- ${notice.text}（${notice.shot}）`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeResult(
  dir: string,
  record: QaRecord,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const md = path.join(dir, "result.md");
  await writeAtomic(
    path.join(dir, "result.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  await writeAtomic(md, `${renderResultMd(record)}\n`);
  return md;
}

export async function readResult(dir: string): Promise<QaRecord | null> {
  let text: string;
  try {
    text = await readFile(path.join(dir, "result.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FlowError(1, `結果を読めませんでした：${message(error)}`);
  }
  try {
    const raw = JSON.parse(text) as QaRecord;
    if (!Array.isArray(raw.items) || !Array.isArray(raw.notices))
      throw new Error();
    return raw;
  } catch {
    throw new FlowError(
      1,
      `結果が壊れています。${path.join(dir, "result.json")} を消すか --record をやり直してください`,
    );
  }
}

/** --open で開いたページ */
export interface OpenedPage {
  page: string;
  url: string;
  /** 開いた URL のスキームとホストとポート */
  origin: string;
  worktree: string;
  at: string;
}

export type OpenedPages = Partial<Record<Side, OpenedPage>>;

const pagesFile = (dir: string) => path.join(dir, "pages.json");

export async function readPages(dir: string): Promise<OpenedPages> {
  let text: string;
  try {
    text = await readFile(pagesFile(dir), "utf8");
  } catch {
    return {};
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const pages: OpenedPages = {};
    for (const side of ["before", "after"] as const) {
      const p = raw[side] as Record<string, unknown> | undefined;
      if (
        p &&
        typeof p.page === "string" &&
        typeof p.url === "string" &&
        typeof p.origin === "string" &&
        typeof p.worktree === "string" &&
        typeof p.at === "string"
      )
        pages[side] = {
          page: p.page,
          url: p.url,
          origin: p.origin,
          worktree: p.worktree,
          at: p.at,
        };
    }
    return pages;
  } catch {
    return {};
  }
}

export async function writePages(
  dir: string,
  pages: OpenedPages,
): Promise<void> {
  if (pages.before === undefined && pages.after === undefined) {
    await rm(pagesFile(dir), { force: true });
    return;
  }
  await mkdir(dir, { recursive: true });
  await writeAtomic(pagesFile(dir), `${JSON.stringify(pages, null, 2)}\n`);
}

export async function writeShot(
  dir: string,
  name: string,
  side: Side,
  png: Buffer,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, shotFile(name, side));
  await writeAtomic(file, png);
  return file;
}

/** --open で作った isolated の profile。pages.json とは分ける（両方のページがないと pages.json ごと消えるため） */
const profileFile = (dir: string) => path.join(dir, "profile.json");

/**
 * 記録の profile の ID。記録がない・読めなければ null。
 * 既定の profile も null（使えば人のサインインが AI のタブに来て、片づけで消せばサインインが消えるため）
 */
export async function readProfile(dir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(profileFile(dir), "utf8")) as Record<
      string,
      unknown
    >;
    return typeof raw.id === "string" &&
      raw.id !== "" &&
      !isDefaultProfile(raw.id)
      ? raw.id
      : null;
  } catch {
    return null;
  }
}

export async function writeProfile(
  dir: string,
  id: string,
  at: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeAtomic(
    profileFile(dir),
    `${JSON.stringify({ id, at }, null, 2)}\n`,
  );
}

export const qaProfileLabel = (id: string) => `orca-flow qa-check ${id}`;

/**
 * 記録の profile を消し、消せたら記録も消す。記録がなければ何もしない。
 * 消せなければ警告だけ出し、記録を残す（--close のときは次の --clear で消し直すため）。消せたかを返す
 */
export async function deleteQaProfile(
  ctx: CommandContext,
  orca: Orca,
  dir: string,
  id: string,
): Promise<boolean> {
  const profile = await readProfile(dir);
  if (profile === null) return false;
  try {
    await orca.deleteProfile(profile);
  } catch (error) {
    ctx.stderr(
      `警告：${id} の QA の確かめのブラウザの profile（${profile}）を消せませんでした（${message(error)}）。orca tab profile delete --profile ${profile} で消してください`,
    );
    return false;
  }
  await rm(profileFile(dir), { force: true });
  return true;
}

/** profile の記録だけを消す。Orca 側の profile は触らない */
export async function forgetProfile(dir: string): Promise<void> {
  await rm(profileFile(dir), { force: true });
}

/** 置き場を消す。ID が空・形が外れていれば何も消さない。消せなければ警告だけ（統合の仕上げ用） */
export async function clearQaChecks(
  ctx: CommandContext,
  common: string,
  id: string,
): Promise<boolean> {
  if (id === "" || !hasIdShape(id)) return false;
  const dir = qaChecksDir(common, id);
  if (!(await exists(dir))) return false;
  await deleteQaProfile(ctx, createOrca(ctx.runner, ctx.cwd), dir, id);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    ctx.stderr(
      `警告：${id} の QA の確かめの置き場（${dir}）を消せませんでした（${message(error)}）。手で消してください`,
    );
    return false;
  }
}

/** URL の origin。http(s) でなければ null */
export function httpOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}
