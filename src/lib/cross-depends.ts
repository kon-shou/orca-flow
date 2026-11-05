import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type FlowConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import { BRANCH_PACKAGE_FILES, lineHasBranch } from "./branch-push.ts";
import type { Runner } from "./exec.ts";
import { readPushRecord } from "./finish.ts";
import { gitCommonDir } from "./git.ts";
import { taskMergedInto } from "./merged.ts";
import { canonicalPath, samePath } from "./paths.ts";
import { SLUG_PATTERN } from "./slug.ts";
import { commonRecordPath, hasIdShape, isTaskIdShape } from "./task-id.ts";

// またぐ依存（ほかのリポジトリのタスクへの依存）の記録と、merge の確かめ（integrate は記録があれば止まる）。
// 記録は `〈共通〉/orca-flow/cross-depends/〈ID〉.json`（作業ツリーの外）。今の依存の記録（depends）とは別のファイル

/** 依存先のリポジトリ1つ分 */
export interface CrossDependsRepo {
  /** 設定の名前（slug の形。重ならない） */
  name: string;
  /** 依存先のメインの作業ツリーの実の絶対パス */
  path: string;
  /** 共通のパッケージ名 */
  package: string;
  /** 上げる版（枝で取り込む（branch がある）なら省ける） */
  version?: string;
  /** 枝で取り込む共通のタスクの枝の名前 */
  branch?: string;
  /** `{branch}` を枝の名前に置き換えた取り込み方のコマンド（branch があるとき要る） */
  branchCommand?: string;
  /** 正式な版に戻すときの取り込み方のコマンド */
  bumpCommand?: string;
  /** 依存先の ID の並び（1つ以上） */
  ids: string[];
}

export interface CrossDepends {
  id: string;
  /** 書いた時刻（ISO） */
  at: string;
  repos: CrossDependsRepo[];
}

/** 枝の名前の形（6章の baseBranch と同じ。コマンドに埋めるため、この形だけ受ける） */
export function isBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (/^[-/.]/.test(value)) return false;
  if (/\.\.|\/\/|\/\./.test(value)) return false;
  if (value.split("/").some((part) => part.endsWith(".lock"))) return false;
  if (/[/.]$/.test(value)) return false;
  return true;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** repos の並びの形の問題の文の並び（空なら正しい） */
function repoProblems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["repos が並びではありません"];
  if (raw.length === 0) return ["repos が空です"];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry: unknown, i) => {
    const at = `repos[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`${at} がオブジェクトではありません`);
      return;
    }
    const r = entry as Record<string, unknown>;
    if (typeof r.name !== "string" || !SLUG_PATTERN.test(r.name))
      problems.push(
        `${at}.name が名前の形（英小文字・数字・「-」）ではありません`,
      );
    else if (seen.has(r.name))
      problems.push(`${at}.name が重なっています：${r.name}`);
    else seen.add(r.name);
    if (!isNonEmptyString(r.path) || !path.isAbsolute(r.path))
      problems.push(`${at}.path が絶対パスではありません`);
    if (!isNonEmptyString(r.package)) problems.push(`${at}.package が空です`);
    const hasBranch = r.branch !== undefined;
    if (hasBranch) {
      if (typeof r.branch !== "string" || !isBranchName(r.branch))
        problems.push(`${at}.branch が枝の名前の形ではありません`);
      if (!isNonEmptyString(r.branchCommand))
        problems.push(`${at}.branchCommand が空か、ありません`);
      if (!isNonEmptyString(r.bumpCommand))
        problems.push(
          `${at}.bumpCommand が空か、ありません（branch があるとき要る）`,
        );
      if (r.version !== undefined && !isNonEmptyString(r.version))
        problems.push(`${at}.version が空です`);
    } else {
      if (!isNonEmptyString(r.version))
        problems.push(`${at}.version が空です（branch もありません）`);
      if (r.branchCommand !== undefined)
        problems.push(`${at}.branchCommand は branch があるときだけです`);
    }
    if (r.bumpCommand !== undefined && !isNonEmptyString(r.bumpCommand))
      problems.push(`${at}.bumpCommand が空です`);
    if (
      !Array.isArray(r.ids) ||
      r.ids.length === 0 ||
      !r.ids.every((x) => typeof x === "string" && hasIdShape(x))
    )
      problems.push(`${at}.ids が ID の形の並び（1つ以上）ではありません`);
  });
  return problems;
}

/** 知っているキーだけを決まった順で写す（ids は重なりを除く） */
function normalizeRepo(r: CrossDependsRepo): CrossDependsRepo {
  return {
    name: r.name,
    path: r.path,
    package: r.package,
    ...(r.version !== undefined ? { version: r.version } : {}),
    ...(r.branch !== undefined ? { branch: r.branch } : {}),
    ...(r.branchCommand !== undefined
      ? { branchCommand: r.branchCommand }
      : {}),
    ...(r.bumpCommand !== undefined ? { bumpCommand: r.bumpCommand } : {}),
    ids: [...new Set(r.ids)],
  };
}

/** `--cross-depends-json` の値（repos の並びの JSON）を確かめて返す。形が外れたら FlowError(1) */
export function parseCrossDependsJson(text: string): CrossDependsRepo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FlowError(1, "--cross-depends-json が JSON として読めません");
  }
  const problems = repoProblems(raw);
  if (problems.length > 0)
    throw new FlowError(
      1,
      `--cross-depends-json の形が違います：${problems.join("、")}`,
    );
  return (raw as CrossDependsRepo[]).map(normalizeRepo);
}

const file = (common: string, id: string) =>
  commonRecordPath(common, "cross-depends", id, ".json");

const broken = (id: string) =>
  new FlowError(
    1,
    `またぐ依存の記録が壊れています：cross-depends/${id}.json。直すか消してからもう一度流してください`,
  );

/** `〈名前〉:〈ID〉` の形か。そうなら分けて返し、違えば null（merge の --drop-depend で今の ID と見分ける） */
export function parseCrossDependsRef(
  s: string,
): { name: string; id: string } | null {
  const i = s.indexOf(":");
  if (i < 0) return null;
  const name = s.slice(0, i);
  const id = s.slice(i + 1);
  if (!SLUG_PATTERN.test(name) || !hasIdShape(id)) return null;
  return { name, id };
}

/** 記録を読む。ない（ENOENT・ID の形が違う）なら null、壊れていれば FlowError(1) */
export async function readCrossDepends(
  runner: Runner,
  root: string,
  id: string,
): Promise<CrossDepends | null> {
  if (!hasIdShape(id)) return null;
  const common = await gitCommonDir(runner, root);
  let text: string;
  try {
    text = await readFile(file(common, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw broken(id);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw broken(id);
  }
  if (typeof raw !== "object" || raw === null) throw broken(id);
  const r = raw as Record<string, unknown>;
  if (
    r.id !== id ||
    typeof r.at !== "string" ||
    repoProblems(r.repos).length > 0
  )
    throw broken(id);
  return {
    id,
    at: r.at,
    repos: (r.repos as CrossDependsRepo[]).map(normalizeRepo),
  };
}

/** 共通ディレクトリを渡して記録を書く（一時ファイルと rename）。repos が空なら記録を消す */
export async function writeCrossDependsAt(
  common: string,
  id: string,
  repos: readonly CrossDependsRepo[],
  now: Date,
): Promise<void> {
  const target = file(common, id);
  if (repos.length === 0) {
    await rm(target, { force: true });
    return;
  }
  const record: CrossDepends = {
    id,
    at: now.toISOString(),
    repos: repos.map((r) => ({ ...r })),
  };
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, target);
}

/** 記録を書く。repos が空なら記録を消す */
export async function writeCrossDepends(
  runner: Runner,
  root: string,
  id: string,
  repos: readonly CrossDependsRepo[],
  now: Date = new Date(),
): Promise<void> {
  await writeCrossDependsAt(await gitCommonDir(runner, root), id, repos, now);
}

/** 記録を消す（なくてもよい） */
export async function removeCrossDepends(
  runner: Runner,
  root: string,
  id: string,
): Promise<void> {
  await writeCrossDependsAt(
    await gitCommonDir(runner, root),
    id,
    [],
    new Date(),
  );
}

/**
 * 記録から `〈名前〉:〈ID〉` を外し、残りの記録を返す（残りがなければ null）。
 * 最後の ID が外れたリポジトリは消え、repos が空なら記録ごと消す。記録にない ref は何もしない
 */
export async function dropCrossDepends(
  runner: Runner,
  root: string,
  id: string,
  refs: readonly string[],
  now: Date = new Date(),
): Promise<CrossDepends | null> {
  const current = await readCrossDepends(runner, root, id);
  if (current === null) return null;
  const parsed = refs.flatMap((r) => parseCrossDependsRef(r) ?? []);
  let changed = false;
  const repos: CrossDependsRepo[] = [];
  for (const repo of current.repos) {
    const ids = repo.ids.filter(
      (x) => !parsed.some((p) => p.name === repo.name && p.id === x),
    );
    if (ids.length !== repo.ids.length) changed = true;
    if (ids.length > 0) repos.push({ ...repo, ids });
  }
  if (!changed) return current;
  await writeCrossDepends(runner, root, id, repos, now);
  return repos.length === 0 ? null : { id, at: now.toISOString(), repos };
}

/** 依存先がメインの作業ツリーの一番上か。そうでなければ理由 */
async function locationProblem(
  runner: Runner,
  root: string,
  repo: CrossDependsRepo,
): Promise<string | null> {
  try {
    if (!(await stat(repo.path)).isDirectory())
      return "ディレクトリではありません";
  } catch {
    return "パスがありません";
  }
  const out = await runner(
    "git",
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
    ],
    { cwd: repo.path },
  );
  if (out.code !== 0) return "git のリポジトリではありません";
  const [top, gitDir, common] = out.stdout.trim().split(/\r?\n/);
  if (!top || !gitDir || !common) return "git のリポジトリではありません";
  if (!samePath(gitDir, common) || !samePath(top, repo.path))
    return "git のメインの作業ツリーの一番上ではありません";
  const mine = await gitCommonDir(runner, root);
  if (samePath(mine, common)) return "自分と同じリポジトリです";
  return null;
}

/** パッケージ名に使う文字 */
const NAME_CHAR = /[A-Za-z0-9\-_./@]/;

/** パッケージ名が、前後にパッケージ名の文字が続かない形で行にあるか */
function hasPackageName(line: string, pkg: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(pkg, from);
    if (at < 0) return false;
    const before = line[at - 1] ?? "";
    const after = line[at + pkg.length] ?? "";
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true;
    from = at + 1;
  }
}

/** パッケージ名の前後がパッケージ名の文字なら当てない。版の前後が数字か `.` でも当てない */
function lineHasBump(line: string, pkg: string, version: string): boolean {
  if (!hasPackageName(line, pkg)) return false;
  let from = 0;
  for (;;) {
    const at = line.indexOf(version, from);
    if (at < 0) return false;
    const before = line[at - 1] ?? "";
    const after = line[at + version.length] ?? "";
    if (!/[0-9.]/.test(before) && !/[0-9.]/.test(after)) return true;
    from = at + 1;
  }
}

const DEFINITION_FILES = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
];

/** タスクのブランチの先頭に版上げがあるか（作業ツリーは読まない） */
async function hasBump(
  runner: Runner,
  root: string,
  branch: string,
  pkg: string,
  version: string,
): Promise<boolean> {
  if (branch === "" || branch.startsWith("-")) return false;
  const result = await runner(
    "git",
    [
      "grep",
      "-h",
      "-I",
      "-F",
      "-e",
      pkg,
      branch,
      "--",
      ...DEFINITION_FILES.map((f) => `:(glob)**/${f}`),
    ],
    { cwd: root },
  );
  if (result.code !== 0) return false;
  return result.stdout
    .split(/\r?\n/)
    .some((line) => lineHasBump(line, pkg, version));
}

/** タスクのブランチの先頭のパッケージの定義とロックファイルに、枝の名前が残っているファイル（なければ空）。git grep が見つからない（1）以外で失敗したら null */
async function branchLeftIn(
  runner: Runner,
  root: string,
  taskBranch: string,
  name: string,
): Promise<string[] | null> {
  if (taskBranch === "" || taskBranch.startsWith("-")) return [];
  const result = await runner(
    "git",
    [
      "grep",
      "-I",
      "-F",
      "-e",
      name,
      taskBranch,
      "--",
      ...BRANCH_PACKAGE_FILES.map((f) => `:(glob)**/${f}`),
    ],
    { cwd: root },
  );
  if (result.code === 1) return [];
  if (result.code !== 0) return null;
  const files = new Set<string>();
  const prefix = `${taskBranch}:`;
  for (const raw of result.stdout.split(/\r?\n/)) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    const colon = rest.indexOf(":");
    if (colon < 0) continue;
    if (lineHasBranch(rest.slice(colon + 1), name))
      files.add(rest.slice(0, colon));
  }
  return [...files];
}

/**
 * 依存先が PR でマージされていない外れの文。基本の文のあとに、場合ごとの次の手を添える：
 * (i) baseBranch に integrate の件名の行がある（PR の道には戻せない。--drop-depend）、
 * (ii) push の記録に PR があってマージのコミットがない、
 * (iii) 記録にマージのコミットがあるが baseBranch の祖先でない、
 * (iv) 記録に PR がない、(v) 記録がない（基本の文だけ）
 */
async function notMergedByPr(
  runner: Runner,
  repo: CrossDependsRepo,
  config: FlowConfig,
  dep: string,
): Promise<string> {
  const base = `${repo.name}:${dep} が ${repo.name} で PR でマージされていません`;
  // 件名の行は by で見る（後始末と同時に走ると、push の記録で merged が true になることがあるため）
  const again = await taskMergedInto(
    runner,
    repo.path,
    config,
    dep,
    config.baseBranch,
  );
  if (again.merged && again.by === "subject")
    return `${base}（${config.baseBranch} には integrate の件名の行があるが、integrate で入れたものは数えない決まりです。PR の道には戻せないので、${config.baseBranch} が GitHub に入ったと人が確かめたら --drop-depend ${repo.name}:${dep} で記録から外せます）`;
  const record = await readPushRecord(runner, repo.path, dep);
  if (record === null) return base;
  if (typeof record.mergeCommit === "string" && record.mergeCommit !== "")
    return `${base}。記録のマージのコミット（${record.mergeCommit.slice(0, 7)}）が ${repo.name} の ${config.baseBranch} にありません。${repo.name} の手元の ${config.baseBranch} を origin に合わせてください`;
  if (record.pr)
    return `${base}。PR がまだならマージし、GitHub でマージ済みなら ${repo.name} で /orca-flow:push ${dep} で後始末を済ませてください`;
  return `${base}。${repo.name} で /orca-flow:push ${dep} で PR にし、マージしてください`;
}

/**
 * merge の確かめ（merge だけが呼ぶ）。記録の各リポジトリで、場所が読めるか・ID が依存先の idPrefix の形か・
 * 依存先の baseBranch に PR でマージされて入ったか（件名の行は数えない）・版上げがタスクのブランチにあるかを見て、外れを全部返す。
 * 記録がなければ空。記録が壊れていれば FlowError(1)
 */
export async function checkCrossDepends(
  runner: Runner,
  root: string,
  branch: string,
  id: string,
): Promise<string[]> {
  const record = await readCrossDepends(runner, root, id);
  if (record === null) return [];
  const lines: string[] = [];
  for (const repo of record.repos) {
    const problem = await locationProblem(runner, root, repo);
    if (problem !== null) {
      lines.push(
        `${repo.name} の場所が読めません（${canonicalPath(repo.path)}）：${problem}`,
      );
      continue;
    }
    let loaded;
    try {
      loaded = await loadConfig(repo.path);
    } catch (error) {
      lines.push(
        `${repo.name} の設定が読めません：${error instanceof FlowError ? error.message : String(error)}`,
      );
      continue;
    }
    if (!loaded.exists) {
      lines.push(
        `${repo.name} の場所が読めません：このリポジトリは orca-flow の設定がありません（init 前）`,
      );
      continue;
    }
    const config = loaded.config;
    for (const dep of repo.ids) {
      if (!isTaskIdShape(dep, config.idPrefix)) {
        lines.push(
          `${repo.name}:${dep} は ${repo.name} の ID の形（${config.idPrefix} と数字）ではありません`,
        );
        continue;
      }
      try {
        // PR でマージされたときだけ入ったとみなす（件名の行は数えない）
        const merged = await taskMergedInto(
          runner,
          repo.path,
          config,
          dep,
          config.baseBranch,
          { countSubject: false },
        );
        if (!merged.merged)
          lines.push(await notMergedByPr(runner, repo, config, dep));
      } catch (error) {
        lines.push(
          `${repo.name}:${dep} が入ったかを確かめられません：${error instanceof FlowError ? error.message : String(error)}`,
        );
      }
    }
    if (typeof repo.branch === "string") {
      const left = await branchLeftIn(runner, root, branch, repo.branch);
      if (left === null)
        lines.push(
          `${repo.name} の枝 ${repo.branch} が残っていないかを確かめられません`,
        );
      else if (left.length > 0)
        lines.push(
          `${repo.name} を枝 ${repo.branch} で取り込んだままです（${left.join("・")}）。正式な版に戻してください${repo.bumpCommand ? `（${repo.bumpCommand}）` : ""}`,
        );
    } else if (
      !(await hasBump(runner, root, branch, repo.package, repo.version ?? ""))
    )
      lines.push(
        `${repo.name} の版上げ（${repo.package} を ${repo.version}）がタスクのブランチにありません`,
      );
  }
  return lines;
}

/** ワークスペースの設定の読み出し（loadWorkspace）が返すリポジトリのうち、親の確かめに要る欄 */
export interface WorkspaceRepoLike {
  name: string;
  /** 実の絶対パス */
  path: string;
  role: "common" | "app";
  /** 共通のときのパッケージ名 */
  package?: string;
  /** 共通のときの、正式な版に戻す取り込み方のコマンド */
  bumpCommand?: string;
  /** 共通のときの、枝の取り込み方のコマンド（`{branch}` を含む）。なければ枝では取り込めない */
  branchCommand?: string;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 親の `workspace 〈名前〉 new` の確かめ。`--cross-depends`（`〈名前〉:〈ID〉,…`）と `--bumps`（`〈名前〉=〈版〉,…`）を、
 * 子の new に渡す `--cross-depends-json` の値にする。どちらも空なら null（渡さない）。
 * 外れは全部まとめて FlowError(1)
 */
export function resolveCrossDependsArgs(
  repos: readonly WorkspaceRepoLike[],
  child: string,
  crossDepends: string | undefined,
  bumps: string | undefined,
  branches?: string,
): string | null {
  const depItems = splitList(crossDepends);
  const bumpItems = splitList(bumps);
  const branchItems = splitList(branches);
  if (
    depItems.length === 0 &&
    bumpItems.length === 0 &&
    branchItems.length === 0
  )
    return null;
  const problems: string[] = [];
  const byName = new Map(repos.map((r) => [r.name, r]));
  const me = byName.get(child);
  if (!me) problems.push(`知らない名前です：${child}`);
  else if (me.role !== "app")
    problems.push(
      `${child} は共通です。またぐ依存はアプリの子の new にだけ付けられます`,
    );

  const idsByName = new Map<string, string[]>();
  for (const item of depItems) {
    const ref = parseCrossDependsRef(item);
    if (!ref) {
      problems.push(
        `--cross-depends は 〈名前〉:〈ID〉 の形で書いてください：${item}`,
      );
      continue;
    }
    const target = byName.get(ref.name);
    if (!target) {
      problems.push(`--cross-depends の名前を知りません：${ref.name}`);
      continue;
    }
    if (target.role !== "common") {
      problems.push(
        `--cross-depends の ${ref.name} は共通ではありません（依存先は共通だけ）`,
      );
      continue;
    }
    const ids = idsByName.get(ref.name) ?? [];
    if (!ids.includes(ref.id)) ids.push(ref.id);
    idsByName.set(ref.name, ids);
  }

  const versions = new Map<string, string[]>();
  for (const item of bumpItems) {
    const eq = item.indexOf("=");
    const name = eq < 0 ? "" : item.slice(0, eq).trim();
    const version = eq < 0 ? "" : item.slice(eq + 1).trim();
    if (name === "" || version === "") {
      problems.push(`--bumps は 〈名前〉=〈版〉 の形で書いてください：${item}`);
      continue;
    }
    versions.set(name, [...(versions.get(name) ?? []), version]);
  }
  const branchOf = new Map<string, string[]>();
  for (const item of branchItems) {
    const eq = item.indexOf("=");
    const name = eq < 0 ? "" : item.slice(0, eq).trim();
    const branch = eq < 0 ? "" : item.slice(eq + 1).trim();
    if (name === "" || branch === "") {
      problems.push(
        `--branches は 〈名前〉=〈枝〉 の形で書いてください：${item}`,
      );
      continue;
    }
    if (!isBranchName(branch)) {
      problems.push(
        `--branches の枝の名前の形が違います（英数字・「.」・「_」・「-」・「/」だけで、「-」「/」「.」で始まらず、「..」「//」「/.」を含まず、「/」「.」で終わらない形）：${name}`,
      );
      continue;
    }
    branchOf.set(name, [...(branchOf.get(name) ?? []), branch]);
  }
  for (const name of idsByName.keys()) {
    const found = versions.get(name) ?? [];
    const branchFound = branchOf.get(name) ?? [];
    if (found.length > 0 && branchFound.length > 0)
      problems.push(
        `${name} に --bumps と --branches の両方が書かれています（名前ごとにどちらか1つ）`,
      );
    else if (found.length === 0 && branchFound.length === 0)
      problems.push(
        `${name} の版がありません（--bumps ${name}=〈版〉。枝なら --branches ${name}=〈枝〉）`,
      );
    else if (found.length > 1)
      problems.push(`${name} の版が複数あります（--bumps は名前ごとに1つ）`);
    else if (branchFound.length > 1)
      problems.push(`${name} の枝が複数あります（--branches は名前ごとに1つ）`);
  }
  for (const name of versions.keys())
    if (!idsByName.has(name))
      problems.push(
        `--bumps の ${name} に対応する依存がありません（--cross-depends に ${name}:〈ID〉 がありません）`,
      );
  for (const name of branchOf.keys()) {
    if (!idsByName.has(name))
      problems.push(
        `--branches の ${name} に対応する依存がありません（--cross-depends に ${name}:〈ID〉 がありません）`,
      );
    else if (!isNonEmptyString(byName.get(name)?.branchCommand))
      problems.push(
        `${name} の設定に branchCommand がありません（枝では取り込めません。--bumps で版を渡してください）`,
      );
  }

  if (problems.length > 0) throw new FlowError(1, problems.join("\n"));

  const out: CrossDependsRepo[] = [];
  for (const [name, ids] of idsByName) {
    const target = byName.get(name)!;
    if (!isNonEmptyString(target.package)) {
      problems.push(`${name} のパッケージ名が設定にありません`);
      continue;
    }
    const branch = branchOf.get(name)?.[0];
    if (branch !== undefined) {
      if (!isNonEmptyString(target.bumpCommand)) {
        problems.push(`${name} の bumpCommand が設定にありません`);
        continue;
      }
      out.push({
        name,
        path: target.path,
        package: target.package,
        branch,
        branchCommand: target.branchCommand!.split("{branch}").join(branch),
        bumpCommand: target.bumpCommand,
        ids,
      });
      continue;
    }
    out.push({
      name,
      path: target.path,
      package: target.package,
      version: versions.get(name)![0]!,
      ids,
    });
  }
  if (problems.length > 0) throw new FlowError(1, problems.join("\n"));
  return JSON.stringify(out);
}
