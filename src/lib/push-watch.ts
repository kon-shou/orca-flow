import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { requireConfig, type FlowConfig } from "../config.ts";
import {
  FlowError,
  type CommandContext,
  type CommandResult,
} from "../types.ts";
import {
  findPushTask,
  finishMergedTask,
  pushRecordFile,
  readPushRecord,
  writePushRecord,
} from "./finish.ts";
import {
  envSecrets,
  findPr,
  markPrReady,
  readPr,
  redactSecrets,
  requireGh,
  type GhContext,
  type PrInfo,
} from "./github.ts";
import { requireRoot } from "./git.ts";
import { acquireLock, holderAlive, parseLock, releaseOrWarn } from "./lock.ts";
import { launchBackground } from "./background.ts";
import {
  cardForPushWatch,
  createOrca,
  type CardUpdate,
  type PushWatchPhase,
} from "./orca.ts";

// push の道の背景の待ち受け。CI を待ち、設定が after-ci なら通ったときに下書きを外し、
// マージか閉じるまで PR を見続ける。マージを見つけたら finishMergedTask で後始末をする。

/** 見に行く間隔の既定（ミリ秒） */
export const DEFAULT_INTERVAL_MS = 60_000;
/** CI のチェックが見つからない（none）状態が、これだけ続いたら「チェックなし＝通った」と同じに扱う */
export const DEFAULT_NO_CI_POLLS = 3;
/** gh の読み取りが続けて失敗したら、待ち受けを止める回数 */
export const MAX_READ_FAILURES = 10;

/** テストで時計・間隔を差し替えるための引数 */
export interface WatchOptions {
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  noCiPolls?: number;
  /** 見に行く回数の上限（テスト用）。超えたらマージも閉じも見つけずに終わる */
  maxPolls?: number;
}

/** 記録の watch キーの状態 */
export type WatchStatus = PushWatchPhase | "merged" | "gh-error";

export interface WatchState {
  status: WatchStatus;
  /** 止まったときの理由など */
  detail: string | null;
  /** 後始末が止まった理由の種類（place・dirty・fetch・conflict・orca） */
  reason: string | null;
  /** CI の結果 */
  ci: string | null;
  /** PR が下書きか */
  draft: boolean | null;
  updatedAt: string;
}

export const STATUS_LABEL: Record<WatchStatus, string> = {
  "ci-wait": "CI 待ち",
  "review-wait": "レビュー待ち",
  "ci-failed": "CI が落ちた",
  "cleanup-stopped": "後始末で止まった",
  "watch-stopped": "待ち受けが止まった",
  closed: "PR が閉じられた",
  merged: "マージされて後始末が済んだ",
  "gh-error": "GitHub を読めず止まった",
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 待ち受けのロックと起動のログを置く所（記録と同じ場所） */
async function watchDir(ctx: CommandContext, root: string, id: string) {
  return path.dirname(await pushRecordFile(ctx.runner, root, id));
}
const lockFile = (dir: string, id: string) => path.join(dir, `${id}.lock`);

/** 出力・記録・カードに出す前に、トークンらしい値と環境変数のトークンを伏せる */
const safe = (ctx: CommandContext, text: string) =>
  redactSecrets(text, envSecrets(ctx.env));

/** 待ち受けが今動いているか（ロックの持ち主が生きているか） */
export async function watcherRunning(
  ctx: CommandContext,
  root: string,
  id: string,
): Promise<{ running: boolean; pid: number | null }> {
  try {
    const holder = parseLock(
      await readFile(lockFile(await watchDir(ctx, root, id), id), "utf8"),
    );
    return {
      running: holderAlive(holder.pid, holder.bootAt),
      pid: Number.isInteger(holder.pid) ? holder.pid : null,
    };
  } catch {
    return { running: false, pid: null };
  }
}

/** 記録の watch キーを書く */
async function saveWatchState(
  ctx: CommandContext,
  root: string,
  id: string,
  status: WatchStatus,
  extra: Partial<Pick<WatchState, "detail" | "reason" | "ci" | "draft">> = {},
) {
  return writePushRecord(ctx.runner, root, id, {
    id,
    watch: {
      status,
      detail: null,
      reason: null,
      ci: null,
      draft: null,
      ...extra,
      updatedAt: ctx.now().toISOString(),
    } satisfies WatchState,
  });
}

/** カードを更新する。失敗しても投げず、警告だけ出して false */
async function putWatchCard(
  ctx: CommandContext,
  root: string,
  id: string,
  worktree: string,
  update: CardUpdate,
): Promise<boolean> {
  try {
    await createOrca(ctx.runner, root).setCard(worktree, update);
    return true;
  } catch (error) {
    ctx.stderr(
      `警告：${id} のカードを更新できませんでした（${safe(ctx, message(error))}）`,
    );
    return false;
  }
}

/** push のあと、背景で `orca-flow push 〈ID〉 --watch` を起こして、終わりを待たずに戻る */
export async function launchPushWatch(
  ctx: CommandContext,
  id: string,
): Promise<void> {
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const dir = await watchDir(ctx, root, id);
  await mkdir(dir, { recursive: true });
  const log = path.join(dir, `${id}.log`);
  await launchBackground(
    ctx.runner,
    {
      cwd: root,
      log,
      args: ["push", id, "--watch"],
      failure: (reason) =>
        `背景の待ち受けを起動できませんでした：${reason}。orca-flow push ${id} をもう一度打つと起こし直します`,
    },
    redactSecrets,
  );
}

// ---- 待ち受けの本体 ----

/** 待ち受けが止まるときの印のために、いま分かっていること */
interface Known {
  number: number | null;
  taskPath: string | null;
}

/** `orca-flow push 〈ID〉 --watch`：PR のマージか閉じるまで見続ける */
export async function runPushWatch(
  ctx: CommandContext,
  id: string,
  opts: WatchOptions = {},
): Promise<CommandResult> {
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const dir = await watchDir(ctx, root, id);
  await mkdir(dir, { recursive: true });
  const lock = await acquireWatchLock(dir, id);
  if (lock.kind === "held") {
    if (!ctx.json)
      ctx.stdout(
        `${id} の待ち受けはすでに動いています（プロセス ${lock.pid ?? "不明"}）。2つ目は起こしませんでした`,
      );
    return {
      code: 0,
      data: { id, watching: false, alreadyRunning: true, pid: lock.pid },
    };
  }
  const known: Known = { number: null, taskPath: null };
  try {
    return await watchLoop(ctx, root, id, opts, known);
  } catch (error) {
    throw await markWatchStopped(ctx, root, id, error, known);
  } finally {
    await releaseOrWarn(lock.release);
  }
}

function acquireWatchLock(dir: string, id: string) {
  return acquireLock(lockFile(dir, id), {
    waitMs: 0,
    maxAttempts: 3,
    failed: (file, detail) =>
      `待ち受けのロックを読み書きできません（${file}：${detail}）。ロックのパスを確かめてください`,
    releaseFailed: (file, detail) =>
      `待ち受けのロックを外せませんでした（${file}：${detail}）。ロックが残っていれば、${file} を消してください`,
  });
}

/** 待ち受けが止まるとき、記録とカードに印を残す（できる範囲で）。投げ直すエラー（トークンは伏せる）を返す */
async function markWatchStopped(
  ctx: CommandContext,
  root: string,
  id: string,
  error: unknown,
  known: Known,
): Promise<FlowError> {
  const detail = safe(ctx, message(error));
  try {
    if (await readPushRecord(ctx.runner, root, id))
      await saveWatchState(ctx, root, id, "watch-stopped", { detail });
  } catch {
    // 記録を書けなくても、元のエラーを返す
  }
  if (known.taskPath)
    await putWatchCard(
      ctx,
      root,
      id,
      known.taskPath,
      cardForPushWatch("watch-stopped", known.number, { detail }),
    );
  return new FlowError(error instanceof FlowError ? error.code : 1, detail);
}

/** マージ済みの PR の後始末の結果 */
export type CleanupOutcome =
  /** 待ち受けがロックを持っている（待ち受けが後始末をしている） */
  | { kind: "watching"; pid: number | null }
  /** main のロックが取れない（integrate・push の道の後始末・approve・new のどれかが main を書き換えている） */
  | { kind: "busy" }
  /** 後始末をした、または止まった（記録とカードは更新済み） */
  | { kind: "finished"; result: CommandResult };

/**
 * PR がマージされたあとの後始末。待ち受けと push の打ち直しが両方これを通る。
 * 待ち受けのロックを取り（待ち受け自身は holdingWatchLock で、持っていることを伝える）、finishMergedTask を流して、
 * 記録の watch とカードを更新する
 */
export async function cleanupMergedPr(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  task: { id: string; branch: string; path: string },
  pr: PrInfo,
  options: { holdingWatchLock: boolean },
): Promise<CleanupOutcome> {
  const id = task.id;
  let release: (() => Promise<void>) | null = null;
  if (!options.holdingWatchLock) {
    const dir = await watchDir(ctx, root, id);
    await mkdir(dir, { recursive: true });
    const lock = await acquireWatchLock(dir, id);
    if (lock.kind === "held") return { kind: "watching", pid: lock.pid };
    release = () => releaseOrWarn(lock.release);
  }
  try {
    const stopped = async (
      reason: string,
      detail: string,
      code: 1 | 2,
    ): Promise<CleanupOutcome> => {
      const text = safe(ctx, detail);
      await saveWatchState(ctx, root, id, "cleanup-stopped", {
        reason,
        detail: text,
      });
      await putWatchCard(
        ctx,
        root,
        id,
        task.path,
        cardForPushWatch("cleanup-stopped", pr.number, { detail: text }),
      );
      ctx.stderr(
        `${id} の PR #${pr.number} はマージされましたが、後始末が止まりました（${text}）。直してから orca-flow push ${id} をもう一度打ってください`,
      );
      return {
        kind: "finished",
        result: { code, data: { id, pr: pr.number, stopped: reason } },
      };
    };
    let result;
    try {
      result = await finishMergedTask(ctx, config, root, task, {
        prHead: pr.headSha,
        prNumber: pr.number,
        mergeCommit: pr.mergeCommit,
        mergedAt: pr.mergedAt,
      });
    } catch (error) {
      return await stopped("orca", message(error), 1);
    }
    if (result.kind === "stopped") {
      if (result.reason === "busy") return { kind: "busy" };
      return await stopped(result.reason, result.detail, 2);
    }
    await saveWatchState(ctx, root, id, "merged", { detail: result.sync.how });
    if (!ctx.json)
      ctx.stdout(
        `${id} の PR #${pr.number} はマージ済みです。${config.baseBranch} に取り込み（${result.sync.how}）、後始末をしました`,
      );
    return {
      kind: "finished",
      result: {
        code: 0,
        data: {
          id,
          pr: pr.number,
          merged: true,
          sync: result.sync.how,
          notified: result.notified,
          worktreeRemoved: result.worktreeRemoved,
        },
      },
    };
  } finally {
    if (release) await release();
  }
}

async function watchLoop(
  ctx: CommandContext,
  root: string,
  id: string,
  opts: WatchOptions,
  known: Known,
): Promise<CommandResult> {
  const config = await requireConfig(root);
  const record = await readPushRecord(ctx.runner, root, id);
  if (!record)
    throw new FlowError(
      1,
      `${id} の push の記録がありません。orca-flow push ${id} を打ってください`,
    );
  // タスクと PR の番号は、止まるときにカードへ印を残せるよう、gh を確かめる前に決める
  const task = await findPushTask(ctx.runner, root, config, id, record);
  known.taskPath = task.path;
  known.number = record.pr?.number ?? null;
  const g: GhContext = { runner: ctx.runner, cwd: root, env: ctx.env };
  await requireGh(g);
  const first =
    record.pr?.number ?? (await findPr(g, record.branch))?.number ?? null;
  if (first === null)
    throw new FlowError(
      1,
      `${id} の PR が見つかりません。orca-flow push ${id} を打ってください`,
    );
  let number: number = first;
  known.number = number;
  const sleep = opts.sleep ?? realSleep;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const noCiPolls = opts.noCiPolls ?? DEFAULT_NO_CI_POLLS;

  const say = (text: string) => {
    if (!ctx.json) ctx.stdout(text);
  };
  const putCard = (update: CardUpdate) =>
    putWatchCard(ctx, root, id, task.path, update);

  let lastKey: string | null = null;
  let cardOk = true;
  let noneStreak = 0;
  let failures = 0;

  /** 記録の PR の番号が変わっていれば（閉じて出し直した）、新しい番号に切り替える */
  const followRecord = async (): Promise<boolean> => {
    const now = await readPushRecord(ctx.runner, root, id);
    if (!now?.pr || now.pr.number === number) return false;
    number = now.pr.number;
    known.number = number;
    lastKey = null;
    cardOk = true;
    noneStreak = 0;
    failures = 0;
    return true;
  };

  for (let polls = 0; ; polls++) {
    if (opts.maxPolls !== undefined && polls >= opts.maxPolls) {
      return { code: 0, data: { id, pr: number, watching: false } };
    }
    await followRecord();
    let pr: PrInfo;
    try {
      pr = await readPr(g, number);
      failures = 0;
    } catch (error) {
      // gh が見つからない・ログインが切れた（終了コード2）はすぐ止める。ほかは数回やり直す
      if (error instanceof FlowError && error.code === 2) throw error;
      failures++;
      if (failures >= MAX_READ_FAILURES) {
        const detail = safe(ctx, message(error));
        await saveWatchState(ctx, root, id, "gh-error", { detail });
        await putCard(cardForPushWatch("watch-stopped", number, { detail }));
        ctx.stderr(
          `${id} の PR #${number} を読めない状態が続いたので、待ち受けを止めました（${detail}）。orca-flow push ${id} をもう一度打つと起こし直します`,
        );
        return { code: 1, data: { id, pr: number, stopped: "gh-error" } };
      }
      await sleep(intervalMs);
      continue;
    }

    if (pr.state === "merged") {
      const out = await cleanupMergedPr(ctx, root, config, task, pr, {
        holdingWatchLock: true,
      });
      if (out.kind === "finished") return out.result;
      // main を別の処理が書き換えている：次の回にやり直す
      await sleep(intervalMs);
      continue;
    }

    if (pr.state === "closed") {
      // 閉じてすぐ push し直したなら、記録の番号が新しい PR に変わっている：そちらを見る
      if (await followRecord()) continue;
      await saveWatchState(ctx, root, id, "closed");
      await putCard(cardForPushWatch("closed", number));
      say(
        `${id} の PR #${number} はマージされずに閉じられました。後始末はせず、待ち受けを終えました（カードは「PR が閉じられた」）。直して orca-flow push ${id} をもう一度打つと PR を出し直します`,
      );
      return { code: 0, data: { id, pr: number, closed: true } };
    }

    // 開いている PR：CI の結果で決める
    noneStreak = pr.ci === "none" ? noneStreak + 1 : 0;
    const ci =
      pr.ci === "none"
        ? noneStreak >= noCiPolls
          ? "passed"
          : "pending"
        : pr.ci;
    let draft = pr.isDraft;
    let phase: PushWatchPhase;
    if (ci === "failed") phase = "ci-failed";
    else if (ci === "pending") phase = "ci-wait";
    else {
      phase = "review-wait";
      if (draft && config.prReady === "after-ci") {
        try {
          await markPrReady(g, number);
          draft = false;
          say(`${id} の PR #${number} は CI が通ったので、下書きを外しました`);
        } catch (error) {
          ctx.stderr(
            `警告：PR #${number} の下書きを外せませんでした（${safe(ctx, message(error))}）。次の回にやり直します`,
          );
        }
      }
    }

    const key = `${phase}:${draft}`;
    if (key !== lastKey || !cardOk) {
      if (key !== lastKey) {
        await saveWatchState(ctx, root, id, phase, { ci: pr.ci, draft });
        say(`${id} の PR #${number}：${STATUS_LABEL[phase]}`);
      }
      lastKey = key;
      cardOk = await putCard(
        cardForPushWatch(phase, number, {
          draft: phase === "review-wait" && draft,
        }),
      );
    }
    await sleep(intervalMs);
  }
}

// ---- 様子の表示 ----

const isWatchState = (v: unknown): v is WatchState =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as WatchState).status === "string" &&
  (v as WatchState).status in STATUS_LABEL;

/** `orca-flow push 〈ID〉 --show`：記録から今の様子を出す（GitHub には問い合わせない） */
export async function showPushWatch(
  ctx: CommandContext,
  id: string,
): Promise<CommandResult> {
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const record = await readPushRecord(ctx.runner, root, id);
  if (!record)
    throw new FlowError(
      1,
      `${id} の push の記録がありません。orca-flow push ${id} を打ってください`,
    );
  const { running: watching } = await watcherRunning(ctx, root, id);
  const state = isWatchState(record.watch) ? record.watch : null;
  const label = state ? STATUS_LABEL[state.status] : "まだ見ていません";
  if (!ctx.json) {
    ctx.stdout(
      `${id}：${record.pr ? `PR #${record.pr.number} ${record.pr.url}` : "PR なし"}`,
    );
    ctx.stdout(
      `様子：${label}${state?.detail ? `（${state.detail}）` : ""}${state ? `（${state.updatedAt}）` : ""}`,
    );
    ctx.stdout(
      `背景の待ち受け：${watching ? "動いています" : "動いていません"}${watching ? "" : `（起こし直すには orca-flow push ${id}）`}`,
    );
  }
  return {
    code: 0,
    data: {
      id,
      pr: record.pr,
      pushedHead: record.pushedHead,
      pushedAt: record.pushedAt,
      status: state?.status ?? null,
      label,
      detail: state?.detail ?? null,
      reason: state?.reason ?? null,
      ci: state?.ci ?? null,
      draft: state?.draft ?? null,
      updatedAt: state?.updatedAt ?? null,
      watching,
    },
  };
}
