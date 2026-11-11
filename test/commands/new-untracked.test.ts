import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { makeRepo } from "../helpers/repo.ts";

function withHooks(orca: ReturnType<typeof fakeOrca>, hooks: unknown | "fail") {
  const inner: Runner = orca.runner;
  orca.runner = async (cmd, args, opts) => {
    if (cmd === "orca" && args[0] === "repo" && args[1] === "show") {
      if (hooks === "fail")
        return { code: 1, stdout: "", stderr: "down", timedOut: false };
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { repo: { hookSettings: hooks } },
        }),
        stderr: "",
        timedOut: false,
      };
    }
    return inner(cmd, args, opts);
  };
}

const good = {
  scripts: { setup: 'bash "$ORCA_ROOT_PATH/.orca-flow/setup.sh"' },
  setupAgentStartupPolicy: "wait-for-setup",
};
const args = ["new", "--title", "a", "--slug", "a"];

describe("new（untracked）", () => {
  for (const [name, hooks] of [
    [
      "setup が空",
      { scripts: { setup: "" }, setupAgentStartupPolicy: "wait-for-setup" },
    ],
    [
      "start-immediately",
      { ...good, setupAgentStartupPolicy: "start-immediately" },
    ],
  ] as const) {
    it(`${name}なら worktree を作らず終了コード2で直し方を出す`, async () => {
      const root = await makeRepo({ untracked: true });
      const orca = fakeOrca();
      withHooks(orca, hooks);
      const result = await runCli(args, { cwd: root, runner: orca.runner });
      expect(result.code).toBe(2);
      expect(result.err).toContain(
        name === "setup が空"
          ? 'bash "$ORCA_ROOT_PATH/.orca-flow/setup.sh"'
          : "wait-for-setup",
      );
      expect(orca.callsOf("worktree", "create")).toEqual([]);
    });
  }

  it("そろっていれば今までどおり worktree を作る", async () => {
    const root = await makeRepo({ untracked: true });
    const orca = fakeOrca();
    withHooks(orca, good);
    const result = await runCli(args, { cwd: root, runner: orca.runner });
    expect(result.code).toBe(0);
    expect(orca.callsOf("worktree", "create")).toHaveLength(1);
  });

  it("Orca に聞けなければ警告を出して進む", async () => {
    const root = await makeRepo({ untracked: true });
    const orca = fakeOrca();
    withHooks(orca, "fail");
    const result = await runCli(args, { cwd: root, runner: orca.runner });
    expect(result.code).toBe(0);
    expect(result.err).toContain("警告");
  });

  it("untracked でなければ画面の設定を読まない", async () => {
    const root = await makeRepo({});
    const orca = fakeOrca();
    await runCli(args, { cwd: root, runner: orca.runner });
    expect(orca.callsOf("repo", "show")).toEqual([]);
  });
});
