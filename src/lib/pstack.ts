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

const marketList = (marketplaces: unknown): Record<string, unknown>[] =>
  (Array.isArray(marketplaces) ? marketplaces : []).filter(isRecord);

/** 候補1つ（id は pstack@〈マーケットプレイス〉）の入手元を確かめる。正なら source、そうでなければ理由と、一覧にある項のマーケットプレイス名（一覧になければ null） */
function checkSource(
  id: string,
  markets: Record<string, unknown>[],
): { source: string } | { reason: string; market: string | null } {
  const market = id.slice(id.lastIndexOf("@") + 1);
  const entries = markets.filter((m) => m.name === market);
  if (entries.length === 0)
    return {
      reason: `${id} のマーケットプレイス ${market} が一覧にないため、入手元を確かめられません`,
      market: null,
    };
  const sources = entries.map(trustedSourceOf);
  if (entries.some(hasRef))
    return {
      reason: `${id} の入手元に ref（ブランチ・タグ・PR などの指定）があり、本文を確かめられません`,
      market,
    };
  if (sources.some((s) => s === null || s !== sources[0]))
    return {
      reason: `${id} の入手元が、正の入手元（${TRUSTED_PSTACK_SOURCES.join("・")}）ではないか、確かめられません`,
      market,
    };
  return { source: sources[0]! };
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

  const markets = marketList(marketplaces);
  const passed: { plugin: Plugin; source: string }[] = [];
  const others: string[] = [];
  let firstReason = "";
  for (const c of candidates) {
    const checked = checkSource(c.id, markets);
    if ("reason" in checked) {
      firstReason ||= checked.reason;
      others.push(c.id);
    } else if (c.installPath === null) {
      firstReason ||= `${c.id} の installPath がなく、場所を確かめられません`;
    } else passed.push({ plugin: c, source: checked.source });
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

/** setup が入れる pstack の入手元（`TRUSTED_PSTACK_SOURCES` の1つ）。引数や設定では変えない */
export const PSTACK_INSTALL_SOURCE = "cursor/plugins";
/** 入手元のマーケットプレイスの名前（`claude plugin install` が付ける名前） */
export const PSTACK_MARKETPLACE = "cursor-plugins";
/** プラグインの名前 */
export const PSTACK_PLUGIN = "pstack";

export type PstackClass =
  | { kind: "enabled"; id: string; warning: string | null }
  | { kind: "disabled"; id: string }
  | { kind: "missing" }
  | {
      kind: "untrusted";
      reason: string;
      /** 正でない入手元と分かった pstack の id 全部（名前のぶつかりだけのときは空） */
      ids: string[];
      /** 外す必要があるマーケットプレイスの名前（cursor-plugins が原因のときだけ） */
      marketplaces: string[];
    }
  | { kind: "unknown"; reason: string };

const pstackIds = (plugins: unknown, enabled: boolean): string[] =>
  (Array.isArray(plugins) ? plugins : [])
    .filter(
      (p): p is Record<string, unknown> =>
        isRecord(p) &&
        (p.enabled === true) === enabled &&
        typeof p.id === "string" &&
        p.id.includes("@") &&
        p.id.slice(0, p.id.lastIndexOf("@")) === PSTACK_PLUGIN,
    )
    .map((p) => p.id as string);

/** 入手元を確かめて、通らなかったものを「正でない」にまとめる。通ったものが1つでもあれば null */
function untrustedOf(
  ids: string[],
  markets: Record<string, unknown>[],
): PstackClass | null {
  const bad: string[] = [];
  const marketplaces: string[] = [];
  let reason = "";
  for (const id of ids) {
    const r = checkSource(id, markets);
    if ("source" in r) return null;
    reason ||= r.reason;
    bad.push(id);
    if (r.market === PSTACK_MARKETPLACE && !marketplaces.includes(r.market))
      marketplaces.push(r.market);
  }
  return {
    kind: "untrusted",
    reason: reason || "pstack の入手元を確かめられません",
    ids: bad,
    marketplaces,
  };
}

/**
 * プラグインとマーケットプレイスの一覧から、pstack の状態を決める。
 * 有効なものは selectPstack と同じ入手元の確かめ。有効なものがなければ、無効なものを同じ確かめにかける。
 * 入手元が正なのに installPath で場所が1つに決まらないときは、正でないではなく unknown。
 * 何もなくても、マーケットプレイスに cursor-plugins の名前で入手元が違う項があれば、入れずに正でない扱いにする
 */
export function classifyPstack(
  plugins: unknown,
  marketplaces: unknown,
): PstackClass {
  const markets = marketList(marketplaces);
  const sel = selectPstack(plugins, marketplaces);
  if (sel.kind === "ok")
    return { kind: "enabled", id: sel.plugin, warning: sel.warning };
  if (sel.kind === "untrusted") {
    const bad = untrustedOf(pstackIds(plugins, true), markets);
    if (bad !== null) return bad;
    const good = pstackIds(plugins, true).filter(
      (id) => "source" in checkSource(id, markets),
    );
    return {
      kind: "unknown",
      reason: `入手元が正の pstack（${good.join("・")}）の場所が1つに決まりません（installPath がないか、2通り以上あります）。正の pstack が2つ入っているなら、どちらかを claude plugin uninstall で外してください`,
    };
  }

  // 有効なものがない。無効な pstack に同じ入手元の確かめをかける
  const off = pstackIds(plugins, false);
  if (off.length > 0) {
    const bad = untrustedOf(off, markets);
    if (bad !== null) return bad;
    const first = off.find((id) => "source" in checkSource(id, markets))!;
    return { kind: "disabled", id: first };
  }

  const clash = markets.filter(
    (m) =>
      m.name === PSTACK_MARKETPLACE &&
      trustedSourceOf(m) !== PSTACK_INSTALL_SOURCE,
  );
  if (clash.length > 0)
    return {
      kind: "untrusted",
      reason: `マーケットプレイス ${PSTACK_MARKETPLACE} がすでにあり、入手元が ${PSTACK_INSTALL_SOURCE} ではないか確かめられないため、入れません（正の入手元：${TRUSTED_PSTACK_SOURCES.join("・")}）`,
      ids: [],
      marketplaces: [PSTACK_MARKETPLACE],
    };
  return { kind: "missing" };
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
