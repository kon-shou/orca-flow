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
  /** worktree create で Orca が付けるブランチ名（既定は --name そのまま） */
  branchFor: (name: string) => string;
  /** terminal read に渡された待ち時間（ミリ秒）。呼び出しの順 */
  readTimeouts: (number | undefined)[];
  /** 背景の確かめの起動役（process.execPath で main-check run を起動する呼び出し）の引数。本物は起動しない */
  launches: (readonly string[])[];
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
    branchFor: (name) => name,
    readTimeouts: [],
    launches: [],
    callsOf: (...head) =>
      state.calls.filter((call) => head.every((h, i) => call[i] === h)),
  };

  state.runner = async (cmd, args, opts) => {
    // 背景の確かめの起動は、呼び出しだけ残して本物の子を起こさない
    if (
      cmd === process.execPath &&
      String(args[1] ?? "").includes('"main-check"')
    ) {
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
    if (group === "worktree" && action === "list") return ok({ worktrees: [] });
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
    if (group === "terminal" && action === "list") {
      const wt = flag(plain, "--worktree")!.replace(/^path:/, "");
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
