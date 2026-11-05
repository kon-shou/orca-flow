import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import {
  FlowError,
  type CommandContext,
  type CommandResult,
} from "../types.ts";
import {
  finishMergedTask,
  pushRecordFile,
  readPushRecord,
  writePushRecord,
} from "./finish.ts";
import { envSecrets, redactSecrets, type PrInfo } from "./github.ts";
import { requireRoot } from "./git.ts";
import {
  acquireLock,
  holderAlive,
  parseLock,
  parseLockKind,
  releaseOrWarn,
} from "./lock.ts";
import {
  cardForPushWatch,
  createOrca,
  type CardUpdate,
  type PushWatchPhase,
} from "./orca.ts";

// 見張り（pr-watch）が PR のマージで行う仕事：マージ済みの PR の後始末。
// push の2回目（マージ済みの PR の後始末のやり直し）も cleanupMergedPr を通る。
// push の記録の watch キーの型と言葉（WatchState・STATUS_LABEL）もここにある。

/** send が記録の watch に置く印（reason）。見張りは見つけたらカードを書き直す */
export const CARD_RESET = "card-reset";

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

/** 古いタスクごとの待ち受けのロックと記録を置く所（push の記録と同じ場所） */
async function watchDir(ctx: CommandContext, root: string, id: string) {
  return path.dirname(await pushRecordFile(ctx.runner, root, id));
}
const lockFile = (dir: string, id: string) => path.join(dir, `${id}.lock`);

/** 出力・記録・カードに出す前に、トークンらしい値と環境変数のトークンを伏せる */
const safe = (ctx: CommandContext, text: string) =>
  redactSecrets(text, envSecrets(ctx.env));

/**
 * 古いタスクごとの待ち受けが今動いているか（`push/〈ID〉.lock` の持ち主が生きているか）。
 * 見張りの前の版が起こした待ち受けが残っているとき、後始末を二重にしないために見る
 */
export async function watcherRunning(
  ctx: CommandContext,
  root: string,
  id: string,
): Promise<{
  running: boolean;
  pid: number | null;
  holderKind: string | null;
}> {
  try {
    const text = await readFile(
      lockFile(await watchDir(ctx, root, id), id),
      "utf8",
    );
    const holder = parseLock(text);
    return {
      running: holderAlive(holder.pid, holder.bootAt),
      pid: Number.isInteger(holder.pid) ? holder.pid : null,
      holderKind: parseLockKind(text),
    };
  } catch {
    return { running: false, pid: null, holderKind: null };
  }
}

/** 記録の watch キーを書く */
export async function saveWatchState(
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

/** push/〈ID〉.lock の持ち主の種類。watch＝見張りの背景、push＝2回目の push、merge＝マージのコマンド。種類なしは古い待ち受け */
export type CleanupLockKind = "watch" | "push" | "merge";

/** 後始末のロックを持っている相手の言い方（ロックの種類で分ける） */
export function cleanupHolderLabel(holderKind: string | null | undefined) {
  if (holderKind === "watch") return "見張りが後始末をしています";
  if (holderKind === "push") return "ほかの push が後始末をしています";
  if (holderKind === "merge") return "マージのコマンドが後始末をしています";
  return "古い待ち受けが後始末をしています";
}

function acquireWatchLock(dir: string, id: string, kind: CleanupLockKind) {
  return acquireLock(lockFile(dir, id), {
    kind,
    waitMs: 0,
    maxAttempts: 3,
    failed: (file, detail) =>
      `待ち受けのロックを読み書きできません（${file}：${detail}）。ロックのパスを確かめてください`,
    releaseFailed: (file, detail) =>
      `待ち受けのロックを外せませんでした（${file}：${detail}）。ロックが残っていれば、${file} を消してください`,
  });
}

// ---- マージ済みの PR の後始末 ----

/** マージ済みの PR の後始末の結果 */
export type CleanupOutcome =
  /** 古いタスクごとの待ち受けがロックを持っている（その待ち受けが後始末をしている） */
  | {
      kind: "watching";
      pid: number | null;
      /** 持ち主の種類（watch・push）。種類のない古い待ち受けは null */
      holderKind: string | null;
    }
  /** main のロックが取れない（integrate・push の道の後始末・approve・new のどれかが main を書き換えている） */
  | { kind: "busy" }
  /** 後始末をした、または止まった（記録とカードは更新済み） */
  | { kind: "finished"; result: CommandResult };

/**
 * PR がマージされたあとの後始末。見張りと push の打ち直しが両方これを通る。
 * 古いタスクごとの待ち受けのロックを取り（持っていれば後始末せず watching を返す。
 * その待ち受け自身が呼ぶときは holdingWatchLock で、持っていることを伝える）、
 * finishMergedTask を mergeCommit・mergedAt つきで流して、記録の watch とカードを更新する
 */
export async function cleanupMergedPr(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  task: { id: string; branch: string; path: string },
  pr: PrInfo,
  options: {
    holdingWatchLock: boolean;
    /** ロックに書く持ち主の種類。見張りの背景は watch（既定）、2回目の push は push、マージのコマンドは merge */
    lockKind?: CleanupLockKind;
  },
): Promise<CleanupOutcome> {
  const id = task.id;
  let release: (() => Promise<void>) | null = null;
  if (!options.holdingWatchLock) {
    const dir = await watchDir(ctx, root, id);
    await mkdir(dir, { recursive: true });
    const lock = await acquireWatchLock(dir, id, options.lockKind ?? "watch");
    if (lock.kind === "held")
      return {
        kind: "watching",
        pid: lock.pid,
        holderKind: lock.holderKind ?? null,
      };
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
  const state = isWatchState(record.watch) ? record.watch : null;
  const label = state ? STATUS_LABEL[state.status] : "まだ見ていません";
  if (!ctx.json) {
    ctx.stdout(
      `${id}：${record.pr ? `PR #${record.pr.number} ${record.pr.url}` : "PR なし"}`,
    );
    ctx.stdout(
      `様子：${label}${state?.detail ? `（${state.detail}）` : ""}${state ? `（${state.updatedAt}）` : ""}`,
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
    },
  };
}
