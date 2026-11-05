import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireLock, releaseOrWarn } from "./lock.ts";
import {
  isVoteKey,
  type KindStats,
  type VoteKey,
  type VoteKind,
} from "./vote.ts";
import { FlowError } from "../types.ts";

// 合議の2票が一致した指摘を、種類ごとに自動で決める道の状態。
// 状態と自動で決めた件は作業ツリーの外（git の共通ディレクトリ）に置く。設定のファイルでは、外れたときに CLI が切れないため。
// 他人の文章と2票目の理由は入れない。合議の記録（vote/〈ID〉.jsonl）の形は変えない。

/** 自動で入れられる種類。判断事項の7項目は2票目をとらないので入れられない */
export const AUTO_KINDS = ["comment"] as const;
export const isAutoKind = (v: string): v is (typeof AUTO_KINDS)[number] =>
  (AUTO_KINDS as readonly string[]).includes(v);

/** 入れられる数の下限：2票が一致して人が答えた件がこの数以上 */
export const AUTO_MIN_AGREED = 20;
/** そのうち人とも一致する割合の下限（百分率） */
export const AUTO_MIN_RATE_PERCENT = 95;
/** 人がまだ確かめていない自動の件がこの数以上なら、自動で決めない */
export const AUTO_MAX_PENDING = 5;

export type AutoOffWhy = "human" | "miss";

export interface AutoKindState {
  on: boolean;
  /** 最後に入れた・切った時刻 */
  at: string | null;
  /** 切れた理由。入っている・一度も触っていないときは null */
  why: AutoOffWhy | null;
}

export interface AutoItem {
  id: string;
  target: string;
  kind: VoteKind;
  /** 自動で決めたキー（2票が一致したキー） */
  key: VoteKey;
  at: string;
  /** 人の答え。まだなら null */
  human: VoteKey | null;
}

export interface AutoState {
  kinds: Partial<Record<VoteKind, AutoKindState>>;
  items: AutoItem[];
}

export const emptyAutoState = (): AutoState => ({ kinds: {}, items: [] });

export const autoPath = (common: string) =>
  path.join(common, "orca-flow", "vote-auto.json");

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function stateFrom(value: unknown): AutoState | null {
  if (!isObject(value) || !isObject(value.kinds) || !Array.isArray(value.items))
    return null;
  const kinds: AutoState["kinds"] = {};
  for (const [name, k] of Object.entries(value.kinds)) {
    if (!isObject(k) || typeof k.on !== "boolean") return null;
    if (!(AUTO_KINDS as readonly string[]).includes(name)) continue;
    kinds[name as VoteKind] = {
      on: k.on,
      at: typeof k.at === "string" ? k.at : null,
      why: k.why === "human" || k.why === "miss" ? k.why : null,
    };
  }
  const items: AutoItem[] = [];
  for (const i of value.items) {
    if (
      !isObject(i) ||
      typeof i.id !== "string" ||
      typeof i.target !== "string" ||
      typeof i.kind !== "string" ||
      typeof i.at !== "string" ||
      !isVoteKey(i.key) ||
      (i.human !== null && !isVoteKey(i.human))
    )
      return null;
    items.push({
      id: i.id,
      target: i.target,
      kind: i.kind as VoteKind,
      key: i.key,
      at: i.at,
      human: i.human,
    });
  }
  return { kinds, items };
}

export type AutoRead =
  | { status: "missing" }
  | { status: "broken" }
  | { status: "ok"; state: AutoState };

/** 自動の記録を読む。ないときは missing、読めないときは broken（呼び手が全部切りとして扱う） */
export async function readAutoState(common: string): Promise<AutoRead> {
  let text: string;
  try {
    text = await readFile(autoPath(common), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    return { status: "broken" };
  }
  try {
    const state = stateFrom(JSON.parse(text));
    return state ? { status: "ok", state } : { status: "broken" };
  } catch {
    return { status: "broken" };
  }
}

/** 今の状態。ないときも読めないときも全部切り */
export async function currentAutoState(common: string): Promise<AutoState> {
  const r = await readAutoState(common);
  return r.status === "ok" ? r.state : emptyAutoState();
}

async function writeState(common: string, state: AutoState): Promise<void> {
  const file = autoPath(common);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** 自動の記録を同時に直すのを順に並べるロックの中で fn を流す */
async function withAutoLock<T>(
  common: string,
  fn: () => Promise<T>,
): Promise<T> {
  const file = autoPath(common);
  await mkdir(path.dirname(file), { recursive: true });
  const lock = await acquireLock(file.replace(/\.json$/, "") + ".lock", {
    waitMs: 15_000,
    failed: (f, detail) =>
      `自動の記録のロックを読み書きできません（${f}：${detail}）`,
    releaseFailed: (f, detail) =>
      `自動の記録のロックを外せませんでした（${f}：${detail}）。残っていれば ${f} を消してください`,
  });
  if (lock.kind === "held")
    throw new FlowError(
      1,
      `ほかの自動の記録の書き込みが続いています（${lock.lockPath}）。少し待って、もう一度流してください`,
    );
  try {
    return await fn();
  } finally {
    await releaseOrWarn(lock.release);
  }
}

/** ロックの中で読み、fn が新しい状態を返せば書く（null なら書かない）。読めない記録は、書き換えず断る */
async function updateState<T>(
  common: string,
  fn: (state: AutoState) => { state: AutoState | null; result: T },
  options: { replaceBroken?: boolean } = {},
): Promise<T> {
  return withAutoLock(common, async () => {
    const r = await readAutoState(common);
    if (r.status === "broken" && !options.replaceBroken)
      throw new FlowError(
        1,
        `自動の記録が読めません（${autoPath(common)}）。中を確かめるか、消してから流し直してください`,
      );
    const { state, result } = fn(
      r.status === "ok" ? r.state : emptyAutoState(),
    );
    if (state) await writeState(common, state);
    return result;
  });
}

// ---- 数える ----

/** 入れられる数を満たしているか。割合は整数で比べる（小数の丸めを避ける） */
export function meetsFloor(stats: KindStats | undefined): boolean {
  if (!stats) return false;
  return (
    stats.bothAgree >= AUTO_MIN_AGREED &&
    stats.bothAgreeHuman * 100 >= stats.bothAgree * AUTO_MIN_RATE_PERCENT
  );
}

export interface AutoCounts {
  /** 自動で決めた件 */
  total: number;
  /** 人が確かめた件 */
  checked: number;
  /** 確かめた件のうち、人の答えが違った件 */
  missed: number;
  /** 人がまだ確かめていない件 */
  pending: number;
}

export function countAuto(state: AutoState, kind: VoteKind): AutoCounts {
  const mine = state.items.filter((i) => i.kind === kind);
  const checked = mine.filter((i) => i.human !== null);
  return {
    total: mine.length,
    checked: checked.length,
    missed: checked.filter((i) => i.human !== i.key).length,
    pending: mine.length - checked.length,
  };
}

// ---- 入れる・切る ----

/** 種類を入れる。数を満たすかの確かめは呼び手がする */
export async function enableKind(
  common: string,
  kind: VoteKind,
  now: string,
): Promise<void> {
  await updateState(common, (state) => ({
    state: {
      ...state,
      kinds: { ...state.kinds, [kind]: { on: true, at: now, why: null } },
    },
    result: undefined,
  }));
}

/** 種類を切る。記録がなく、もともと切りなら何も作らない。切ったら true */
export async function disableKind(
  common: string,
  kind: VoteKind,
  now: string,
  why: AutoOffWhy,
): Promise<boolean> {
  const before = await readAutoState(common);
  if (before.status === "missing") return false;
  return updateState(
    common,
    (state) => ({
      state: {
        ...state,
        kinds: { ...state.kinds, [kind]: { on: false, at: now, why } },
      },
      result: true,
    }),
    { replaceBroken: true },
  );
}

// ---- cast と answer ----

export interface AutoCastInput {
  id: string;
  target: string;
  kind: VoteKind;
  key: VoteKey;
  now: string;
  /** 2票が一致したか（棄権・割れた・とらなかったは false） */
  agreed: boolean;
  /** 今も下限を満たすか */
  floorMet: boolean;
}

/**
 * cast の後に呼ぶ。同じ対象の人がまだ確かめていない自動の件は先に消し、
 * 入っていて、2票が一致し、下限を満たし、確かめ待ちが上限に届かないときだけ件を足す。
 * 自動で決めたら true。記録がなく自動で決めないときは何も作らない
 */
export async function applyAutoCast(
  common: string,
  input: AutoCastInput,
): Promise<boolean> {
  const before = await readAutoState(common);
  if (before.status !== "ok") return false;
  return updateState(common, (state) => {
    const rest = state.items.filter(
      (i) =>
        !(i.id === input.id && i.target === input.target && i.human === null),
    );
    const on = state.kinds[input.kind]?.on === true;
    const pending = rest.filter(
      (i) => i.kind === input.kind && i.human === null,
    ).length;
    const auto =
      on && input.agreed && input.floorMet && pending < AUTO_MAX_PENDING;
    const items = auto
      ? [
          ...rest,
          {
            id: input.id,
            target: input.target,
            kind: input.kind,
            key: input.key,
            at: input.now,
            human: null,
          },
        ]
      : rest;
    return {
      state:
        items.length === state.items.length && !auto
          ? null
          : { ...state, items },
      result: auto,
    };
  });
}

/**
 * answer の後に呼ぶ。自動の件に人の答えを書き、キーが違えばその種類を切る。
 * 自動の件でなければ null、あれば外れたかを返す
 */
export async function applyAutoAnswer(
  common: string,
  input: { id: string; target: string; human: VoteKey; now: string },
): Promise<{ kind: VoteKind; missed: boolean } | null> {
  const before = await readAutoState(common);
  if (before.status !== "ok") return null;
  return updateState(common, (state) => {
    const index = state.items.findIndex(
      (i) => i.id === input.id && i.target === input.target && i.human === null,
    );
    if (index < 0) return { state: null, result: null };
    const item = state.items[index]!;
    const missed = item.key !== input.human;
    const items = state.items.map((i, n) =>
      n === index ? { ...i, human: input.human } : i,
    );
    const kinds = missed
      ? {
          ...state.kinds,
          [item.kind]: { on: false, at: input.now, why: "miss" as const },
        }
      : state.kinds;
    return { state: { kinds, items }, result: { kind: item.kind, missed } };
  });
}
