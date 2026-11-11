import path from "node:path";
import type { Runner, RunResult } from "../../src/lib/exec.ts";
import { testRunner as realRunner } from "./runner.ts";
import { main } from "../../src/cli.ts";

export interface FakeTerminal {
  handle: string;
  worktreePath: string;
  title?: string;
  /** Orca がそのターミナルで今動いているエージェントにつける名前。シェルにはつかない */
  agentIdentity?: string;
  connected?: boolean;
  writable?: boolean;
  orphaned?: boolean;
  /** terminal read --screen の tail。書かなければ入力欄が空の Claude Code の画面 */
  screen?: string[];
  /**
   * Orca が入力欄の文として取り出す draft（1.4.237 の本物の形：人の打った文は draft に入り、
   * screen を書かなければ tail の入力欄は「❯」だけ）
   */
  draft?: string;
  /** 読むたびに先頭から1つずつ使う画面。使い切ったら screen */
  screenSequence?: string[][];
  /** true にすると terminal read が失敗する */
  readFails?: boolean;
}

/** orca automations runs の1回分（本物と同じ欄だけ） */
export interface FakeAutomationRun {
  id?: string;
  status?: string;
  scheduledFor?: number;
  startedAt?: number | null;
  /** precheck を流した回だけ入る。今すぐ実行の回は null */
  precheckResult?: {
    startedAt: number;
    completedAt?: number;
    exitCode?: number;
  } | null;
}

/** precheck を流した回を1つ作る。at は ISO 文字列かミリ秒 */
export function precheckRun(at: string | number): FakeAutomationRun {
  const ms = typeof at === "number" ? at : Date.parse(at);
  return { status: "ok", startedAt: ms, precheckResult: { startedAt: ms } };
}

export interface FakeAutomation {
  id: string;
  name: string;
  trigger?: string;
  /** 本物の一覧は { command } の入れ物で返す。テストから文字列を直接入れてもよい */
  precheck?: string | { command: string; timeoutSeconds?: number };
  prompt?: string;
  provider?: string;
  repo?: string;
  workspace?: string;
  reuseSession?: boolean;
}

const LINE = "─".repeat(40);

/** Claude Code の画面（1.4.237 の tail の形）。draft が長ければ次の行に続ける */
export function claudeScreen(
  draft = "",
  continuation: string[] = [],
): string[] {
  return [
    "● 了解しました。",
    "",
    LINE,
    draft === "" ? "❯" : `❯ ${draft}`,
    ...continuation.map((c) => `  ${c}`),
    LINE,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ];
}

/** bash モードの画面（1.4.237：入力欄の行が「! 〜」のまま tail に残り、下の行は「! for shell mode」） */
export function bashScreen(command = "echo hi"): string[] {
  return [
    "● 了解しました。",
    "",
    LINE,
    `! ${command}`,
    LINE,
    "  ! for shell mode",
  ];
}

export interface FakeOrca {
  runner: Runner;
  /** orca に渡された引数（--json は除く） */
  calls: string[][];
  terminals: FakeTerminal[];
  /** true にすると orca が動いていないふりをする */
  unavailable: boolean;
  /** true にすると file open が失敗する */
  fileOpenFails: boolean;
  /** true にすると terminal close が失敗する */
  closeFails: boolean;
  /** worktree create で Orca が付けるブランチ名（既定は --name そのまま） */
  branchFor: (name: string) => string;
  /** terminal read に渡された待ち時間（ミリ秒）。呼び出しの順 */
  readTimeouts: (number | undefined)[];
  /** 背景の確かめの起動役（process.execPath で main-check run を起動する呼び出し）の引数。本物は起動しない */
  launches: (readonly string[])[];
  /** orca automations の偽物の中身（create で増え、remove で減る） */
  automations: FakeAutomation[];
  /** ここに入れた worktree の terminal list が失敗する */
  terminalListFailsFor: string[];
  /** true にすると agent launch が時間切れ（timedOut）になる。呼び出しは記録に残る */
  launchTimesOut: boolean;
  /** true にすると orca automations list だけが失敗する */
  automationsListFails: boolean;
  /** automation の id ごとの回の履歴（新しい順で入れる）。runs は --id で絞り --limit で切る */
  automationRuns: Record<string, FakeAutomationRun[]>;
  /** true にすると orca automations runs だけが失敗する */
  automationRunsFail: boolean;
  /**
   * true にすると、worktree set --comment で書いた一言を worktree list が返す（既定は空の一覧）。
   * 書いていない worktree の一言は worktreeComments に入れて渡す
   */
  trackComments: boolean;
  /** worktree のパスごとの今の一言（trackComments のときだけ一覧に出る） */
  worktreeComments: Record<string, string>;
  /** true にすると worktree list だけが失敗する */
  worktreeListFails: boolean;
  /** 指定の頭の呼び出しだけを取り出す */
  callsOf: (...head: string[]) => string[][];
}

const ok = (result: unknown): RunResult => ({
  code: 0,
  stdout: JSON.stringify({ id: "x", ok: true, result }),
  stderr: "",
  timedOut: false,
});

const flag = (args: readonly string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** git などは本物に、orca だけを偽物に回す Runner */
export function fakeOrca(): FakeOrca {
  const state: FakeOrca = {
    runner: async () => ok(null),
    calls: [],
    terminals: [],
    unavailable: false,
    fileOpenFails: false,
    closeFails: false,
    branchFor: (name) => name,
    readTimeouts: [],
    launches: [],
    automations: [],
    automationsListFails: false,
    automationRuns: {},
    automationRunsFail: false,
    terminalListFailsFor: [],
    launchTimesOut: false,
    trackComments: false,
    worktreeComments: {},
    worktreeListFails: false,
    callsOf: (...head) =>
      state.calls.filter((call) => head.every((h, i) => call[i] === h)),
  };

  state.runner = async (cmd, args, opts) => {
    // 背景の起動（main-check・push --watch など）は、呼び出しだけ残して本物の子を起こさない
    if (cmd === process.execPath) {
      state.launches.push(args);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (cmd !== "orca") return realRunner(cmd, args, opts);
    const plain = args.filter((a) => a !== "--json");
    state.calls.push(plain);
    if (state.unavailable)
      return {
        code: 1,
        stdout: "",
        stderr: "Could not connect to Orca. Is Orca running?",
        timedOut: false,
      };
    const [group, action] = plain;
    if (group === "file" && action === "open") {
      if (state.fileOpenFails)
        return {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { message: "renderer_unavailable" },
          }),
          stderr: "",
          timedOut: false,
        };
      return ok({ opened: true });
    }
    if (group === "automations") {
      const fail = (message: string): RunResult => ({
        code: 1,
        stdout: JSON.stringify({ ok: false, error: { message } }),
        stderr: "",
        timedOut: false,
      });
      const fields = (a: FakeAutomation) => {
        a.name = flag(plain, "--name") ?? a.name;
        a.trigger = flag(plain, "--trigger") ?? a.trigger;
        const pre = flag(plain, "--precheck");
        if (pre !== undefined)
          a.precheck = { command: pre, timeoutSeconds: 30 };
        a.prompt = flag(plain, "--prompt") ?? a.prompt;
        a.provider = flag(plain, "--provider") ?? a.provider;
        a.repo = flag(plain, "--repo") ?? a.repo;
        a.workspace = flag(plain, "--workspace") ?? a.workspace;
        if (plain.includes("--reuse-session")) a.reuseSession = true;
        return a;
      };
      if (action === "list") {
        if (state.automationsListFails) return fail("list_failed");
        return ok({
          automations: state.automations,
          orphanCount: 0,
        });
      }
      if (action === "runs") {
        if (state.automationRunsFail) return fail("runs_failed");
        const runId = flag(plain, "--id");
        if (!runId) return fail("missing_id");
        const limit = Number(flag(plain, "--limit") ?? Infinity);
        const all = state.automationRuns[runId] ?? [];
        return ok({ runs: all.slice(0, limit) });
      }
      if (action === "create") {
        const a = fields({
          id: `auto-${state.automations.length + 1}`,
          name: "",
        });
        state.automations.push(a);
        return ok({ automation: a });
      }
      const id = plain[2] ?? flag(plain, "--id");
      const hit = state.automations.find((a) => a.id === id);
      if (!hit) return fail("automation_not_found");
      if (action === "show") return ok({ automation: hit });
      if (action === "edit") return ok({ automation: fields(hit) });
      if (action === "remove") {
        state.automations = state.automations.filter((a) => a !== hit);
        return ok({ removed: true });
      }
      return ok({});
    }
    if (group === "worktree" && action === "list") {
      if (state.worktreeListFails)
        return {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { message: "list_failed" },
          }),
          stderr: "",
          timedOut: false,
        };
      if (!state.trackComments) return ok({ worktrees: [] });
      return ok({
        worktrees: Object.entries(state.worktreeComments).map(
          ([p, comment]) => ({
            id: `wt-${p}`,
            path: p,
            branch: null,
            isMainWorktree: false,
            comment,
          }),
        ),
      });
    }
    if (group === "worktree" && action === "set") {
      const wt = flag(plain, "--worktree")?.replace(/^path:/, "");
      const comment = flag(plain, "--comment");
      if (wt !== undefined && comment !== undefined)
        state.worktreeComments[wt] = comment;
      return ok({});
    }
    if (group === "worktree" && action === "create") {
      const repo = flag(plain, "--repo")!.replace(/^path:/, "");
      const name = flag(plain, "--name")!;
      const base = flag(plain, "--base-branch") ?? "main";
      const branch = state.branchFor(name);
      const wt = path.join(path.dirname(repo), name);
      const result = await realRunner(
        "git",
        ["worktree", "add", "--quiet", "-b", branch, wt, base],
        { cwd: repo },
      );
      if (result.code !== 0) return { ...result, code: 1 };
      // Setup のシェルが先、タスク長のターミナルが後（題名は会話の中身に書き換わる）
      state.terminals.push(
        {
          handle: `setup_${name}`,
          worktreePath: wt,
          title: "Setup",
        },
        {
          handle: `term_${name}`,
          worktreePath: wt,
          title: "シニアエンジニアのレビュー観点",
          agentIdentity: flag(plain, "--agent"),
        },
      );
      return ok({
        worktree: {
          id: `repo::${wt}`,
          path: wt,
          branch: `refs/heads/${branch}`,
        },
      });
    }
    if (group === "worktree" && action === "rm") {
      const wt = flag(plain, "--worktree")!.replace(/^path:/, "");
      const result = await realRunner("git", ["worktree", "remove", wt], {
        cwd: opts?.cwd,
      });
      if (result.code !== 0) return { ...result, code: 1 };
      state.terminals = state.terminals.filter((t) => t.worktreePath !== wt);
      return ok({ removed: true });
    }
    if (group === "agent" && action === "launch" && state.launchTimesOut)
      return { code: 1, stdout: "", stderr: "", timedOut: true };
    if (group === "terminal" && action === "list") {
      const wt = flag(plain, "--worktree")!.replace(/^path:/, "");
      if (state.terminalListFailsFor.includes(wt))
        return {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { message: "list_failed" },
          }),
          stderr: "",
          timedOut: false,
        };
      return ok({
        terminals: state.terminals
          .filter((t) => t.worktreePath === wt)
          .map((t) => ({
            handle: t.handle,
            worktreePath: t.worktreePath,
            title: t.title ?? "Terminal 1",
            connected: t.connected ?? true,
            writable: t.writable ?? true,
            orphaned: t.orphaned ?? false,
            ...(t.agentIdentity !== undefined
              ? { agentIdentity: t.agentIdentity }
              : {}),
          })),
      });
    }
    if (group === "terminal" && action === "close") {
      const handle = flag(plain, "--terminal");
      if (state.closeFails)
        return {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { message: "close_failed" },
          }),
          stderr: "",
          timedOut: false,
        };
      state.terminals = state.terminals.filter((t) => t.handle !== handle);
      return ok({ closed: true });
    }
    if (group === "terminal" && action === "read") {
      const handle = flag(plain, "--terminal");
      state.readTimeouts.push(opts?.timeoutMs);
      const t = state.terminals.find((x) => x.handle === handle);
      if (!t || t.readFails)
        return {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { message: "terminal_not_found" },
          }),
          stderr: "",
          timedOut: false,
        };
      // --screen がない read は画面（tail）を返さない
      if (!plain.includes("--screen"))
        return ok({
          terminal: {
            handle,
            status: "idle",
            tail: [],
            source: "scrollback",
          },
        });
      const tail = t.screenSequence?.shift() ?? t.screen ?? claudeScreen();
      return ok({
        terminal: {
          handle,
          status: "idle",
          tail,
          ...(t.draft !== undefined ? { draft: t.draft } : {}),
          source: "screen",
        },
      });
    }
    return ok({});
  };
  return state;
}

/** cli の main を偽の Runner で動かし、出力を集める */
export async function runCli(
  argv: string[],
  options: { cwd: string; runner: Runner },
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd: options.cwd,
    runner: options.runner,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
