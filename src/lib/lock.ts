import { readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { FlowError } from "../types.ts";

// ロックの判定を1か所にまとめたファイル。マージの順・main の確かめ・おまかせの待ち受けが使う。
// src/lib のほかのファイルは読み込まない（循環を作らないため）。

/** マシンの起動の時刻（秒）。Node の標準ライブラリだけで求める */
export const currentBootAt = () => Math.round(Date.now() / 1000 - os.uptime());

/** 起動の時刻のずれの許す幅（秒）。時計の合わせ直しの揺れは許し、再起動（これより長い）は違うとみなす */
export const BOOT_TOLERANCE_SECONDS = 60;

/** 書いてある起動の時刻が今のマシンのものか。書いていない（古い形）なら true */
export const sameBoot = (bootAt: number | null | undefined) =>
  bootAt === null ||
  bootAt === undefined ||
  Math.abs(bootAt - currentBootAt()) <= BOOT_TOLERANCE_SECONDS;

/** プロセスが生きているか */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 記録やロックに書いたプロセスが、今も同じ起動のあいだ生きているか */
export const holderAlive = (
  pid: number | null | undefined,
  bootAt: number | null | undefined,
) => !!pid && sameBoot(bootAt) && processAlive(pid);

/** ロックのファイルの中身：「プロセスの番号 起動の時刻」。前の形（番号だけ）も読む */
export function parseLock(text: string): {
  pid: number;
  bootAt: number | null;
} {
  const [pidText = "", bootText] = text.trim().split(/\s+/);
  const pid = Number.parseInt(pidText, 10);
  const boot = bootText === undefined ? NaN : Number.parseInt(bootText, 10);
  return { pid, bootAt: Number.isInteger(boot) ? boot : null };
}

/** 中身が空・読めない形のロックを、書いている途中とみなす間（ミリ秒）。ロックの mtime がこれより新しければ生きているとみなす */
export const LOCK_FRESH_MS = 3_000;
/** 待つときに確かめる間隔（ミリ秒） */
export const LOCK_POLL_MS = 50;

export interface LockOptions {
  /** 生きている持ち主を待つ長さ（ミリ秒）。0 なら待たない */
  waitMs: number;
  /** 確かめる間隔（ミリ秒）。既定は LOCK_POLL_MS */
  pollMs?: number;
  /** 取り直しを含めて試す回数の上限。なければ waitMs の間は続ける */
  maxAttempts?: number;
  /** ENOENT 以外の失敗のときの FlowError の言葉。ロックのパスを含めること */
  failed: (lock: string, detail: string) => string;
  /** 外すときの失敗の言葉。ロックのパスを含めること。なければ failed と同じ */
  releaseFailed?: (lock: string, detail: string) => string;
}

export type LockResult =
  | { kind: "acquired"; release: () => Promise<void> }
  | { kind: "held"; lockPath: string; pid: number | null };

const errCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ロックを取る。生きていないプロセス・再起動より前のロックは取り直す。
 * 中身が空・読めない形のロックは、LOCK_FRESH_MS より新しい間は生きているとみなす。
 * 生きている持ち主がいれば waitMs まで待ち、取れなければ held を返す（FlowError にするかは呼び手が決める）。
 * ENOENT 以外のファイルの失敗は、ロックのパスを含む FlowError(1)。
 */
export async function acquireLock(
  lock: string,
  options: LockOptions,
): Promise<LockResult> {
  const fail = (error: unknown) =>
    new FlowError(
      1,
      options.failed(
        lock,
        error instanceof Error ? error.message : String(error),
      ),
    );
  const deadline = Date.now() + options.waitMs;
  const mine = `${process.pid} ${currentBootAt()}\n`;
  const releaseFail = (error: unknown) =>
    new FlowError(
      1,
      (options.releaseFailed ?? options.failed)(
        lock,
        error instanceof Error ? error.message : String(error),
      ),
    );
  let holderPid: number | null = null;
  for (let attempt = 0; ; attempt++) {
    if (options.maxAttempts !== undefined && attempt >= options.maxAttempts)
      return { kind: "held", lockPath: lock, pid: holderPid };
    try {
      await writeFile(lock, mine, { flag: "wx" });
      return {
        kind: "acquired",
        release: () => releaseLock(lock, mine, releaseFail),
      };
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw fail(error);
    }
    let text: string;
    try {
      text = await readFile(lock, "utf8");
    } catch (error) {
      if (errCode(error) === "ENOENT") continue; // 読む前に外された。すぐ取り直す
      throw fail(error);
    }
    const holder = parseLock(text);
    const validPid = Number.isInteger(holder.pid) && holder.pid > 0;
    holderPid = validPid ? holder.pid : null;
    let alive = holderAlive(holder.pid, holder.bootAt);
    if (!validPid) {
      // 作った直後で中身がまだ空かもしれない。新しい間は生きているとみなす
      try {
        alive = Date.now() - (await stat(lock)).mtimeMs < LOCK_FRESH_MS;
      } catch (error) {
        if (errCode(error) === "ENOENT") continue;
        throw fail(error);
      }
    }
    if (!alive) {
      // 消す前にもう一度読み、読んだ中身のままのときだけ消す
      try {
        if ((await readFile(lock, "utf8")) === text) await rm(lock);
      } catch (error) {
        if (errCode(error) !== "ENOENT") throw fail(error);
      }
      continue;
    }
    if (Date.now() >= deadline)
      return { kind: "held", lockPath: lock, pid: holderPid };
    await sleep(options.pollMs ?? LOCK_POLL_MS);
  }
}

/** 自分のロックだけを外す。中身が自分の書いたものでなければ消さない */
async function releaseLock(
  lock: string,
  mine: string,
  fail: (error: unknown) => FlowError,
): Promise<void> {
  try {
    if ((await readFile(lock, "utf8")) === mine) await rm(lock);
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw fail(error);
  }
}

/**
 * ロックを外す。失敗しても投げず、ロックのパスを含む警告を標準エラーに出す。
 * finally から呼び、本体の結果や元のエラーを上書きしないために使う
 */
export async function releaseOrWarn(
  release: () => Promise<void>,
): Promise<void> {
  try {
    await release();
  } catch (error) {
    process.stderr.write(
      `警告：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
