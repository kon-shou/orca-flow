import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import { runOrThrow, type Runner } from "./exec.ts";
import { isMainWorktree, listBranches } from "./git.ts";
import { progressIds } from "./progress.ts";
import { nextTaskId } from "./task-id.ts";
import { readProgressText } from "./tasks.ts";
import { SLUG_PATTERN } from "./slug.ts";

export const WORKSPACE_FILE = "orca-flow-workspace.json";

export type WorkspaceRole = "common" | "app";

export interface WorkspaceRepo {
  name: string;
  /** 実の絶対パス（git のメインの作業ツリーの一番上） */
  path: string;
  role: WorkspaceRole;
  keywords: string[];
  /** 共通だけ */
  scope?: string;
  /** 共通だけ */
  package?: string;
  /** 共通だけ */
  bumpCommand?: string;
  /** 共通だけ・任意。`{branch}` を枝の名前に置き換えて流す、枝の取り込み方のコマンド */
  branchCommand?: string;
  /** 任意。clone 元（`workspace --setup` だけが読む） */
  url?: string;
  /** `--setup` の計画だけ。パスがまだなく、url から clone する子のとき true */
  missing?: true;
}

export interface Workspace {
  /** ワークスペースのフォルダの実のパス */
  dir: string;
  /** 設定のファイルの中身の sha256（16進） */
  sha256: string;
  repos: WorkspaceRepo[];
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const COMMON_ONLY = ["scope", "package", "bumpCommand"] as const;
const REPO_KEYS = new Set([
  "name",
  "path",
  "role",
  "keywords",
  ...COMMON_ONLY,
  "branchCommand",
  "url",
]);

/** loadWorkspace の読み方。allowMissing は `--setup` の計画だけ（パスのない子を、url があれば通す） */
interface ParseOptions {
  allowMissing: boolean;
}

/** パスが（途中まで）まだなくても、あるところまでの実のパスにして返す */
async function realish(p: string): Promise<string> {
  const real = await realOrNull(p);
  if (real !== null) return real;
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(await realish(parent), path.basename(p));
}

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
  );
};

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** ワークスペースのフォルダの設定を読んで確かめる。誤りはまとめて FlowError(1)、ファイルがなければ FlowError(2) */
export async function loadWorkspace(
  runner: Runner,
  folder: string,
): Promise<Workspace> {
  const dir = (await realOrNull(folder)) ?? path.resolve(folder);
  let buffer: Buffer;
  try {
    buffer = await readFile(path.join(dir, WORKSPACE_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FlowError(
        2,
        `${WORKSPACE_FILE} がありません。ワークスペースのフォルダで呼んでください`,
      );
    }
    throw error;
  }
  return parseWorkspace(runner, dir, buffer, { allowMissing: false });
}

/** 設定の中身（バッファ）を読んで確かめる。dir は実のパス */
export async function parseWorkspace(
  runner: Runner,
  dir: string,
  buffer: Buffer,
  options: ParseOptions,
): Promise<Workspace> {
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new FlowError(1, `${WORKSPACE_FILE} が JSON として読めません`);
  }
  if (!isObject(raw))
    throw new FlowError(
      1,
      `${WORKSPACE_FILE} は JSON のオブジェクトにしてください`,
    );

  const problems: string[] = [];
  for (const key of Object.keys(raw))
    if (key !== "repos") problems.push(`知らないキー ${key}`);

  const repos: WorkspaceRepo[] = [];
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    problems.push("repos は1つ以上のリポジトリの配列にしてください");
  } else {
    const seen = new Set<string>();
    for (const [index, item] of raw.repos.entries()) {
      const repo = await parseRepo(
        runner,
        dir,
        item,
        index,
        seen,
        problems,
        options,
      );
      if (repo) repos.push(repo);
    }
    checkNesting(dir, repos, problems);
    // 元の role から数える（パスの誤りで落ちた子のせいで誤った「ない」を出さない）
    const roles = raw.repos.map((r) => (isObject(r) ? r.role : undefined));
    if (!roles.includes("common"))
      problems.push('role が "common" のリポジトリが1つ以上要ります');
    if (!roles.includes("app"))
      problems.push('role が "app" のリポジトリが1つ以上要ります');
  }

  if (problems.length > 0)
    throw new FlowError(
      1,
      `${WORKSPACE_FILE} に直すところがあります：\n- ${problems.join("\n- ")}`,
    );
  return {
    dir,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    repos,
  };
}

async function parseRepo(
  runner: Runner,
  dir: string,
  item: unknown,
  index: number,
  seen: Set<string>,
  problems: string[],
  options: ParseOptions,
): Promise<WorkspaceRepo | null> {
  const before = problems.length;
  if (!isObject(item)) {
    problems.push(`repos[${index}] はオブジェクトにしてください`);
    return null;
  }
  const rawName = item.name;
  const label = isNonEmptyString(rawName)
    ? `repos[${index}]（${rawName}）`
    : `repos[${index}]`;

  for (const key of Object.keys(item))
    if (!REPO_KEYS.has(key)) problems.push(`知らないキー ${label}.${key}`);

  let name = "";
  if (!isNonEmptyString(rawName))
    problems.push(`${label}.name は空でない文字列にしてください`);
  else if (!SLUG_PATTERN.test(rawName))
    problems.push(
      `${label}.name は英小文字・数字・「-」にしてください（先頭は英小文字か数字）：${rawName}`,
    );
  else if (seen.has(rawName))
    problems.push(`${label}.name が重なっています：${rawName}`);
  else {
    name = rawName;
  }
  if (isNonEmptyString(rawName)) seen.add(rawName);

  const role = item.role;
  if (role !== "common" && role !== "app")
    problems.push(`${label}.role は "common" か "app" にしてください`);

  const keywords = item.keywords;
  if (
    !Array.isArray(keywords) ||
    keywords.length === 0 ||
    !keywords.every(isNonEmptyString)
  )
    problems.push(
      `${label}.keywords は空でない文字列を1つ以上並べた配列にしてください`,
    );

  const extras: Partial<Record<(typeof COMMON_ONLY)[number], string>> = {};
  for (const key of COMMON_ONLY) {
    const value = item[key];
    if (role === "common") {
      if (value === undefined)
        problems.push(`${label}.${key} がありません（共通には要ります）`);
      else if (!isNonEmptyString(value))
        problems.push(`${label}.${key} は空でない文字列にしてください`);
      else extras[key] = value;
    } else if (role === "app" && value !== undefined) {
      problems.push(`${label}.${key} は共通（common）だけの欄です`);
    }
  }

  const branchCommand = item.branchCommand;
  let branchCommandValue: string | undefined;
  if (branchCommand !== undefined) {
    if (role === "app")
      problems.push(`${label}.branchCommand は共通（common）だけの欄です`);
    else if (!isNonEmptyString(branchCommand) || branchCommand.trim() === "")
      problems.push(`${label}.branchCommand は空でない文字列にしてください`);
    else if (!branchCommand.includes("{branch}"))
      problems.push(
        `${label}.branchCommand に {branch}（枝の名前に置き換わる印）がありません`,
      );
    else branchCommandValue = branchCommand;
  }

  const url = item.url;
  let urlValue: string | undefined;
  if (url !== undefined) {
    if (!isNonEmptyString(url) || url.trim() === "")
      problems.push(`${label}.url は空でない文字列にしてください`);
    else if (url.startsWith("-"))
      problems.push(`${label}.url は「-」で始まらない文字列にしてください`);
    else urlValue = url;
  }

  let resolved = "";
  let missing = false;
  if (!isNonEmptyString(item.path)) {
    problems.push(`${label}.path は空でない文字列にしてください`);
  } else {
    const real = await realOrNull(path.resolve(dir, item.path));
    if (real === null) {
      if (options.allowMissing && urlValue !== undefined) {
        resolved = await realish(path.resolve(dir, item.path));
        missing = true;
      } else if (options.allowMissing && url === undefined) {
        problems.push(
          `${label}.path が見つからず、url もありません（clone 元の url を書くか、先にリポジトリを置いてください）：${item.path}`,
        );
      } else {
        problems.push(`${label}.path が見つかりません：${item.path}`);
      }
    } else {
      const problem = await checkTopLevel(runner, real);
      if (problem) problems.push(`${label}.path ${problem}：${item.path}`);
      else resolved = real;
    }
  }

  if (problems.length > before) return null;
  return {
    name,
    path: resolved,
    role: role as WorkspaceRole,
    keywords: keywords as string[],
    ...extras,
    ...(branchCommandValue !== undefined
      ? { branchCommand: branchCommandValue }
      : {}),
    ...(urlValue !== undefined ? { url: urlValue } : {}),
    ...(missing ? { missing: true as const } : {}),
  };
}

/** git のメインの作業ツリーの一番上でなければ、理由の文を返す */
async function checkTopLevel(
  runner: Runner,
  real: string,
): Promise<string | null> {
  let top: string;
  try {
    top = (
      await runOrThrow(
        runner,
        "git",
        ["rev-parse", "--show-toplevel"],
        "git rev-parse",
        { cwd: real },
      )
    ).trim();
  } catch {
    return "は git のリポジトリではありません";
  }
  if ((await realOrNull(top)) !== real)
    return "はリポジトリの一番上ではありません（リポジトリの下のフォルダです）";
  let main = false;
  try {
    main = await isMainWorktree(runner, real);
  } catch {
    main = false;
  }
  if (!main)
    return "はリンクした worktree です（メインの作業ツリーを指してください）";
  return null;
}

function checkNesting(
  dir: string,
  repos: WorkspaceRepo[],
  problems: string[],
): void {
  for (const [i, a] of repos.entries()) {
    if (isInside(dir, a.path) || isInside(a.path, dir))
      problems.push(
        `ワークスペースのフォルダと ${a.name} が入れ子か同じ場所です（どちらの向きも止めています）`,
      );
    for (const b of repos.slice(i + 1))
      if (isInside(a.path, b.path) || isInside(b.path, a.path))
        problems.push(
          `${a.name} と ${b.name} が入れ子か同じ場所です（どちらの向きも止めています）`,
        );
  }
}

/**
 * 子で `new` が次に振る ID。子の設定の答え（`config --json`）と、tasksDir・進捗表・ブランチから、
 * `new` と同じ関数（nextTaskId）で出す。設定が読めない・数えられないときは null
 */
export async function nextIdOf(
  runner: Runner,
  repoPath: string,
  rawConfig: unknown,
): Promise<string | null> {
  try {
    const config = parseConfig(rawConfig);
    let taskFiles: string[] = [];
    try {
      taskFiles = await readdir(path.join(repoPath, config.tasksDir));
    } catch {
      taskFiles = [];
    }
    const progressText = await readProgressText(repoPath, config);
    return nextTaskId({
      idPrefix: config.idPrefix,
      branchPrefix: config.branchPrefix,
      taskFiles,
      progressIds:
        progressText && config.progress
          ? progressIds(progressText, config.progress)
          : [],
      branches: await listBranches(runner, repoPath),
    });
  } catch {
    return null;
  }
}
