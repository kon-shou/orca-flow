import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../../types.ts";
import { acquireLock, releaseOrWarn } from "../lock.ts";

// QA 環境の貸し出しの記録（6章『QA 環境』）。作業ツリーの外の1ファイル：
// 〈XDG_STATE_HOME または ~/.local/state〉/orca-flow/qa-leases.json。管理画面の url ごとに分け、番号ごとに借りたタスクを持つ。

export interface Lease {
  /** 借りたリポジトリ（メインの作業ツリーのパス） */
  repo: string;
  id: string;
  branch: string;
  head: string;
  /** 借りた時刻（ISO 8601） */
  at: string;
  /** 組で借りたときだけ。組のアプリごとのブランチと先頭（repo はワークスペースのフォルダ、branch・head はこの並びを「,」でつないだもの） */
  apps?: LeaseApp[];
}

export interface LeaseApp {
  name: string;
  /** アプリのリポジトリ（メインの作業ツリーのパス） */
  path: string;
  branch: string;
  head: string;
}

/** url → 番号（文字列） → 貸し出し */
type Store = Record<string, Record<string, Lease>>;

const LOCK_WAIT_MS = 15_000;

/** 記録のファイルのパス。環境変数で場所を決める */
export function leasesPath(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_STATE_HOME;
  if (xdg && path.isAbsolute(xdg))
    return path.join(xdg, "orca-flow", "qa-leases.json");
  const home = env.HOME || env.USERPROFILE;
  if (!home)
    throw new FlowError(
      1,
      "貸し出しの記録の場所を決められません（XDG_STATE_HOME か HOME を設定してください）",
    );
  return path.join(home, ".local", "state", "orca-flow", "qa-leases.json");
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isLeaseApp = (v: unknown): v is LeaseApp =>
  isObject(v) &&
  ["name", "path", "branch", "head"].every((k) => typeof v[k] === "string");

const isLease = (v: unknown): v is Lease =>
  isObject(v) &&
  ["repo", "id", "head", "at"].every((k) => typeof v[k] === "string") &&
  (v.branch === undefined || typeof v.branch === "string") &&
  (v.apps === undefined || (Array.isArray(v.apps) && v.apps.every(isLeaseApp)));

function broken(file: string, why: string): FlowError {
  return new FlowError(
    1,
    `QA 環境の貸し出しの記録が壊れています（${why}）。中身を確かめて直すか、不要なら消してください：${file}`,
  );
}

async function readStore(file: string): Promise<Store> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new FlowError(
      1,
      `QA 環境の貸し出しの記録を読めません：${file}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw broken(file, "JSON として読めません");
  }
  if (!isObject(data) || !isObject(data.urls))
    throw broken(file, "形が違います");
  const store: Store = {};
  for (const [url, envs] of Object.entries(data.urls)) {
    if (!isObject(envs)) throw broken(file, "形が違います");
    store[url] = {};
    for (const [env, lease] of Object.entries(envs)) {
      if (!/^[1-9]\d*$/.test(env) || !isLease(lease))
        throw broken(file, "形が違います");
      // ブランチ名のない古い記録は「分からない」として読み、ID だけで比べる
      store[url][env] = { ...lease, branch: lease.branch ?? "" };
    }
  }
  return store;
}

async function writeStore(file: string, store: Store): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      tmp,
      `${JSON.stringify({ version: 1, urls: store }, null, 2)}\n`,
    );
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** ロックの中で読み、f が返した変更を書く。f が false を返したら書かない */
async function withStore<T>(
  env: NodeJS.ProcessEnv,
  f: (store: Store) => { result: T; write: boolean },
): Promise<T> {
  const file = leasesPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  const lock = await acquireLock(lockPath, {
    waitMs: LOCK_WAIT_MS,
    kind: "qa-leases",
    failed: (l, d) => `貸し出しの記録のロックを扱えません：${l}（${d}）`,
  });
  if (lock.kind !== "acquired")
    throw new FlowError(
      1,
      `ほかの処理が貸し出しの記録を使っています。少し待ってやり直してください：${lockPath}`,
    );
  try {
    const store = await readStore(file);
    const { result, write } = f(store);
    if (write) await writeStore(file, store);
    return result;
  } finally {
    await releaseOrWarn(lock.release);
  }
}

/** 番号ごとの貸し出し（借りていない番号は含まない） */
export async function readLeases(
  env: NodeJS.ProcessEnv,
  url: string,
): Promise<Map<number, Lease>> {
  return withStore(env, (store) => ({
    result: new Map(
      Object.entries(store[url] ?? {}).map(([k, v]) => [Number(k), v]),
    ),
    write: false,
  }));
}

export interface Borrower {
  repo: string;
  id: string;
  /** 組のとき：これらのリポジトリが借りていても、同じ持ち主として使い直す */
  also?: readonly string[];
  /** 借り手のブランチ。貸し出しにもブランチ名があれば、ID でなくこれで比べる */
  branches?: readonly string[];
}

/** 貸し出しのブランチ。組はアプリごと、子は branch。分からなければ空 */
export function leaseBranches(lease: Lease): string[] {
  if (lease.apps) return lease.apps.map((a) => a.branch).filter((b) => b);
  return lease.branch ? [lease.branch] : [];
}

/**
 * 同じ持ち主か。両方にブランチ名があればリポジトリとブランチ名で比べ、ID の欄は見ない
 * （ID はリポジトリごとに振るので、組では番号だけ同じ別の組がありうる）。どちらかが分からなければ ID で比べる
 */
const sameOwner = (lease: Lease, who: Borrower) => {
  const sameRepo =
    lease.repo === who.repo || (who.also?.includes(lease.repo) ?? false);
  const held = leaseBranches(lease);
  if (held.length > 0 && who.branches && who.branches.length > 0)
    return sameRepo && held.some((b) => who.branches!.includes(b));
  return sameRepo && lease.id === who.id;
};

/**
 * path のリポジトリを組のアプリに持つ組の貸し出し（番号順）。
 * branch を渡し、貸し出しのそのアプリのブランチ名も分かれば、ブランチ名で比べて ID の欄は見ない。
 * どちらかが分からなければ同じ ID のものにする
 */
export function groupLeasesOf(
  leases: ReadonlyMap<number, Lease>,
  id: string,
  appPath: string,
  branch?: string,
): { env: number; lease: Lease }[] {
  return [...leases]
    .filter(
      ([, l]) =>
        l.apps?.some(
          (a) =>
            a.path === appPath &&
            (branch !== undefined && a.branch !== ""
              ? a.branch === branch
              : l.id === id),
        ) ?? false,
    )
    .sort(([a], [b]) => a - b)
    .map(([env, lease]) => ({ env, lease }));
}

/**
 * 使う番号を選ぶ。同じ持ち主（sameOwner）がすでに借りていればその番号、
 * なければ envs のうち借りられていない一番小さい番号。なければ null
 */
export function pickEnv(
  leases: ReadonlyMap<number, Lease>,
  envs: readonly number[],
  who: Borrower,
): { env: number; reused: boolean } | null {
  for (const e of envs) {
    const lease = leases.get(e);
    if (lease && sameOwner(lease, who)) return { env: e, reused: true };
  }
  const free = envs.filter((e) => !leases.has(e)).sort((a, b) => a - b)[0];
  return free === undefined ? null : { env: free, reused: false };
}

/**
 * 番号 env を借りる。空いていれば lease を書く。同じタスクがすでに借りていれば何も書かず reused を返す
 * （送りが落ちても前の貸し出しを残すため）。ほかが借りていれば FlowError(2)
 */
export async function borrow(
  envs: NodeJS.ProcessEnv,
  url: string,
  env: number,
  lease: Lease,
  also?: readonly string[],
): Promise<{ reused: boolean }> {
  return withStore<{ reused: boolean }>(envs, (store) => {
    const current = store[url]?.[String(env)];
    if (current) {
      if (
        sameOwner(current, {
          repo: lease.repo,
          id: lease.id,
          also,
          branches: leaseBranches(lease),
        })
      )
        return { result: { reused: true }, write: false };
      throw new FlowError(
        2,
        `QA 環境 ${env} は ${current.id}（${path.basename(current.repo)}）が借りています。別の番号を選ぶか、返してください（orca-flow qa release --env ${env}）`,
      );
    }
    (store[url] ??= {})[String(env)] = lease;
    return { result: { reused: false }, write: true };
  });
}

/** 送れたあとの記録。借りた内容（先頭・時刻）を書く */
export async function recordLease(
  envs: NodeJS.ProcessEnv,
  url: string,
  env: number,
  lease: Lease,
): Promise<void> {
  await withStore(envs, (store) => {
    (store[url] ??= {})[String(env)] = lease;
    return { result: undefined, write: true };
  });
}

/** 条件に合う貸し出しを返す。返したものを返り値にする */
export async function release(
  envs: NodeJS.ProcessEnv,
  url: string,
  match: { env: number } | { who: Borrower },
  /** 同じ持ち主のものに限る（送りが落ちたときの取り消し用） */
  only?: Borrower,
): Promise<{ env: number; lease: Lease }[]> {
  return withStore(envs, (store) => {
    const table = store[url] ?? {};
    const removed: { env: number; lease: Lease }[] = [];
    for (const [key, lease] of Object.entries(table)) {
      const hit =
        "env" in match
          ? Number(key) === match.env
          : sameOwner(lease, match.who);
      if (!hit || (only && !sameOwner(lease, only))) continue;
      removed.push({ env: Number(key), lease });
      delete table[key];
    }
    if (removed.length > 0 && Object.keys(table).length === 0)
      delete store[url];
    return { result: removed, write: removed.length > 0 };
  });
}
