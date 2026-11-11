import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig, PreviewConfig } from "../config.ts";
import { FlowError, type CommandContext } from "../types.ts";
import { shellCommand } from "./exec.ts";
import { acquireLock, releaseOrWarn } from "./lock.ts";
import type { Orca } from "./orca.ts";
import { readStages } from "./stage-log.ts";
import { commonRecordPath } from "./task-id.ts";

// タスクのアプリを Orca のターミナルで起動し、組み込みのブラウザで開く（preview）の部品。
// ターミナルの出力は秘密が出うるので、URL の行を探すだけで、どこにも写さない。

/** 起動の記録（〈git の共通ディレクトリ〉/orca-flow/preview/〈ID〉.json） */
export interface PreviewRecord {
  id: string;
  /** worktree の実のパス */
  worktree: string;
  /** 起動のコマンドを送ったターミナルのハンドル */
  terminal: string;
  /** 分かった URL（まだなら省く） */
  url?: string;
  /** 書いた時刻（ISO） */
  at: string;
}

/** 外とのやりとりを差し替えるための入れ物。テストが書き換える */
export interface PreviewDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** 出力と URL を確かめる間隔 */
  pollMs: number;
  /** 1回の HTTP の待ち時間 */
  httpTimeoutMs: number;
  /** 時計（ミリ秒） */
  clock: () => number;
  /** 記録のロックを待つ長さ（ミリ秒） */
  lockWaitMs: number;
  /** setup の終わりを待つ上限（ミリ秒） */
  setupWaitMs: number;
}

export const previewDeps: PreviewDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs: 2_000,
  httpTimeoutMs: 3_000,
  clock: () => Date.now(),
  lockWaitMs: 10_000,
  setupWaitMs: 30 * 60 * 1000,
};

export const URL_PREFIX = "ORCA_FLOW_URL=";
export const TERMINAL_TITLE = "preview";
/** --stop で止めるものがない（作業中でなく記録もない）ときの文。親の組の --stop がこの文で見分ける */
export const noStopTargetMessage = (id: string) =>
  `作業中のタスクに ${id} が見つかりません（記録もありません）`;
/** down を流す上限（ミリ秒） */
const DOWN_TIMEOUT_MS = 120_000;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const previewRecordPath = (common: string, id: string) =>
  commonRecordPath(common, "preview", id, ".json");

export async function readPreviewRecord(
  common: string,
  id: string,
): Promise<PreviewRecord | null> {
  let text: string;
  try {
    text = await readFile(previewRecordPath(common, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FlowError(
      1,
      `${id} の preview の記録を読めませんでした：${message(error)}`,
    );
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      typeof raw.worktree !== "string" ||
      typeof raw.terminal !== "string" ||
      typeof raw.at !== "string"
    )
      throw new Error("形が違います");
    return {
      id: raw.id,
      worktree: raw.worktree,
      terminal: raw.terminal,
      ...(typeof raw.url === "string" ? { url: raw.url } : {}),
      at: raw.at,
    };
  } catch {
    throw new FlowError(
      1,
      `${id} の preview の記録が壊れています。${previewRecordPath(common, id)} を消してください`,
    );
  }
}

export async function writePreviewRecord(
  common: string,
  record: PreviewRecord,
): Promise<void> {
  const file = previewRecordPath(common, record.id);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temp, file);
}

export async function removePreviewRecord(
  common: string,
  id: string,
): Promise<void> {
  await rm(previewRecordPath(common, id), { force: true });
}

/** 記録の読み書きを、ID ごとのロックの中で行う */
export async function withPreviewLock<T>(
  common: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = previewRecordPath(common, id).replace(/\.json$/, ".lock");
  await mkdir(path.dirname(lock), { recursive: true });
  const got = await acquireLock(lock, {
    waitMs: previewDeps.lockWaitMs,
    kind: "preview",
    failed: (file, detail) =>
      `preview のロックを扱えませんでした（${file}）：${detail}`,
  });
  if (got.kind === "held")
    throw new FlowError(
      1,
      `${id} の preview を別のプロセスが操作中です（${got.lockPath}）。終わってからやり直してください`,
    );
  try {
    return await fn();
  } finally {
    await releaseOrWarn(got.release);
  }
}

/**
 * 表示できる ASCII だけの http(s) の URL を受け、解釈して正規形（href）を返す。
 * 制御文字（色づけの ESC など）を含むものは使わない。使えなければ null
 */
export function parseHttpUrl(text: string): string | null {
  if (!/^https?:\/\/[\x21-\x7e]+$/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** 出力の行から、最後に出た ORCA_FLOW_URL= の http(s) の URL を取る。なければ null */
export function urlFromOutput(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith(URL_PREFIX)) continue;
    const url = parseHttpUrl(line.slice(URL_PREFIX.length).trim());
    if (url !== null) return url;
  }
  return null;
}

/** URL が答えるか（HTTP の応答が返り、5xx でない） */
export async function urlAnswers(url: string): Promise<boolean> {
  try {
    const response = await previewDeps.fetch(url, {
      signal: AbortSignal.timeout(previewDeps.httpTimeoutMs),
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

export type WaitResult = { kind: "ready"; url: string } | { kind: "timeout" };

/**
 * 開く URL が答えるまで待つ。設定の url があれば出力を読まない。
 * なければ出力から URL を見つけ、その URL が答えるのを待つ。出力の読み取りの失敗は次の回に持ち越す
 */
export async function waitForPreview(
  orca: Orca,
  preview: PreviewConfig,
  handle: string,
  knownUrl?: string,
): Promise<WaitResult> {
  const deadline = previewDeps.clock() + preview.timeoutSeconds * 1000;
  let url = preview.url ?? knownUrl ?? null;
  for (;;) {
    if (url === null) {
      try {
        url = urlFromOutput(await orca.readOutput(handle));
      } catch {
        url = null;
      }
    }
    if (url !== null && (await urlAnswers(url))) return { kind: "ready", url };
    if (previewDeps.clock() >= deadline) return { kind: "timeout" };
    await previewDeps.sleep(previewDeps.pollMs);
  }
}

/**
 * setup の終わりを待つ。Orca は setup の間もエージェントの端末を出すので、
 * タスク長の最初の status が段の記録に書いた行（command が status）が出たら終わったとみなす。
 * 上限までに出なければ timeout
 */
export async function waitForSetup(
  common: string,
  id: string,
): Promise<"done" | "timeout"> {
  const deadline = previewDeps.clock() + previewDeps.setupWaitMs;
  for (;;) {
    const stages = await readStages(common, id);
    if (stages?.entries.some((e) => e.command === "status")) return "done";
    if (previewDeps.clock() >= deadline) return "timeout";
    await previewDeps.sleep(previewDeps.pollMs);
  }
}

/** ターミナルがまだあるか（一覧にあり、つながっていて、孤立していない） */
export async function terminalAlive(
  orca: Orca,
  worktree: string,
  handle: string,
): Promise<boolean> {
  const terminals = await orca.listTerminals(worktree);
  return terminals.some(
    (t) => t.handle === handle && t.connected && !t.orphaned,
  );
}

export interface StopOutcome {
  /** 記録があったか */
  hadRecord: boolean;
  /** down を流したか */
  ranDown: boolean;
  /** ターミナルを閉じたか */
  closedTerminal: boolean;
}

/**
 * 止める。down があれば worktree で流し、記録のハンドルのターミナルだけを閉じ、記録を消す。
 * down が失敗したときは、force でなければ FlowError(1) で記録とターミナルを残す。
 * force なら警告にして、閉じて消すところまで進める（統合の仕上げ用）。
 * 記録も down もなければ何もしない
 */
export async function stopPreview(
  ctx: CommandContext,
  orca: Orca,
  common: string,
  id: string,
  worktree: string,
  down: string | undefined,
  options: { force: boolean; onlyWithRecord?: boolean },
): Promise<StopOutcome> {
  return withPreviewLock(common, id, async () => {
    const record = await readPreviewRecord(common, id);
    const outcome: StopOutcome = {
      hadRecord: record !== null,
      ranDown: false,
      closedTerminal: false,
    };
    if (record === null && (down === undefined || options.onlyWithRecord))
      return outcome;
    const cwd = record?.worktree ?? worktree;
    const recordFile = previewRecordPath(common, id);
    const worktreeGone =
      record !== null &&
      !(await stat(cwd).then(
        () => true,
        () => false,
      ));
    if (worktreeGone) {
      ctx.stderr(
        `警告：${id} の記録の worktree（${cwd}）がもうないので、止めるコマンドを流していません。コンテナなどが残っていれば手で止めてください`,
      );
    } else if (down !== undefined) {
      const [cmd, args] = shellCommand(down);
      const result = await ctx.runner(cmd, args, {
        cwd,
        timeoutMs: DOWN_TIMEOUT_MS,
      });
      outcome.ranDown = true;
      if (result.code !== 0 || result.timedOut) {
        const what = result.timedOut
          ? "時間内に終わりませんでした"
          : `失敗しました（終了コード ${result.code}）`;
        const text = `${id} の止めるコマンドが${what}。コンテナなどが残っていないか確かめてください`;
        if (!options.force)
          throw new FlowError(
            1,
            `${text}。記録（${recordFile}）とターミナルは残してあります。原因を直したら orca-flow preview ${id} --stop をやり直してください`,
          );
        ctx.stderr(`警告：${text}`);
      }
    }
    if (record !== null) {
      try {
        if (await terminalAlive(orca, record.worktree, record.terminal)) {
          await orca.closeTerminal(record.terminal);
          outcome.closedTerminal = true;
        }
      } catch (error) {
        ctx.stderr(
          `警告：${id} の起動のターミナルを閉じられませんでした（${message(error)}）。Orca で閉じてください`,
        );
      }
      await removePreviewRecord(common, id);
    }
    return outcome;
  });
}

/**
 * 統合の仕上げ用：記録があれば worktree を消す前に止める。止められなくても警告だけ。
 * 設定は loadConfig で読む（読めなければ、記録があるときだけ警告し、止めるコマンドは流さない）
 */
export async function stopPreviewForFinish(
  ctx: CommandContext,
  orca: Orca,
  loadConfig: () => Promise<FlowConfig>,
  common: string,
  id: string,
  worktree: string,
): Promise<void> {
  let config: FlowConfig | null = null;
  let configError: string | null = null;
  try {
    config = await loadConfig();
  } catch (error) {
    configError = message(error);
  }
  try {
    const outcome = await stopPreview(
      ctx,
      orca,
      common,
      id,
      worktree,
      config?.preview?.down,
      { force: true, onlyWithRecord: true },
    );
    if (configError !== null && outcome.hadRecord)
      ctx.stderr(
        `警告：${id} の設定を読めなかったので、止めるコマンドを流していません（${configError}）。コンテナなどが残っていないか確かめてください`,
      );
  } catch (error) {
    ctx.stderr(
      `警告：${id} のアプリの起動を止められませんでした（${message(error)}）。記録は ${previewRecordPath(common, id)} です。orca-flow preview ${id} --stop か Orca のターミナルで止めてください`,
    );
  }
}
