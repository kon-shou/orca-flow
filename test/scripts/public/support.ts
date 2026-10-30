import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Runner } from "../../../src/lib/exec.ts";
import { testRunner } from "../../helpers/runner.ts";
import { run } from "../../../scripts/public/main.ts";

export const NAME = "Public Name";
export const EMAIL = "public@example.invalid";
export const WORD_1 = "secret-word-1";
export const WORD_2 = "Secret-Word-2";
export const WORD_JA = "秘密の語";

const created: string[] = [];

/** 作った一時ディレクトリを消す。afterEach で呼ぶ */
export async function cleanupSandboxes(): Promise<void> {
  for (const dir of created.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

export const EXCLUDE_TEXT =
  "# テスト用\ndocs/tasks/\ndocs/public-release-audit/\n";

export interface Sandbox {
  base: string;
  env: NodeJS.ProcessEnv;
  runner: Runner;
  /** 一時のリポジトリ（main を持つ） */
  repo: string;
}

/** 利用者の git の設定に左右されず、書き換えもしない環境 */
export async function makeSandbox(
  files: Record<string, string> = {},
): Promise<Sandbox> {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "orca-flow-public-test-")),
  );
  created.push(base);
  const home = path.join(base, "home");
  await mkdir(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    TZ: "Asia/Tokyo",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env))
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_|COMMITTER_)/.test(key))
      delete env[key];
  const runner: Runner = (cmd, args, opts = {}) =>
    testRunner(cmd, args, { ...opts, env: { ...env, ...opts.env } });
  const repo = path.join(base, "repo");
  await mkdir(repo);
  const sandbox: Sandbox = { base, env, runner, repo };
  await git(sandbox, repo, "init", "--quiet", "-b", "main");
  await git(sandbox, repo, "config", "user.name", "Private Person");
  await git(sandbox, repo, "config", "user.email", "private@example.invalid");
  await git(sandbox, repo, "config", "commit.gpgsign", "false");
  // 背景の gc が後始末とぶつからないように
  await git(sandbox, repo, "config", "gc.auto", "0");
  await writeRepoFiles(repo, {
    "README.md": "# 公開するもの\n",
    "src/a.txt": "中身\n",
    "scripts/public/exclude.txt": EXCLUDE_TEXT,
    "docs/tasks/T1.md": "タスクの文書\n",
    "docs/public-release-audit/files.md": "調べた結果\n",
    ...files,
  });
  await git(sandbox, repo, "add", "-A");
  await git(sandbox, repo, "commit", "--quiet", "-m", "main の最初のコミット");
  return sandbox;
}

export async function writeRepoFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
  }
}

/** 本物の git。失敗したら投げる */
export async function git(
  box: Sandbox,
  cwd: string,
  ...args: string[]
): Promise<string> {
  const result = await box.runner("git", args, { cwd });
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} が失敗：${result.stderr}`);
  return result.stdout.trim();
}

/** 終わりが失敗でも結果を返す git */
export function gitRaw(box: Sandbox, cwd: string, ...args: string[]) {
  return box.runner("git", args, { cwd });
}

export async function writeWords(box: Sandbox, words: string[]) {
  const dir = path.join(box.repo, ".git", "orca-flow");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "public-words.txt"),
    `# コメント\n\n${words.join("\n")}\n`,
  );
}

export async function configureIdentity(box: Sandbox) {
  await git(box, box.repo, "config", "orca-flow.publicName", NAME);
  await git(box, box.repo, "config", "orca-flow.publicEmail", EMAIL);
}

export interface Outcome {
  code: number;
  stderr: string;
}

/** main.ts の run を、一時のリポジトリに向けて呼ぶ */
export async function runScript(
  box: Sandbox,
  argv: string[],
  options: {
    cwd?: string;
    stdin?: string;
    now?: Date;
    nodePath?: string;
  } = {},
): Promise<Outcome> {
  let stderr = "";
  const code = await run(argv, {
    // ctx.env は完全な環境なので、箱の環境を足し直さない（足すと消した環境変数が戻る）
    runner: testRunner,
    cwd: options.cwd ?? box.repo,
    env: box.env,
    ...(options.nodePath ? { nodePath: options.nodePath } : {}),
    now: () => options.now ?? new Date("2026-10-26T15:30:00Z"),
    io: {
      stdin: async () => options.stdin ?? "",
      stderr: (text) => {
        stderr += text;
      },
    },
  });
  return { code, stderr };
}

export const SETUP_ARGS = ["setup", "--name", NAME, "--email", EMAIL];

/** setup を流す（公開用の名前と pre-push のフックが入る） */
export async function setupBox(box: Sandbox): Promise<void> {
  const result = await runScript(box, SETUP_ARGS);
  if (result.code !== 0) throw new Error(`setup が失敗：${result.stderr}`);
}

/** public の準備（語の一覧と、setup による公開用の名前・フック）を済ませた箱 */
export async function readyBox(
  files: Record<string, string> = {},
): Promise<Sandbox> {
  const box = await makeSandbox(files);
  await writeWords(box, [WORD_1, WORD_2]);
  await setupBox(box);
  return box;
}

export async function publicTip(box: Sandbox): Promise<string | null> {
  const out = await gitRaw(
    box,
    box.repo,
    "rev-parse",
    "--verify",
    "--quiet",
    "refs/heads/public",
  );
  return out.code === 0 ? out.stdout.trim() : null;
}
