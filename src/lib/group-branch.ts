/**
 * 組の見分け（組の qa と workspace --preview が共通で使う）。
 * ID はリポジトリごとに振るので、組の外のアプリに番号だけ同じタスクがありうる。
 * 組は全部の子で同じ ID と短い名前で始めるので、ブランチ名で受けて見分ける
 */

import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import { listBranches } from "./git.ts";
import { isSafeBranchName } from "./qa/context.ts";
import { escapeId, hasIdShape, idFromBranch } from "./task-id.ts";

export type GroupTarget =
  { kind: "id"; id: string } | { kind: "branch"; branch: string };

/** 子のブランチを読むための材料 */
export interface ChildBranches {
  name: string;
  branchPrefix: string;
  idPrefix: string;
  /** 手元のブランチ（refs/heads/ は取ったもの） */
  branches: readonly string[];
}

/** 子ごとの見分け */
export type Membership =
  /** 組のブランチがある */
  | { kind: "branch"; branch: string }
  /** 同じ ID のブランチはあるが、短い名前が違う */
  | { kind: "other"; branches: string[] }
  /** 同じ ID のブランチがない */
  | { kind: "none" };

export interface GroupChoice {
  id: string;
  /** 打たれた組のブランチ名 */
  branch: string;
  /** 組の短い名前 */
  slug: string;
  /** 子の名前 → 見分け */
  members: Map<string, Membership>;
}

/**
 * 引数を ID かブランチ名に分ける。ID は組の決め（chooseGroup）で候補を出して止めるため、ここでは分けるだけ。
 * ID の形でなく、使えるブランチ名でもなければ FlowError(1)
 */
export function parseGroupTarget(text: string): GroupTarget {
  if (hasIdShape(text)) return { kind: "id", id: text };
  if (isSafeBranchName(text)) return { kind: "branch", branch: text };
  throw new FlowError(
    1,
    `ブランチ名（〈branchPrefix〉〈ID〉-〈短い名前〉）にしてください：${escapeId(text)}`,
  );
}

/** 子の手元のブランチを読む */
export async function readChildBranches(
  runner: Runner,
  repo: { name: string; path: string },
  config: { branchPrefix: string; idPrefix: string },
): Promise<ChildBranches> {
  return {
    name: repo.name,
    branchPrefix: config.branchPrefix,
    idPrefix: config.idPrefix,
    branches: await listBranches(runner, repo.path),
  };
}

/** `〈branchPrefix〉〈ID〉-〈短い名前〉` の形なら ID と短い名前。外れれば null */
export function splitTaskBranch(
  branch: string,
  branchPrefix: string,
  idPrefix: string,
): { id: string; slug: string } | null {
  const id = idFromBranch(branch, branchPrefix, idPrefix);
  if (id === null) return null;
  const rest = branch.slice(branchPrefix.length + id.length);
  if (!rest.startsWith("-") || rest.length < 2) return null;
  return { id, slug: rest.slice(1) };
}

/** 子の、ID で始まるタスクのブランチ */
function idBranches(child: ChildBranches, id: string): string[] {
  const start = `${child.branchPrefix}${id}-`;
  return child.branches.filter(
    (b) => b.startsWith(start) && b.length > start.length,
  );
}

function membersFor(
  children: readonly ChildBranches[],
  id: string,
  slug: string,
): Map<string, Membership> {
  const members = new Map<string, Membership>();
  for (const child of children) {
    const own = `${child.branchPrefix}${id}-${slug}`;
    const found = idBranches(child, id);
    if (found.includes(own))
      members.set(child.name, { kind: "branch", branch: own });
    else if (found.length > 0)
      members.set(child.name, { kind: "other", branches: found });
    else members.set(child.name, { kind: "none" });
  }
  return members;
}

/**
 * 子ごとに組のブランチを決める。組はブランチ名だけで受ける。
 * - ブランチ名：そのブランチがある子を組にする。形が外れる・子で ID が違えば FlowError(1)。
 *   どの子にもなければ FlowError(1)。ただし allowMissing なら、ブランチ名から読んだ ID と短い名前で見分けを返す
 *   （組のブランチを消したあとの片づけで、記録で組に当たる子を見るため）
 * - ID：候補が1つでも進まず、子ごとの候補と打ち直しの1行を出して FlowError(1)
 *   （番号だけ同じ組の外のブランチを取り違えないため）。retype はブランチ名で打ち直すコマンドを返す
 */
export function chooseGroup(
  target: GroupTarget,
  children: readonly ChildBranches[],
  retype: (branch: string) => string,
  options: { allowMissing?: boolean } = {},
): GroupChoice {
  if (target.kind === "id") rejectId(target.id, children, retype);
  return chooseByBranch(target.branch, children, options.allowMissing ?? false);
}

function rejectId(
  id: string,
  children: readonly ChildBranches[],
  retype: (branch: string) => string,
): never {
  const rows = children
    .map((c) => ({ name: c.name, branches: idBranches(c, id) }))
    .filter((r) => r.branches.length > 0);
  if (rows.length === 0)
    throw new FlowError(
      1,
      `組は ID でなくブランチ名（〈branchPrefix〉〈ID〉-〈短い名前〉）で打ってください。${id} のブランチはどのアプリの子にもありません`,
    );
  // 例の1行は人がそのままシェルに写すので、シェル向けの処理なしで出せる名前だけを使う
  const example = rows
    .flatMap((r) => r.branches)
    .find((b) => isSafeBranchName(b));
  // 候補のない子があると、組のブランチを消したあとで番号だけ同じ別のタスクのブランチしか
  // 残っていないことがある。例をそのまま写すと関係のない組を動かすので、条件をつける
  const partial = rows.length < children.length;
  throw new FlowError(
    1,
    [
      `組は ID でなくブランチ名で打ってください。${id} の候補のブランチ：`,
      ...rows.map(
        (r) => `  ${r.name}：${r.branches.map((b) => escapeId(b)).join("、")}`,
      ),
      example === undefined
        ? "候補にそのまま打てる形のブランチ名がありません。組のブランチを使える形のブランチ名に変えてから、ブランチ名で打ち直してください"
        : `${partial ? "候補が組のブランチなら、" : ""}ブランチ名で打ち直してください（例：${retype(example)}）`,
      ...(partial
        ? [
            "組のブランチを消したあとなら、候補は番号だけ同じ別のタスクのものかもしれません。組のブランチ名で打ってください",
          ]
        : []),
    ].join("\n"),
  );
}

function chooseByBranch(
  branch: string,
  children: readonly ChildBranches[],
  allowMissing: boolean,
): GroupChoice {
  const shown = escapeId(branch);
  const shaped = children.filter(
    (c) => splitTaskBranch(branch, c.branchPrefix, c.idPrefix) !== null,
  );
  if (shaped.length === 0)
    throw new FlowError(
      1,
      `ブランチ名の形が違います（アプリの子の設定で 〈branchPrefix〉〈ID〉-〈短い名前〉 に当たりません）：${shown}`,
    );
  const holders = shaped.filter((c) => c.branches.includes(branch));
  if (holders.length === 0 && !allowMissing)
    throw new FlowError(1, `ブランチ ${shown} がどのアプリの子にもありません`);
  const parsed = (holders.length > 0 ? holders : shaped).map((c) =>
    splitTaskBranch(branch, c.branchPrefix, c.idPrefix)!,
  );
  const ids = [...new Set(parsed.map((p) => p.id))];
  if (ids.length > 1)
    throw new FlowError(
      1,
      `ブランチ ${shown} から読む ID がアプリの子の設定で違います（${ids.join("・")}）`,
    );
  const { id, slug } = parsed[0]!;
  const members = membersFor(children, id, slug);
  // branchPrefix が違う子は、同じ短い名前でも組のブランチ名と違うので組に入れない
  for (const child of children) {
    const m = members.get(child.name)!;
    if (m.kind === "branch" && m.branch !== branch)
      members.set(child.name, { kind: "other", branches: [m.branch] });
  }
  return { id, branch, slug, members };
}
