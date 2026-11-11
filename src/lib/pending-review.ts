import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../types.ts";
import {
  addPendingThreadReply,
  createPendingReviewOn,
  deletePendingComment,
  envSecrets,
  readPendingReviewOf,
  redactSecrets,
  updatePendingComment,
  type GhContext,
  type PendingComment,
} from "./github.ts";
import { acquireLock, releaseOrWarn } from "./lock.ts";
import { commonRecordPath } from "./task-id.ts";

// 保留中のレビュー（GitHub の本人にしか見えない下書き）の読み書き。
// ここから書けるのは保留のコメントとレビューの本文だけで、レビューの送信（本投稿）は呼べない
// （送る関数は outbox.ts の reply だけ。このファイルは送信の関数を import しない）。
// respond が書いたコメントの ID は、作業ツリーの外の respond/〈ID〉/drafts.json に残す。

export type { PendingComment };

/** 本文に書いてはいけないものの確かめ（手元のパス・秘密）。呼び手が設定から作る */
export interface BodyGuard {
  env: NodeJS.ProcessEnv;
  /** 本文に含まれる、書いてはいけないものの種類（値は返さない）。秘密は呼ぶ前に伏せ字にしてある */
  problems: (body: string) => string[];
}

/** 保留の記録の置き場所（タスクの ID と git の共通ディレクトリ） */
export interface DraftStore {
  common: string;
  taskId: string;
}

interface DraftsPr {
  reviewId: string;
  /** respond が書いたコメントの ID */
  commentIds: string[];
  /** respond が持つレビューの本文（会話の欄への返事）。GitHub には書かず、本投稿のときに渡す。同じレビューの ID のときだけ使う */
  summary?: string;
  /** 返信のコメントの ID ごとの、直したコミット（40桁の SHA）の並び。ない返信は直しの結びつけがない */
  fixedBy?: Record<string, string[]>;
}

export interface DraftsRecord {
  /** PR の番号ごと */
  prs: Record<string, DraftsPr>;
}

export const draftsPath = (common: string, taskId: string) =>
  commonRecordPath(common, "respond", taskId, `${path.sep}drafts.json`);

export async function readDrafts(
  common: string,
  taskId: string,
): Promise<DraftsRecord> {
  const file = draftsPath(common, taskId);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // ないのは、まだ何も書いていないとき。それ以外（読めない）は黙って空にしない
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { prs: {} };
    throw broken(file, error instanceof Error ? error.message : String(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw broken(file, error instanceof Error ? error.message : String(error));
  }
  const raw =
    typeof parsed === "object" && parsed !== null && "prs" in parsed
      ? (parsed as { prs: unknown }).prs
      : null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw broken(file, "prs の形が正しくありません");
  const prs: Record<string, DraftsPr> = {};
  for (const [key, value] of Object.entries(raw)) {
    const v = value as {
      reviewId?: unknown;
      commentIds?: unknown;
      summary?: unknown;
      fixedBy?: unknown;
    };
    if (
      typeof v?.reviewId !== "string" ||
      !Array.isArray(v.commentIds) ||
      !v.commentIds.every((c) => typeof c === "string") ||
      (v.summary !== undefined && typeof v.summary !== "string") ||
      (v.fixedBy !== undefined && !isFixedBy(v.fixedBy))
    )
      throw broken(file, `PR ${key} の項目の形が正しくありません`);
    prs[key] = {
      reviewId: v.reviewId,
      commentIds: v.commentIds as string[],
      ...(v.summary === undefined ? {} : { summary: v.summary }),
      ...(v.fixedBy === undefined ? {} : { fixedBy: v.fixedBy }),
    };
  }
  return { prs };
}

function isFixedBy(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (list) =>
        Array.isArray(list) &&
        list.length > 0 &&
        list.every((x) => typeof x === "string" && /^[0-9a-f]{40}$/.test(x)),
    )
  );
}

const broken = (file: string, detail: string) =>
  new FlowError(
    1,
    `respond の記録を読めませんでした：${file}（${detail}）。respond が書いたコメントを見分けられなくなるので、中身を確かめて直すか、消してから（GitHub の保留中のレビューは残ります）やり直してください`,
  );

const LOCK_WAIT_MS = 30_000;

/** 記録の書き換えを、タスクの respond の記録ごとに順番にする（GitHub への書き込みから記録の書き込みまで囲む） */
async function withDraftsLock<T>(
  store: DraftStore,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = commonRecordPath(
    store.common,
    "respond",
    store.taskId,
    `${path.sep}drafts.lock`,
  );
  await mkdir(path.dirname(lock), { recursive: true });
  const got = await acquireLock(lock, {
    waitMs: LOCK_WAIT_MS,
    kind: "respond-draft",
    failed: (file, detail) =>
      `respond の記録のロックを扱えませんでした：${file}（${detail}）`,
  });
  if (got.kind === "held")
    throw new FlowError(
      2,
      `ほかの respond draft が動いています${got.pid === null ? "" : `（プロセス ${got.pid}）`}。終わってからやり直してください（${got.lockPath}）`,
    );
  try {
    return await fn();
  } finally {
    await releaseOrWarn(got.release);
  }
}

export async function writeDrafts(
  common: string,
  taskId: string,
  record: DraftsRecord,
): Promise<void> {
  const file = draftsPath(common, taskId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** 保留中のレビューの中身。mine＝respond が書いたコメント、foreign＝respond の記録にないコメント（人が GitHub で書いたか、記録が欠けた） */
export interface PendingDrafts {
  prId: string;
  /** 保留中のレビューの ID。なければ null */
  reviewId: string | null;
  /** レビューの本文 */
  body: string;
  mine: PendingComment[];
  foreign: PendingComment[];
  /** PR の URL（読めなければ null） */
  prUrl: string | null;
  /** 自分のログイン名（読めなければ null） */
  viewer: string | null;
  /** respond の記録の、返信のコメントの ID ごとの直しのコミット（今のレビューの ID と同じ記録のときだけ） */
  fixedBy: Record<string, string[]>;
}

/** 記録のレビューの本文。記録のレビューの ID が今のレビューと同じときだけ返す。なければ、空白だけのときも、ないもの（undefined）として扱う */
export function recordedSummary(
  record: DraftsRecord,
  pr: number,
  reviewId: string,
): string | undefined {
  const found = record.prs[String(pr)];
  return found &&
    found.reviewId === reviewId &&
    found.summary !== undefined &&
    found.summary.trim() !== ""
    ? found.summary
    : undefined;
}

/** 記録の、返信ごとの直しのコミット。記録のレビューの ID が今のレビューと同じときだけ返す */
export function recordedFixedBy(
  record: DraftsRecord,
  pr: number,
  reviewId: string,
): Record<string, string[]> {
  const found = record.prs[String(pr)];
  return found && found.reviewId === reviewId ? (found.fixedBy ?? {}) : {};
}

/** 保留中のレビューを読み、respond が書いたコメントとそれ以外に分ける（読むだけ） */
export async function loadPendingDrafts(
  g: GhContext,
  store: DraftStore,
  pr: number,
): Promise<PendingDrafts> {
  const read = await readPendingReviewOf(g, pr);
  if (!read.review)
    return {
      prId: read.prId,
      reviewId: null,
      body: "",
      mine: [],
      foreign: [],
      prUrl: read.prUrl,
      viewer: read.viewer,
      fixedBy: {},
    };
  const all = await readDrafts(store.common, store.taskId);
  const record = all.prs[String(pr)];
  // 記録のレビューと違うレビュー（本投稿して作り直した）なら、記録のコメントは別のものとして扱う
  const known = new Set(
    record && record.reviewId === read.review.id ? record.commentIds : [],
  );
  return {
    prId: read.prId,
    reviewId: read.review.id,
    // 本文は記録のものを優先し、なければ GitHub の本文
    body: recordedSummary(all, pr, read.review.id) ?? read.review.body,
    mine: read.review.comments.filter((c) => known.has(c.id)),
    foreign: read.review.comments.filter((c) => !known.has(c.id)),
    prUrl: read.prUrl,
    viewer: read.viewer,
    fixedBy: recordedFixedBy(all, pr, read.review.id),
  };
}

/** 書く本文の確かめ：秘密は伏せ字にし、手元のパスがあれば書かずに FlowError(1) */
export function prepareDraftBody(body: string, guard: BodyGuard): string {
  const redacted = redactSecrets(body, envSecrets(guard.env));
  if (redacted.trim() === "") throw new FlowError(1, "本文が空です");
  const problems = guard.problems(redacted);
  if (problems.length > 0)
    throw new FlowError(
      1,
      `本文に、${problems.join("、")}が含まれています。消してから、もう一度やり直してください（何も書いていません）`,
    );
  return redacted;
}

async function ensureReview(
  g: GhContext,
  store: DraftStore,
  pr: number,
): Promise<{ prId: string; reviewId: string }> {
  const current = await loadPendingDrafts(g, store, pr);
  if (current.reviewId)
    return { prId: current.prId, reviewId: current.reviewId };
  const reviewId = await createPendingReviewOn(g, current.prId);
  const record = await readDrafts(store.common, store.taskId);
  record.prs[String(pr)] = { reviewId, commentIds: [] };
  await writeDrafts(store.common, store.taskId, record);
  return { prId: current.prId, reviewId };
}

/** 記録の PR の項目を、今のレビューの ID に合わせて返す（違えば空から始める） */
function entryFor(
  record: DraftsRecord,
  pr: number,
  reviewId: string,
): DraftsPr {
  const found = record.prs[String(pr)];
  const entry: DraftsPr =
    found && found.reviewId === reviewId ? found : { reviewId, commentIds: [] };
  record.prs[String(pr)] = entry;
  return entry;
}

/** スレッドへの返信を保留中のレビューに足す（保留中のレビューがなければ作る）。足したコメントの ID を返す */
export async function draftThreadReply(
  g: GhContext,
  store: DraftStore,
  input: {
    pr: number;
    threadId: string;
    body: string;
    /** 直したコミット（40桁）。なければ結びつけない */
    fixedBy?: string[];
  },
  guard: BodyGuard,
): Promise<{ commentId: string; reviewId: string }> {
  const body = prepareDraftBody(input.body, guard);
  if (input.threadId.trim() === "")
    throw new FlowError(1, "スレッドの ID を渡してください");
  return withDraftsLock(store, async () => {
    const { reviewId } = await ensureReview(g, store, input.pr);
    const commentId = await addPendingThreadReply(
      g,
      reviewId,
      input.threadId,
      body,
    );
    const record = await readDrafts(store.common, store.taskId);
    const entry = entryFor(record, input.pr, reviewId);
    entry.commentIds.push(commentId);
    if (input.fixedBy && input.fixedBy.length > 0)
      entry.fixedBy = { ...entry.fixedBy, [commentId]: input.fixedBy };
    await writeDrafts(store.common, store.taskId, record);
    return { commentId, reviewId };
  });
}

async function requireMine(
  g: GhContext,
  store: DraftStore,
  pr: number,
  commentId: string,
): Promise<void> {
  const drafts = await loadPendingDrafts(g, store, pr);
  if (!drafts.mine.some((c) => c.id === commentId))
    throw new FlowError(
      1,
      "respond が書いた保留中のコメントではありません（人が書いたコメントは直しも消しもしません）",
    );
}

/**
 * respond が書いた保留中のコメントを直す。
 * body があれば本文を直し、fixedBy があれば直しの結びつけを書き換える（"none" なら外す）。どちらかは要る
 */
export async function editDraftComment(
  g: GhContext,
  store: DraftStore,
  input: {
    pr: number;
    commentId: string;
    body?: string;
    fixedBy?: string[] | "none";
  },
  guard: BodyGuard,
): Promise<void> {
  if (input.body === undefined && input.fixedBy === undefined)
    throw new FlowError(1, "本文か直しのコミットのどちらかを渡してください");
  const body =
    input.body === undefined ? null : prepareDraftBody(input.body, guard);
  await withDraftsLock(store, async () => {
    await requireMine(g, store, input.pr, input.commentId);
    if (body !== null) await updatePendingComment(g, input.commentId, body);
    if (input.fixedBy === undefined) return;
    const record = await readDrafts(store.common, store.taskId);
    const entry = record.prs[String(input.pr)];
    if (!entry) return;
    const next = { ...entry.fixedBy };
    if (input.fixedBy === "none") delete next[input.commentId];
    else next[input.commentId] = input.fixedBy;
    if (Object.keys(next).length === 0) delete entry.fixedBy;
    else entry.fixedBy = next;
    await writeDrafts(store.common, store.taskId, record);
  });
}

/** respond が書いた保留中のコメントを消す */
export async function deleteDraftComment(
  g: GhContext,
  store: DraftStore,
  input: { pr: number; commentId: string },
): Promise<void> {
  await withDraftsLock(store, async () => {
    await requireMine(g, store, input.pr, input.commentId);
    await deletePendingComment(g, input.commentId);
    const record = await readDrafts(store.common, store.taskId);
    const entry = record.prs[String(input.pr)];
    if (entry) {
      entry.commentIds = entry.commentIds.filter((c) => c !== input.commentId);
      if (entry.fixedBy) {
        delete entry.fixedBy[input.commentId];
        if (Object.keys(entry.fixedBy).length === 0) delete entry.fixedBy;
      }
      await writeDrafts(store.common, store.taskId, record);
    }
  });
}

/** 保留中のレビューの本文（行に付かない会話の欄への返事など）を記録に書く。GitHub には書かず、本投稿のときに渡す */
export async function setReviewSummary(
  g: GhContext,
  store: DraftStore,
  input: { pr: number; body: string },
  guard: BodyGuard,
): Promise<{ reviewId: string }> {
  const body = prepareDraftBody(input.body, guard);
  return withDraftsLock(store, async () => {
    const { reviewId } = await ensureReview(g, store, input.pr);
    const record = await readDrafts(store.common, store.taskId);
    entryFor(record, input.pr, reviewId).summary = body;
    await writeDrafts(store.common, store.taskId, record);
    return { reviewId };
  });
}
