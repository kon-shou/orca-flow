import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bashScreen,
  claudeScreen,
  fakeOrca,
  runCli,
} from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
} from "../helpers/repo.ts";

const mainCheck = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: mainCheck.state,
  recordMerge: vi.fn(),
  launchMainCheck: vi.fn(),
  unsentNoticeWarnings: vi.fn(async () => []),
}));

const FAILED = {
  kind: "failed",
  commit: "f".repeat(40),
  culprit: "abcdef0123456789abcdef0123456789abcdef01",
  culpritLabel: "T07",
  failedCommand: "pnpm test",
  cause: "known",
};

beforeEach(() => {
  mainCheck.state.mockReset();
  mainCheck.state.mockResolvedValue({ kind: "none" });
});

const progressConfig = { progress: { file: "docs/progress.md" } };
const progressWith = (row: string) =>
  PROGRESS.replace(
    "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
    `| T01 | 雛形   | —    | 統合済み | main         |      |\n${row}\n`,
  );

async function setup(prechanges?: string[]) {
  const root = await makeRepo(progressConfig, {
    "docs/progress.md": progressWith(
      "| T12 | 買い物 | — | 設計中 | task/T12-shop | |",
    ),
    "x.txt": "元\n",
  });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"], prechanges }),
  });
  return { root, wt };
}

describe("approve", () => {
  it("ターミナルがあれば send し、カードを working・進捗表を作業中にしてコミットする", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    orca.terminals.push(
      { handle: "term_shell", worktreePath: wt.path, title: "Terminal 1" },
      {
        handle: "term_lead",
        worktreePath: wt.path,
        title: "会話の中身",
        agentIdentity: "claude",
      },
    );
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toEqual([
      [
        "terminal",
        "send",
        "--terminal",
        "term_lead",
        "--text",
        "/clear",
        "--enter",
        "--wait-submit",
        "5",
      ],
      [
        "terminal",
        "send",
        "--terminal",
        "term_lead",
        "--text",
        "/orca-flow:run T12",
        "--enter",
        "--wait-submit",
        "5",
      ],
    ]);
    expect(orca.callsOf("agent", "launch")).toEqual([]);
    expect(orca.callsOf("worktree", "set")).toEqual([
      [
        "worktree",
        "set",
        "--worktree",
        `path:${wt.path}`,
        "--workspace-status",
        "in-progress",
        "--comment",
        "実装中",
        "--read",
      ],
    ]);
    expect(await readFile(path.join(root, "docs/progress.md"), "utf8")).toBe(
      progressWith("| T12 | 買い物 | — | 作業中 | task/T12-shop | |"),
    );
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await git(root, "log", "-1", "--format=%s")).toBe(
      "統括役: T12 の設計を承認する",
    );
  });

  it("進捗表のコミットのあとも、タスクのブランチが main を取り込んでいる（run の手順2が通る）", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      title: "claude",
      agentIdentity: "claude",
    });
    const taskHeadBefore = await git(wt.path, "rev-parse", "HEAD");
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    const mainHead = await git(root, "rev-parse", "HEAD");
    expect(await git(root, "log", "-1", "--format=%s")).toBe(
      "統括役: T12 の設計を承認する",
    );
    // main の HEAD（承認のコミット）がタスクのブランチに入っている
    expect(
      await git(wt.path, "merge-base", "--is-ancestor", mainHead, "HEAD").then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    // 前のコミットは書き換わらず、取り込む前の先頭が祖先のまま残る
    expect(
      await git(
        wt.path,
        "merge-base",
        "--is-ancestor",
        taskHeadBefore,
        "HEAD",
      ).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(await git(wt.path, "log", "-1", "--format=%s")).toBe(
      "T12: main を取り込む",
    );
  });

  it("ターミナルがなければ agent launch で lead の引数と prompt で起動する", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(orca.callsOf("agent", "launch")).toEqual([
      [
        "agent",
        "launch",
        "--agent",
        "claude",
        "--worktree",
        `path:${wt.path}`,
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high",
        "--prompt",
        "/orca-flow:run T12",
      ],
    ]);
  });

  it("Setup が先頭でも、タスク長のハンドルに送る", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    orca.terminals.push(
      { handle: "term_setup", worktreePath: wt.path, title: "Setup" },
      {
        handle: "term_lead",
        worktreePath: wt.path,
        title: "会話の中身",
        agentIdentity: "claude",
      },
    );
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(orca.callsOf("terminal", "send").map((c) => [c[3], c[5]])).toEqual([
      ["term_lead", "/clear"],
      ["term_lead", "/orca-flow:run T12"],
    ]);
    expect(orca.callsOf("agent", "launch")).toEqual([]);
  });

  it("Setup だけなら send せず agent launch を呼ぶ", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_setup",
      worktreePath: wt.path,
      title: "Setup",
    });
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(orca.callsOf("agent", "launch")).toHaveLength(1);
  });

  describe("カードを先に実装中にする", () => {
    const setCalls = (orca: ReturnType<typeof fakeOrca>) =>
      orca.calls.findIndex((c) => c[0] === "worktree" && c[1] === "set");
    const comments = (orca: ReturnType<typeof fakeOrca>) =>
      orca.callsOf("worktree", "set").map((c) => c[c.indexOf("--comment") + 1]);

    it("送る道では、カードを実装中にする呼び出しが /clear より先に来る", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        agentIdentity: "claude",
      });
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      const set = setCalls(orca);
      const clear = orca.calls.findIndex(
        (c) => c[0] === "terminal" && c[1] === "send",
      );
      expect(set).toBeGreaterThanOrEqual(0);
      expect(set).toBeLessThan(clear);
      expect(comments(orca)).toEqual(["実装中"]);
    });

    it("起動の道では、カードを実装中にする呼び出しが agent launch より先に来る", async () => {
      const { root } = await setup();
      const orca = fakeOrca();
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      const set = setCalls(orca);
      const launch = orca.calls.findIndex(
        (c) => c[0] === "agent" && c[1] === "launch",
      );
      expect(set).toBeGreaterThanOrEqual(0);
      expect(set).toBeLessThan(launch);
    });

    it("送るのに失敗したら、カードを設計書のレビュー待ちに戻して失敗を返す", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        agentIdentity: "claude",
      });
      const inner = orca.runner;
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: async (cmd, args, opts) => {
          if (cmd === "orca" && args[0] === "terminal" && args[1] === "send") {
            orca.calls.push(args.filter((a) => a !== "--json"));
            return {
              code: 1,
              stdout: JSON.stringify({
                ok: false,
                error: { message: "send_failed" },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          return inner(cmd, args, opts);
        },
      });
      expect(result.code).not.toBe(0);
      expect(comments(orca)).toEqual(["実装中", "設計書のレビュー待ち"]);
    });

    it("起動に失敗したら、カードを設計書のレビュー待ちに戻して失敗を返す", async () => {
      const { root } = await setup();
      const orca = fakeOrca();
      orca.launchTimesOut = true;
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).not.toBe(0);
      expect(comments(orca)).toEqual(["実装中", "設計書のレビュー待ち"]);
    });

    const failSecondSet = (
      inner: ReturnType<typeof fakeOrca>["runner"],
      extra?: ReturnType<typeof fakeOrca>["runner"],
    ): ReturnType<typeof fakeOrca>["runner"] => {
      let sets = 0;
      return async (cmd, args, opts) => {
        if (cmd === "orca" && args[0] === "worktree" && args[1] === "set") {
          sets += 1;
          if (sets === 2)
            return {
              code: 1,
              stdout: JSON.stringify({
                ok: false,
                error: { message: "set_failed" },
              }),
              stderr: "",
              timedOut: false,
            };
        }
        return (extra ?? inner)(cmd, args, opts);
      };
    };

    it("送るのに失敗し、カードを戻すのにも失敗したら、警告を出し、送るのに失敗した元の失敗を返す", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        agentIdentity: "claude",
      });
      const inner = orca.runner;
      const sendFails: typeof inner = async (cmd, args, opts) => {
        if (cmd === "orca" && args[0] === "terminal" && args[1] === "send")
          return {
            code: 1,
            stdout: JSON.stringify({
              ok: false,
              error: { message: "send_failed" },
            }),
            stderr: "",
            timedOut: false,
          };
        return inner(cmd, args, opts);
      };
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: failSecondSet(inner, sendFails),
      });
      expect(result.code).not.toBe(0);
      expect(result.err).toContain(
        "カードを「設計書のレビュー待ち」に戻せませんでした",
      );
      // 元の送る失敗が返り、カードを戻す失敗（set_failed）に置き換わらない
      const lastLine = result.err.trimEnd().split("\n").at(-1)!;
      expect(lastLine).toContain("send_failed");
      expect(lastLine).not.toContain("set_failed");
    });

    it("起動に失敗し、カードを戻すのにも失敗したら、警告を出し、起動の失敗を返す", async () => {
      const { root } = await setup();
      const orca = fakeOrca();
      orca.launchTimesOut = true;
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: failSecondSet(orca.runner),
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        "カードを「設計書のレビュー待ち」に戻せませんでした",
      );
      // 元の起動の失敗（時間切れ）が返り、カードを戻す失敗に置き換わらない
      const lastLine = result.err.trimEnd().split("\n").at(-1)!;
      expect(lastLine).toContain(
        "Orca のエージェントの起動が時間内に終わりませんでした",
      );
      expect(lastLine).not.toContain("set_failed");
    });

    it("入力欄の確かめで止まるときは、カードを変える呼び出しがない", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        agentIdentity: "claude",
        screenSequence: [claudeScreen(), bashScreen()],
      });
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(2);
      expect(orca.callsOf("worktree", "set")).toEqual([]);
    });

    it("カードを変えられなくても警告だけで、送る", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        agentIdentity: "claude",
      });
      const inner = orca.runner;
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: async (cmd, args, opts) => {
          if (cmd === "orca" && args[0] === "worktree" && args[1] === "set") {
            orca.calls.push(args.filter((a) => a !== "--json"));
            return {
              code: 1,
              stdout: JSON.stringify({
                ok: false,
                error: { message: "set_failed" },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          return inner(cmd, args, opts);
        },
      });
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        "警告：カードを「実装中」にできませんでした",
      );
      expect(orca.callsOf("terminal", "send")).toHaveLength(2);
    });
  });

  it("候補が2つなら終了コード2で、取り込みも進捗表のコミットも send も launch もしない", async () => {
    const { root, wt } = await setup();
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "main を進める",
    );
    const mainBefore = await git(root, "rev-parse", "HEAD");
    const wtBefore = await git(wt.path, "rev-parse", "HEAD");
    const orca = fakeOrca();
    orca.terminals.push(
      {
        handle: "term_a",
        worktreePath: wt.path,
        title: "買い物の設計",
        agentIdentity: "claude",
      },
      {
        handle: "term_b",
        worktreePath: wt.path,
        title: "レビュー観点",
        agentIdentity: "claude",
      },
    );
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("送れませんでした");
    expect(result.err).toContain("買い物の設計");
    expect(result.err).toContain("term_a");
    expect(result.err).toContain("レビュー観点");
    expect(result.err).toContain("term_b");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(orca.callsOf("agent", "launch")).toEqual([]);
    expect(orca.callsOf("worktree", "set")).toEqual([]);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtBefore);
    expect(await git(root, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("入力欄に打ちかけがあれば終了コード2で、取り込みも進捗表のコミットも send もしない", async () => {
    const { root, wt } = await setup();
    const mainBefore = await git(root, "rev-parse", "HEAD");
    const wtBefore = await git(wt.path, "rev-parse", "HEAD");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
      screen: claudeScreen("書きかけ"),
    });
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("送れませんでした");
    expect(result.err).toContain("書きかけ");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(orca.callsOf("agent", "launch")).toEqual([]);
    expect(orca.callsOf("worktree", "set")).toEqual([]);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtBefore);
    expect(await git(root, "rev-parse", "HEAD")).toBe(mainBefore);
  });

  it("入力欄が空、または draft だけに文があるなら send する", async () => {
    for (const extra of [
      { screen: claudeScreen() },
      { draft: "人の打った文" },
    ]) {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        agentIdentity: "claude",
        ...extra,
      });
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      expect(orca.callsOf("terminal", "send")).toHaveLength(2);
    }
  });

  it("claude で形がない画面・read の失敗・bash モードなら終了コード2で、取り込みも send もしない", async () => {
    for (const extra of [
      { screen: ["$ "] },
      { readFails: true },
      { screen: bashScreen() },
    ]) {
      const { root, wt } = await setup();
      const wtBefore = await git(wt.path, "rev-parse", "HEAD");
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        agentIdentity: "claude",
        ...extra,
      });
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain("送れませんでした");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
      expect(orca.callsOf("agent", "launch")).toEqual([]);
      expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtBefore);
    }
  });

  it("claude 以外なら、形がない画面でも read の失敗でも send する", async () => {
    for (const extra of [{ screen: ["$ "] }, { readFails: true }]) {
      const root = await makeRepo(
        {
          ...progressConfig,
          lead: { agent: "codex", model: "m", effort: "h" },
        },
        {
          "docs/progress.md": progressWith(
            "| T12 | 買い物 | — | 設計中 | task/T12-shop | |",
          ),
        },
      );
      const wt = await addTaskWorktree(root, "T12", "shop", {
        "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
      });
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        agentIdentity: "codex",
        ...extra,
      });
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      expect(orca.callsOf("terminal", "send")).toHaveLength(2);
    }
  });

  it("最初の確かめのあと、送る直前に bash モードなら、送らず起動もせず終了コード2。入力欄を戻して流し直すと送る", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    const term = {
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
      screenSequence: [claudeScreen(), bashScreen()],
    };
    orca.terminals.push(term);
    const result = await runCli(["approve", "T12", "--prechanges-done"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("送れませんでした");
    expect(result.err).toContain("bash モード");
    expect(result.err).toContain("orca-flow approve T12 --prechanges-done");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(orca.callsOf("agent", "launch")).toEqual([]);
    expect(orca.callsOf("worktree", "set")).toEqual([]);
    // 取り込みと進捗表のコミットは済んでいる
    expect(await git(root, "log", "-1", "--format=%s")).toBe(
      "統括役: T12 の設計を承認する",
    );

    // 入力欄が戻った（screenSequence は使い切り、screen は既定の空の入力欄）
    const again = await runCli(["approve", "T12", "--prechanges-done"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toHaveLength(2);
  });

  it("read に --screen をつけ、待ち時間は10秒", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    await runCli(["approve", "T12"], { cwd: root, runner: orca.runner });
    const reads = orca.callsOf("terminal", "read");
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read).toContain("--screen");
    expect(orca.readTimeouts).toEqual([10_000, 10_000]);
  });

  it("main への事前変更があり --prechanges-done がなければ終了コード2で何も書き換えない", async () => {
    const { root } = await setup(["`package.json` に zod を足す"]);
    const before = await git(root, "rev-parse", "HEAD");
    const orca = fakeOrca();
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("package.json");
    expect(orca.calls).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);

    const done = await runCli(["approve", "T12", "--prechanges-done"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(done.code).toBe(0);
  });

  it("設計書がコミットされていなければ終了コード1", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("設計書");
  });

  it("worktree に未コミットの変更があれば終了コード1", async () => {
    const { root, wt } = await setup();
    await writeFile(path.join(wt.path, "new.txt"), "x");
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
  });

  it("取り込みが競合したら終了コード3で、送らず、進捗表も変えない", async () => {
    const { root, wt } = await setup();
    await writeFile(path.join(wt.path, "x.txt"), "タスク\n");
    await git(wt.path, "commit", "--quiet", "-am", "T12: x を変える");
    await writeFile(path.join(root, "x.txt"), "main\n");
    await git(root, "commit", "--quiet", "-am", "main で x を変える");
    const before = await git(root, "rev-parse", "HEAD");
    const wtBefore = await git(wt.path, "rev-parse", "HEAD");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(3);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(orca.callsOf("worktree", "set")).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtBefore);
  });

  it("Orca につながらなければ終了コード1で、取り込みもしない", async () => {
    const { root, wt } = await setup();
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "main を進める",
    );
    const wtBefore = await git(wt.path, "rev-parse", "HEAD");
    const orca = fakeOrca();
    orca.unavailable = true;
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtBefore);
  });

  describe("落ちた main の警告", () => {
    const approve = async (config?: Record<string, unknown>) => {
      const { root, wt } = await setup();
      if (config) {
        const file = path.join(root, ".orca-flow/config.json");
        const current = JSON.parse(await readFile(file, "utf8"));
        await writeFile(file, JSON.stringify({ ...current, ...config }));
        await git(root, "commit", "--quiet", "-am", "設定");
        await git(wt.path, "rebase", "--quiet", "main");
      }
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt.path,
        title: "claude",
        agentIdentity: "claude",
      });
      const result = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      return { result, orca };
    };

    it("after-merge で main の確かめが落ちていたら、警告を出すだけで承認は進む", async () => {
      mainCheck.state.mockResolvedValue(FAILED);
      const { result, orca } = await approve();
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        "警告：main の確かめが T07 の時点（abcdef01）で落ちています",
      );
      expect(orca.callsOf("terminal", "send")).toHaveLength(2);
    });

    it("落ちた記録の上で確かめが流れていても、警告を出すだけで承認は進む", async () => {
      mainCheck.state.mockResolvedValue({
        ...FAILED,
        above: { kind: "pending", commit: "1".repeat(40) },
      });
      const { result, orca } = await approve();
      expect(result.code).toBe(0);
      expect(result.err).toContain("警告：main の確かめが T07 の時点");
      expect(orca.callsOf("terminal", "send")).toHaveLength(2);
    });

    it("原因を探している間も、警告を出すだけで承認は進む", async () => {
      mainCheck.state.mockResolvedValue({
        ...FAILED,
        culprit: null,
        culpritLabel: null,
        cause: "searching",
      });
      const { result } = await approve();
      expect(result.code).toBe(0);
      expect(result.err).toContain("警告：main の確かめが落ちています");
      expect(result.err).not.toContain("git revert");
    });

    it.each([
      ["stalled", "orca-flow main-check run で確かめ直してください"],
      ["searching", "orca-flow main-check で様子を見てください"],
      ["unknown", "ログを見て"],
    ])(
      "原因が分かっていない（%s）警告は cause ごとの文",
      async (cause, text) => {
        mainCheck.state.mockResolvedValue({
          ...FAILED,
          culprit: null,
          culpritLabel: null,
          cause,
        });
        const { result } = await approve();
        expect(result.code).toBe(0);
        expect(result.err).toContain(text);
        expect(result.err).not.toContain("戻すか");
      },
    );

    it("mainCheckState が投げても、警告に変えて承認は進む", async () => {
      mainCheck.state.mockRejectedValue(new Error("壊れた記録"));
      const { result } = await approve();
      expect(result.code).toBe(0);
      expect(result.err).toContain("壊れた記録");
    });

    it("通っていれば何も出さない", async () => {
      const { result } = await approve();
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
    });

    it("before-merge なら mainCheckState を呼ばない", async () => {
      mainCheck.state.mockResolvedValue(FAILED);
      const { result } = await approve({ integrateVerify: "before-merge" });
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
      expect(mainCheck.state).not.toHaveBeenCalled();
    });
  });
});
