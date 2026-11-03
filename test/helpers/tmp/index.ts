import { mkdtempSync, realpathSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

/** テストの外（beforeAll・describe・import の時点）で作ったもの。ファイルの終わりに消す */
const fileScoped: string[] = [];

const RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
} as const;

/** テストの終わりに消す予約をする。テストの外なら false（ファイルの終わりに回す） */
function scheduleForTest(dir: string): boolean {
  try {
    onTestFinished(() => removeDir(dir));
    return true;
  } catch {
    // テストの外では onTestFinished が投げる
    return false;
  }
}

async function removeDir(dir: string): Promise<void> {
  // Windows のロックに備えて retry つき。消せなければ投げる（漏れを隠さない）
  await rm(dir, RM_OPTIONS);
}

/** 作った一時フォルダを覚える。テストの中ならテストの終わり、外ならファイルの終わりに消す */
function track(dir: string): void {
  if (!scheduleForTest(dir)) fileScoped.push(dir);
}

/** 一時フォルダ（シンボリックリンクを解いたもの）を作る。自分で消さなくてよい */
export async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  track(dir);
  return dir;
}

/** makeTmpDir の同期版 */
export function makeTmpDirSync(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  track(dir);
  return dir;
}

/** ファイルの終わりに、テストの外で作ったものを消す（setup.ts の afterAll から呼ぶ） */
export async function removeFileScoped(): Promise<void> {
  const dirs = fileScoped.splice(0);
  const failures: string[] = [];
  for (const dir of dirs) {
    try {
      await removeDir(dir);
    } catch (error) {
      failures.push(`${dir}：${(error as Error).message}`);
    }
  }
  if (failures.length > 0)
    throw new Error(`一時フォルダを消せなかった：\n${failures.join("\n")}`);
}
