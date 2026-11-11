import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import { gitCommonDir } from "./git.ts";
import { SLUG_PATTERN } from "./slug.ts";
import { commonRecordPath, hasIdShape } from "./task-id.ts";
import {
  captureShapeProblems,
  commandEntries,
  commandFor,
  commandMarkProblems,
  commandShapeProblems,
  copyCommand,
  PREVIEW_URL_MARK,
  type CompanionCommand,
  type WorkspaceCapture,
  type WorkspaceRepo,
} from "./workspace.ts";

// 伴う記録（E2E のタスクが、どのアプリのブランチのプレビューに向けて何を流すか）。
// 記録は `〈git の共通ディレクトリ〉/orca-flow/companion/〈ID〉.json`（作業ツリーの外）。子は親の設定を読まないので、親が解いて渡す

/** 伴う相手のアプリ1つ分 */
export interface CompanionApp {
  /** 設定の名前（slug の形。重ならない） */
  name: string;
  /** アプリのメインの作業ツリーの実の絶対パス */
  path: string;
}

/** `new --companion-json` で渡す値 */
export interface CompanionInput {
  /**
   * `{previewUrl:〈名前〉}` の印を1つ以上持つ。名前は apps のどれか。
   * オブジェクトなら apps の名前をキーにしたアプリごとのコマンドで、各値に自分のキーの印がある
   */
  command: CompanionCommand;
  apps: CompanionApp[];
  /**
   * 任意。印に出るがブランチにないアプリ（土台のアプリで埋める）。apps と名前が重ならない。
   * ない記録は空と同じ（書くときも空なら書かない）
   */
  baseApps?: CompanionApp[];
  /** 任意。録画を有効にして流すコマンドと録画の書き出し先（E2E のリポジトリの中の相対パス） */
  capture?: WorkspaceCapture;
}

export interface Companion extends CompanionInput {
  id: string;
  /** 書いた時刻（ISO） */
  at: string;
  /** 書いたタスクのブランチ名。古い記録にはない（組の見分けは ID で見る） */
  taskBranch?: string;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** command の `{previewUrl:〈名前〉}` の名前の並び（出た順・重なりなし） */
export function previewMarkNames(command: string): string[] {
  return [
    ...new Set([...command.matchAll(PREVIEW_URL_MARK)].map((m) => m[1]!)),
  ];
}

/** 形の問題の文の並び（空なら正しい） */
function inputProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return ["オブジェクトではありません"];
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(r))
    if (!["command", "apps", "baseApps", "capture"].includes(key))
      problems.push(`知らないキー ${key}`);
  const names: string[] = [];
  const baseNames: string[] = [];
  const seen = new Set<string>();
  const appEntries = (list: unknown[], field: string, into: string[]) =>
    list.forEach((entry: unknown, i) => {
      const at = `${field}[${i}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        problems.push(`${at} がオブジェクトではありません`);
        return;
      }
      const a = entry as Record<string, unknown>;
      if (typeof a.name !== "string" || !SLUG_PATTERN.test(a.name))
        problems.push(
          `${at}.name が名前の形（英小文字・数字・「-」）ではありません`,
        );
      else if (seen.has(a.name))
        problems.push(`${at}.name が重なっています：${a.name}`);
      else {
        seen.add(a.name);
        into.push(a.name);
      }
      if (!isNonEmptyString(a.path) || !path.isAbsolute(a.path))
        problems.push(`${at}.path が絶対パスではありません`);
    });
  if (!Array.isArray(r.apps) || r.apps.length === 0)
    problems.push("apps が1つ以上の並びではありません");
  else appEntries(r.apps, "apps", names);
  if (r.baseApps !== undefined) {
    if (!Array.isArray(r.baseApps))
      problems.push("baseApps が並びではありません");
    else appEntries(r.baseApps, "baseApps", baseNames);
  }
  // 印は土台のアプリも指せるが、アプリごとのコマンドのキーはブランチにあるアプリだけ
  const markProblems = (command: CompanionCommand, at: string) => [
    ...commandMarkProblems(command, at, [...names, ...baseNames], " の印"),
    ...(typeof command === "string"
      ? []
      : Object.keys(command)
          .filter((key) => baseNames.includes(key))
          .map((key) => `${at} のキー ${key} が apps にありません`)),
  ];
  if (r.command === undefined) {
    problems.push("command が空か、ありません");
  } else {
    const shape = commandShapeProblems(r.command, "command");
    problems.push(...shape);
    if (shape.length === 0)
      problems.push(...markProblems(r.command as CompanionCommand, "command"));
  }
  if (r.capture !== undefined) {
    const shape = captureShapeProblems(r.capture, "capture");
    problems.push(...shape);
    if (shape.length === 0)
      problems.push(
        ...markProblems(
          (r.capture as WorkspaceCapture).command,
          "capture.command",
        ),
      );
  }
  return problems;
}

const normalize = (r: CompanionInput): CompanionInput => ({
  command: copyCommand(r.command),
  apps: r.apps.map((a) => ({ name: a.name, path: a.path })),
  ...(r.baseApps !== undefined && r.baseApps.length > 0
    ? { baseApps: r.baseApps.map((a) => ({ name: a.name, path: a.path })) }
    : {}),
  ...(r.capture !== undefined
    ? {
        capture: {
          command: copyCommand(r.capture.command),
          output: r.capture.output,
        },
      }
    : {}),
});

/** 記録の土台のアプリ（ない記録は空） */
export const companionBaseApps = (
  record: Pick<CompanionInput, "baseApps">,
): CompanionApp[] => record.baseApps ?? [];

/** コマンドのどれかに出る印の名前の並び（出た順・重なりなし） */
export function commandMarkNames(command: CompanionCommand): string[] {
  return [
    ...new Set(
      commandEntries(command).flatMap(([, text]) => previewMarkNames(text)),
    ),
  ];
}

/** オブジェクトのコマンドから渡したアプリのキーの分だけを取る。文字列はそのまま。取るものがなければ null */
function pickCommand(
  command: CompanionCommand,
  given: ReadonlySet<string>,
): CompanionCommand | null {
  if (typeof command === "string") return command;
  const picked = Object.fromEntries(
    Object.keys(command).flatMap((key) => {
      const text = given.has(key) ? commandFor(command, key) : undefined;
      return text === undefined ? [] : [[key, text]];
    }),
  );
  return Object.keys(picked).length > 0 ? picked : null;
}

/** `--companion-json` の値を確かめて返す。形が外れたら FlowError(1) */
export function parseCompanionJson(text: string): CompanionInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FlowError(1, "--companion-json が JSON として読めません");
  }
  const problems = inputProblems(raw);
  if (problems.length > 0)
    throw new FlowError(
      1,
      `--companion-json の形が違います：${problems.join("、")}`,
    );
  return normalize(raw as CompanionInput);
}

const file = (common: string, id: string) =>
  commonRecordPath(common, "companion", id, ".json");

const broken = (common: string, id: string) =>
  new FlowError(
    1,
    `伴う記録が壊れています：${file(common, id)}。直すか消してからもう一度流してください`,
  );

/** 記録を読む。ない（ENOENT・ID の形が違う）なら null、壊れていれば FlowError(1) */
export async function readCompanion(
  runner: Runner,
  root: string,
  id: string,
): Promise<Companion | null> {
  if (!hasIdShape(id)) return null;
  const common = await gitCommonDir(runner, root);
  let text: string;
  try {
    text = await readFile(file(common, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw broken(common, id);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw broken(common, id);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw broken(common, id);
  const { id: rawId, at, taskBranch, ...body } = raw as Record<string, unknown>;
  if (
    rawId !== id ||
    typeof at !== "string" ||
    (taskBranch !== undefined && !isNonEmptyString(taskBranch)) ||
    inputProblems(body).length > 0
  )
    throw broken(common, id);
  return {
    id,
    at,
    ...(taskBranch !== undefined ? { taskBranch } : {}),
    ...normalize(body as unknown as CompanionInput),
  };
}

/** 共通ディレクトリを渡して記録を書く（一時ファイルと rename）。input が null なら記録を消す */
export async function writeCompanionAt(
  common: string,
  id: string,
  input: CompanionInput | null,
  now: Date,
  taskBranch?: string,
): Promise<void> {
  const target = file(common, id);
  if (input === null) {
    await rm(target, { force: true });
    return;
  }
  const record: Companion = {
    id,
    at: now.toISOString(),
    ...(taskBranch !== undefined ? { taskBranch } : {}),
    ...normalize(input),
  };
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, target);
}

/**
 * 親の `new --companion 〈アプリ〉,…` を、設定のパスと command に解いた JSON にする。
 * command・capture.command がオブジェクトなら、渡したアプリのキーの分だけを写す。
 * 写したコマンドの印のアプリが渡されていなければ、baseApps に入れる。
 * 値がなければ null。外れは全部まとめて FlowError(1)
 */
export function resolveCompanionArg(
  repos: readonly Pick<WorkspaceRepo, "name" | "path" | "companion">[],
  child: string,
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  const names = value.split(/[,、\s]+/).filter((n) => n !== "");
  const me = repos.find((r) => r.name === child);
  const setting = me?.companion;
  const problems: string[] = [];
  if (names.length === 0)
    problems.push("--companion に伴うアプリの名前を書いてください");
  if (!setting)
    problems.push(
      `${child} には companion の設定がありません（設定の companion があるアプリの new にだけ付けられます）`,
    );
  const apps: CompanionApp[] = [];
  const baseApps: CompanionApp[] = [];
  const given = new Set(names);
  const command = setting ? pickCommand(setting.command, given) : null;
  const captureCommand = setting?.capture
    ? pickCommand(setting.capture.command, given)
    : null;
  if (setting && names.length > 0) {
    if (command === null)
      problems.push(
        `--companion に command のキーのアプリがありません（流すコマンドが1つもありません。キー：${Object.keys(setting.command).join("・")}）`,
      );
    // 印のアプリが --companion にない（ブランチにない）なら止めず、土台のアプリで埋める
    for (const name of new Set([
      ...(command ? commandMarkNames(command) : []),
      ...(captureCommand ? commandMarkNames(captureCommand) : []),
    ])) {
      if (given.has(name)) continue;
      const target = repos.find((r) => r.name === name);
      if (!target)
        problems.push(
          `command（capture.command を含む）の印 {previewUrl:${name}} の名前を知りません`,
        );
      else baseApps.push({ name, path: target.path });
    }
  }
  for (const name of new Set(names)) {
    if (setting && !setting.apps.includes(name)) {
      problems.push(
        `--companion の ${name} は ${child} の companion.apps にありません`,
      );
      continue;
    }
    const target = repos.find((r) => r.name === name);
    if (!target) problems.push(`--companion の名前を知りません：${name}`);
    else apps.push({ name, path: target.path });
  }
  if (problems.length > 0 || !setting || command === null)
    throw new FlowError(
      1,
      `--companion に直すところがあります：${problems.join("、")}`,
    );
  return JSON.stringify({
    command,
    apps,
    ...(baseApps.length > 0 ? { baseApps } : {}),
    ...(setting.capture && captureCommand !== null
      ? {
          capture: {
            command: captureCommand,
            output: setting.capture.output,
          },
        }
      : {}),
  });
}
