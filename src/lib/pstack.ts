import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";

/** 本文を読んで確かめた、pstack の正の入手元（GitHub の owner/repo）。設定には持たない */
export const TRUSTED_PSTACK_SOURCES: readonly string[] = [
  "cursor/plugins",
  "painhardcore/pstack",
];

/** claude の1回の呼び出しを打ち切るまでのミリ秒 */
export const CLAUDE_TIMEOUT_MS = 30_000;

export type PstackSelection =
  | {
      kind: "ok";
      plugin: string;
      installPath: string;
      source: string;
      /** 別の入手元の pstack も有効なときの注意の1行。なければ null */
      warning: string | null;
    }
  | { kind: "none" }
  | { kind: "untrusted"; reason: string };

interface Plugin {
  id: string;
  installPath: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/** github の repo か git の url から「owner/repo」（小文字）を取り出す。github.com でなければ null */
export function githubRepoOf(url: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/(?:[^/@]+@)?|git:\/\/|git\+ssh:\/\/(?:[^/@]+@)?|[^/@\s]+@)github\.com(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** ref（ブランチ・タグ・PR などの指定）がついているか。空文字列・ない・文字列でないものは「ない」 */
const hasRef = (entry: Record<string, unknown>): boolean =>
  typeof entry.ref === "string" && entry.ref !== "";

/** マーケットプレイス1件の入手元が正なら、正の定数の綴りで返す。確かめられなければ null */
function trustedSourceOf(entry: Record<string, unknown>): string | null {
  if (hasRef(entry)) return null;
  const source = str(entry.source);
  let repo: string | null = null;
  if (source === "github") {
    const r = str(entry.repo);
    repo =
      r === null
        ? null
        : r
            .trim()
            .replace(/\.git$/i, "")
            .toLowerCase();
  } else if (source === "git") {
    const u = str(entry.url);
    repo = u === null ? null : githubRepoOf(u);
  }
  if (repo === null) return null;
  return TRUSTED_PSTACK_SOURCES.find((s) => s.toLowerCase() === repo) ?? null;
}

/** プラグインの一覧とマーケットプレイスの一覧から、読んでよい pstack を選ぶ */
export function selectPstack(
  plugins: unknown,
  marketplaces: unknown,
): PstackSelection {
  const candidates: Plugin[] = [];
  for (const p of Array.isArray(plugins) ? plugins : []) {
    if (!isRecord(p) || p.enabled !== true) continue;
    const id = str(p.id);
    if (id === null || !id.includes("@")) continue;
    if (id.slice(0, id.lastIndexOf("@")) !== "pstack") continue;
    candidates.push({ id, installPath: str(p.installPath) });
  }
  if (candidates.length === 0) return { kind: "none" };

  const markets = (Array.isArray(marketplaces) ? marketplaces : []).filter(
    isRecord,
  );
  const passed: { plugin: Plugin; source: string }[] = [];
  const others: string[] = [];
  let firstReason = "";
  for (const c of candidates) {
    const market = c.id.slice(c.id.lastIndexOf("@") + 1);
    const entries = markets.filter((m) => m.name === market);
    let reason = "";
    let source: string | null = null;
    if (entries.length === 0)
      reason = `${c.id} のマーケットプレイス ${market} が一覧にないため、入手元を確かめられません`;
    else {
      const sources = entries.map(trustedSourceOf);
      if (entries.some(hasRef))
        reason = `${c.id} の入手元に ref（ブランチ・タグ・PR などの指定）があり、本文を確かめられません`;
      else if (sources.some((s) => s === null || s !== sources[0]))
        reason = `${c.id} の入手元が、正の入手元（${TRUSTED_PSTACK_SOURCES.join("・")}）ではないか、確かめられません`;
      else source = sources[0]!;
    }
    if (source === null) {
      firstReason ||= reason;
      others.push(c.id);
    } else if (c.installPath === null) {
      firstReason ||= `${c.id} の installPath がなく、場所を確かめられません`;
    } else passed.push({ plugin: c, source });
  }
  if (passed.length === 0) return { kind: "untrusted", reason: firstReason };
  const paths = new Set(passed.map((x) => x.plugin.installPath));
  if (paths.size > 1)
    return {
      kind: "untrusted",
      reason: `入手元が正の pstack の installPath が ${paths.size} 通りあり、どれを読むか決められません`,
    };
  const first = passed[0]!;
  return {
    kind: "ok",
    plugin: first.plugin.id,
    installPath: first.plugin.installPath!,
    source: first.source,
    warning:
      others.length === 0
        ? null
        : `注意：別の入手元の pstack（${others.join("・")}）も有効です。読むのは正の入手元のものだけです`,
  };
}

/** 相対パスの形を確かめる。正しくなければ FlowError(1) */
export function checkRelativePath(rel: string): void {
  if (rel.trim() === "")
    throw new FlowError(1, "pstack の中の相対パスを書いてください");
  if (
    path.posix.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    /^[A-Za-z]:/.test(rel)
  )
    throw new FlowError(1, `相対パスで書いてください：${rel}`);
  if (rel.split(/[\\/]+/).includes(".."))
    throw new FlowError(1, `「..」を含む相対パスは使えません：${rel}`);
  if (rel.includes("\0"))
    throw new FlowError(1, "相対パスに使えない文字があります");
}

const within = (root: string, file: string) => {
  const r = path.relative(root, file);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};

const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

export interface PstackFile {
  file: string;
  harness: string | null;
  plugin: string;
  source: string;
  warning: string | null;
}

async function claudeJson(runner: Runner, args: string[]): Promise<unknown> {
  const what = `claude ${args.join(" ")}`;
  const r = await runner("claude", args, { timeoutMs: CLAUDE_TIMEOUT_MS });
  if (r.timedOut)
    throw new FlowError(1, `${what} が時間内に終わりませんでした`);
  if (r.code === 127)
    throw new FlowError(
      1,
      "claude が見つかりません。pstack の場所を引けません",
    );
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
    throw new FlowError(
      1,
      `${what} に失敗しました${detail ? `：${detail}` : ""}`,
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new FlowError(1, `${what} の出力が JSON として読めません`);
  }
}

async function claudeList(runner: Runner, args: string[]): Promise<unknown[]> {
  const v = await claudeJson(runner, args);
  if (!Array.isArray(v))
    throw new FlowError(
      1,
      `claude ${args.join(" ")} の出力が思った形（配列）ではありません`,
    );
  return v;
}

/** 入手元を確かめて、pstack の中のファイルの場所を返す。終了コード1・2のときは FlowError */
export async function resolvePstackFile(
  runner: Runner,
  rel: string,
): Promise<PstackFile> {
  checkRelativePath(rel);
  const plugins = await claudeList(runner, ["plugin", "list", "--json"]);
  const markets = await claudeList(runner, [
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  const sel = selectPstack(plugins, markets);
  if (sel.kind === "none")
    throw new FlowError(1, "pstack が入っていません（有効なものがありません）");
  if (sel.kind === "untrusted") throw new FlowError(2, sel.reason);

  const root = path.resolve(sel.installPath);
  const file = path.resolve(root, rel);
  if (!within(root, file))
    throw new FlowError(1, `pstack の外に出る相対パスです：${rel}`);
  if (!isFile(file))
    throw new FlowError(1, `pstack にファイルがありません：${rel}`);
  // シンボリックリンクで外に出ていないか
  try {
    if (!within(realpathSync(root), realpathSync(file)))
      throw new FlowError(1, `pstack の外に出る相対パスです：${rel}`);
  } catch (e) {
    if (e instanceof FlowError) throw e;
    throw new FlowError(1, `pstack のファイルを確かめられません：${rel}`);
  }
  const harnessFile = path.join(root, "docs", "harness", "claude-code.md");
  const harness = isFile(harnessFile) ? harnessFile : null;
  if (harness !== null) {
    try {
      if (!within(realpathSync(root), realpathSync(harness)))
        throw new FlowError(
          1,
          "pstack の harness の手引きが pstack の外を指しています",
        );
    } catch (e) {
      if (e instanceof FlowError) throw e;
      throw new FlowError(1, "pstack の harness の手引きを確かめられません");
    }
  }
  return {
    file,
    harness,
    plugin: sel.plugin,
    source: `github:${sel.source}`,
    warning: sel.warning,
  };
}
