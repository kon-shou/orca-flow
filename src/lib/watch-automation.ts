import { ORCA_FLOW_MAIN } from "./background.ts";
import type { Runner } from "./exec.ts";
import { readState, watchDir } from "./pr-watch/store.ts";
import { FlowError } from "../types.ts";

// 見張り（pr-watch）の Orca の automation の作る・消す・探す道（1か所）。
// automation はリポジトリごとに1つ。名前で見つける。

const ORCA_TIMEOUT_MS = 15_000;

/** automation の名前（リポジトリのメインの作業ツリーごとに1つ） */
export function watchAutomationName(root: string): string {
  return `orca-flow pr-watch ${root}`;
}

/** 探した結果。「ない」と「分からない」（Orca につながらないなど）を分ける */
export type WatchAutomationLookup =
  | {
      state: "found";
      id: string;
      name: string;
      /** 一覧にあれば。false は無効の automation */
      enabled?: boolean;
      /** Orca が最後に流した時刻（一覧にあれば） */
      lastRunAt?: string | number;
      precheck?: string;
    }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

export interface WatchAutomationInstall {
  /** 作ったか、今の automation の中身を直したか */
  action: "created" | "updated";
  id: string;
}

export interface WatchAutomationRemove {
  /** 消した automation の id。なかったら null */
  id: string | null;
}

export interface WatchAutomationOptions {
  /** メインの作業ツリー（--root に渡す） */
  root: string;
  /** 見張りの間隔（分）。config の prWatch.intervalMinutes */
  intervalMinutes: number;
  /** precheck を組む環境。省けば今のプロセスの環境 */
  env?: WatchEnv;
}

/** precheck を組むときの環境。テストから3つの形を確かめられるように引数で渡せる */
export interface WatchEnv {
  platform: NodeJS.Platform;
  /** WSL_DISTRO_NAME（linux で入っていれば WSL の中） */
  distro?: string;
  /** install のときの PATH */
  path?: string;
}

/** 今のプロセスの環境 */
export function currentWatchEnv(): WatchEnv {
  return {
    platform: process.platform,
    distro: process.env.WSL_DISTRO_NAME,
    path: process.env.PATH,
  };
}

function isWsl(env: WatchEnv): env is WatchEnv & { distro: string } {
  return (
    env.platform === "linux" &&
    typeof env.distro === "string" &&
    env.distro !== ""
  );
}

/** sh に1語として渡す形にする。Windows は " で囲む */
export function shellQuote(
  word: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return `"${word.replaceAll('"', '\\"')}"`;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** CMD が読んでしまう文字（"・%・\）と制御文字 */
function hasCmdUnsafe(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
    if (ch === '"' || ch === "%" || ch === "\\") return true;
  }
  return false;
}

/** 1行の長さの上限（CMD の上限に余裕を持たせた値） */
const MAX_PRECHECK_LENGTH = 8000;

/** PATH の同じ場所を1つにまとめ、CMD で渡せない場所は落とす。順は変えない */
export function cleanPath(value: string | undefined): string {
  const seen = new Set<string>();
  for (const dir of (value ?? "").split(":")) {
    if (dir === "" || hasCmdUnsafe(dir)) continue;
    seen.add(dir);
  }
  return [...seen].join(":");
}

const refuse = (what: string): FlowError =>
  new FlowError(
    1,
    `見張りの automation を作りません。CMD で渡せないものがあります：${what}`,
  );

/** WSL の形。wsl.exe の自分の引数は囲まず、-e のあとの語を1つずつ " で囲む */
function wslPrecheck(
  root: string,
  distro: string,
  pathValue: string | undefined,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(distro))
    throw refuse("ディストリの名前（英数字・.・_・- だけにしてください）");
  if (hasCmdUnsafe(process.execPath)) throw refuse("node のパス");
  if (hasCmdUnsafe(ORCA_FLOW_MAIN)) throw refuse("main.ts のパス");
  if (hasCmdUnsafe(root)) throw refuse("リポジトリのパス");
  const words = [
    "/usr/bin/env",
    `PATH=${cleanPath(pathValue)}`,
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    ORCA_FLOW_MAIN,
    "pr-watch",
    "--root",
    root,
  ].map((w) => `"${w}"`);
  const text = ["wsl.exe", "-d", distro, "--cd", "~", "-e", ...words].join(" ");
  if (text.length > MAX_PRECHECK_LENGTH)
    throw refuse(`precheck が長すぎます（${MAX_PRECHECK_LENGTH}文字まで）`);
  return text;
}

/**
 * precheck の文。PATH の orca-flow に頼らず、プラグインの node と main.ts の絶対パスで呼ぶ
 * （automation はプラグインのセッションの外で動く）。作業の場所は --root で渡す。
 * WSL の中では wsl.exe を通して WSL の中で流す（Windows の Orca は precheck を CMD で流す）
 */
export function watchPrecheck(
  root: string,
  env: WatchEnv | NodeJS.Platform = currentWatchEnv(),
): string {
  const e: WatchEnv = typeof env === "string" ? { platform: env } : env;
  if (isWsl(e)) return wslPrecheck(root, e.distro, e.path);
  return [
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    ORCA_FLOW_MAIN,
    "pr-watch",
    "--root",
    root,
  ]
    .map((w) => shellQuote(w, e.platform))
    .join(" ");
}

/** 比べるときは install のときの PATH の違いを無視する（"PATH=…" の語を決まった文字にする） */
function withoutPath(precheck: string | undefined): string | undefined {
  return precheck?.replace(/"PATH=[^"]*"/, '"PATH="');
}

/** 間隔（分）の cron。60分未満は分おき、それ以上は時間おき（24時間を超えたら1日1回） */
export function watchCron(intervalMinutes: number): string {
  if (intervalMinutes < 60) return `*/${intervalMinutes} * * * *`;
  const hours = Math.round(intervalMinutes / 60);
  return hours < 24 ? `0 */${hours} * * *` : "0 0 * * *";
}

const WATCH_PROMPT =
  "orca-flow の見張りの automation です。precheck が0以外で終わるので、この会話は普通は始まりません。始まったら何もせず終えてください。";

function parse(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    return typeof parsed.result === "object" && parsed.result !== null
      ? (parsed.result as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function orca(
  runner: Runner,
  args: string[],
  cwd: string | undefined,
): Promise<{
  ok: boolean;
  result: Record<string, unknown> | null;
  why: string;
}> {
  const r = await runner("orca", [...args, "--json"], {
    cwd,
    timeoutMs: ORCA_TIMEOUT_MS,
  });
  if (r.timedOut) return { ok: false, result: null, why: "時間切れ" };
  if (r.code !== 0)
    return {
      ok: false,
      result: null,
      why: (r.stderr || r.stdout).trim() || `終了コード ${r.code}`,
    };
  return { ok: true, result: parse(r.stdout), why: "" };
}

/** このリポジトリの見張りの automation を探す。ある・ない・分からない */
export async function findWatchAutomation(
  runner: Runner,
  root: string,
): Promise<WatchAutomationLookup> {
  const listed = await orca(runner, ["automations", "list"], root);
  if (!listed.ok)
    return { state: "unknown", reason: `orca automations list：${listed.why}` };
  const items = listed.result?.automations ?? listed.result?.items;
  if (!Array.isArray(items))
    return { state: "unknown", reason: "automations の一覧を読めませんでした" };
  const name = watchAutomationName(root);
  const hit = (items as Record<string, unknown>[]).find(
    (item) => item.name === name,
  );
  if (!hit) return { state: "missing" };
  const id = typeof hit.id === "string" ? hit.id : "";
  if (id === "")
    return { state: "unknown", reason: "automation の id を読めませんでした" };
  return {
    state: "found",
    id,
    name,
    enabled: typeof hit.enabled === "boolean" ? hit.enabled : undefined,
    lastRunAt:
      typeof hit.lastRunAt === "string" || typeof hit.lastRunAt === "number"
        ? hit.lastRunAt
        : undefined,
    precheck: typeof hit.precheck === "string" ? hit.precheck : undefined,
  };
}

/**
 * 見張りの automation を作る。すでにあれば2つ目は作らず、今の中身（precheck・cron）に直す。
 * --workspace・--reuse-session は渡さない（precheck が0以外で終わるので会話を立てない）
 */
export async function installWatchAutomation(
  runner: Runner,
  options: WatchAutomationOptions,
): Promise<WatchAutomationInstall> {
  const { root } = options;
  const precheck = watchPrecheck(root, options.env ?? currentWatchEnv());
  const found = await findWatchAutomation(runner, root);
  if (found.state === "unknown")
    throw new FlowError(
      1,
      `見張りの automation があるか確かめられません（${found.reason}）。Orca を起動してからやり直してください`,
    );
  const body = [
    "--name",
    watchAutomationName(root),
    "--trigger",
    watchCron(options.intervalMinutes),
    "--precheck",
    precheck,
    "--prompt",
    WATCH_PROMPT,
    "--provider",
    "claude",
  ];
  if (found.state === "found") {
    const r = await orca(
      runner,
      ["automations", "edit", found.id, ...body],
      root,
    );
    if (!r.ok)
      throw new FlowError(
        1,
        `見張りの automation を直せませんでした：${r.why}`,
      );
    return { action: "updated", id: found.id };
  }
  const r = await orca(
    runner,
    ["automations", "create", ...body, "--repo", `path:${root}`],
    root,
  );
  if (!r.ok)
    throw new FlowError(1, `見張りの automation を作れませんでした：${r.why}`);
  const created = r.result?.automation as Record<string, unknown> | undefined;
  const id =
    (typeof created?.id === "string" ? created.id : undefined) ??
    (typeof r.result?.id === "string" ? r.result.id : "");
  return { action: "created", id };
}

/** 見張りの automation を消す。なければ何もせず id: null */
export async function removeWatchAutomation(
  runner: Runner,
  root: string,
): Promise<WatchAutomationRemove> {
  const found = await findWatchAutomation(runner, root);
  if (found.state === "unknown")
    throw new FlowError(
      1,
      `見張りの automation があるか確かめられません（${found.reason}）。Orca を起動してからやり直してください`,
    );
  if (found.state === "missing") return { id: null };
  const r = await orca(runner, ["automations", "remove", found.id], root);
  if (!r.ok)
    throw new FlowError(1, `見張りの automation を消せませんでした：${r.why}`);
  return { id: found.id };
}

/** 落ち続けの判定の入力 */
export interface WatchStuckInput {
  enabled?: boolean;
  /** Orca が最後に流した時刻（ISO の文字列かエポックのミリ秒） */
  lastRunAt?: string | number;
  /** automation の今の precheck */
  precheck?: string;
  /** state.json の直近の回の始まりの時刻。なければ null */
  lastRoundAt: string | null;
  /** prWatch.intervalMinutes */
  intervalMinutes: number;
  /** 今の形の precheck（組めなければ null。今の形と違う扱い） */
  expectedPrecheck: string | null;
}

export interface WatchStuck {
  /** Orca が最後に流した時刻（ISO） */
  orcaRanAt: string;
  /** 直近の回の時刻（ISO）。記録がなければ null */
  lastRoundAt: string | null;
  /** automation の precheck が今の形と違う */
  outdated: boolean;
}

function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 見張りが落ち続けているか。有効で lastRunAt があり、直近の回の記録がないか、
 * lastRunAt との差が間隔の2回分（最低10分）を超えるとき。無効と lastRunAt なしは判定しない
 */
export function judgeWatchStuck(input: WatchStuckInput): WatchStuck | null {
  if (input.enabled === false) return null;
  const ran = toMs(input.lastRunAt);
  if (ran === null) return null;
  const round = toMs(input.lastRoundAt);
  const limitMs = Math.max(10, input.intervalMinutes * 2) * 60_000;
  if (round !== null && ran - round <= limitMs) return null;
  return {
    orcaRanAt: new Date(ran).toISOString(),
    lastRoundAt: round === null ? null : new Date(round).toISOString(),
    outdated:
      withoutPath(input.precheck) !==
      (input.expectedPrecheck === null
        ? null
        : withoutPath(input.expectedPrecheck)),
  };
}

/** 出す文（usage と push で同じ）。直し方まで1つの文字列 */
export function stuckMessage(id: string, stuck: WatchStuck): string {
  const first = `見張りの automation が落ち続けています（Orca は ${stuck.orcaRanAt} に流しましたが、pr-watch の回の記録が${stuck.lastRoundAt === null ? "ありません" : `${stuck.lastRoundAt} で止まっています`}）。`;
  const fix = stuck.outdated
    ? "orca-flow pr-watch install を打ち直すと、今の形に直ります（あれば今の中身に直すだけです）"
    : `precheck の出力を orca automations runs --id ${id} --json で読んでください`;
  return `${first}${fix}`;
}

/**
 * 探した結果と state.json から、落ち続けの文を決める。落ちていなければ null。
 * 読めないときも null（分からないことを落ちているとは言わない）
 */
export async function watchStuckNote(
  runner: Runner,
  root: string,
  lookup: WatchAutomationLookup,
  intervalMinutes: number,
  env: WatchEnv = currentWatchEnv(),
): Promise<string | null> {
  if (lookup.state !== "found") return null;
  try {
    const state = await readState(await watchDir(runner, root));
    let expected: string | null = null;
    try {
      expected = watchPrecheck(root, env);
    } catch {
      expected = null;
    }
    const stuck = judgeWatchStuck({
      enabled: lookup.enabled,
      lastRunAt: lookup.lastRunAt,
      precheck: lookup.precheck,
      lastRoundAt: state.lastRun?.at ?? null,
      intervalMinutes,
      expectedPrecheck: expected,
    });
    return stuck ? stuckMessage(lookup.id, stuck) : null;
  } catch {
    return null;
  }
}
