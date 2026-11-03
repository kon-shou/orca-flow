import { fileURLToPath } from "node:url";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";

// 背景の起こし方（1か所）。push の待ち受けと main の確かめの両方がこれを通る。

/**
 * このプラグインの src/main.ts。bin/orca-flow は sh のスクリプトで Windows は直接起動できないので、
 * node の実行ファイルにこれを渡して起動する
 */
export const ORCA_FLOW_MAIN = fileURLToPath(
  new URL("../main.ts", import.meta.url),
);

/** 起動役の本文。切り離した子（別のプロセスグループ、stdin は閉じ、出力はログのファイル）で main.ts を流して、すぐ終わる */
function launcherSource(args: readonly string[]): string {
  const list = args.map((a) => JSON.stringify(a)).join(", ");
  return `
const { spawn } = require("node:child_process");
const { openSync } = require("node:fs");
const [node, main, cwd, log] = process.argv.slice(1);
const fd = openSync(log, "a");
const child = spawn(node, ["--disable-warning=ExperimentalWarning", main, ${list}], {
  cwd,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", fd, fd],
});
child.on("error", () => process.exit(1));
child.unref();
setImmediate(() => process.exit(0));
`;
}

export interface BackgroundLaunch {
  /** 子の作業フォルダ（Runner の cwd にもなる） */
  cwd: string;
  /** 子の出力を足すログのパス */
  log: string;
  /** main.ts に渡す引数（例：["push", "T12", "--watch"]） */
  args: readonly string[];
  /** 起動に失敗したときの文の前半（理由と起こし直し方は呼び出し側が足す） */
  failure: (reason: string) => string;
}

/** orca-flow の子を背景で起こし、終わりを待たずに戻る。起動に失敗したら FlowError(1) */
export async function launchBackground(
  runner: Runner,
  launch: BackgroundLaunch,
  redact: (text: string) => string = (t) => t,
): Promise<void> {
  const result = await runner(
    process.execPath,
    [
      "-e",
      launcherSource(launch.args),
      process.execPath,
      ORCA_FLOW_MAIN,
      launch.cwd,
      launch.log,
    ],
    { cwd: launch.cwd, timeoutMs: 30_000 },
  );
  if (result.code !== 0 || result.timedOut)
    throw new FlowError(
      1,
      launch.failure(
        redact((result.stderr || result.stdout).trim()) ||
          `終了コード ${result.code}`,
      ),
    );
}
