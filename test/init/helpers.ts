import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunOptions, RunResult, Runner } from "../../src/lib/exec.ts";
import { realRunner } from "../../src/lib/exec.ts";

/** 一時ディレクトリ（シンボリックリンクを解いたもの） */
export function tempDir(prefix = "orca-flow-p3-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} に失敗：${result.stderr}`);
  return result.stdout;
}

/** main ブランチと最初のコミットを持つ一時の git リポジトリ */
export function makeRepo(files: Record<string, string> = {}): string {
  const root = tempDir();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "config", "commit.gpgsign", "false");
  writeFiles(root, { "README.md": "# test\n", ...files });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

export interface Call {
  cmd: string;
  args: string[];
  opts?: RunOptions;
}

export type OrcaHandler = (
  args: string[],
  opts?: RunOptions,
) => RunResult | Promise<RunResult>;

/** git は本物、orca は handler に回す Runner。呼び出しを記録する */
export function fakeOrcaRunner(handler: OrcaHandler): {
  runner: Runner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    if (cmd === "orca") return handler([...args], opts);
    return realRunner(cmd, args, opts);
  };
  return { runner, calls };
}

export const ok = (value: unknown): RunResult => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, result: value }),
  stderr: "",
  timedOut: false,
});

export const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
};
