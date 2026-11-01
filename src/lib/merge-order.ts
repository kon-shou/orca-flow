import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Runner } from "./exec.ts";
import { gitCommonDir } from "./git.ts";
import { FlowError } from "../types.ts";

/** 鎖の1項目 */
export interface OrderItem {
  id: string;
  /** 統合済みか（integrate がつける） */
  integrated: boolean;
  /** 統合したマージのコミット。差分なしで片づけたとき・未統合のときは null */
  mergeCommit: string | null;
}

/** マージの順：鎖（前から後ろへの並び）の一覧 */
export interface MergeOrder {
  chains: OrderItem[][];
}

export const emptyOrder = (): MergeOrder => ({ chains: [] });

/** 置き場所：〈git の共通ディレクトリ〉/orca-flow/merge-order.json（作業ツリーの外） */
export async function mergeOrderFile(
  runner: Runner,
  cwd: string,
): Promise<string> {
  return path.join(
    await gitCommonDir(runner, cwd),
    "orca-flow",
    "merge-order.json",
  );
}

const isItem = (value: unknown): value is OrderItem => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.integrated === "boolean" &&
    (v.mergeCommit === null || typeof v.mergeCommit === "string")
  );
};

/** 順を読む。ファイルがなければ空（ファイルは作らない）。壊れていれば FlowError */
export async function readMergeOrder(
  runner: Runner,
  cwd: string,
): Promise<MergeOrder> {
  const file = await mergeOrderFile(runner, cwd);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyOrder();
    throw error;
  }
  const broken = () =>
    new FlowError(
      1,
      `マージの順のファイルが壊れています：${file}。orca-flow order --clear で消して、順を決め直してください`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw broken();
  }
  const chains = (parsed as { chains?: unknown } | null)?.chains;
  if (
    !Array.isArray(chains) ||
    !chains.every((chain) => Array.isArray(chain) && chain.every(isItem))
  )
    throw broken();
  return { chains: chains as OrderItem[][] };
}

/** 順を書く。鎖が1つもなければファイルを消す。一時ファイルに書いてから rename する */
export async function writeMergeOrder(
  runner: Runner,
  cwd: string,
  order: MergeOrder,
): Promise<void> {
  const file = await mergeOrderFile(runner, cwd);
  if (order.chains.length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(order, null, 2)}\n`);
  await rename(tmp, file);
}

/** ID が入っている鎖。なければ null */
export function chainOf(order: MergeOrder, id: string): OrderItem[] | null {
  return order.chains.find((chain) => chain.some((i) => i.id === id)) ?? null;
}

/** 同じ鎖で id より前の項目（前から順）。id が鎖になければ空 */
export function orderBefore(order: MergeOrder, id: string): OrderItem[] {
  const chain = chainOf(order, id);
  if (!chain) return [];
  return chain.slice(
    0,
    chain.findIndex((i) => i.id === id),
  );
}

/** 同じ鎖での a から見た b の位置。b が a より前なら "before"、後ろなら "after"、同じ鎖でなければ null */
export function orderRelation(
  order: MergeOrder,
  a: string,
  b: string,
): "before" | "after" | null {
  const chain = chainOf(order, a);
  if (!chain || a === b) return null;
  const ia = chain.findIndex((i) => i.id === a);
  const ib = chain.findIndex((i) => i.id === b);
  if (ib < 0) return null;
  return ib < ia ? "before" : "after";
}

export type AddChainResult =
  | { ok: true; order: MergeOrder; replaced: boolean }
  | { ok: false; message: string };

/**
 * 鎖を1つ足す（ID は2つ以上・重複なし）。
 * すでにある鎖の ID を全部含むなら置き換える（統合済みの印は引き継ぐ）。一部だけ含むなら失敗
 */
export function addChain(
  order: MergeOrder,
  ids: readonly string[],
): AddChainResult {
  if (ids.length < 2)
    return {
      ok: false,
      message: "ID は2つ以上、「,」で区切って書いてください",
    };
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return { ok: false, message: `ID が重なっています：${dup}` };
  const newSet = new Set(ids);
  const touched = order.chains.filter((chain) =>
    chain.some((i) => newSet.has(i.id)),
  );
  for (const chain of touched) {
    if (!chain.every((i) => newSet.has(i.id))) {
      const shown = chain.map((i) => i.id).join(" → ");
      return {
        ok: false,
        message: `すでにある鎖（${shown}）の一部だけを含みます。先に orca-flow order --remove 〈ID〉 か --clear で消してください`,
      };
    }
  }
  const old = new Map<string, OrderItem>();
  for (const chain of touched) for (const i of chain) old.set(i.id, i);
  const chain = ids.map(
    (id) => old.get(id) ?? { id, integrated: false, mergeCommit: null },
  );
  const firstOpen = chain.findIndex((i) => !i.integrated);
  if (firstOpen >= 0 && chain.slice(firstOpen).some((i) => i.integrated))
    return {
      ok: false,
      message: `統合済みの ID は未統合の ID より前に並べてください：${chain
        .map((i) => (i.integrated ? `${i.id}（統合済み）` : i.id))
        .join(" → ")}`,
    };
  return {
    ok: true,
    replaced: touched.length > 0,
    order: {
      chains: [...order.chains.filter((c) => !touched.includes(c)), chain],
    },
  };
}

/** ID を鎖から外す。残りが1つ以下になった鎖は消す */
export function removeId(order: MergeOrder, id: string): MergeOrder {
  return {
    chains: order.chains
      .map((chain) => chain.filter((i) => i.id !== id))
      .filter((chain) => chain.length >= 2),
  };
}

/**
 * 統合済みの印をつける（差分なしで片づけたときの mergeCommit は null）。
 * 鎖の全部が統合済みになったら鎖を消す。id が順になければ何も書かない
 */
export async function recordIntegrated(
  runner: Runner,
  cwd: string,
  id: string,
  mergeCommit: string | null,
): Promise<void> {
  const order = await readMergeOrder(runner, cwd);
  if (!chainOf(order, id)) return;
  const chains = order.chains
    .map((chain) =>
      chain.map((i) =>
        i.id === id ? { ...i, integrated: true, mergeCommit } : i,
      ),
    )
    .filter((chain) => !chain.every((i) => i.integrated));
  await writeMergeOrder(runner, cwd, { chains });
}
