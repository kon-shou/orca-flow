import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../../types.ts";
import type { Runner } from "../exec.ts";
import { gitCommonDir } from "../git.ts";
import { acquireLock, releaseOrWarn, type LockResult } from "../lock.ts";
import { emptyState, type UsageLine, type WatchFile } from "./types.ts";

// 見張りの記録の置き場：〈git の共通ディレクトリ〉/orca-flow/pr-watch/。
// state.json は、ロックを取り、一時ファイルに書いてから名前を変える（同時に流れても壊れない）。

export async function watchDir(runner: Runner, root: string): Promise<string> {
  return path.join(await gitCommonDir(runner, root), "orca-flow", "pr-watch");
}

const STATE_LOCK_WAIT_MS = 10_000;

const lockMessages = (what: string) => ({
  failed: (file: string, detail: string) =>
    `${what}のロックを読み書きできません（${file}：${detail}）。ロックのパスを確かめてください`,
  releaseFailed: (file: string, detail: string) =>
    `${what}のロックを外せませんでした（${file}：${detail}）。残っていれば ${file} を消してください`,
});

/** 回・背景ごとのロック。取れなければ null（呼び手が「飛ばした」と記録する） */
export async function tryLock(
  dir: string,
  name: string,
  kind: string,
): Promise<{ release: () => Promise<void> } | null> {
  await mkdir(dir, { recursive: true });
  const lock: LockResult = await acquireLock(path.join(dir, name), {
    waitMs: 0,
    maxAttempts: 3,
    kind,
    ...lockMessages("見張り"),
  });
  return lock.kind === "acquired" ? { release: lock.release } : null;
}

/** state.json を読む。なければ・壊れていれば空の形（壊れた場合は次の書き込みで直る） */
export async function readState(dir: string): Promise<WatchFile> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(dir, "state.json"), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as WatchFile).version === 1
    )
      return { ...emptyState(), ...(parsed as WatchFile) };
  } catch {
    // なければ空
  }
  return emptyState();
}

async function withStateLock<T>(
  dir: string,
  body: () => Promise<T>,
): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = await acquireLock(path.join(dir, "state.lock"), {
    waitMs: STATE_LOCK_WAIT_MS,
    pollMs: 20,
    kind: "state",
    ...lockMessages("見張りの記録"),
  });
  if (lock.kind === "held")
    throw new FlowError(
      1,
      `見張りの記録を別のプロセスが書いています（プロセス ${lock.pid ?? "不明"}）。少し待ってやり直してください`,
    );
  try {
    return await body();
  } finally {
    await releaseOrWarn(lock.release);
  }
}

/** state.json を、ロックを取って読み直し、mutate で直して、一時ファイルから名前を変えて書く */
export async function updateState<T = void>(
  dir: string,
  mutate: (state: WatchFile) => T,
): Promise<T> {
  return withStateLock(dir, async () => {
    const state = await readState(dir);
    const result = mutate(state);
    const file = path.join(dir, "state.json");
    const tmp = path.join(dir, `.state-${process.pid}-${Date.now()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, file);
    return result;
  });
}

/** 使った回数の1行を足す。日付は UTC の日 */
export async function appendUsage(dir: string, line: UsageLine): Promise<void> {
  await withStateLock(dir, async () => {
    await appendFile(
      path.join(dir, `usage-${line.at.slice(0, 10)}.jsonl`),
      `${JSON.stringify(line)}\n`,
    );
  });
}

/** 使った回数の記録の日付の一覧（古い順） */
export async function usageDates(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .map((f) => /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1])
      .filter((d): d is string => d !== undefined)
      .sort();
  } catch {
    return [];
  }
}

/** keepDays 日より古い日付の usage ファイルを消す（日付は UTC の日） */
export async function pruneUsage(
  dir: string,
  now: Date,
  keepDays: number,
): Promise<void> {
  const cutoff = now.getTime() - keepDays * 86_400_000;
  for (const date of await usageDates(dir))
    if (Date.parse(`${date}T23:59:59Z`) < cutoff)
      await rm(path.join(dir, `usage-${date}.jsonl`), { force: true });
}

export async function readUsage(
  dir: string,
  date: string,
): Promise<UsageLine[]> {
  try {
    return (await readFile(path.join(dir, `usage-${date}.jsonl`), "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as UsageLine];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
