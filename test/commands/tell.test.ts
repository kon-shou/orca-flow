import { describe, expect, it } from "vitest";
import {
  bashScreen,
  claudeScreen,
  fakeOrca,
  runCli,
  type FakeTerminal,
} from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

describe("tell", () => {
  it("先頭に「（統括役より）」をつけてタスク長のターミナルに送る", async () => {
    const root = await makeRepo({ integratorName: "まとめ役" });
    const wt = await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_1",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    const result = await runCli(["tell", "T12", "git", "rebase", "をして"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toEqual([
      [
        "terminal",
        "send",
        "--terminal",
        "term_1",
        "--text",
        "（まとめ役より）git rebase をして",
        "--enter",
      ],
    ]);
  });

  it("Setup だけなら終了コード2で、send を1回も呼ばない", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_setup",
      worktreePath: wt.path,
      title: "Setup",
    });
    const result = await runCli(["tell", "T12", "やあ"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("送れませんでした");
    expect(result.err).toContain("見つかりません");
    expect(result.err).toContain("開き直してください");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
  });

  it("Setup が先頭でも、タスク長のターミナルに送る", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
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
    const result = await runCli(["tell", "T12", "やあ"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(orca.callsOf("terminal", "send").map((c) => c[3])).toEqual([
      "term_lead",
    ]);
  });

  it("候補が2つなら終了コード2で送らず、候補の題名を並べる", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
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
    const result = await runCli(["tell", "T12", "やあ"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("送れませんでした");
    expect(result.err).toContain("1つに決まりません");
    expect(result.err).toContain("買い物の設計");
    expect(result.err).toContain("term_a");
    expect(result.err).toContain("レビュー観点");
    expect(result.err).toContain("term_b");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
  });

  describe("入力欄の確かめ", () => {
    const tellWith = async (terminal: Partial<FakeTerminal>) => {
      const root = await makeRepo();
      const wt = await addTaskWorktree(root, "T12", "shop");
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_1",
        worktreePath: wt.path,
        agentIdentity: "claude",
        ...terminal,
      });
      const result = await runCli(["tell", "T12", "やあ"], {
        cwd: root,
        runner: orca.runner,
      });
      return { result, orca };
    };

    it("打ちかけがあれば終了コード2で送らない", async () => {
      const { result, orca } = await tellWith({
        screen: claudeScreen("書きかけ"),
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain("送れませんでした");
      expect(result.err).toContain("書きかけ");
      expect(result.err).toContain("送るか消してから");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });

    it("入力欄が空の画面なら送る", async () => {
      const { result, orca } = await tellWith({ screen: claudeScreen() });
      expect(result.code).toBe(0);
      expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    });

    it("claude で横線と「❯」の形がない画面なら、終了コード2で送らない", async () => {
      const { result, orca } = await tellWith({ screen: ["$ ls", "a b"] });
      expect(result.code).toBe(2);
      expect(result.err).toContain("送れませんでした");
      expect(result.err).toContain("入力欄を確かめられません");
      expect(result.err).toContain("入力欄に戻してから");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });

    it("claude で read が失敗したら、終了コード2で送らない", async () => {
      const { result, orca } = await tellWith({ readFails: true });
      expect(result.code).toBe(2);
      expect(result.err).toContain("入力欄を確かめられません");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });

    it("bash モードの画面なら、終了コード2で送らず、bash モードのことを伝える", async () => {
      const { result, orca } = await tellWith({ screen: bashScreen() });
      expect(result.code).toBe(2);
      expect(result.err).toContain("送れませんでした");
      expect(result.err).toContain("bash モード");
      expect(result.err).toContain("抜けてから");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });

    it("draft に文があり入力欄が「❯」だけなら送る（draft は見ない）", async () => {
      const { result, orca } = await tellWith({ draft: "人の打ちかけ" });
      expect(result.code).toBe(0);
      expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    });

    it("read に --screen をつけ、待ち時間は10秒", async () => {
      const { orca } = await tellWith({});
      const reads = orca.callsOf("terminal", "read");
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain("--screen");
      expect(orca.readTimeouts).toEqual([10_000]);
    });

    it("40文字の打ちかけ（改行つき）は、30文字と「…」に切って伝える", async () => {
      const first = "あ".repeat(10);
      const second = `${"い".repeat(19)}${"B".repeat(10)}`;
      const { result, orca } = await tellWith({
        screen: claudeScreen(first, [second]),
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain(`「${first} ${"い".repeat(19)}…」`);
      expect(result.err).not.toContain("B");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });
  });

  describe("lead.agent が claude 以外のとき", () => {
    const tellAs = async (terminal: Partial<FakeTerminal>) => {
      const root = await makeRepo({
        lead: { agent: "codex", model: "m", effort: "high" },
      });
      const wt = await addTaskWorktree(root, "T12", "shop");
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_1",
        worktreePath: wt.path,
        agentIdentity: "codex",
        ...terminal,
      });
      const result = await runCli(["tell", "T12", "やあ"], {
        cwd: root,
        runner: orca.runner,
      });
      return { result, orca };
    };

    it.each([
      ["形がない画面", { screen: ["$ ls", "a b"] }],
      ["read の失敗", { readFails: true }],
      ["bash モードの画面", { screen: bashScreen() }],
    ] as [string, Partial<FakeTerminal>][])(
      "%sでも、確かめずに送る",
      async (_name, extra) => {
        const { result, orca } = await tellAs(extra);
        expect(result.code).toBe(0);
        expect(orca.callsOf("terminal", "send")).toHaveLength(1);
      },
    );

    it("「❯」の行に文字があれば送らない", async () => {
      const { result, orca } = await tellAs({
        screen: claudeScreen("書きかけ"),
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain("書きかけ");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });
  });

  it("作業中でないタスクは終了コード1", async () => {
    const root = await makeRepo();
    const result = await runCli(["tell", "T99", "やあ"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
  });
});
