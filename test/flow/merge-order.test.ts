import { describe, expect, it, vi } from "vitest";
import { readMergeOrder } from "../../src/lib/merge-order.ts";
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

const BASE = "head\nmid1\nmid2\nmid3\ntail\n";

/** T12 → T14 の2タスクが同じファイルを変える。T12 が先に入り、T14 は rebase して見直す */
async function flow(conflict: boolean, config: Record<string, unknown> = {}) {
  const root = await makeRepo(
    {
      verifySkipPaths: ["src/", "docs/"],
      maxActiveTasks: 5,
      ...config,
    },
    { "src/shared.txt": BASE },
  );
  const make = async (id: string, content: string) => {
    const wt = await addTaskWorktree(root, id, "shop", {
      [`docs/tasks/${id}.md`]: specDoc(id, { allowed: ["src/"] }),
    });
    await writeFiles(wt.path, {
      "src/shared.txt": content,
      [`docs/tasks/reports/${id}.md`]: "# 報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", `${id}: 作る`);
    return wt;
  };
  // T12 は先頭を変える。T14 は、競合なしなら末尾を、競合ありなら同じ先頭を変える
  const wt12 = await make("T12", "T12head\nmid1\nmid2\nmid3\ntail\n");
  const wt14 = await make(
    "T14",
    conflict
      ? "T14head\nmid1\nmid2\nmid3\ntail\n"
      : "head\nmid1\nmid2\nmid3\nT14tail\n",
  );
  await writeMerge(root);
  return { root, wt12, wt14 };
}

async function writeMerge(root: string) {
  const { writeMergeOrder } = await import("../../src/lib/merge-order.ts");
  await writeMergeOrder(testRunner, root, {
    chains: [
      [
        { id: "T12", integrated: false, mergeCommit: null },
        { id: "T14", integrated: false, mergeCommit: null },
      ],
    ],
  });
}

const integrate = (
  root: string,
  id: string,
  wt: { path: string },
  args: string[] = [],
) => {
  const orca = fakeOrca();
  orca.terminals.push({
    handle: `term_${id}`,
    worktreePath: wt.path,
    title: "claude",
    agentIdentity: "claude",
  });
  return runCli(["integrate", id, "--keep-worktree", ...args], {
    cwd: root,
    runner: orca.runner,
  }).then((result) => ({ result, orca }));
};

describe("マージの順の流れ（本物の git）", () => {
  // 取り込みをタスク長に頼む流れ（after-merge の取り込みは integrate-order-take.test.ts）
  it("競合なし：前のタスクのマージ → rebase → rebase-review → --done → integrate", async () => {
    const { root, wt12, wt14 } = await flow(false, {
      integrateVerify: "before-merge",
    });
    expect((await integrate(root, "T14", wt14)).result.code).toBe(2);
    expect((await integrate(root, "T12", wt12)).result.code).toBe(0);
    // 取り込んでいない
    const blocked = await integrate(root, "T14", wt14);
    expect(blocked.result.code).toBe(2);
    expect(blocked.orca.callsOf("terminal", "send")).toHaveLength(1);

    const before = await git(wt14.path, "rev-parse", "HEAD");
    await git(wt14.path, "rebase", "--quiet", "main");
    const noRecord = await integrate(root, "T14", wt14);
    expect(noRecord.result.code).toBe(2);

    const review = await runCli(["rebase-review", before], {
      cwd: wt14.path,
      runner: fakeOrca().runner,
    });
    expect(review.err).toBe("");
    expect(review.code).toBe(0);

    const done = await integrate(root, "T14", wt14);
    expect(done.result.err).toBe("");
    expect(done.result.code).toBe(0);
    expect(await git(root, "show", "main:src/shared.txt")).toBe(
      "T12head\nmid1\nmid2\nmid3\nT14tail",
    );
    expect((await readMergeOrder(testRunner, root)).chains).toEqual([]);
  });

  it("競合あり：直し方が変わると rebase-review が1で止め、見直して --done すれば通る", async () => {
    const { root, wt12, wt14 } = await flow(true);
    expect((await integrate(root, "T12", wt12)).result.code).toBe(0);

    const before = await git(wt14.path, "rev-parse", "HEAD");
    const rebase = await testRunner("git", ["rebase", "main"], {
      cwd: wt14.path,
    });
    expect(rebase.code).not.toBe(0);
    await writeFiles(wt14.path, {
      "src/shared.txt": "T12head\nT14head\nmid1\nmid2\nmid3\ntail\n",
    });
    await git(wt14.path, "add", "src/shared.txt");
    const cont = await testRunner("git", ["rebase", "--continue"], {
      cwd: wt14.path,
      env: { ...process.env, GIT_EDITOR: "true" },
    });
    expect(cont.code).toBe(0);

    const review = await runCli(["rebase-review", before], {
      cwd: wt14.path,
      runner: fakeOrca().runner,
    });
    expect(review.code).toBe(1);
    expect(review.out).toContain("src/shared.txt");
    expect(review.out).toContain("前にだけ：-head");

    // 見直しの前は通らない
    expect((await integrate(root, "T14", wt14)).result.code).toBe(2);

    const done = await runCli(["rebase-review", "--done"], {
      cwd: wt14.path,
      runner: fakeOrca().runner,
    });
    expect(done.code).toBe(0);
    const merged = await integrate(root, "T14", wt14);
    expect(merged.result.err).toBe("");
    expect(merged.result.code).toBe(0);
    expect(await git(root, "show", "main:src/shared.txt")).toContain("T14head");
  });
});
