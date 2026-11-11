import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import { waitState } from "./auto.ts";
import { FlowError, type CommandContext } from "../types.ts";
import type { Runner } from "./exec.ts";
import { tellLead } from "./finish.ts";
import { gitCommonDir, type ActiveTask } from "./git.ts";
import { acquireLock, releaseOrWarn } from "./lock.ts";
import {
  createOrca,
  describeSendBlock,
  notSentWarning,
  type Orca,
} from "./orca.ts";
import { missingMessage, stackedOn, stackState } from "./stack.ts";
import { commonRecordPath, hasIdShape } from "./task-id.ts";
import { readRecord } from "./verified.ts";

// 乗せたタスクで CLI が決めた文：統合と push の止める文と、後ろのタスクへの知らせ。
// 知らせはここの固定の文だけにする（タスクが書いた文をほかのタスクへ渡さない。7章5番）。
// 枝の名前は前のタスクが git branch -m で変えられるので埋めない。埋めるのは形を確かめた ID だけ

/** 後ろへの知らせの種類。advanced：乗せた先の verify が通った。respec：乗せた先が spec-review になった */
export type StackNoticeKind = "advanced" | "respec";

/** 後ろのタスク長 self に送る文（tellLead が頭に「（〈integratorName〉より）」をつける） */
export function stackNoticeText(
  kind: StackNoticeKind,
  on: string,
  self: string,
): string {
  return kind === "advanced"
    ? `乗せた先 ${on} の verify が通り、前の枝が進んだので知らせます。土台の枝は orca-flow depends ${self} --base で読めます。区切りのよいところで土台の枝を取り込んで見直し、orca-flow verify を流してください。統合待ちなら、取り込んで verify を流し直し、integrate-wait に戻してください。`
    : `乗せた先 ${on} が spec-review になり、前の設計書が出直したので知らせます。${on} の設計書を読み直し、このタスクの設計と作業が前提にしたものが変わっていれば直してください。`;
}

const WHAT: Record<StackNoticeKind, string> = {
  advanced: "前の枝が進んだ知らせ",
  respec: "前の設計書が出直した知らせ",
};

const tellWhat = (kind: StackNoticeKind, on: string) =>
  kind === "advanced"
    ? `${on} の枝を取り込んで verify をする`
    : `${on} の設計書を読み直し、要れば直す`;

/** 後ろのタスク長 task に、onId からの知らせを送る。送れたら true（送れなければ tellLead が警告する） */
export function tellStacked(
  ctx: CommandContext,
  config: FlowConfig,
  orca: Orca,
  task: { id: string; path: string },
  onId: string,
  kind: StackNoticeKind,
): Promise<boolean> {
  return tellLead(
    ctx,
    config,
    orca,
    task.id,
    task.path,
    WHAT[kind],
    tellWhat(kind, onId),
    stackNoticeText(kind, onId, task.id),
  );
}

// ---- 知らせの記録 ----

/** 送れなかった知らせを待ち受けが送り直すまでの間（ミリ秒）：1分 */
export const STACK_RETRY_MS = 60_000;
/** テストで間を短くする環境変数 */
export const STACK_RETRY_ENV = "ORCA_FLOW_STACK_RETRY_MS";

/**
 * 送り中の印を、送っている最中とみなす間（ミリ秒）：5分。
 * 送る途中でプロセスが落ちて印が残っても、これを過ぎたら待ち受けが送り直す
 */
export const STACK_SENDING_MS = 5 * 60_000;

/**
 * 後ろのタスクに「前の枝が進んだ」を送った記録。`〈共通〉/orca-flow/stack-notice/〈後ろの ID〉.json`。
 * verify と待ち受けが同じ記録を書き、同じ先頭を二度送らない
 */
export interface StackNoticeRecord {
  /** 後ろのタスクの ID */
  id: string;
  /** 乗せた先の ID */
  on: string;
  /** 送れた、乗せた先の verify の記録の先頭 */
  sentHead: string | null;
  sentAt: string | null;
  /** 送れなかった先頭と時刻（待ち受けは間を置いてから送り直す） */
  failedHead: string | null;
  failedAt: string | null;
  /** 送っている最中の先頭と時刻（verify と待ち受けが同じ先頭を同時に送らない） */
  sendingHead: string | null;
  sendingAt: string | null;
}

export const stackNoticeFile = (common: string, id: string) =>
  commonRecordPath(common, "stack-notice", id, ".json");

const textOrNull = (v: unknown) => (typeof v === "string" ? v : null);

/** 記録を読む。ない・壊れている・ID の形が違うなら null */
export async function readStackNotice(
  common: string,
  id: string,
): Promise<StackNoticeRecord | null> {
  if (!hasIdShape(id)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(stackNoticeFile(common, id), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.id !== id || typeof r.on !== "string" || !hasIdShape(r.on)) return null;
  return {
    id,
    on: r.on,
    sentHead: textOrNull(r.sentHead),
    sentAt: textOrNull(r.sentAt),
    failedHead: textOrNull(r.failedHead),
    failedAt: textOrNull(r.failedAt),
    sendingHead: textOrNull(r.sendingHead),
    sendingAt: textOrNull(r.sendingAt),
  };
}

/** 記録を一時ファイルと rename で置き換える（verify と待ち受けが同じ記録を書くため） */
export async function writeStackNotice(
  common: string,
  record: StackNoticeRecord,
): Promise<void> {
  const file = stackNoticeFile(common, record.id);
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

/**
 * 記録の読みと書きを、後ろの ID ごとのロックの中で行う。ほかが持っていて取れなければ null
 * （読んでから送り中の印を書くまでの間に、もう一方が同じ先頭を読んで送らないため）
 */
async function withNoticeLock<T>(
  common: string,
  id: string,
  body: () => Promise<T>,
): Promise<T | null> {
  const file = stackNoticeFile(common, id);
  await mkdir(path.dirname(file), { recursive: true });
  const got = await acquireLock(`${file}.lock`, {
    waitMs: 3_000,
    pollMs: 20,
    kind: "stack-notice",
    failed: (lock, detail) =>
      `乗せたタスクへの知らせの記録のロックを読み書きできません（${lock}：${detail}）`,
  });
  if (got.kind === "held") return null;
  try {
    return await body();
  } finally {
    await releaseOrWarn(got.release);
  }
}

/** 乗せた先が同じときだけ前の記録を引き継ぐ */
const sameOn = (record: StackNoticeRecord | null, on: string) =>
  record?.on === on ? record : null;

const within = (at: string | null, now: Date, ms: number) =>
  at !== null && now.getTime() - Date.parse(at) < ms;

/**
 * 送る前に、同じ先頭を送り済み・ほかが送り中（・送り直しの間の内）でないかを確かめ、送り中の印を書く。
 * - claimed：送ってよい。previous は印を書く前の記録（乗せた先が違えば null）
 * - skip：送らない（sent：送り済み。sending：ほかが送り中か、ロックを取れない。waiting：送り直しの間の内）
 * retryAfterFailMs が null なら、送れなかった先頭でもすぐ送る（verify が通るたびに送る）
 */
export async function claimStackNotice(
  common: string,
  id: string,
  on: string,
  head: string,
  now: Date,
  retryAfterFailMs: number | null,
): Promise<
  | { kind: "claimed"; previous: StackNoticeRecord | null }
  | { kind: "skip"; reason: "sent" | "sending" | "waiting" }
> {
  const result = await withNoticeLock(common, id, async () => {
    const previous = sameOn(await readStackNotice(common, id), on);
    if (previous?.sentHead === head)
      return { kind: "skip" as const, reason: "sent" as const };
    if (
      previous?.sendingHead === head &&
      within(previous.sendingAt, now, STACK_SENDING_MS)
    )
      return { kind: "skip" as const, reason: "sending" as const };
    if (
      retryAfterFailMs !== null &&
      previous?.failedHead === head &&
      within(previous.failedAt, now, retryAfterFailMs)
    )
      return { kind: "skip" as const, reason: "waiting" as const };
    await writeStackNotice(common, {
      id,
      on,
      sentHead: previous?.sentHead ?? null,
      sentAt: previous?.sentAt ?? null,
      failedHead: previous?.failedHead ?? null,
      failedAt: previous?.failedAt ?? null,
      sendingHead: head,
      sendingAt: now.toISOString(),
    });
    return { kind: "claimed" as const, previous };
  });
  return result ?? { kind: "skip", reason: "sending" };
}

/**
 * 送った結果を書き、送り中の印を消す。送れたら送れた先頭を、送れなければ送れなかった先頭を書く。
 * 送り中の印が head でなければ書かない（送っている間にほかが新しい先頭を取ったとき、
 * その印と結果を古い先頭で上書きすると、次の見直しで新しい先頭をもう一度送るため）。
 * ロックを取れなくても同じ条件で書く（rename で置き換えるので、記録は壊れない）
 */
export async function settleStackNotice(
  common: string,
  id: string,
  on: string,
  head: string,
  now: Date,
  sent: boolean,
): Promise<void> {
  const write = async () => {
    const current = sameOn(await readStackNotice(common, id), on);
    if (current?.sendingHead !== head) return false;
    await writeStackNotice(
      common,
      sent
        ? {
            id,
            on,
            sentHead: head,
            sentAt: now.toISOString(),
            failedHead: null,
            failedAt: null,
            sendingHead: null,
            sendingAt: null,
          }
        : {
            id,
            on,
            sentHead: current?.sentHead ?? null,
            sentAt: current?.sentAt ?? null,
            failedHead: head,
            failedAt: now.toISOString(),
            sendingHead: null,
            sendingAt: null,
          },
    );
    return true;
  };
  if ((await withNoticeLock(common, id, write)) === null) await write();
}

/** 待ち受けから送る。tellLead と違い、警告は出さずに送れない理由を返す（警告の出し方は呼び手が決める） */
export async function sendStackedQuietly(
  config: FlowConfig,
  orca: Orca,
  task: { id: string; path: string },
  onId: string,
  kind: StackNoticeKind,
): Promise<{ sent: true } | { sent: false; reason: string }> {
  try {
    const found = await orca.findSendTarget(task.path, config.lead.agent);
    if (found.kind !== "found")
      return {
        sent: false,
        reason: describeSendBlock(found, config.lead.agent),
      };
    await orca.sendText(
      found.terminal.handle,
      `（${config.integratorName}より）${stackNoticeText(kind, onId, task.id)}`,
    );
    return { sent: true };
  } catch (error) {
    return {
      sent: false,
      reason: `Orca の送信が失敗しました（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
}

/** 待ち受けが送れなかったときの警告。同じ先頭では1回だけ出し、人に tell で伝え直させない（二重に届くため） */
export const retryWarning = (
  id: string,
  kind: StackNoticeKind,
  reason: string,
) =>
  notSentWarning(
    id,
    WHAT[kind],
    reason,
    "統括役の待ち受けが間を置いて送り直すので、orca-flow tell で伝え直さないでください（同じ先頭で送れないあいだ、この警告はもう出しません）",
  );

/**
 * onId に乗せている作業中のタスク長へ知らせを送る。送れた ID を返す。
 * 「前の枝が進んだ」は、乗せた先の verify の記録の先頭を送り済み・待ち受けが送り中なら送らず、
 * 送ったら結果（送れた・送れなかった先頭）を知らせの記録に書く。
 * 記録に書けて待ち受けが動いていれば、送れないときは待ち受けと同じ警告（tell を促さない）にする。
 * 送れない・送り先を探せない・記録を書けないときは警告だけにして、呼んだコマンドの終了コードを変えない
 */
export async function notifyStacked(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  onId: string,
  kind: StackNoticeKind,
): Promise<string[]> {
  let targets: ActiveTask[];
  try {
    targets = await stackedOn(ctx.runner, root, config, onId);
  } catch (error) {
    ctx.stderr(
      `警告：${onId} に乗せたタスクを探せなかったので、${WHAT[kind]}を送っていません（${error instanceof Error ? error.message : String(error)}）`,
    );
    return [];
  }
  if (targets.length === 0) return [];
  const orca = createOrca(ctx.runner, root);
  const recordWarning = (error: unknown) =>
    ctx.stderr(
      `警告：${WHAT[kind]}の記録を読み書きできませんでした。統括役の待ち受けが同じ知らせをもう一度送ることがあります（${error instanceof Error ? error.message : String(error)}）`,
    );
  let notice: { common: string; head: string } | null = null;
  if (kind === "advanced")
    try {
      const head = (await readRecord(ctx.runner, root, onId))?.head;
      if (head) notice = { common: await gitCommonDir(ctx.runner, root), head };
    } catch (error) {
      recordWarning(error);
    }
  // 待ち受けが動いていれば、送れなかった先頭は待ち受けが送り直すので、tell を促さない（二重に届くため）
  const waiterRetries =
    notice !== null && (await waitState(notice.common)).running;
  const sent: string[] = [];
  for (const task of targets) {
    let claimed = false;
    let failedBefore = false;
    if (notice)
      try {
        const claim = await claimStackNotice(
          notice.common,
          task.id,
          onId,
          notice.head,
          ctx.now(),
          null,
        );
        if (claim.kind === "skip") continue;
        claimed = true;
        failedBefore = claim.previous?.failedHead === notice.head;
      } catch (error) {
        recordWarning(error);
      }
    let ok: boolean;
    if (claimed && waiterRetries) {
      const outcome = await sendStackedQuietly(config, orca, task, onId, kind);
      ok = outcome.sent;
      if (!outcome.sent && !failedBefore)
        ctx.stderr(retryWarning(task.id, kind, outcome.reason));
    } else ok = await tellStacked(ctx, config, orca, task, onId, kind);
    if (ok) sent.push(task.id);
    if (notice && claimed)
      try {
        await settleStackNotice(
          notice.common,
          task.id,
          onId,
          notice.head,
          ctx.now(),
          ok,
        );
      } catch (error) {
        recordWarning(error);
      }
  }
  return sent;
}

/**
 * integrate と push の前に、乗せた先が baseBranch に入ったかを確かめる。
 * 入っていなければ（--skip-order でも）、乗せた先が見つからなければ FlowError(2)
 */
export async function requireStackLanded(
  runner: Runner,
  root: string,
  config: FlowConfig,
  id: string,
  verb: "integrate" | "push",
): Promise<void> {
  const state = await stackState(runner, root, config, id);
  if (state.kind === "missing")
    throw new FlowError(2, missingMessage(id, state.record));
  if (state.kind !== "open") return;
  const on = state.record.on;
  throw new FlowError(
    2,
    `${id} は ${on}（${state.task.branch}）に乗せていて、${on} がまだ ${config.baseBranch} に入っていません。${verb === "integrate" ? "マージしていません" : "push も PR もしていません"}。乗せた先より先には入れられないので（--skip-order でも飛ばせません）、先に ${on} を入れてから、もう一度 ${verb} してください`,
  );
}
