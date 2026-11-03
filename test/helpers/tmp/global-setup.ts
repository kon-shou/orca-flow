import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 実行ごとの親フォルダの名前の始まり */
export const RUN_PREFIX = "orca-flow-test-";

/**
 * vitest の globalSetup。実行ごとの親フォルダを作り、TMPDIR・TMP・TEMP をそこへ向ける。
 * 子のプロセスも同じ親の下に作るので、終わりに丸ごと消せる。
 */
export default function setup(): () => void {
  // makeTmpDir が返す realpath と食い違わないよう、リンクを解いた名前にする
  const parent = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), RUN_PREFIX)),
  );
  process.env.TMPDIR = parent;
  process.env.TMP = parent;
  process.env.TEMP = parent;
  return () => {
    rmSync(parent, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  };
}
