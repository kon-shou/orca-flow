import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import {
  BRANCH_DEFINITION_FILES,
  hasPackageName,
  refPackageLines,
} from "./branch-push.ts";
import { ORCA_FLOW_MAIN } from "./background.ts";
import { runOrThrow, type Runner } from "./exec.ts";
import { isMainWorktree, listBranches } from "./git.ts";
import { progressIds } from "./progress.ts";
import { nextTaskId } from "./task-id.ts";
import { readProgressText } from "./tasks.ts";
import { SLUG_PATTERN } from "./slug.ts";

export const WORKSPACE_FILE = "orca-flow-workspace.json";

export type WorkspaceRole = "common" | "app";

/** アプリの子に書く、E2E を伴わせる設定（`repos[].companion`） */
export interface WorkspaceCompanion {
  /** 伴う相手のアプリの子の名前 */
  apps: string[];
  /** 条件の文（intake の AI が読む） */
  when: string;
  /** 流すコマンド。`{previewUrl:〈名前〉}` の印が1つ以上ある */
  command: CompanionCommand;
  /** 任意。録画を有効にして E2E を流すコマンドと、道具が録画を書き出すフォルダ */
  capture?: WorkspaceCapture;
}

/** `companion.capture`：e2e --capture が前後の画面に流して録る設定 */
export interface WorkspaceCapture {
  /** 録画を有効にして流すコマンド。`{previewUrl:〈名前〉}` の印の決まりは companion.command と同じ */
  command: CompanionCommand;
  /** E2E のリポジトリの中の相対パス（録画を書き出すフォルダ） */
  output: string;
}

/**
 * E2E のコマンド。文字列は全部のアプリの分の1本。
 * オブジェクトは apps の名前をキーにしたアプリごとの1本（キーのないアプリは印の相手としてだけ使う）
 */
export type CompanionCommand = string | Readonly<Record<string, string>>;

/** コマンドを [キー, コマンド] の並びにする。文字列はキーが null の1つ */
export function commandEntries(
  command: CompanionCommand,
): [string | null, string][] {
  return typeof command === "string"
    ? [[null, command]]
    : Object.entries(command);
}

/**
 * アプリの分のコマンド。文字列は全部のアプリの分なのでそのまま返す。
 * アプリの名前は constructor なども通るので、Object.prototype のものを拾わないよう自分のキーだけを見る
 */
export function commandFor(
  command: CompanionCommand,
  app: string,
): string | undefined {
  if (typeof command === "string") return command;
  return Object.hasOwn(command, app) ? command[app] : undefined;
}

/** 同じ形の写し（オブジェクトは新しいオブジェクトにする） */
export const copyCommand = (command: CompanionCommand): CompanionCommand =>
  typeof command === "string" ? command : { ...command };

/** command の形（空でない文字列か、値が空でない文字列の空でないオブジェクト）の問題の文の並び */
export function commandShapeProblems(value: unknown, at: string): string[] {
  if (typeof value === "string")
    return value.trim() === "" ? [`${at} は空でない文字列にしてください`] : [];
  if (!isObject(value) || Object.keys(value).length === 0)
    return [
      `${at} は空でない文字列か、アプリの名前をキーにした空でないオブジェクトにしてください`,
    ];
  return Object.entries(value)
    .filter(([, v]) => !isNonEmptyString(v) || v.trim() === "")
    .map(([key]) => `${at}.${key} は空でない文字列にしてください`);
}

/**
 * command の印の問題の文の並び。印がある・オブジェクトならキーが apps にあり自分のキーの印がある・
 * 印の名前が apps にある・引用符の外。noMark は印がないときの文の「〈印〉」のあとに続ける語
 */
export function commandMarkProblems(
  command: CompanionCommand,
  at: string,
  apps: readonly string[],
  noMark: string,
): string[] {
  const problems: string[] = [];
  for (const [key, text] of commandEntries(command)) {
    const where = key === null ? at : `${at}.${key}`;
    if (key !== null && !apps.includes(key))
      problems.push(`${at} のキー ${key} が apps にありません`);
    const marks = [
      ...new Set([...text.matchAll(PREVIEW_URL_MARK)].map((m) => m[1]!)),
    ];
    if (marks.length === 0)
      problems.push(`${where} に {previewUrl:〈名前〉}${noMark}がありません`);
    else if (key !== null && !marks.includes(key))
      problems.push(
        `${where} に {previewUrl:${key}}（自分のキーのアプリの印）がありません`,
      );
    for (const name of marks)
      if (!apps.includes(name))
        problems.push(
          `${where} の印 {previewUrl:${name}} の名前が apps にありません`,
        );
    for (const name of quotedPreviewMarkNames(text))
      problems.push(
        `${where} の印 {previewUrl:${name}} を引用符で囲まないでください（e2e が引用します）`,
      );
  }
  return problems;
}

const CAPTURE_KEYS = ["command", "output"] as const;

/** capture.output の誤りの文（正しければ null）。空・絶対パス・「.」「..」の部分を含む形は誤り */
export function captureOutputProblem(output: unknown): string | null {
  if (typeof output !== "string" || output.trim() === "")
    return "は空でない文字列にしてください";
  if (
    path.isAbsolute(output) ||
    path.win32.isAbsolute(output) ||
    path.posix.isAbsolute(output)
  )
    return "は E2E のリポジトリの中の相対パスにしてください（絶対パスは書けません）";
  const parts = output.split(/[\\/]/);
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    return "に「.」「..」・空の部分は書けません";
  return null;
}

/** capture の形（キー・型）の問題の文の並び。command の印の突き合わせは呼ぶ側が見る */
export function captureShapeProblems(value: unknown, at: string): string[] {
  if (!isObject(value)) return [`${at} はオブジェクトにしてください`];
  const problems: string[] = [];
  for (const key of Object.keys(value))
    if (!(CAPTURE_KEYS as readonly string[]).includes(key))
      problems.push(`知らないキー ${at}.${key}`);
  if (value.command === undefined) problems.push(`${at}.command がありません`);
  else problems.push(...commandShapeProblems(value.command, `${at}.command`));
  if (value.output === undefined) problems.push(`${at}.output がありません`);
  else {
    const problem = captureOutputProblem(value.output);
    if (problem) problems.push(`${at}.output ${problem}`);
  }
  return problems;
}

/** コマンドの `{previewUrl:〈名前〉}` の印（名前の部分を取る） */
export const PREVIEW_URL_MARK = /\{previewUrl:([^{}]*)\}/g;

/** 一重・二重の引用符の中にある印の名前の並び（e2e が印を引用した URL に置き換えるので、引用の中は壊れる） */
export function quotedPreviewMarkNames(command: string): string[] {
  const found: string[] = [];
  for (const m of command.matchAll(PREVIEW_URL_MARK)) {
    let state: "" | "'" | '"' = "";
    for (let i = 0; i < m.index; i++) {
      const ch = command[i]!;
      if (state === "'") {
        if (ch === "'") state = "";
      } else if (ch === "\\") {
        i++;
      } else if (state === '"') {
        if (ch === '"') state = "";
      } else if (ch === "'" || ch === '"') {
        state = ch;
      }
    }
    if (state !== "" && !found.includes(m[1]!)) found.push(m[1]!);
  }
  return found;
}

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
  /** 任意。true のときだけ持つ。intake が要件の言葉に当たらなくても毎回読む印 */
  alwaysRead?: true;
  /** アプリだけ・任意。E2E を伴わせる相手・条件・コマンド */
  companion?: WorkspaceCompanion;
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
  /** 任意。先に読む文書の実の絶対パス（書いた順・重なりなし）。なければキーごとない */
  readFirst?: string[];
  /** 任意。読み方が文書のないことを許したときだけ、まだない先に読む文書の絶対パス（書いた順・重なりなし） */
  readFirstMissing?: string[];
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
  "alwaysRead",
  "companion",
  "url",
]);
const COMPANION_KEYS = ["apps", "when", "command"] as const;
const COMPANION_OPTIONAL_KEYS = ["capture"] as const;

/** loadWorkspace の読み方。allowMissing は `--setup` の計画だけ（パスのない子を、url があれば通す） */
interface ParseOptions {
  allowMissing: boolean;
  /** 先に読む文書がないことだけを誤りにしない（`--setup --yes` の終わり。ほかの確かめは厳しいまま） */
  allowMissingReadFirst?: boolean;
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
  options: { allowMissingReadFirst?: boolean } = {},
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
  return parseWorkspace(runner, dir, buffer, {
    allowMissing: false,
    ...(options.allowMissingReadFirst ? { allowMissingReadFirst: true } : {}),
  });
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
    if (key !== "repos" && key !== "readFirst")
      problems.push(`知らないキー ${key}`);
  const { found: readFirst, missing: readFirstMissing } = await parseReadFirst(
    dir,
    raw.readFirst,
    problems,
    options,
  );

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
    checkCompanions(raw.repos, repos, problems);
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
    ...(readFirst.length > 0 ? { readFirst } : {}),
    ...(readFirstMissing.length > 0 ? { readFirstMissing } : {}),
  };
}

/** readFirst の形と、各パスが通常のファイルとして実在するかを確かめる。実のパスの並びと、許したときのまだないパスの並びを返す */
async function parseReadFirst(
  dir: string,
  value: unknown,
  problems: string[],
  options: ParseOptions,
): Promise<{ found: string[]; missing: string[] }> {
  const found: string[] = [];
  const missing: string[] = [];
  if (value === undefined) return { found, missing };
  if (!Array.isArray(value)) {
    problems.push("readFirst は文字列の配列にしてください");
    return { found, missing };
  }
  for (const [index, item] of value.entries()) {
    if (!isNonEmptyString(item) || item.trim() === "") {
      problems.push(`readFirst[${index}] は空でない文字列にしてください`);
      continue;
    }
    const real = await realOrNull(path.resolve(dir, item));
    if (real === null) {
      // clone の前は文書がまだないことがある
      if (options.allowMissing || options.allowMissingReadFirst) {
        const where = await realish(path.resolve(dir, item));
        if (!missing.includes(where)) missing.push(where);
      } else {
        problems.push(
          `readFirst[${index}] のファイルが見つかりません：${item}`,
        );
      }
      continue;
    }
    const info = await stat(real).catch(() => null);
    if (info === null || !info.isFile()) {
      problems.push(
        `readFirst[${index}] は通常のファイルにしてください：${item}`,
      );
      continue;
    }
    if (!found.includes(real)) found.push(real);
  }
  return { found, missing };
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

  const alwaysRead = item.alwaysRead;
  let alwaysReadValue = false;
  if (alwaysRead !== undefined) {
    if (typeof alwaysRead !== "boolean")
      problems.push(
        `${label}.alwaysRead は真偽（true か false）にしてください`,
      );
    else if (!alwaysRead && role === "common")
      problems.push(
        `${label}.alwaysRead を false にはできません（共通はいつも読むので、書くなら true か消してください）`,
      );
    else alwaysReadValue = alwaysRead;
  }

  let companionValue: WorkspaceCompanion | undefined;
  if (item.companion !== undefined) {
    if (role === "common")
      problems.push(`${label}.companion は共通（common）には書けません`);
    else companionValue = parseCompanionShape(item.companion, label, problems);
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
    ...(alwaysReadValue ? { alwaysRead: true as const } : {}),
    ...(companionValue !== undefined ? { companion: companionValue } : {}),
    ...(urlValue !== undefined ? { url: urlValue } : {}),
    ...(missing ? { missing: true as const } : {}),
  };
}

/** companion の形（キー・型）を確かめる。ほかの子との関係は checkCompanions が見る */
function parseCompanionShape(
  value: unknown,
  label: string,
  problems: string[],
): WorkspaceCompanion | undefined {
  const at = `${label}.companion`;
  if (!isObject(value)) {
    problems.push(`${at} はオブジェクトにしてください`);
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(value))
    if (
      !(COMPANION_KEYS as readonly string[]).includes(key) &&
      !(COMPANION_OPTIONAL_KEYS as readonly string[]).includes(key)
    )
      problems.push(`知らないキー ${at}.${key}`);
  for (const key of COMPANION_KEYS)
    if (value[key] === undefined) problems.push(`${at}.${key} がありません`);
  const { apps, when, command } = value;
  if (apps !== undefined) {
    if (
      !Array.isArray(apps) ||
      apps.length === 0 ||
      !apps.every(isNonEmptyString)
    )
      problems.push(
        `${at}.apps は子の名前（空でない文字列）を1つ以上並べた配列にしてください`,
      );
    else if (new Set(apps).size !== apps.length)
      problems.push(`${at}.apps に重なりがあります`);
  }
  if (when !== undefined && (!isNonEmptyString(when) || when.trim() === ""))
    problems.push(`${at}.when は空でない文字列にしてください`);
  if (command !== undefined)
    problems.push(...commandShapeProblems(command, `${at}.command`));
  if (value.capture !== undefined)
    problems.push(...captureShapeProblems(value.capture, `${at}.capture`));
  if (problems.length > before) return undefined;
  const capture = value.capture as WorkspaceCapture | undefined;
  return {
    apps: apps as string[],
    when: when as string,
    command: copyCommand(command as CompanionCommand),
    ...(capture !== undefined
      ? {
          capture: {
            command: copyCommand(capture.command),
            output: capture.output,
          },
        }
      : {}),
  };
}

/** companion の apps が、自分以外の実在するアプリの子か。command の印が apps のどれかか */
function checkCompanions(
  rawRepos: readonly unknown[],
  repos: readonly WorkspaceRepo[],
  problems: string[],
): void {
  const roleOf = new Map<string, unknown>();
  for (const r of rawRepos)
    if (isObject(r) && isNonEmptyString(r.name)) roleOf.set(r.name, r.role);
  for (const repo of repos) {
    const c = repo.companion;
    if (!c) continue;
    const at = `repos[（${repo.name}）].companion`;
    for (const app of c.apps) {
      if (app === repo.name)
        problems.push(`${at}.apps に自分（${app}）は書けません`);
      else if (!roleOf.has(app))
        problems.push(`${at}.apps の名前が設定にありません：${app}`);
      else if (roleOf.get(app) !== "app")
        problems.push(`${at}.apps はアプリ（app）の子だけです：${app}`);
    }
    problems.push(
      ...commandMarkProblems(
        c.command,
        `${at}.command`,
        c.apps,
        "（プレビューの URL に置き換わる印）",
      ),
    );
    if (c.capture)
      problems.push(
        ...commandMarkProblems(
          c.capture.command,
          `${at}.capture.command`,
          c.apps,
          "（前後の画面の URL に置き換わる印）",
        ),
      );
  }
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

/**
 * 共通のパッケージ名を使うアプリの名前の並び。アプリの baseBranch の先頭のパッケージの定義（5種。どの階層でも）に、
 * パッケージ名が版上げの確かめと同じ区切り（前後にパッケージ名の文字が続かない）で出るものを数える。
 * アプリの baseBranch が分からない・定義を読めないアプリが1つでもあれば null（読めないまま「使わない」と言わない）。
 * 読むだけで、作業ツリーは見ない
 */
export async function appUsersOf(
  runner: Runner,
  pkg: string,
  apps: readonly { name: string; path: string; baseBranch: string | null }[],
): Promise<string[] | null> {
  const users: string[] = [];
  for (const app of apps) {
    if (app.baseBranch === null) return null;
    const lines = await refPackageLines(
      runner,
      app.path,
      app.baseBranch,
      pkg,
      BRANCH_DEFINITION_FILES,
    );
    if (lines === null) return null;
    if (lines.some((line) => hasPackageName(line, pkg))) users.push(app.name);
  }
  return users;
}

/** 子の CLI を、子のフォルダを作業の場所にして流す（親から子へ流す道はここだけ） */
export function runChildCli(
  runner: Runner,
  env: NodeJS.ProcessEnv,
  repo: Pick<WorkspaceRepo, "path">,
  args: readonly string[],
) {
  return runner(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", ORCA_FLOW_MAIN, ...args],
    { cwd: repo.path, env },
  );
}
