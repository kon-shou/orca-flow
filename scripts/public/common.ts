import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Runner, RunOptions } from "../../src/lib/exec.ts";
import { FlowError } from "../../src/types.ts";

/** 入出力。メッセージは標準エラーに出す */
export interface Io {
  stdin(): Promise<string>;
  stderr(text: string): void;
}

export interface Ctx {
  runner: Runner;
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: Io;
  /** コミットの日時に使う現在時刻 */
  now: () => Date;
  /** main.ts の絶対パス（フックに書き込む） */
  mainFile: string;
  /** node の絶対パス（フックに書き込む） */
  nodePath: string;
}

export const ZERO_OID = /^0+$/;
export const PUBLIC_REF = "refs/heads/public";
export const MAIN_REF = "refs/heads/main";

export function say(ctx: Ctx, line: string): void {
  ctx.io.stderr(`${line}\n`);
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** pathspec の解釈を変える環境変数を消す（あると、語を含むパスの照合が効かなくなる） */
const PATHSPEC_VARS = [
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
];

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of PATHSPEC_VARS) delete copy[key];
  return copy;
}

export async function git(
  ctx: Ctx,
  args: readonly string[],
  opts: Omit<RunOptions, "env"> & { env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  const result = await ctx.runner("git", args, {
    cwd: ctx.cwd,
    ...opts,
    env: cleanEnv({ ...ctx.env, ...opts.env }),
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** 成功しなければ終了コード1で投げ、標準出力を返す */
export async function gitOrThrow(
  ctx: Ctx,
  args: readonly string[],
  what: string,
  opts: Omit<RunOptions, "env"> & { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const result = await git(ctx, args, opts);
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new FlowError(
      1,
      `${what}に失敗しました${detail ? `：${detail}` : ""}`,
    );
  }
  return result.stdout;
}

export async function commonDir(ctx: Ctx): Promise<string> {
  const out = await git(ctx, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (out.code !== 0)
    throw new FlowError(2, "git のリポジトリの中で実行してください");
  return out.stdout.trim();
}

export async function topLevel(ctx: Ctx): Promise<string> {
  const out = await git(ctx, ["rev-parse", "--show-toplevel"]);
  const top = out.stdout.trim();
  if (out.code !== 0 || !top)
    throw new FlowError(2, "作業ツリーのあるリポジトリの中で実行してください");
  return top;
}

/** 1行1項目の一覧（# で始まる行と空行は除く） */
export function parseList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

async function readList(file: string): Promise<string[] | null> {
  try {
    return parseList(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 語の一覧を置く場所 */
async function wordsFile(ctx: Ctx): Promise<string> {
  return path.join(await commonDir(ctx), "orca-flow", "public-words.txt");
}

/** 語の一覧。ない・空なら空の一覧（手元の確かめ用。語を確かめずに飛ばす） */
export async function loadWordsIfPresent(ctx: Ctx): Promise<string[]> {
  return (await readList(await wordsFile(ctx))) ?? [];
}

/** 語の一覧。ない・空なら終了コード2 */
export async function loadWords(ctx: Ctx): Promise<string[]> {
  const words = await readList(await wordsFile(ctx));
  if (words === null || words.length === 0)
    throw new FlowError(
      2,
      "語の一覧がないか空です。git の共通ディレクトリの orca-flow/public-words.txt に 1行1語で書いてください",
    );
  return words;
}

/** 抜くパスの一覧を置く、main の中のパス */
export const EXCLUDE_PATH = "scripts/public/exclude.txt";

/** 抜くパス。既定は、流した作業ツリーではなく main のものを読む（ref で読む先を変えられる）。末尾の / は取り除く */
export async function loadExclude(
  ctx: Ctx,
  ref: string = MAIN_REF,
): Promise<string[]> {
  const out = await git(ctx, ["show", `${ref}:${EXCLUDE_PATH}`]);
  if (out.code !== 0)
    throw new FlowError(
      2,
      `${ref === MAIN_REF ? "main" : "確かめる木"} に ${EXCLUDE_PATH}（抜くパスの一覧）がありません`,
    );
  return parseList(out.stdout).map((entry) => entry.replace(/\/+$/, ""));
}

export interface Identity {
  name: string;
  email: string;
}

/** 公開用の名前とメールアドレス。どちらかがなければ終了コード2 */
export async function loadIdentity(ctx: Ctx): Promise<Identity> {
  const get = async (key: string) => {
    const out = await git(ctx, ["config", "--get", key]);
    return out.code === 0 ? out.stdout.trim() : "";
  };
  const name = await get("orca-flow.publicName");
  const email = await get("orca-flow.publicEmail");
  if (!name || !email)
    throw new FlowError(
      2,
      "公開用の名前かメールアドレスがありません。setup --name 〈名前〉 --email 〈メールアドレス〉 を先に実行してください",
    );
  return { name, email };
}
