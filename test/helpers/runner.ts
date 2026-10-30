import { spawn } from "node:child_process";
import type { Runner } from "../../src/lib/exec.ts";

/**
 * テスト用の本物の Runner。
 * 契約の realRunner は、子が先に終わると stdin への書き込みが EPIPE になって捕まえられない例外になることがあるため
 * （契約の変更を依頼済み）、テストでは stdin を閉じた形で走らせる
 */
export const testRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    // 断片の境目で複数バイトの文字が壊れないよう、文字に直すのはストリームに任せる
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      stderr += error.message;
      finish(error.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code) => finish(code ?? 1));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
