import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import { loadFlowConfig } from "./flow-config.ts";
import { activeTasks, gitCommonDir, type ActiveTask } from "./git.ts";
import { taskMergedInto } from "./merged.ts";
import { canonicalPath, samePath } from "./paths.ts";
import { SLUG_PATTERN } from "./slug.ts";
import { readStages } from "./stage-log.ts";
import {
  commonRecordPath,
  escapeId,
  hasIdShape,
  isTaskIdShape,
} from "./task-id.ts";

// 前を待つ印：前のタスクが入る前に始めた後ろのタスクの、待つ先の記録と、前が整ったかの見分け。
// 記録は `〈共通〉/orca-flow/start-after/〈ID〉.json`（作業ツリーの外）

/** 待つ条件。implemented＝実装完了（段の記録に統合待ちの行がある）、merged＝baseBranch に入った */
export type StartAfterWait = "implemented" | "merged";

/** ほかのリポジトリ（ワークスペースの設定の名前と、メインの作業ツリーの実の絶対パス） */
export interface StartAfterRepo {
  name: string;
  path: string;
}

/** 前1つ分 */
export interface StartAfterEntry {
  id: string;
  /** 同じリポジトリなら null */
  repo: StartAfterRepo | null;
  wait: StartAfterWait;
}

export interface StartAfterRecord {
  id: string;
  /** 書いた時刻（ISO） */
  at: string;
  after: StartAfterEntry[];
}

/** `--start-after-json` の要素（ほかのリポジトリ1つ分） */
export interface StartAfterJsonRepo {
  name: string;
  path: string;
  ids: string[];
}

export const startAfterDir = (common: string) =>
  path.join(common, "orca-flow", "start-after");

export const startAfterFile = (common: string, id: string) =>
  commonRecordPath(common, "start-after", id, ".json");

/** 前の見出し（同じリポジトリなら ID、ほかなら 〈名前〉:〈ID〉） */
export const entryLabel = (entry: StartAfterEntry): string =>
  entry.repo === null ? entry.id : `${entry.repo.name}:${entry.id}`;

export const WAIT_LABEL: Record<StartAfterWait, string> = {
  implemented: "実装完了",
  merged: "入る",
};

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** `--start-after` の値（「,」「、」空白で区切った ID）を分けて重なりを除く */
export function splitStartAfter(value: string): string[] {
  return [...new Set(value.split(/[,、\s]+/).filter((d) => d !== ""))];
}

/** `--start-after-json` の値を確かめて返す。形が外れたら FlowError(1) */
export function parseStartAfterJson(text: string): StartAfterJsonRepo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FlowError(1, "--start-after-json が JSON として読めません");
  }
  const problems: string[] = [];
  if (!Array.isArray(raw)) problems.push("並びではありません");
  else if (raw.length === 0) problems.push("並びが空です");
  else {
    const seen = new Set<string>();
    raw.forEach((entry: unknown, i) => {
      const at = `[${i}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        problems.push(`${at} がオブジェクトではありません`);
        return;
      }
      const r = entry as Record<string, unknown>;
      const extra = Object.keys(r).filter(
        (k) => !["name", "path", "ids"].includes(k),
      );
      if (extra.length > 0)
        problems.push(`${at} に知らないキーがあります：${extra.join("・")}`);
      if (typeof r.name !== "string" || !SLUG_PATTERN.test(r.name))
        problems.push(
          `${at}.name が名前の形（英小文字・数字・「-」）ではありません`,
        );
      else if (seen.has(r.name))
        problems.push(`${at}.name が重なっています：${r.name}`);
      else seen.add(r.name);
      if (!isNonEmptyString(r.path) || !path.isAbsolute(r.path))
        problems.push(`${at}.path が絶対パスではありません`);
      if (
        !Array.isArray(r.ids) ||
        r.ids.length === 0 ||
        !r.ids.every((x) => typeof x === "string" && hasIdShape(x))
      )
        problems.push(`${at}.ids が ID の形の並び（1つ以上）ではありません`);
    });
  }
  if (problems.length > 0)
    throw new FlowError(
      1,
      `--start-after-json の形が違います：${problems.map(escapeId).join("、")}`,
    );
  return (raw as StartAfterJsonRepo[]).map((r) => ({
    name: r.name,
    path: r.path,
    ids: [...new Set(r.ids)],
  }));
}

/** 記録の after が正しい形（1つ以上）か */
function isAfterShape(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  return raw.every((e: unknown) => {
    if (typeof e !== "object" || e === null) return false;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string" || !hasIdShape(r.id)) return false;
    if (r.wait !== "implemented" && r.wait !== "merged") return false;
    if (r.repo === null) return true;
    if (typeof r.repo !== "object" || r.repo === undefined) return false;
    const repo = r.repo as Record<string, unknown>;
    return (
      typeof repo.name === "string" &&
      SLUG_PATTERN.test(repo.name) &&
      isNonEmptyString(repo.path) &&
      path.isAbsolute(repo.path)
    );
  });
}

const broken = (common: string, id: string) =>
  new FlowError(
    1,
    `前を待つ印の記録が壊れています：${startAfterFile(common, id)}。直すか消してからもう一度流してください`,
  );

/** 共通ディレクトリを渡して記録を読む。ない・ID の形が違うなら null。壊れていれば FlowError(1) */
export async function readStartAfterAt(
  common: string,
  id: string,
): Promise<StartAfterRecord | null> {
  if (!hasIdShape(id)) return null;
  let text: string;
  try {
    text = await readFile(startAfterFile(common, id), "utf8");
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
  if (typeof raw !== "object" || raw === null) throw broken(common, id);
  const r = raw as Record<string, unknown>;
  if (r.id !== id || typeof r.at !== "string" || !isAfterShape(r.after))
    throw broken(common, id);
  return {
    id,
    at: r.at,
    after: (r.after as StartAfterEntry[]).map((e) => ({
      id: e.id,
      repo: e.repo === null ? null : { name: e.repo.name, path: e.repo.path },
      wait: e.wait,
    })),
  };
}

/** どの作業ツリーからでも記録を読む（readStartAfterAt と同じ） */
export async function readStartAfter(
  runner: Runner,
  cwd: string,
  id: string,
): Promise<StartAfterRecord | null> {
  if (!hasIdShape(id)) return null;
  return readStartAfterAt(await gitCommonDir(runner, cwd), id);
}

/** 共通ディレクトリを渡して記録を書く（一時ファイルと rename）。after が空なら同じ ID の記録を消す */
export async function writeStartAfterAt(
  common: string,
  id: string,
  after: readonly StartAfterEntry[],
  now: Date,
): Promise<void> {
  const file = startAfterFile(common, id);
  if (after.length === 0) {
    await removeStartAfterAt(common, id);
    return;
  }
  const record: StartAfterRecord = {
    id,
    at: now.toISOString(),
    after: after.map((e) => ({ ...e })),
  };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
}

/** 記録を消す。消したら true、もともとなければ false */
export async function removeStartAfterAt(
  common: string,
  id: string,
): Promise<boolean> {
  try {
    await unlink(startAfterFile(common, id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 記録のある ID（並べ替え済み）。ディレクトリがなければ空 */
export async function listStartAfterIds(common: string): Promise<string[]> {
  try {
    return (await readdir(startAfterDir(common)))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .filter(hasIdShape)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * 見直しの1回の中で、リポジトリごとの git の共通ディレクトリと設定を使い回す入れ物。
 * 待ち受けの1回ごとに newStartAfterCache() で作り直す（前の回の答えを持ち越さない）
 */
export interface StartAfterCache {
  commons: Map<string, Promise<string>>;
  configs: Map<string, Promise<FlowConfig>>;
}

export const newStartAfterCache = (): StartAfterCache => ({
  commons: new Map(),
  configs: new Map(),
});

function cachedCommon(
  runner: Runner,
  cache: StartAfterCache,
  repoPath: string,
): Promise<string> {
  const key = canonicalPath(repoPath);
  let found = cache.commons.get(key);
  if (found === undefined) {
    found = gitCommonDir(runner, repoPath);
    cache.commons.set(key, found);
  }
  return found;
}

function cachedConfig(
  runner: Runner,
  cache: StartAfterCache,
  repoPath: string,
): Promise<FlowConfig> {
  const key = canonicalPath(repoPath);
  let found = cache.configs.get(key);
  if (found === undefined) {
    found = loadFlowConfig(runner, repoPath).then((loaded) => {
      if (!loaded.exists)
        throw new Error("orca-flow の設定がありません（init 前）");
      return loaded.config;
    });
    cache.configs.set(key, found);
  }
  return found;
}

/** 前1つの見分け */
export interface StartAfterEntryState {
  entry: StartAfterEntry;
  /** 同じリポジトリなら ID、ほかなら 〈名前〉:〈ID〉 */
  label: string;
  ready: boolean;
  /** 前を読めなかったら true（理由の文の言い方に頼らず見分けるため） */
  unreadable: boolean;
  /** 人に見せる一言（整った・整っていない・読めないの理由） */
  reason: string;
}

export interface StartAfterReadiness {
  /** 前が全部整ったら true。記録が読めない・前が1つでも読めなければ false */
  ready: boolean;
  entries: StartAfterEntryState[];
  /** 記録そのものが読めないときの理由。読めれば null */
  problem: string | null;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** 段の記録で実装完了（統合待ちの行が一度でもある）と見なす状態 */
const IMPLEMENTED_STATES = ["integrate-wait", "integrated"];

async function entryState(
  runner: Runner,
  root: string,
  config: Pick<FlowConfig, "baseBranch" | "integratorName">,
  entry: StartAfterEntry,
  cache: StartAfterCache,
): Promise<StartAfterEntryState> {
  const label = entryLabel(entry);
  const where = entry.repo === null ? root : entry.repo.path;
  try {
    if (entry.wait === "implemented") {
      const common = await cachedCommon(runner, cache, where);
      const stages = await readStages(common, entry.id);
      if (stages === null)
        return {
          entry,
          label,
          ready: false,
          unreadable: false,
          reason: "段の記録がまだありません",
        };
      const done = stages.entries.some((e) =>
        IMPLEMENTED_STATES.includes(e.state),
      );
      return {
        entry,
        label,
        ready: done,
        unreadable: false,
        reason: done ? "統合待ちになりました" : "まだ統合待ちになっていません",
      };
    }
    const repoConfig =
      entry.repo === null ? config : await cachedConfig(runner, cache, where);
    const merged = await taskMergedInto(
      runner,
      where,
      repoConfig,
      entry.id,
      repoConfig.baseBranch,
    );
    return {
      entry,
      label,
      ready: merged.merged,
      unreadable: false,
      reason: merged.merged
        ? `${repoConfig.baseBranch} に入りました`
        : `まだ ${repoConfig.baseBranch} に入っていません`,
    };
  } catch (error) {
    return {
      entry,
      label,
      ready: false,
      unreadable: true,
      reason: `読めません（${messageOf(error)}）`,
    };
  }
}

/** 印が壊れたか、前が1つでも読めないか。読めない前は待っても整わない */
export const startAfterUnreadable = (readiness: StartAfterReadiness): boolean =>
  readiness.problem !== null || readiness.entries.some((e) => e.unreadable);

/**
 * 記録の前ごとに整ったかを見る。root は記録のあるリポジトリのメインの作業ツリー、config はその設定。
 * 読めない前は整っていないとし、理由を返す（投げない）
 */
export async function checkStartAfter(
  runner: Runner,
  root: string,
  config: Pick<FlowConfig, "baseBranch" | "integratorName">,
  record: StartAfterRecord,
  cache: StartAfterCache = newStartAfterCache(),
): Promise<StartAfterReadiness> {
  const entries: StartAfterEntryState[] = [];
  for (const entry of record.after)
    entries.push(await entryState(runner, root, config, entry, cache));
  return {
    ready: entries.length > 0 && entries.every((e) => e.ready),
    entries,
    problem: null,
  };
}

/**
 * ID の印を読んで整ったかを見る。印がなければ null。印が壊れていれば ready: false と problem に理由（投げない）。
 * common は root の git の共通ディレクトリ
 */
export async function startAfterReadiness(
  runner: Runner,
  root: string,
  common: string,
  config: Pick<FlowConfig, "baseBranch" | "integratorName">,
  id: string,
  cache: StartAfterCache = newStartAfterCache(),
): Promise<StartAfterReadiness | null> {
  let record: StartAfterRecord | null;
  try {
    record = await readStartAfterAt(common, id);
  } catch (error) {
    return { ready: false, entries: [], problem: messageOf(error) };
  }
  if (record === null) return null;
  return checkStartAfter(runner, root, config, record, cache);
}

/** new が受け取った前の並び */
export interface StartAfterRequest {
  /** 自分の ID */
  id: string;
  /** 乗せた先の ID（なければ null） */
  stackOn: string | null;
  /** 同じリポジトリの前の ID */
  same: readonly string[];
  /** ほかのリポジトリの前 */
  others: readonly StartAfterJsonRepo[];
}

/**
 * new の確かめ。前ごとに、形・自分でない・作業中か統合済みかを見て、待つ条件を決めた並びを返す。
 * 外れは全部まとめて FlowError(1)。待つ条件は、乗せた先とほかのリポジトリは実装完了、ほかの同じリポジトリは入った
 */
export async function resolveStartAfter(
  runner: Runner,
  root: string,
  config: FlowConfig,
  active: readonly ActiveTask[],
  request: StartAfterRequest,
): Promise<StartAfterEntry[]> {
  const problems: string[] = [];
  const entries: StartAfterEntry[] = [];
  for (const id of request.same) {
    if (!isTaskIdShape(id, config.idPrefix)) {
      problems.push(
        `--start-after の ID の形が違います：${escapeId(id)}（${config.idPrefix} と数字の形で書いてください）`,
      );
      continue;
    }
    if (id === request.id) {
      problems.push(`--start-after に自分の ID（${id}）は渡せません`);
      continue;
    }
    if (
      !active.some((t) => t.id === id) &&
      !(await mergedQuietly(runner, root, config, id))
    ) {
      problems.push(
        `${id} はこのリポジトリの作業中のタスクでも統合済みのタスクでもありません`,
      );
      continue;
    }
    entries.push({
      id,
      repo: null,
      wait: id === request.stackOn ? "implemented" : "merged",
    });
  }
  if (request.others.length > 0) {
    const mine = await gitCommonDir(runner, root);
    for (const repo of request.others)
      entries.push(...(await resolveOtherRepo(runner, mine, repo, problems)));
  }
  if (problems.length > 0) throw new FlowError(1, problems.join("\n"));
  return entries;
}

async function mergedQuietly(
  runner: Runner,
  root: string,
  config: Pick<FlowConfig, "baseBranch" | "integratorName">,
  id: string,
): Promise<boolean> {
  try {
    return (await taskMergedInto(runner, root, config, id, config.baseBranch))
      .merged;
  } catch {
    return false;
  }
}

async function resolveOtherRepo(
  runner: Runner,
  mine: string,
  repo: StartAfterJsonRepo,
  problems: string[],
): Promise<StartAfterEntry[]> {
  const head = `--start-after-json の ${repo.name}（${canonicalPath(repo.path)}）`;
  let common: string;
  try {
    common = await gitCommonDir(runner, repo.path);
  } catch {
    problems.push(`${head} が git のリポジトリとして読めません`);
    return [];
  }
  if (samePath(common, mine)) {
    problems.push(
      `${head} は自分と同じリポジトリです。同じリポジトリの前は --start-after で渡してください`,
    );
    return [];
  }
  let config: FlowConfig;
  try {
    const loaded = await loadFlowConfig(runner, repo.path);
    if (!loaded.exists) {
      problems.push(`${head} に orca-flow の設定がありません（init 前）`);
      return [];
    }
    config = loaded.config;
  } catch (error) {
    problems.push(`${head} の設定が読めません：${messageOf(error)}`);
    return [];
  }
  let active: ActiveTask[];
  try {
    active = await activeTasks(runner, repo.path, config);
  } catch (error) {
    problems.push(`${head} の作業中のタスクが読めません：${messageOf(error)}`);
    return [];
  }
  const entries: StartAfterEntry[] = [];
  for (const id of repo.ids) {
    const label = `${repo.name}:${escapeId(id)}`;
    if (!isTaskIdShape(id, config.idPrefix)) {
      problems.push(
        `${label} は ${repo.name} の ID の形（${config.idPrefix} と数字）ではありません`,
      );
      continue;
    }
    if (
      !active.some((t) => t.id === id) &&
      !(await mergedQuietly(runner, repo.path, config, id))
    ) {
      problems.push(
        `${label} は ${repo.name} の作業中のタスクでも統合済みのタスクでもありません`,
      );
      continue;
    }
    entries.push({
      id,
      repo: { name: repo.name, path: repo.path },
      wait: "implemented",
    });
  }
  return entries;
}

/**
 * 親の `workspace 〈名前〉 new` の `--start-after`（`〈名前〉:〈ID〉,…`）を、子の new に渡す引数にする。
 * 子と同じ名前の ID は子の `--start-after`、ほかは実のパスつきの `--start-after-json`。
 * 外れは全部まとめて FlowError(1)
 */
export function resolveWorkspaceStartAfter(
  repos: readonly { name: string; path: string }[],
  child: string,
  value: string,
): { same: string[]; json: StartAfterJsonRepo[] } {
  const problems: string[] = [];
  const byName = new Map(repos.map((r) => [r.name, r]));
  const same: string[] = [];
  const json: StartAfterJsonRepo[] = [];
  const items = value
    .split(/[,、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (items.length === 0)
    problems.push("--start-after に 〈名前〉:〈ID〉 を書いてください");
  for (const item of items) {
    const at = item.indexOf(":");
    const name = at < 0 ? "" : item.slice(0, at);
    const id = at < 0 ? "" : item.slice(at + 1);
    if (!SLUG_PATTERN.test(name) || !hasIdShape(id)) {
      problems.push(
        `--start-after は 〈名前〉:〈ID〉 の形で書いてください：${escapeId(item)}`,
      );
      continue;
    }
    const repo = byName.get(name);
    if (!repo) {
      problems.push(`--start-after の名前を知りません：${name}`);
      continue;
    }
    if (name === child) {
      if (!same.includes(id)) same.push(id);
      continue;
    }
    const found = json.find((r) => r.name === name);
    if (found === undefined) json.push({ name, path: repo.path, ids: [id] });
    else if (!found.ids.includes(id)) found.ids.push(id);
  }
  if (problems.length > 0) throw new FlowError(1, problems.join("\n"));
  return { same, json };
}
