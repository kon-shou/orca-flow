import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
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

/** Windows でコマンドを探すときに使うもの。テストでは作り物を渡す */
export interface WindowsLookup {
  path: string | undefined;
  pathExt: string | undefined;
  comSpec: string | undefined;
  exists: (file: string) => boolean;
}

export type SpawnPlan =
  | { ok: true; file: string; args: string[]; verbatim: boolean }
  | { ok: false; reason: string };

// cmd.exe が特別に読む文字。^ で逃がす
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** 1つの引数を、cmd.exe を2回通っても元のまま届く形にする（.cmd の中でもう一度 cmd が読むため2重に逃がす） */
function quoteForCmd(arg: string): string {
  let quoted = arg
    // " の前の \ を2倍にして " を \" にする
    .replace(/(\\*)"/g, '$1$1\\"')
    // 終わりの \ を2倍にする（閉じる " を逃がさないため）
    .replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * Windows で起動するものを決める。区切りも拡張子もないコマンドを PATH と PATHEXT で探し、
 * .cmd・.bat なら cmd.exe の /d /s /c に1行で渡す。見つからなければ、そのまま起動する
 */
export function planWindowsSpawn(
  cmd: string,
  args: readonly string[],
  lookup: WindowsLookup,
): SpawnPlan {
  const asIs: SpawnPlan = {
    ok: true,
    file: cmd,
    args: [...args],
    verbatim: false,
  };
  if (/[\\/]/.test(cmd) || path.win32.extname(cmd) !== "") return asIs;
  const exts = (lookup.pathExt || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((e) => e !== "");
  let found: string | null = null;
  for (const dir of (lookup.path ?? "").split(";").filter((d) => d !== "")) {
    for (const ext of exts) {
      const candidate = path.win32.join(dir, `${cmd}${ext.toLowerCase()}`);
      if (lookup.exists(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found) break;
  }
  if (found === null) return asIs;
  if (!/\.(cmd|bat)$/i.test(found))
    return { ok: true, file: found, args: [...args], verbatim: false };
  if (args.some((a) => /[\r\n]/.test(a)))
    return {
      ok: false,
      reason: `${cmd} は .cmd・.bat なので、改行を含む引数を1行に入れて渡せません`,
    };
  const line = [found.replace(CMD_META, "^$1"), ...args.map(quoteForCmd)].join(
    " ",
  );
  return {
    ok: true,
    file: lookup.comSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}

/** 環境変数を、大文字小文字を問わずに引く（Windows の Path・PATH の違い） */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const env = opts.env ?? process.env;
    let plan: SpawnPlan = {
      ok: true,
      file: cmd,
      args: [...args],
      verbatim: false,
    };
    if (process.platform === "win32")
      plan = planWindowsSpawn(cmd, args, {
        path: envValue(env, "PATH"),
        pathExt: envValue(env, "PATHEXT"),
        comSpec: envValue(env, "COMSPEC"),
        exists: existsSync,
      });
    if (!plan.ok) {
      resolve({ code: 1, stdout: "", stderr: plan.reason, timedOut: false });
      return;
    }
    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env,
      // input がなければ stdin を開かない（先に終わった子に書いて EPIPE になるのを避ける）
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
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
