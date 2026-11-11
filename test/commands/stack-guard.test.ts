import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { writeStackAt } from "../../src/lib/stack.ts";
import { readRecord } from "../../src/lib/verified.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

/** 前のタスク T01 と、その枝に乗せた後ろのタスク T02（報告まで書いた統合待ち） */
async function setup(config: Record<string, unknown> = {}) {
  const root = await makeRepo({
    verify: ["true"],
    maxActiveTasks: 5,
    ...config,
  });
  const front = await addTaskWorktree(root, "T01", "front", {
    "docs/tasks/T01.md": specDoc("T01", { allowed: ["front.txt"] }),
    "front.txt": "前\n",
  });
  const back = {
    path: path.join(path.dirname(root), "T02-back"),
    branch: "task/T02-back",
  };
  await git(
    root,
    "worktree",
    "add",
    "--quiet",
    "-b",
    back.branch,
    back.path,
    front.branch,
  );
  await writeFiles(back.path, {
    "docs/tasks/T02.md": specDoc("T02", { allowed: ["back.txt"] }),
    "docs/tasks/reports/T02.md": "# 報告\n",
    "back.txt": "後ろ\n",
  });
  await git(back.path, "add", "-A");
  await git(back.path, "commit", "--quiet", "-m", "T02: 作る");
  await writeStackAt(
    path.join(root, ".git"),
    "T02",
    { id: "T01", branch: front.branch },
    new Date(),
  );
  return { root, front, back };
}

function withLead(worktree: string) {
  const orca = fakeOrca();
  orca.terminals.push({
    handle: "term_lead",
    worktreePath: worktree,
    title: "claude",
    agentIdentity: "claude",
  });
  return orca;
}

const inMain = async (root: string, branch: string) =>
  (
    await testRunner("git", ["merge-base", "--is-ancestor", branch, "main"], {
      cwd: root,
    })
  ).code === 0;

describe("乗せたタスクの integrate", () => {
  it("乗せた先が入っていなければ、--skip-order を付けても終了コード2で止める", async () => {
    const { root, back } = await setup();
    for (const extra of [[], ["--skip-order"]]) {
      const orca = withLead(back.path);
      const r = await runCli(
        ["integrate", "T02", "--keep-worktree", ...extra],
        { cwd: root, runner: orca.runner },
      );
      expect(r.code).toBe(2);
      expect(r.err).toContain("T01");
      expect(r.err).toContain("マージしていません");
      expect(await inMain(root, back.branch)).toBe(false);
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    }
  });

  it("乗せた先が見つからなければ終了コード2で、--unstack を案内する", async () => {
    const { root, front, back } = await setup();
    await git(root, "worktree", "remove", "--force", front.path);
    await git(root, "branch", "-D", front.branch);
    const r = await runCli(["integrate", "T02", "--skip-order"], {
      cwd: root,
      runner: withLead(back.path).runner,
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--unstack");
    expect(await inMain(root, back.branch)).toBe(false);
  });

  it("乗せている間の verify の記録では、乗せた先が入ったあとも速い道を通らない", async () => {
    const { root, front, back } = await setup();
    const verified = await runCli(["verify"], {
      cwd: back.path,
      runner: fakeOrca().runner,
    });
    expect(verified.code).toBe(0);
    expect((await readRecord(testRunner, root, "T02"))?.stackedOn).toBe("T01");

    await git(
      root,
      "merge",
      "--no-ff",
      "--quiet",
      "-m",
      "統括役: T01 をマージする",
      front.branch,
    );
    await git(root, "worktree", "remove", "--force", front.path);

    const orca = withLead(back.path);
    const r = await runCli(["integrate", "T02", "--keep-worktree"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("verify の記録が使えない");
    expect(r.err).toContain("乗せている間");
    expect(await inMain(root, back.branch)).toBe(false);

    // 入ったあとに verify をやり直せば、記録で入る
    const again = await runCli(["verify"], {
      cwd: back.path,
      runner: fakeOrca().runner,
    });
    expect(again.code).toBe(0);
    const ok = await runCli(["integrate", "T02", "--keep-worktree"], {
      cwd: root,
      runner: withLead(back.path).runner,
    });
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    expect(await inMain(root, back.branch)).toBe(true);
  });
});

describe("乗せたタスクの push", () => {
  it("乗せた先が入っていなければ終了コード2で止め、案を積まない", async () => {
    const { root, back } = await setup();
    const orca = withLead(back.path);
    const gh: string[][] = [];
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "gh") {
        gh.push([...args]);
        return {
          code: 0,
          stdout: args[0] === "pr" ? "[]" : "ok",
          stderr: "",
          timedOut: false,
        };
      }
      if (cmd === "git" && args[0] === "push")
        throw new Error("git push を流してはいけない");
      return orca.runner(cmd, args, opts);
    };
    const r = await runCli(["push", "T02", "--body-file", "x.md"], {
      cwd: root,
      runner,
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("T01");
    expect(r.err).toContain("push も PR もしていません");
    expect(gh.some((a) => a[0] === "pr" && a[1] === "create")).toBe(false);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
  });
});
