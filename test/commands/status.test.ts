import { describe, expect, it } from "vitest";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";

describe("status", () => {
  it("6つの状態が4章の表どおりの呼び出しになる", async () => {
    const root = await makeRepo({ reportsDir: "docs/reports" });
    const wt = await addTaskWorktree(root, "T12", "shop");
    const sel = `path:${wt.path}`;
    const cases: [string[], string[]][] = [
      [
        ["designing"],
        ["--workspace-status", "in-progress", "--comment", "設計中", "--read"],
      ],
      [
        ["spec-review"],
        [
          "--workspace-status",
          "in-review",
          "--comment",
          "設計書のレビュー待ち",
          "--unread",
        ],
      ],
      [
        ["working"],
        ["--workspace-status", "in-progress", "--comment", "実装中", "--read"],
      ],
      [
        ["question", "--note", "API の形"],
        ["--comment", "質問があります：API の形", "--unread"],
      ],
      [
        ["integrate-wait"],
        [
          "--workspace-status",
          "in-review",
          "--comment",
          "統合待ち：docs/reports/T12.md",
          "--unread",
        ],
      ],
      [
        ["integrated"],
        ["--workspace-status", "completed", "--comment", "統合済み", "--read"],
      ],
    ];
    for (const [argv, expected] of cases) {
      const orca = fakeOrca();
      const result = await runCli(["status", ...argv], {
        cwd: wt.path,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      expect(orca.calls).toEqual([
        ["worktree", "set", "--worktree", sel, ...expected],
      ]);
    }
  });

  it("Orca につながらなくても警告だけで終了コード0", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    orca.unavailable = true;
    const result = await runCli(["status", "working"], {
      cwd: wt.path,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("警告");
  });

  it("知らない状態とタスクでないブランチは終了コード1", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    expect(
      (
        await runCli(["status", "done"], {
          cwd: wt.path,
          runner: fakeOrca().runner,
        })
      ).code,
    ).toBe(1);
    expect(
      (
        await runCli(["status", "working"], {
          cwd: root,
          runner: fakeOrca().runner,
        })
      ).code,
    ).toBe(1);
  });

  it("--note は designing・spec-review・working・question で comment に一言をつける", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const cases: [string, string][] = [
      ["designing", "設計中：設計書を書いている"],
      ["spec-review", "設計書のレビュー待ち：設計書を書いている"],
      ["working", "実装中：設計書を書いている"],
      ["question", "質問があります：設計書を書いている"],
    ];
    for (const [state, comment] of cases) {
      const orca = fakeOrca();
      const result = await runCli(
        ["status", state, "--note", "設計書を書いている"],
        { cwd: wt.path, runner: orca.runner },
      );
      expect(result.code).toBe(0);
      const call = orca.callsOf("worktree", "set")[0]!;
      expect(call[call.indexOf("--comment") + 1]).toBe(comment);
    }
  });

  it("status working --note が comment「実装中：テストを流している」を渡す", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    const result = await runCli(
      ["status", "working", "--note", "テストを流している"],
      { cwd: wt.path, runner: orca.runner },
    );
    expect(result.code).toBe(0);
    expect(orca.calls).toEqual([
      [
        "worktree",
        "set",
        "--worktree",
        `path:${wt.path}`,
        "--workspace-status",
        "in-progress",
        "--comment",
        "実装中：テストを流している",
        "--read",
      ],
    ]);
  });

  it("integrate-wait と integrated に --note をつけると終了コード1で、orca を呼ばない", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    for (const state of ["integrate-wait", "integrated"]) {
      const orca = fakeOrca();
      const result = await runCli(["status", state, "--note", "x"], {
        cwd: wt.path,
        runner: orca.runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("--note");
      expect(orca.calls).toEqual([]);
    }
  });

  describe("integrate-wait の警告", () => {
    const wait = async (cwd: string) => {
      const orca = fakeOrca();
      const result = await runCli(["status", "integrate-wait"], {
        cwd,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      expect(orca.callsOf("worktree", "set")).toHaveLength(1);
      return result;
    };

    it("記録がなければ警告を出し、終了コードは0", async () => {
      const root = await makeRepo();
      const wt = await addTaskWorktree(root, "T12", "shop", { "a.txt": "x\n" });
      const result = await wait(wt.path);
      expect(result.err).toContain("orca-flow verify");
    });

    it("記録が今の HEAD と違えば警告を出す", async () => {
      const root = await makeRepo();
      const wt = await addTaskWorktree(root, "T12", "shop", { "a.txt": "x\n" });
      await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner });
      expect((await wait(wt.path)).err).toBe("");
      await writeFiles(wt.path, { "b.txt": "y\n" });
      await git(wt.path, "add", "-A");
      await git(wt.path, "commit", "--quiet", "-m", "足す");
      expect((await wait(wt.path)).err).toContain("HEAD と違います");
    });

    it("差分がすべて verifySkipPaths の中なら警告しない", async () => {
      const root = await makeRepo({ verifySkipPaths: ["docs/"] });
      const wt = await addTaskWorktree(root, "T12", "shop", {
        "docs/a.md": "x\n",
      });
      expect((await wait(wt.path)).err).toBe("");
    });

    it("ほかの状態では警告しない", async () => {
      const root = await makeRepo();
      const wt = await addTaskWorktree(root, "T12", "shop", { "a.txt": "x\n" });
      const result = await runCli(["status", "working"], {
        cwd: wt.path,
        runner: fakeOrca().runner,
      });
      expect(result.err).toBe("");
    });
  });
});
