import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasIdShape, requireIdShape as requireIdShapeOf } from "./task-id.ts";
import { acquireLock, holderAlive, parseLock, releaseOrWarn } from "./lock.ts";
import type { FlowConfig } from "../config.ts";
import type { Runner } from "./exec.ts";
import { readStackAt } from "./stack-record.ts";
import { readStages, type StageEntry } from "./stage-log.ts";
import {
  startAfterReadiness,
  WAIT_LABEL,
  type StartAfterCache,
  type StartAfterEntryState,
  type StartAfterReadiness,
} from "./start-after.ts";
import { readTaskRecord, taskDocPath } from "./tasks.ts";

/** おまかせのタスクの記録。`〈共通〉/orca-flow/auto/〈ID〉.json` に置く */
export type TurnKind = "approve" | "integrate";

export interface AutoTurn {
  kind: TurnKind;
  /** 番を立てた時刻（ISO） */
  at: string;
  /** 待ち受けが拾ったか */
  picked: boolean;
  pickedAt: string | null;
}

export interface AutoDecision {
  at: string;
  text: string;
}

/** 先の承認（approve --when-ready）。人が読んだ設計書の blob に結ぶ */
export interface PreApproval {
  /** 承認したときの設計書の blob（git hash-object の値） */
  blob: string;
  /** 承認した時刻（ISO） */
  at: string;
}

export interface AutoRecord {
  id: string;
  /** おまかせか（auto off で false） */
  auto: boolean;
  /**
   * 承認だけのおまかせか（前を待つ印から待ち受けが立てた。統合の番は立てない）。
   * 欄のない古い記録は false（今までどおりのおまかせ）として読む
   */
  approveOnly: boolean;
  createdAt: string;
  turn: AutoTurn | null;
  offReason: string | null;
  offAt: string | null;
  decisions: AutoDecision[];
  /** 先の承認。欄のない古い記録は null */
  preApproval: PreApproval | null;
}

/** 待ち受けを見直す間隔（ミリ秒） */
export const POLL_MS = 5000;
/** 待ち受けが番を待つ最長（ミリ秒）：12時間 */
export const MAX_WAIT_MS = 12 * 60 * 60 * 1000;
/** テストで間隔と最長を短くする環境変数 */
export const POLL_ENV = "ORCA_FLOW_AUTO_POLL_MS";
export const MAX_WAIT_ENV = "ORCA_FLOW_AUTO_MAX_WAIT_MS";

export const TURN_LABEL: Record<TurnKind, string> = {
  approve: "承認",
  integrate: "統合",
};

/** auto のスキルのファイル（プラグインの場所から求める） */
export const autoSkillPath = () =>
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "skills",
    "auto",
    "SKILL.md",
  );

export const autoDir = (common: string) =>
  path.join(common, "orca-flow", "auto");

/** 名前を残して、中身は task-id.ts の関数に任せる */
export function requireIdShape(id: string): void {
  requireIdShapeOf(id);
}

const autoFile = (common: string, id: string) => {
  requireIdShapeOf(id);
  return path.join(autoDir(common), `${id}.json`);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseRecord(text: string, id: string): AutoRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  let turn: AutoTurn | null = null;
  if (
    isObject(raw.turn) &&
    (raw.turn.kind === "approve" || raw.turn.kind === "integrate") &&
    typeof raw.turn.at === "string"
  )
    turn = {
      kind: raw.turn.kind,
      at: raw.turn.at,
      picked: raw.turn.picked === true,
      pickedAt:
        typeof raw.turn.pickedAt === "string" ? raw.turn.pickedAt : null,
    };
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions
        .filter(isObject)
        .filter((d) => typeof d.at === "string" && typeof d.text === "string")
        .map((d) => ({ at: d.at as string, text: d.text as string }))
    : [];
  return {
    id,
    auto: raw.auto === true,
    approveOnly: raw.approveOnly === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    turn,
    offReason: typeof raw.offReason === "string" ? raw.offReason : null,
    offAt: typeof raw.offAt === "string" ? raw.offAt : null,
    decisions,
    preApproval:
      isObject(raw.preApproval) &&
      typeof raw.preApproval.blob === "string" &&
      typeof raw.preApproval.at === "string"
        ? { blob: raw.preApproval.blob, at: raw.preApproval.at }
        : null,
  };
}

/** 記録を読む。なければ・壊れていれば null */
export async function readAuto(
  common: string,
  id: string,
): Promise<AutoRecord | null> {
  // 形の外れた ID は読まずに null（これまでの動き。test/lib/auto.test.ts）
  if (!hasIdShape(id)) return null;
  const file = autoFile(common, id);
  try {
    return parseRecord(await readFile(file, "utf8"), id);
  } catch {
    return null;
  }
}

/** 記録を一時ファイルと rename で置き換える（status と待ち受けが同じ記録を書くため） */
export async function writeAuto(
  common: string,
  record: AutoRecord,
): Promise<void> {
  requireIdShape(record.id);
  const dir = autoDir(common);
  await mkdir(dir, { recursive: true });
  const file = autoFile(common, record.id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** すべての記録（ID 順） */
export async function listAuto(common: string): Promise<AutoRecord[]> {
  let names: string[];
  try {
    names = await readdir(autoDir(common));
  } catch {
    return [];
  }
  const records: AutoRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const record = await readAuto(common, name.slice(0, -5));
    if (record) records.push(record);
  }
  return records.sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true }),
  );
}

export function newRecord(
  id: string,
  now: Date,
  approveOnly = false,
): AutoRecord {
  return {
    id,
    auto: true,
    approveOnly,
    createdAt: now.toISOString(),
    turn: null,
    offReason: null,
    offAt: null,
    decisions: [],
    preApproval: null,
  };
}

/** 番を立てる（前の番は置き換える） */
export function withTurn(
  record: AutoRecord,
  kind: TurnKind,
  now: Date,
): AutoRecord {
  return {
    ...record,
    turn: { kind, at: now.toISOString(), picked: false, pickedAt: null },
  };
}

/** おまかせを外す：番と先の承認を消して理由を残す */
export function withOff(
  record: AutoRecord,
  reason: string | null,
  now: Date,
): AutoRecord {
  return {
    ...record,
    auto: false,
    turn: null,
    preApproval: null,
    offReason: reason,
    offAt: now.toISOString(),
  };
}

// ---- 先の承認 ----

/** 先の承認の見分け。valid：今の設計書が承認したときと同じ。stale：設計書が変わった（なくなった）ので外れた */
export type PreApprovalState = "valid" | "stale";

/** 設計書の中身の blob。無視された設計書もコミットされた設計書も、中身から同じ求め方で出す */
export async function docBlob(
  runner: Runner,
  cwd: string,
  text: string,
): Promise<string> {
  const result = await runner("git", ["hash-object", "--stdin"], {
    cwd,
    input: text,
  });
  const blob = result.stdout.trim();
  if (result.code !== 0 || blob === "")
    throw new Error(
      `設計書の指紋を求められませんでした（git hash-object：${(result.stderr || result.stdout).trim()}）`,
    );
  return blob;
}

/** タスクの今の設計書の blob。設計書がなければ null */
export async function taskDocBlob(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  task: { id: string; branch: string; path: string },
): Promise<string | null> {
  const doc = await readTaskRecord(
    runner,
    cwd,
    task,
    taskDocPath(config, task.id),
  );
  return doc.text === null ? null : docBlob(runner, task.path, doc.text);
}

/** 先の承認が今の設計書のままか */
export async function preApprovalState(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  task: { id: string; branch: string; path: string },
  preApproval: PreApproval,
): Promise<PreApprovalState> {
  const blob = await taskDocBlob(runner, cwd, config, task);
  return blob === preApproval.blob ? "valid" : "stale";
}

export const PRE_APPROVAL_LABEL: Record<PreApprovalState, string> = {
  valid: "先の承認：有効",
  stale: "先の承認：設計書が変わったので外れました",
};

// ---- 乗せたタスク ----

/** 乗せる記録の組（後ろの ID と乗せた先の ID） */
export interface StackPair {
  id: string;
  on: string;
}

/**
 * 乗せる記録の組を、記録のファイルだけで読む（ID 順）。壊れた記録は飛ばす。
 * 待ち受けの見直しと context のフックが毎回読むので、git は呼ばない
 */
export async function listStackPairs(common: string): Promise<StackPair[]> {
  let names: string[];
  try {
    names = await readdir(path.join(common, "orca-flow", "stack"));
  } catch {
    return [];
  }
  const pairs: StackPair[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = await readStackAt(common, name.slice(0, -5));
      if (record) pairs.push({ id: record.id, on: record.on });
    } catch {
      // 壊れた記録は、使うコマンドが止めて直し方を伝える
    }
  }
  return pairs.sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true }),
  );
}

/** 自分も乗せた先も作業中の、乗せたタスクの ID */
export const stackedTargets = (
  pairs: readonly StackPair[],
  active: ReadonlySet<string>,
): string[] =>
  pairs.filter((p) => active.has(p.id) && active.has(p.on)).map((p) => p.id);

// ---- 待ち受けのロック ----

const lockPath = (common: string) => path.join(autoDir(common), "wait.lock");

export interface WaitState {
  running: boolean;
  pid: number | null;
}

/** 生きている待ち受けがあるか（ロックを読むだけ） */
export async function waitState(common: string): Promise<WaitState> {
  try {
    const holder = parseLock(await readFile(lockPath(common), "utf8"));
    const pid =
      Number.isInteger(holder.pid) && holder.pid > 0 ? holder.pid : null;
    return pid !== null && holderAlive(pid, holder.bootAt)
      ? { running: true, pid }
      : { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

export type LockResult =
  | { kind: "acquired"; release: () => Promise<void> }
  | { kind: "held"; pid: number | null };

/** 待ち受けのロックを取る。生きているほかの待ち受けがあれば held（待たない）。古いロックは取り直す */
export async function acquireWaitLock(common: string): Promise<LockResult> {
  await mkdir(autoDir(common), { recursive: true });
  const got = await acquireLock(lockPath(common), {
    waitMs: 0,
    maxAttempts: 3,
    failed: (file, detail) =>
      `おまかせの待ち受けのロックを読み書きできません（${file}：${detail}）。ロックのパスを確かめてください`,
    releaseFailed: (file, detail) =>
      `おまかせの待ち受けのロックを外せませんでした（${file}：${detail}）。ロックが残っていれば、${file} を消してください`,
  });
  if (got.kind === "held") return { kind: "held", pid: got.pid };
  // 外す失敗で wait の結果（番の印・--json の next）を壊さないよう、投げずに警告にとどめる
  return { kind: "acquired", release: () => releaseOrWarn(got.release) };
}

// ---- 待ち受け ----

export interface PickedTurn {
  id: string;
  kind: TurnKind;
  at: string;
}

export interface WaitDeps {
  common: string;
  /** 作業中のタスクの ID */
  activeIds: () => Promise<string[]>;
  /** 前を待つ印のある ID（なければ印を見ない） */
  markedIds?: () => Promise<string[]>;
  /** 印のある作業中のタスクを見直し、整ったものに承認の番を立てる */
  raise?: (ids: readonly string[]) => Promise<void>;
  /** 乗せる記録の組（なければ乗せたタスクを見ない） */
  stackPairs?: () => Promise<StackPair[]>;
  /** 乗せた先が作業中の乗せたタスクに、乗せた先の直しを知らせ直す */
  syncStacks?: (ids: readonly string[]) => Promise<void>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  maxWaitMs: number;
}

/** 立っていて拾われていない番を古い順に1つ拾って印をつける。なければ null */
async function pickOne(
  deps: WaitDeps,
  active: ReadonlySet<string>,
): Promise<PickedTurn | null> {
  const candidates = (await listAuto(deps.common))
    .filter((r) => r.auto && active.has(r.id) && r.turn && !r.turn.picked)
    .sort((a, b) => a.turn!.at.localeCompare(b.turn!.at));
  for (const candidate of candidates) {
    // 書く直前に読み直し、同じ番がまだ拾われていないことを確かめる
    const fresh = await readAuto(deps.common, candidate.id);
    if (
      !fresh ||
      !fresh.auto ||
      !fresh.turn ||
      fresh.turn.picked ||
      fresh.turn.at !== candidate.turn!.at
    )
      continue;
    await writeAuto(deps.common, {
      ...fresh,
      turn: {
        ...fresh.turn,
        picked: true,
        pickedAt: deps.now().toISOString(),
      },
    });
    return { id: fresh.id, kind: fresh.turn.kind, at: fresh.turn.at };
  }
  return null;
}

/** 最後の spec-review のあとに approve の承認（working の行）があるか */
export function approvedSinceSpecReview(
  entries: readonly StageEntry[],
): boolean {
  const review = entries.map((e) => e.state).lastIndexOf("spec-review");
  return (
    review >= 0 &&
    entries
      .slice(review + 1)
      .some((e) => e.state === "working" && e.command === "approve")
  );
}

/** 段の記録で、最後の spec-review のあとに承認があるか。読めなければ false */
export async function approvedNow(
  common: string,
  id: string,
): Promise<boolean> {
  try {
    const stages = await readStages(common, id);
    return stages !== null && approvedSinceSpecReview(stages.entries);
  } catch {
    // 段の記録が読めなければ、承認が済んだとは見なさない（待ち受けを早く終えない）
    return false;
  }
}

export interface WaitTargets {
  /** 番を待つおまかせのタスク */
  live: string[];
  /** 承認の番を待つ前を待つタスク（live のものも含む） */
  waiting: string[];
}

/**
 * 待ち受けが待つ先を、作業中のタスクから選ぶ。承認が済んだ承認だけのおまかせと印だけのタスクは、
 * もう番が立たないので外す（ふつうのおまかせは統合の番があるので残す）。外したおまかせの印も外す
 */
export async function waitTargets(
  common: string,
  records: readonly AutoRecord[],
  marked: readonly string[],
  active: ReadonlySet<string>,
): Promise<WaitTargets> {
  const byId = new Map(records.map((r) => [r.id, r]));
  const live: string[] = [];
  for (const r of records)
    if (
      r.auto &&
      active.has(r.id) &&
      !(r.approveOnly && (await approvedNow(common, r.id)))
    )
      live.push(r.id);
  const waiting: string[] = [];
  for (const id of marked) {
    if (!active.has(id)) continue;
    const record = byId.get(id);
    if (record && !record.auto) continue;
    if ((!record || record.approveOnly) && (await approvedNow(common, id)))
      continue;
    waiting.push(id);
  }
  return { live, waiting };
}

/**
 * 番を1つ拾うまで待つ。待つ先（waitTargets と、乗せた先が作業中の乗せたタスク）がなくなるか、
 * 最長を過ぎたら null
 */
export async function waitForTurn(deps: WaitDeps): Promise<PickedTurn | null> {
  const started = deps.now().getTime();
  for (;;) {
    const records = await listAuto(deps.common);
    const marked = deps.markedIds ? await deps.markedIds() : [];
    const pairs = deps.stackPairs ? await deps.stackPairs() : [];
    const active = new Set(
      records.some((r) => r.auto) || marked.length > 0 || pairs.length > 0
        ? await deps.activeIds()
        : [],
    );
    const { live, waiting } = await waitTargets(
      deps.common,
      records,
      marked,
      active,
    );
    const stacked = stackedTargets(pairs, active);
    if (live.length === 0 && waiting.length === 0 && stacked.length === 0)
      return null;
    if (waiting.length > 0 && deps.raise) await deps.raise(waiting);
    if (stacked.length > 0 && deps.syncStacks) await deps.syncStacks(stacked);
    const picked = await pickOne(deps, active);
    if (picked) return picked;
    if (deps.now().getTime() - started >= deps.maxWaitMs) return null;
    await deps.sleep(deps.pollMs);
  }
}

// ---- 前を待つ印から承認の番を立てる ----

/** 前1つの整い具合（〈前〉（〈条件〉を待つ：〈理由〉）） */
export const entryStateText = (e: StartAfterEntryState): string =>
  `${e.label}（${WAIT_LABEL[e.entry.wait]}を待つ：${e.reason}）`;

/** 整っていない前（印が読めなければその理由） */
export function waitDetail(readiness: StartAfterReadiness): string {
  return readiness.problem !== null
    ? `前を待つ印が読めません：${readiness.problem}`
    : readiness.entries
        .filter((e) => !e.ready)
        .map(entryStateText)
        .join("、");
}

/** 印が壊れた・前が読めないときの抜け方（記録の場所と、今承認できること） */
export const approveNowNote = (file: string): string =>
  `記録：${file}。/orca-flow:approve で今承認できます（approve が前を待つかを聞きます）`;

export interface RaiseDeps {
  runner: Runner;
  /** メインの作業ツリー */
  root: string;
  common: string;
  config: Pick<FlowConfig, "baseBranch" | "integratorName">;
  now: Date;
  /** 見直しの1回で使い回す（前の回のものを渡さない） */
  cache: StartAfterCache;
}

/**
 * 印のあるタスクのうち、段の記録の最後が spec-review で、前が整い、その spec-review のあとに承認の番を
 * まだ立てていないものに番を立てる。記録がなければ承認だけのおまかせの記録を作る。
 * 人が外したおまかせ（auto: false）には立てない。立てた ID を返す。1つ読めなくてもほかは続ける
 */
export async function raiseStartAfterTurns(
  deps: RaiseDeps,
  ids: readonly string[],
): Promise<string[]> {
  const raised: string[] = [];
  for (const id of ids) {
    try {
      const last = (await readStages(deps.common, id))?.entries.at(-1);
      if (last?.state !== "spec-review") continue;
      const record = await readAuto(deps.common, id);
      if (record && !record.auto) continue;
      if (
        record?.turn?.kind === "approve" &&
        Date.parse(record.turn.at) >= Date.parse(last.at)
      )
        continue;
      const readiness = await startAfterReadiness(
        deps.runner,
        deps.root,
        deps.common,
        deps.config,
        id,
        deps.cache,
      );
      if (!readiness?.ready) continue;
      // 書く直前に読み直し、status が同じ間に立てた番を上書きしない
      const fresh = await readAuto(deps.common, id);
      if (fresh && !fresh.auto) continue;
      if (
        fresh?.turn?.kind === "approve" &&
        Date.parse(fresh.turn.at) >= Date.parse(last.at)
      )
        continue;
      await writeAuto(
        deps.common,
        withTurn(fresh ?? newRecord(id, deps.now, true), "approve", deps.now),
      );
      raised.push(id);
    } catch {
      // 1つのタスクの記録が読めなくても、待ち受けは止めない（次の見直しで読み直す）
    }
  }
  return raised;
}
