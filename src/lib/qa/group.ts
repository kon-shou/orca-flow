import { stat } from "node:fs/promises";
import path from "node:path";
import { parseConfig, type FlowConfig, type QaConfig } from "../../config.ts";
import { FlowError } from "../../types.ts";
import { branchLeftIn } from "../cross-depends.ts";
import type { Runner } from "../exec.ts";
import { listBranches } from "../git.ts";
import {
  chooseGroup,
  readChildBranches,
  type GroupChoice,
  type GroupTarget,
} from "../group-branch.ts";
import {
  loadWorkspace,
  runChildCli,
  WORKSPACE_FILE,
  type Workspace,
  type WorkspaceRepo,
} from "../workspace.ts";
import { isSafeBranchName, originHead } from "./context.ts";

export interface GroupApp {
  name: string;
  /** 実の絶対パス */
  path: string;
  selfField: string;
  branch: string;
  /** origin のそのブランチの先頭 */
  head: string;
}

export interface GroupTask {
  /** ワークスペースのフォルダの実のパス（貸し出しの借り手） */
  dir: string;
  /** 組のアプリの子の qa。selfField は最初の組のアプリのもの */
  qa: QaConfig;
  id: string;
  apps: GroupApp[];
  /** 枝の取り込みの確かめで通した旨の行 */
  notes: string[];
}

export interface GroupQa {
  workspace: Workspace;
  qa: QaConfig;
  /** qa のあるアプリの子 */
  members: { repo: WorkspaceRepo; config: FlowConfig; qa: QaConfig }[];
  /** qa のないアプリの子 */
  bare: { repo: WorkspaceRepo; config: FlowConfig }[];
}

/** 今の場所がワークスペースのフォルダか（git でなくてもよい） */
export async function isWorkspaceFolder(cwd: string): Promise<boolean> {
  try {
    return (await stat(path.join(cwd, WORKSPACE_FILE))).isFile();
  } catch {
    return false;
  }
}

/** 子の config --json の答え。読めなければ FlowError(1) */
async function childConfig(
  runner: Runner,
  env: NodeJS.ProcessEnv,
  repo: WorkspaceRepo,
): Promise<FlowConfig> {
  const result = await runChildCli(runner, env, repo, ["config", "--json"]);
  if (result.code !== 0)
    throw new FlowError(
      1,
      `子 ${repo.name} の設定を読めません（config が終了コード ${result.code}）${result.stderr.trim() ? `：${result.stderr.trim()}` : ""}`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new FlowError(
      1,
      `子 ${repo.name} の config --json の答えを読めません`,
    );
  }
  try {
    return parseConfig(raw);
  } catch (error) {
    throw new FlowError(
      1,
      `子 ${repo.name} の設定を読めません：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** キーの並びによらず同じ値か比べるための文字列 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * ワークスペースの設定と、アプリの子の qa を読む。qa のある子がなければ FlowError(2)。
 * selfField 以外が全部同じでなければ・selfField が重なれば FlowError(1)
 */
export async function readGroupQa(
  runner: Runner,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<GroupQa> {
  const workspace = await loadWorkspace(runner, cwd);
  const members: GroupQa["members"] = [];
  const bare: GroupQa["bare"] = [];
  for (const repo of workspace.repos) {
    if (repo.role !== "app") continue;
    const config = await childConfig(runner, env, repo);
    if (config.qa) members.push({ repo, config, qa: config.qa });
    else bare.push({ repo, config });
  }
  const first = members[0];
  if (!first)
    throw new FlowError(
      2,
      "アプリの子の設定に qa がありません。各アプリの .orca-flow/config.json に qa を書いてください（docs/spec.md の6章）。qa を使うときは、settings の permissions.ask に Bash(orca-flow qa deploy *) があるかも確かめてください（仕様の12章）",
    );
  const rest = (qa: QaConfig) => {
    const { selfField: _self, ...others } = qa;
    return others;
  };
  const base = rest(first.qa) as Record<string, unknown>;
  for (const m of members.slice(1)) {
    const other = rest(m.qa) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(base), ...Object.keys(other)])]
      .filter((k) => stable(base[k]) !== stable(other[k]))
      .sort();
    if (keys.length > 0)
      throw new FlowError(
        1,
        `子 ${m.repo.name} の qa が ${first.repo.name} と違います（selfField 以外は同じにしてください）：${keys.join("・")}`,
      );
  }
  const seen = new Map<string, string>();
  for (const m of members) {
    const other = seen.get(m.qa.selfField);
    if (other !== undefined)
      throw new FlowError(
        1,
        `子 ${other} と ${m.repo.name} の qa.selfField が重なっています（${m.qa.selfField}）。アプリごとに違う欄にしてください`,
      );
    seen.set(m.qa.selfField, m.repo.name);
  }
  return { workspace, qa: first.qa, members, bare };
}

async function onOrigin(
  runner: Runner,
  repo: WorkspaceRepo,
  branch: string,
): Promise<boolean> {
  try {
    await originHead(runner, repo.path, branch);
    return true;
  } catch (error) {
    if (error instanceof FlowError && error.code === 2) return false;
    throw error;
  }
}

/**
 * 組のアプリが共通を枝で取り込んだままか。共通に組と同じ ID・短い名前のブランチがあるとき、
 * アプリの origin の先頭に枝の名前が残っていて、その枝が共通の origin になければ FlowError(2)。
 * 通したものは旨の行で返す。確かめに失敗したら FlowError(1)
 */
async function checkBranchImports(
  runner: Runner,
  env: NodeJS.ProcessEnv,
  workspace: Workspace,
  apps: readonly GroupApp[],
  id: string,
  slug: string,
): Promise<string[]> {
  const notes: string[] = [];
  for (const common of workspace.repos) {
    if (common.role !== "common") continue;
    const config = await childConfig(runner, env, common);
    const own = `${config.branchPrefix}${id}-${slug}`;
    const branches = (await listBranches(runner, common.path)).filter(
      (b) => b === own,
    );
    for (const name of branches) {
      let present: boolean | undefined;
      for (const app of apps) {
        const left = await branchLeftIn(runner, app.path, app.head, name);
        if (left === null)
          throw new FlowError(
            1,
            `${app.name} が ${common.name} を枝 ${name} で取り込んだままかを確かめられません（origin の先頭 ${app.head.slice(0, 12)} が手元にないかもしれません。fetch してやり直してください）`,
          );
        if (left.length === 0) continue;
        present ??= await onOrigin(runner, common, name);
        if (!present)
          throw new FlowError(
            2,
            `${app.name} は ${common.name} を枝 ${name} で取り込んだままで、その枝が origin にありません。${common.name} で枝を push するか、正式な版に上げてから、やり直してください`,
          );
        notes.push(
          `${app.name} は ${common.name} を枝 ${name} で取り込んでいますが、その枝は ${common.name} の origin にあるので通します`,
        );
      }
    }
  }
  return notes;
}

/**
 * 組のアプリの子ごとに、組のブランチを決める（qa のない子も含む）。
 * ID で打った・ブランチ名が外れる・どの子にもなければ FlowError(1)
 * （allowMissing なら、どの子にもないブランチ名でも止めない）
 */
export async function chooseGroupApps(
  runner: Runner,
  env: NodeJS.ProcessEnv,
  cwd: string,
  target: GroupTarget,
  retype: (branch: string) => string,
  options: { allowMissing?: boolean } = {},
): Promise<{ group: GroupQa; choice: GroupChoice }> {
  const group = await readGroupQa(runner, env, cwd);
  const configs = new Map<string, FlowConfig>(
    [...group.members, ...group.bare].map((m) => [m.repo.name, m.config]),
  );
  const children = [];
  for (const repo of group.workspace.repos) {
    const config = configs.get(repo.name);
    if (config) children.push(await readChildBranches(runner, repo, config));
  }
  return { group, choice: chooseGroup(target, children, retype, options) };
}

/** 組のアプリのブランチ。組のブランチがどの子にもなければ undefined */
export function choiceBranches(choice: GroupChoice): string[] | undefined {
  const branches = [...choice.members.values()].flatMap((m) =>
    m.kind === "branch" ? [m.branch] : [],
  );
  return branches.length > 0 ? branches : undefined;
}

/**
 * plan と deploy が共通で確かめる：引数、子の設定、組のアプリ、origin の先頭、枝の取り込み。
 * 組のアプリがなければ FlowError(1)、origin になければ FlowError(2)
 */
export async function resolveGroup(
  runner: Runner,
  env: NodeJS.ProcessEnv,
  cwd: string,
  target: GroupTarget,
  retype: (branch: string) => string,
): Promise<GroupTask> {
  const { group, choice } = await chooseGroupApps(
    runner,
    env,
    cwd,
    target,
    retype,
  );
  const { id } = choice;
  const apps: GroupApp[] = [];
  const candidates: {
    name: string;
    path: string;
    selfField: string;
    branch: string;
  }[] = [];
  for (const m of group.members) {
    const member = choice.members.get(m.repo.name);
    if (member?.kind !== "branch") continue;
    const { branch } = member;
    if (!isSafeBranchName(branch))
      throw new FlowError(
        1,
        `${m.repo.name} の ${id} のブランチ名が使える形ではないので送りません：${JSON.stringify(branch)}`,
      );
    candidates.push({
      name: m.repo.name,
      path: m.repo.path,
      selfField: m.qa.selfField,
      branch,
    });
  }
  for (const b of group.bare) {
    const member = choice.members.get(b.repo.name);
    if (member?.kind === "branch")
      throw new FlowError(
        1,
        `${b.repo.name} に ${id} のブランチ（${member.branch}）がありますが、設定に qa がないので、その変更は QA に載りません。${b.repo.name} の設定に qa を書いてください`,
      );
  }
  if (candidates.length === 0)
    throw new FlowError(
      1,
      `ブランチ ${choice.branch} が、qa のあるアプリのどれにもありません`,
    );
  for (const c of candidates)
    apps.push({ ...c, head: await originHead(runner, c.path, c.branch) });
  const notes = await checkBranchImports(
    runner,
    env,
    group.workspace,
    apps,
    id,
    choice.slug,
  );
  return {
    dir: group.workspace.dir,
    qa: { ...group.qa, selfField: apps[0]!.selfField },
    id,
    apps,
    notes,
  };
}
