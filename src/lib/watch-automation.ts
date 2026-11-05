import { ORCA_FLOW_MAIN } from "./background.ts";
import type { Runner } from "./exec.ts";
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
  | { state: "found"; id: string; name: string }
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
}

/** sh に1語として渡す形にする。Windows は " で囲む */
export function shellQuote(
  word: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return `"${word.replaceAll('"', '\\"')}"`;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * precheck の文。PATH の orca-flow に頼らず、プラグインの node と main.ts の絶対パスで呼ぶ
 * （automation はプラグインのセッションの外で動く）。作業の場所は --root で渡す
 */
export function watchPrecheck(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return [
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    ORCA_FLOW_MAIN,
    "pr-watch",
    "--root",
    root,
  ]
    .map((w) => shellQuote(w, platform))
    .join(" ");
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
  return { state: "found", id, name };
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
    watchPrecheck(root),
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
