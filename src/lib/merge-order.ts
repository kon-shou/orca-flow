import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Runner } from "./exec.ts";
import { gitCommonDir } from "./git.ts";
import { FlowError } from "../types.ts";
import { currentBootAt, holderAlive, parseLock } from "./main-check.ts";

/** 鎖の1項目 */
export interface OrderItem {
  id: string;
  /** 統合済みか（integrate がつける） */
  integrated: boolean;
  /** 統合したマージのコミット。差分なしで片づけたとき・未統合のときは null */
  mergeCommit: string | null;
  /** overlap が自動で足したときの印（時刻は ISO 8601）。なければ人が足した項目。古いファイルにはない */
  auto?: { at: string };
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
    (v.mergeCommit === null || typeof v.mergeCommit === "string") &&
    (v.auto === undefined ||
      (typeof v.auto === "object" &&
        v.auto !== null &&
        typeof (v.auto as Record<string, unknown>).at === "string"))
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
  // 足し直した鎖の「自動で足した」印は消す（人が見た印）
  const chain = ids.map((id): OrderItem => {
    const prev = old.get(id);
    return prev
      ? { id, integrated: prev.integrated, mergeCommit: prev.mergeCommit }
      : { id, integrated: false, mergeCommit: null };
  });
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
  await withOrderLock(runner, cwd, async () => {
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
  });
}

/** ロックを待つ長さ（ミリ秒）と、確かめる間隔 */
export const LOCK_WAIT_MS = 5_000;
export const LOCK_POLL_MS = 50;

/** ロックの置き場所：〈git の共通ディレクトリ〉/orca-flow/merge-order.lock */
export async function mergeOrderLockFile(
  runner: Runner,
  cwd: string,
): Promise<string> {
  return path.join(
    await gitCommonDir(runner, cwd),
    "orca-flow",
    "merge-order.lock",
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 中身が空・読めない形のロックを、書いている途中とみなす間（ミリ秒）。ロックの mtime がこれより新しければ生きているとみなす */
export const LOCK_FRESH_MS = 3_000;

const errCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * 順のファイルのロックを取って fn を流し、外す。fn の中で読み直して書くこと。
 * 生きていないプロセスのロックは取り直す。生きているロックは LOCK_WAIT_MS まで待ち、取れなければ FlowError(1)
 */
export async function withOrderLock<T>(
  runner: Runner,
  cwd: string,
  fn: () => Promise<T>,
  waitMs = LOCK_WAIT_MS,
): Promise<T> {
  const lock = await mergeOrderLockFile(runner, cwd);
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  const mine = `${process.pid} ${currentBootAt()}\n`;
  let holderPid: number | null = null;
  for (;;) {
    try {
      await writeFile(lock, mine, { flag: "wx" });
      break;
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
    }
    let text: string;
    try {
      text = await readFile(lock, "utf8");
    } catch (error) {
      if (errCode(error) === "ENOENT") continue; // 読む前に外された。すぐ取り直す
      throw new FlowError(
        1,
        `マージの順のロックを読めません（${lock}：${error instanceof Error ? error.message : String(error)}）。順は変えていません。ロックのパスを確かめてください`,
      );
    }
    const holder = parseLock(text);
    const validPid = Number.isInteger(holder.pid) && holder.pid > 0;
    if (validPid) holderPid = holder.pid;
    let alive = holderAlive(holder.pid, holder.bootAt);
    if (!validPid) {
      // 作った直後で中身がまだ空かもしれない。新しい間は生きているとみなす
      try {
        alive = Date.now() - (await stat(lock)).mtimeMs < LOCK_FRESH_MS;
      } catch (error) {
        if (errCode(error) === "ENOENT") continue;
        throw error;
      }
    }
    if (!alive) {
      // 消す前にもう一度読み、読んだ中身のままのときだけ消す
      try {
        if ((await readFile(lock, "utf8")) === text) await rm(lock);
      } catch (error) {
        if (errCode(error) !== "ENOENT") throw error;
      }
      continue;
    }
    if (Date.now() >= deadline)
      throw new FlowError(
        1,
        `マージの順のファイルを別の orca-flow が使っています（プロセス ${holderPid ?? "不明"}、${lock}）。順は変えていません。少し待ってやり直してください。プロセス ${holderPid ?? "不明"} がいなければ（orca-flow でなければ）、${lock} を消してやり直してください`,
      );
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    // 自分のロックだけを外す
    try {
      if ((await readFile(lock, "utf8")) === mine) await rm(lock);
    } catch {
      // すでにない・読めないなら何もしない
    }
  }
}

export type AutoPlan =
  | { ok: true; ids: string[]; kind: "new" | "append" }
  | { ok: false; reason: string };

/**
 * overlap が自動で足せるかを決める。partners は重なる相手（作業中のほかのタスク）の ID。
 * 足すのは「自分も相手もどの鎖にもいない（相手は1つ）」か「自分がどの鎖にもおらず、相手が全部同じ1つの鎖にいる」ときだけ
 */
export function planAutoOrder(
  order: MergeOrder,
  selfId: string,
  partners: readonly string[],
): AutoPlan {
  const ids = [...new Set(partners)];
  if (ids.length === 0)
    return { ok: false, reason: "重なる相手が見つかりませんでした" };
  const own = chainOf(order, selfId);
  if (own)
    return {
      ok: false,
      reason: `${selfId} はすでにマージの順（${own.map((i) => i.id).join(" → ")}）にいるので、自動では足しません`,
    };
  const chains = ids.map((id) => chainOf(order, id));
  const inChain = chains.filter((c) => c !== null);
  if (inChain.length === 0) {
    if (ids.length >= 2)
      return {
        ok: false,
        reason: `鎖にいない相手が2つ以上と重なっています（${ids.join("、")}）。関係のない待ちを作らないよう、自動では足しません`,
      };
    return { ok: true, kind: "new", ids: [ids[0]!, selfId] };
  }
  if (inChain.length < ids.length)
    return {
      ok: false,
      reason: `鎖にいる相手といない相手が混ざっています（${ids.join("、")}）。自動では足しません`,
    };
  const first = inChain[0]!;
  if (inChain.some((c) => c !== first))
    return {
      ok: false,
      reason: `相手が別々の鎖にいます（${ids.join("、")}）。自動ではつなぎません`,
    };
  return { ok: true, kind: "append", ids: [...first.map((i) => i.id), selfId] };
}

/** 自分を自動で足した順を返す（鎖は plan.ids の鎖。自分の項目に印をつける） */
export function applyAutoOrder(
  order: MergeOrder,
  plan: Extract<AutoPlan, { ok: true }>,
  at: string,
): MergeOrder {
  const selfId = plan.ids[plan.ids.length - 1]!;
  const mark = (i: OrderItem): OrderItem =>
    i.id === selfId ? { ...i, auto: { at } } : i;
  const fresh = (id: string): OrderItem => ({
    id,
    integrated: false,
    mergeCommit: null,
  });
  if (plan.kind === "new")
    return {
      chains: [...order.chains, plan.ids.map((id) => mark(fresh(id)))],
    };
  const target = chainOf(order, plan.ids[0]!)!;
  return {
    chains: order.chains.map((c) =>
      c === target ? [...c, mark(fresh(selfId))] : c,
    ),
  };
}
