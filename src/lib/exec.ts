import { spawn } from "node:child_process";
import { FlowError } from "../types.ts";

export interface RunOptions {
  cwd?: string;
  /** 打ち切るまでのミリ秒。打ち切ったら timedOut を true にして返す */
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  /** 終了コード。コマンドが見つからなければ 127 */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 外のコマンドを走らせる関数。シェルは通さない */
export type Runner = (
  cmd: string,
  args: readonly string[],
  opts?: RunOptions,
) => Promise<RunResult>;

export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // input がなければ stdin を開かない（先に終わった子に書いて EPIPE になるのを避ける）
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs);
    // 断片の境目で複数バイトの文字が壊れないよう、文字に直すのはストリームに任せる
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code === "ENOENT" ? 127 : 1;
      finish({ code, stdout, stderr: stderr + error.message, timedOut });
    });
    child.on("close", (code) =>
      finish({ code: code ?? 1, stdout, stderr, timedOut }),
    );
    if (child.stdin) {
      // 子が input を読み切らずに終わったときの EPIPE は、終了コードで分かるので捨てる
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });

/** 成功しなければ FlowError(1) を投げ、成功すれば標準出力を返す。what は「git rebase」のような日本語の名前 */
export async function runOrThrow(
  runner: Runner,
  cmd: string,
  args: readonly string[],
  what: string,
  opts?: RunOptions,
): Promise<string> {
  const result = await runner(cmd, args, opts);
  if (result.timedOut)
    throw new FlowError(1, `${what}が時間内に終わりませんでした`);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new FlowError(
      1,
      `${what}に失敗しました${detail ? `：${detail}` : ""}`,
    );
  }
  return result.stdout;
}

/** cwd を含む git の作業ツリーのトップ。git の外なら null */
export async function repoRoot(
  runner: Runner,
  cwd: string,
): Promise<string | null> {
  const result = await runner("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/** 設定の verify のような1行のシェルのコマンドを Runner に渡す形にする */
export function shellCommand(command: string): [string, string[]] {
  return ["sh", ["-c", command]];
}
