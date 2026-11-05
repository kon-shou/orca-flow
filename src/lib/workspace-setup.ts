import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { FlowError, type ExitCode } from "../types.ts";
import { runOrThrow, type Runner } from "./exec.ts";
import {
  PSTACK_INSTALL_SOURCE,
  PSTACK_MARKETPLACE,
  PSTACK_PLUGIN,
  TRUSTED_PSTACK_SOURCES,
  classifyPstack,
} from "./pstack.ts";
import {
  WORKSPACE_FILE,
  loadWorkspace,
  parseWorkspace,
  type Workspace,
  type WorkspaceRepo,
} from "./workspace.ts";

/** プラグインの入手元の既定（docs/spec.md 12章の「はじめに1回」と同じ） */
export const DEFAULT_MARKETPLACE = "kon-shou/orca-flow";
export const PLUGIN_NAME = "orca-flow";

const CLAUDE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;

export interface SetupArgs {
  file: string | null;
  marketplace: string;
  yes: boolean;
}

/** `--setup` の引数を読む。知らない引数は FlowError(1) */
export function parseSetupArgs(argv: readonly string[]): SetupArgs {
  let file: string | null = null;
  let marketplace = DEFAULT_MARKETPLACE;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--setup") continue;
    if (arg === "--yes") {
      yes = true;
    } else if (arg === "--marketplace" || arg.startsWith("--marketplace=")) {
      const value =
        arg === "--marketplace"
          ? argv[++i]
          : arg.slice("--marketplace=".length);
      if (value === undefined || value === "" || value.startsWith("-"))
        throw new FlowError(
          1,
          "--marketplace に入手元を書いてください（例：kon-shou/orca-flow）",
        );
      marketplace = value;
    } else if (arg.startsWith("-")) {
      throw new FlowError(
        1,
        `workspace --setup が知らない引数です：${arg}（使えるのは --marketplace 〈入手元〉・--yes）`,
      );
    } else if (file === null) {
      file = arg;
    } else {
      throw new FlowError(
        1,
        `設定のファイルは1つだけ渡してください：${file}・${arg}`,
      );
    }
  }
  return { file, marketplace, yes };
}

export type PluginState =
  | { kind: "enabled"; id: string }
  | { kind: "disabled"; id: string }
  | { kind: "missing" }
  | { kind: "no-claude" }
  | { kind: "unknown"; reason: string };

/** `claude plugin list --json` から orca-flow の状態を読む */
export async function pluginState(runner: Runner): Promise<PluginState> {
  const r = await runner("claude", ["plugin", "list", "--json"], {
    timeoutMs: CLAUDE_TIMEOUT_MS,
  });
  if (r.code === 127) return { kind: "no-claude" };
  if (r.timedOut)
    return {
      kind: "unknown",
      reason: "claude plugin list が時間内に終わりませんでした",
    };
  if (r.code !== 0)
    return {
      kind: "unknown",
      reason: `claude plugin list に失敗しました：${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`,
    };
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return {
      kind: "unknown",
      reason: "claude plugin list の出力が JSON として読めません",
    };
  }
  if (!Array.isArray(list))
    return {
      kind: "unknown",
      reason: "claude plugin list の出力が思った形（配列）ではありません",
    };
  const found = list.filter(
    (p): p is { id: string; enabled?: unknown } =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as { id?: unknown }).id === "string" &&
      (p as { id: string }).id.startsWith(`${PLUGIN_NAME}@`),
  );
  if (found.length === 0) return { kind: "missing" };
  const on = found.find((p) => p.enabled === true);
  if (on) return { kind: "enabled", id: on.id };
  return { kind: "disabled", id: found[0]!.id };
}

export type PstackState =
  | { kind: "enabled"; id: string }
  | { kind: "disabled"; id: string }
  | { kind: "missing" }
  | { kind: "untrusted"; reason: string }
  | { kind: "no-claude" }
  | { kind: "unknown"; reason: string };

/** claude の一覧（JSON の配列）を1回読む。読めなければ pstack の状態として返す */
async function readList(
  runner: Runner,
  args: string[],
): Promise<{ list: unknown[] } | { state: PstackState }> {
  const what = `claude ${args.join(" ")}`;
  const r = await runner("claude", args, { timeoutMs: CLAUDE_TIMEOUT_MS });
  if (r.code === 127) return { state: { kind: "no-claude" } };
  if (r.timedOut)
    return {
      state: {
        kind: "unknown",
        reason: `${what} が時間内に終わりませんでした`,
      },
    };
  if (r.code !== 0)
    return {
      state: {
        kind: "unknown",
        reason: `${what} に失敗しました：${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`,
      },
    };
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return {
      state: {
        kind: "unknown",
        reason: `${what} の出力が JSON として読めません`,
      },
    };
  }
  if (!Array.isArray(list))
    return {
      state: {
        kind: "unknown",
        reason: `${what} の出力が思った形（配列）ではありません`,
      },
    };
  return { list };
}

/** 正でないときに外す対象（--json には出さない）。ids は pstack の id、marketplaces はマーケットプレイスの名前 */
export interface PstackRemoval {
  ids: string[];
  marketplaces: string[];
}
const noRemoval: PstackRemoval = { ids: [], marketplaces: [] };

/** プラグインとマーケットプレイスの一覧を読み、pstack の状態を決める。warning は別の入手元も有効なときの注意の1行 */
export async function pstackState(runner: Runner): Promise<{
  state: PstackState;
  warning: string | null;
  remove: PstackRemoval;
}> {
  const plugins = await readList(runner, ["plugin", "list", "--json"]);
  if ("state" in plugins)
    return { state: plugins.state, warning: null, remove: noRemoval };
  const markets = await readList(runner, [
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  if ("state" in markets)
    return { state: markets.state, warning: null, remove: noRemoval };
  const c = classifyPstack(plugins.list, markets.list);
  if (c.kind === "enabled")
    return {
      state: { kind: "enabled", id: c.id },
      warning: c.warning,
      remove: noRemoval,
    };
  if (c.kind === "untrusted")
    return {
      state: { kind: "untrusted", reason: c.reason },
      warning: null,
      remove: { ids: c.ids, marketplaces: c.marketplaces },
    };
  return { state: c, warning: null, remove: noRemoval };
}

/** 終わりの確かめで、子1つ分の結果（commands/workspace.ts の一覧と同じ確かめを渡してもらう） */
export interface ChildCheck {
  name: string;
  path: string;
  initialized: boolean | null;
  placeOk: boolean | null;
  /** 一覧と同じ書き方の、人に見せる文 */
  line: string;
}
export type CheckChildren = (workspace: Workspace) => Promise<ChildCheck[]>;

export interface SetupIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface SetupData {
  dir: string;
  yes: boolean;
  repos: { name: string; path: string; url: string | null; action: string }[];
  plugin: PluginState & { installed: boolean };
  pstack: PstackState & { installed: boolean };
  next: string[];
}

/** 何かがあるか（symlink は行き先がなくても「ある」）。ないときだけ null、あれば中身を返す */
async function readTarget(file: string): Promise<Buffer | null> {
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FlowError(1, `${WORKSPACE_FILE} を確かめられません：${file}`);
  }
  try {
    return await readFile(file);
  } catch {
    throw new FlowError(
      1,
      `今の場所の ${WORKSPACE_FILE} を読めません（行き先のないリンクなど）。上書きしません：${file}`,
    );
  }
}

const differentMessage = `今の場所に中身の違う ${WORKSPACE_FILE} があります。上書きしません。どちらが正しいか決めてから、片方を直してください`;

/** 渡された設定を読み、今の場所の設定と食い違わないか確かめる。計画に使う Workspace と、写す中身（確かめたバッファ）を返す */
async function readPlan(
  runner: Runner,
  cwd: string,
  file: string | null,
): Promise<{ workspace: Workspace; copyBuffer: Buffer | null }> {
  const dir = await realpath(cwd).catch(() => path.resolve(cwd));
  const target = path.join(dir, WORKSPACE_FILE);
  const existing = await readTarget(target);
  if (file === null) {
    if (existing === null)
      throw new FlowError(
        1,
        `${WORKSPACE_FILE} がありません。設定のファイルを渡すか（workspace --setup 〈設定のファイル〉）、ワークスペースのフォルダで流してください`,
      );
    return {
      workspace: await parseWorkspace(runner, dir, existing, {
        allowMissing: true,
      }),
      copyBuffer: null,
    };
  }
  const source = path.resolve(cwd, file);
  let sourceBuffer: Buffer;
  try {
    sourceBuffer = await readFile(source);
  } catch {
    throw new FlowError(1, `設定のファイルを読めません：${file}`);
  }
  if (existing !== null && !existing.equals(sourceBuffer))
    throw new FlowError(1, differentMessage);
  return {
    workspace: await parseWorkspace(runner, dir, sourceBuffer, {
      allowMissing: true,
    }),
    copyBuffer: existing === null ? sourceBuffer : null,
  };
}

const kindOf = (r: WorkspaceRepo) =>
  r.missing ? "clone する" : "ある（触らない）";

/** workspace --setup 本体。--yes がなければ計画を出すだけ */
export async function runSetup(
  runner: Runner,
  cwd: string,
  argv: readonly string[],
  io: SetupIO,
  json: boolean,
  checkChildren: CheckChildren,
): Promise<{ code: ExitCode; data: SetupData }> {
  const args = parseSetupArgs(argv);
  const { workspace, copyBuffer } = await readPlan(runner, cwd, args.file);
  const say = (text: string) => {
    if (!json) io.stdout(text);
  };

  const plugin0 = await pluginState(runner);
  const pstack0 = await pstackState(runner);
  if (pstack0.warning !== null) io.stderr(`${pstack0.warning}\n`);
  const data: SetupData = {
    dir: workspace.dir,
    yes: args.yes,
    repos: workspace.repos.map((r) => ({
      name: r.name,
      path: r.path,
      url: r.url ?? null,
      action: r.missing ? "clone" : "exists",
    })),
    plugin: { ...plugin0, installed: false },
    pstack: { ...pstack0.state, installed: false },
    next: [],
  };

  if (!args.yes) {
    say(
      "orca-flow workspace --setup で用意するもの（まだ何も変えていません。進めるときは --yes をつけて流してください）",
    );
    say(`ワークスペース：${workspace.dir}`);
    if (copyBuffer !== null) say(`  - ${WORKSPACE_FILE}：渡された設定を写す`);
    for (const r of workspace.repos)
      say(
        `  - ${r.name}：${kindOf(r)}${r.missing ? `（${r.url} → ${r.path}）` : `（${r.path}）`}`,
      );
    say(`  - プラグイン：${describePlugin(plugin0, args.marketplace, false)}`);
    say(`  - pstack：${describePstack(pstack0.state, pstack0.warning, false)}`);
    return { code: 0, data };
  }

  // 設定のファイルを写す（clone より先。2回目は同じ中身なので写さない）
  if (copyBuffer !== null) {
    try {
      // wx：その間に何かが置かれていたら（symlink も）上書きせず止める
      await writeFile(path.join(workspace.dir, WORKSPACE_FILE), copyBuffer, {
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new FlowError(1, differentMessage);
      throw error;
    }
    say(`${WORKSPACE_FILE} を写しました`);
  }

  // まだない子だけ clone する。落ちたらその子の名前を出して止める
  for (const r of workspace.repos) {
    if (!r.missing) {
      say(`${r.name}：あるので触りません（${r.path}）`);
      continue;
    }
    try {
      await runOrThrow(
        runner,
        "git",
        ["clone", "--", r.url!, r.path],
        "git clone",
        { cwd: workspace.dir },
      );
    } catch (error) {
      if (error instanceof FlowError)
        throw new FlowError(
          1,
          `${r.name} の clone に失敗しました（残りは流していません）：${error.message}`,
        );
      throw error;
    }
    say(`${r.name}：clone しました（${r.path}）`);
  }

  // プラグイン
  let installed = false;
  let plugin: PluginState = plugin0;
  if (plugin0.kind === "missing") {
    const r = await runner(
      "claude",
      [
        "plugin",
        "install",
        PLUGIN_NAME,
        "--marketplace",
        args.marketplace,
        "--scope",
        "user",
      ],
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    if (r.code !== 0 || r.timedOut) {
      const detail = r.timedOut
        ? "時間内に終わりませんでした"
        : (r.stderr || r.stdout).trim();
      throw new FlowError(
        1,
        `claude plugin install に失敗しました${detail ? `：${detail}` : ""}（入手元：${args.marketplace}）`,
      );
    }
    installed = true;
    say(
      `プラグイン ${PLUGIN_NAME} を入れました（入手元：${args.marketplace}）`,
    );
    plugin = { kind: "enabled", id: PLUGIN_NAME };
  } else {
    say(`プラグイン：${describePlugin(plugin0, args.marketplace, true)}`);
  }
  data.plugin = { ...plugin, installed };

  // pstack（orca-flow のあと。ないときだけ。正の入手元に決め打ち）
  let pstackInstalled = false;
  let pstack: PstackState = pstack0.state;
  let remove: PstackRemoval = pstack0.remove;
  if (pstack0.state.kind === "missing") {
    const r = await runner(
      "claude",
      [
        "plugin",
        "install",
        PSTACK_PLUGIN,
        "--marketplace",
        PSTACK_INSTALL_SOURCE,
        "--scope",
        "user",
      ],
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    if (r.code !== 0 || r.timedOut) {
      const detail = r.timedOut
        ? "時間内に終わりませんでした"
        : (r.stderr || r.stdout).trim();
      throw new FlowError(
        1,
        `claude plugin install ${PSTACK_PLUGIN} に失敗しました${detail ? `：${detail}` : ""}（入手元：${PSTACK_INSTALL_SOURCE}）。${
          installed
            ? `${PLUGIN_NAME} は入れました。Claude Code を開き直してください。`
            : ""
        }もう一度 workspace --setup --yes を流すと pstack から続けます`,
      );
    }
    // 入れたあとは読み直し、入手元が正で有効なときだけ済んだとみなす
    const after = await pstackState(runner);
    if (after.warning !== null) io.stderr(`${after.warning}\n`);
    remove = after.remove;
    pstack =
      after.state.kind === "missing"
        ? {
            kind: "unknown",
            reason: `install のあと、一覧に ${PSTACK_PLUGIN} が見えません`,
          }
        : after.state;
    if (pstack.kind === "enabled") {
      pstackInstalled = true;
      say(
        `プラグイン ${PSTACK_PLUGIN} を入れました（入手元：${PSTACK_INSTALL_SOURCE}）`,
      );
    } else {
      say(
        `pstack：入れたあとの確かめで済んだとみなせません（${describePstack(pstack, null, true)}）`,
      );
    }
  } else {
    say(`pstack：${describePstack(pstack0.state, pstack0.warning, true)}`);
  }
  data.pstack = { ...pstack, installed: pstackInstalled };

  // 終わりの確かめ：clone した子も含め、設定を厳しい読み方で読み直す
  const strict = await loadWorkspace(runner, workspace.dir);
  const children = await checkChildren(strict);
  say(`ワークスペース：${strict.dir}`);
  for (const c of children) say(c.line);

  const next: string[] = [];
  if (installed || pstackInstalled)
    next.push(
      `Claude Code を開き直してください（入れたプラグイン${[installed ? PLUGIN_NAME : "", pstackInstalled ? PSTACK_PLUGIN : ""].filter(Boolean).join("・")}はそのあとに効きます）`,
    );
  if (plugin.kind === "disabled")
    next.push(
      `プラグインが無効です。claude plugin enable ${plugin.id} で有効にして、Claude Code を開き直してください`,
    );
  if (plugin.kind === "no-claude")
    next.push(
      "claude が見つかりません。Claude Code を入れてから、もう一度 workspace --setup --yes を流してください",
    );
  if (plugin.kind === "unknown")
    next.push(`プラグインの状態を読めませんでした：${plugin.reason}`);
  if (pstack.kind === "disabled")
    next.push(
      `pstack が無効です。claude plugin enable ${pstack.id} で有効にして、Claude Code を開き直してください`,
    );
  if (pstack.kind === "untrusted") {
    const cmds = [
      ...remove.ids.map((id) => `claude plugin uninstall ${id}`),
      ...remove.marketplaces.map(
        (m) => `claude plugin marketplace remove ${m}`,
      ),
    ];
    next.push(
      `pstack は入手元が正でないため入れ直しません：${pstack.reason}。${
        cmds.length > 0
          ? `外すなら ${cmds.join(" と ")} を自分で流してから`
          : `マーケットプレイス ${PSTACK_MARKETPLACE} の入手元を直してから`
      }、もう一度 workspace --setup --yes を流してください（正の入手元：${TRUSTED_PSTACK_SOURCES.join("・")}）`,
    );
  }
  if (pstack.kind === "unknown")
    next.push(`pstack の状態を読めませんでした：${pstack.reason}`);
  const todo = children.filter((c) => c.initialized === false);
  for (const c of todo)
    next.push(
      `${c.name}：子のフォルダ（${c.path}）の統括役のタブで /orca-flow:init を流してください`,
    );
  next.push(
    '共通のある構成では、子の設定（.orca-flow/config.json など）の taskEnd を "pr" にしてください',
  );
  next.push(
    "ワークスペースのフォルダを Orca で開き、/orca-flow:intake で要件を渡してください",
  );
  data.next = next;
  if (!json) {
    io.stdout("次の手順：");
    for (const [i, n] of next.entries()) io.stdout(`  ${i + 1}. ${n}`);
  }

  const hasConfigError = children.some((c) => c.initialized === null);
  const needsWork =
    children.some((c) => c.initialized !== true || c.placeOk !== true) ||
    plugin.kind !== "enabled" ||
    pstack.kind !== "enabled";
  const code: ExitCode = hasConfigError ? 1 : needsWork ? 2 : 0;
  return { code, data };
}

function describePlugin(
  state: PluginState,
  marketplace: string,
  done: boolean,
): string {
  switch (state.kind) {
    case "enabled":
      return `${state.id} は入っていて有効（触らない）`;
    case "disabled":
      return `${state.id} は入っているが無効（自分では有効にしません。claude plugin enable ${state.id} を案内します）`;
    case "missing":
      return `claude plugin install ${PLUGIN_NAME} --marketplace ${marketplace} --scope user を流す`;
    case "no-claude":
      return `claude が見つからない（${done ? "入れられません" : "導入は飛ばします"}）`;
    case "unknown":
      return `状態を読めない（${state.reason}）`;
  }
}

function describePstack(
  state: PstackState,
  warning: string | null,
  done: boolean,
): string {
  const note = warning === null ? "" : `。${warning}`;
  switch (state.kind) {
    case "enabled":
      return `${state.id} は入っていて有効（触らない）${note}`;
    case "disabled":
      return `${state.id} は入っているが無効（自分では有効にしません。claude plugin enable ${state.id} を案内します）`;
    case "missing":
      return `claude plugin install ${PSTACK_PLUGIN} --marketplace ${PSTACK_INSTALL_SOURCE} --scope user を流す（入れると intake の /how・push の PR の本文・review の影響範囲の役が使える）`;
    case "untrusted":
      return `入手元が正でない（${state.reason}。入れ直さず、外し方を案内します）`;
    case "no-claude":
      return `claude が見つからない（${done ? "入れられません" : "導入は飛ばします"}）`;
    case "unknown":
      return `状態を読めない（${state.reason}）`;
  }
}
