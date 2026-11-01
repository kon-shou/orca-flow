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
import { FlowError } from "../types.ts";
import { currentBootAt, holderAlive, parseLock } from "./main-check.ts";

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

export interface AutoRecord {
  id: string;
  /** おまかせか（auto off で false） */
  auto: boolean;
  createdAt: string;
  turn: AutoTurn | null;
  offReason: string | null;
  offAt: string | null;
  decisions: AutoDecision[];
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

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function requireIdShape(id: string): void {
  if (!ID_PATTERN.test(id))
    throw new FlowError(1, `ID の形が正しくありません：${id}`);
}

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
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    turn,
    offReason: typeof raw.offReason === "string" ? raw.offReason : null,
    offAt: typeof raw.offAt === "string" ? raw.offAt : null,
    decisions,
  };
}

/** 記録を読む。なければ・壊れていれば null */
export async function readAuto(
  common: string,
  id: string,
): Promise<AutoRecord | null> {
  if (!ID_PATTERN.test(id)) return null;
  try {
    return parseRecord(
      await readFile(path.join(autoDir(common), `${id}.json`), "utf8"),
      id,
    );
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
  const file = path.join(dir, `${record.id}.json`);
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

export function newRecord(id: string, now: Date): AutoRecord {
  return {
    id,
    auto: true,
    createdAt: now.toISOString(),
    turn: null,
    offReason: null,
    offAt: null,
    decisions: [],
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

/** おまかせを外す：番を消して理由を残す */
export function withOff(
  record: AutoRecord,
  reason: string | null,
  now: Date,
): AutoRecord {
  return {
    ...record,
    auto: false,
    turn: null,
    offReason: reason,
    offAt: now.toISOString(),
  };
}

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

/** 待ち受けのロックを取る。生きているほかの待ち受けがあれば held。古いロックは取り直す */
export async function acquireWaitLock(common: string): Promise<LockResult> {
  await mkdir(autoDir(common), { recursive: true });
  const lock = lockPath(common);
  let held: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(lock, `${process.pid} ${currentBootAt()}\n`, {
        flag: "wx",
      });
      return {
        kind: "acquired",
        release: async () => {
          // 自分のロックだけを消す
          try {
            const holder = parseLock(await readFile(lock, "utf8"));
            if (holder.pid !== process.pid) return;
          } catch {
            return;
          }
          await rm(lock, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder: { pid: number; bootAt: number | null };
    try {
      holder = parseLock(await readFile(lock, "utf8"));
    } catch {
      continue;
    }
    held = Number.isInteger(holder.pid) && holder.pid > 0 ? holder.pid : null;
    if (held !== null && holderAlive(holder.pid, holder.bootAt))
      return { kind: "held", pid: held };
    await rm(lock, { force: true });
  }
  return { kind: "held", pid: held };
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

/**
 * 番を1つ拾うまで待つ。作業中のおまかせのタスクがなくなるか、最長を過ぎたら null
 */
export async function waitForTurn(deps: WaitDeps): Promise<PickedTurn | null> {
  const started = deps.now().getTime();
  for (;;) {
    const records = (await listAuto(deps.common)).filter((r) => r.auto);
    const active = new Set(records.length > 0 ? await deps.activeIds() : []);
    const live = records.filter((r) => active.has(r.id));
    if (live.length === 0) return null;
    const picked = await pickOne(deps, active);
    if (picked) return picked;
    if (deps.now().getTime() - started >= deps.maxWaitMs) return null;
    await deps.sleep(deps.pollMs);
  }
}
