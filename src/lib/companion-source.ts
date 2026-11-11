import type { FlowConfig } from "../config.ts";
import type { CompanionApp } from "./companion.ts";
import type { Runner } from "./exec.ts";
import { loadFlowConfig } from "./flow-config.ts";
import { activeTasks, gitCommonDir } from "./git.ts";
import { taskMergedInto } from "./merged.ts";
import { canonicalPath, samePath } from "./paths.ts";
import { readStartAfterAt } from "./start-after.ts";

// 土台のアプリ（印に出るがブランチにないアプリ）の出どころ：E2E のタスクの前を待つ印を近い順にたどり、
// そのアプリのリポジトリの前を探す。親のページは CLI から読めないので、実のパスを持つ印だけを使う

/** 土台のアプリの出どころ */
export type BaseAppSource =
  /** 依存元のタスク（アプリのリポジトリの作業中のタスク）のプレビュー */
  | { kind: "task"; id: string }
  /** アプリの baseBranch の先頭で立てた土台のアプリ */
  | { kind: "baseBranch"; branch: string }
  | { kind: "undecided"; reason: string };

export interface BaseAppSourceEntry {
  app: CompanionApp;
  source: BaseAppSource;
}

/** たどる前1つ（repoPath はそのリポジトリのメインの作業ツリー） */
interface Node {
  repoPath: string;
  common: string;
  id: string;
}

const keyOf = (n: Pick<Node, "common" | "id">) =>
  `${canonicalPath(n.common)}\0${n.id}`;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

class Tracer {
  readonly runner: Runner;
  readonly commons = new Map<string, Promise<string>>();

  constructor(runner: Runner) {
    this.runner = runner;
  }

  common(repoPath: string): Promise<string> {
    const key = canonicalPath(repoPath);
    let found = this.commons.get(key);
    if (found === undefined) {
      found = gitCommonDir(this.runner, repoPath);
      this.commons.set(key, found);
    }
    return found;
  }

  /** 前を待つ印の前の並び。印がなければ空。壊れていれば投げる */
  async parents(node: Node): Promise<Node[]> {
    const record = await readStartAfterAt(node.common, node.id);
    if (record === null) return [];
    const out: Node[] = [];
    for (const entry of record.after) {
      const repoPath = entry.repo === null ? node.repoPath : entry.repo.path;
      out.push({ repoPath, common: await this.common(repoPath), id: entry.id });
    }
    return out;
  }

  /** node から前をたどって届く前の鍵（node 自身は含まない） */
  async ancestors(node: Node): Promise<Set<string>> {
    const seen = new Set<string>();
    let level = [node];
    while (level.length > 0) {
      const next: Node[] = [];
      for (const n of level)
        for (const p of await this.parents(n)) {
          const key = keyOf(p);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(p);
        }
      level = next;
    }
    return seen;
  }
}

/** 近い順にたどって、app のリポジトリの前が初めて出る段の前の並び（重なりなし）。なければ空 */
async function nearestAppNodes(
  tracer: Tracer,
  start: Node,
  appCommon: string,
): Promise<Node[]> {
  const seen = new Set([keyOf(start)]);
  let level = [start];
  while (level.length > 0) {
    const next: Node[] = [];
    for (const n of level)
      for (const p of await tracer.parents(n)) {
        const key = keyOf(p);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(p);
      }
    const hits = next.filter((n) => samePath(n.common, appCommon));
    if (hits.length > 0) return hits;
    level = next;
  }
  return [];
}

/** 同じ近さの前から、ほかの全部を前にたどった先に持つもの（いちばん新しい前）を選ぶ。なければ null */
async function newest(tracer: Tracer, nodes: Node[]): Promise<Node | null> {
  if (nodes.length === 1) return nodes[0]!;
  const found: Node[] = [];
  for (const n of nodes) {
    const ancestors = await tracer.ancestors(n);
    if (nodes.every((o) => o === n || ancestors.has(keyOf(o)))) found.push(n);
  }
  return found.length === 1 ? found[0]! : null;
}

/**
 * 土台のアプリ1つの出どころを決める。root は E2E のリポジトリの作業ツリー、id は E2E のタスクの ID。
 * 近い前が作業中なら依存元のタスク、baseBranch に入っていれば baseBranch、どちらでもなければ決めきれない。
 * 印がない・アプリの前に当たらなければ baseBranch。読めないものがあれば決めきれないとし、投げない
 */
export async function resolveBaseAppSource(
  runner: Runner,
  root: string,
  id: string,
  app: CompanionApp,
): Promise<BaseAppSource> {
  return resolveWith(new Tracer(runner), runner, root, id, app);
}

/** 記録の baseApps の全部の出どころを、並びの順に決める（resolveBaseAppSource と同じ） */
export async function resolveBaseAppSources(
  runner: Runner,
  root: string,
  id: string,
  apps: readonly CompanionApp[],
): Promise<BaseAppSourceEntry[]> {
  const tracer = new Tracer(runner);
  const out: BaseAppSourceEntry[] = [];
  for (const app of apps)
    out.push({
      app,
      source: await resolveWith(tracer, runner, root, id, app),
    });
  return out;
}

async function resolveWith(
  tracer: Tracer,
  runner: Runner,
  root: string,
  id: string,
  app: CompanionApp,
): Promise<BaseAppSource> {
  let config: FlowConfig;
  let hits: Node[];
  try {
    const loaded = await loadFlowConfig(runner, app.path);
    if (!loaded.exists)
      return {
        kind: "undecided",
        reason: `${app.name} に orca-flow の設定がありません（init 前）`,
      };
    config = loaded.config;
    const start: Node = {
      repoPath: root,
      common: await tracer.common(root),
      id,
    };
    hits = await nearestAppNodes(tracer, start, await tracer.common(app.path));
  } catch (error) {
    return {
      kind: "undecided",
      reason: `${app.name} の前をたどれません（${messageOf(error)}）`,
    };
  }
  if (hits.length === 0)
    return { kind: "baseBranch", branch: config.baseBranch };
  let chosen: Node | null;
  try {
    chosen = await newest(tracer, hits);
  } catch (error) {
    return {
      kind: "undecided",
      reason: `${app.name} の前をたどれません（${messageOf(error)}）`,
    };
  }
  if (chosen === null)
    return {
      kind: "undecided",
      reason: `${app.name} の前が同じ近さに2つ以上あり（${hits.map((n) => n.id).join("・")}）、どれに向けるか決められません`,
    };
  try {
    const active = await activeTasks(runner, app.path, config);
    if (active.some((t) => t.id === chosen.id))
      return { kind: "task", id: chosen.id };
    const merged = await taskMergedInto(
      runner,
      app.path,
      config,
      chosen.id,
      config.baseBranch,
    );
    if (merged.merged) return { kind: "baseBranch", branch: config.baseBranch };
  } catch (error) {
    return {
      kind: "undecided",
      reason: `${app.name} の前 ${chosen.id} の状態が読めません（${messageOf(error)}）`,
    };
  }
  return {
    kind: "undecided",
    reason: `${app.name} の前 ${chosen.id} が作業中でも ${config.baseBranch} に入ってもいません`,
  };
}
