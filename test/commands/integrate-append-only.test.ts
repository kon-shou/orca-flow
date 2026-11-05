import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeMergeOrder } from "../../src/lib/merge-order.ts";
import { readReviewed } from "../../src/lib/rebase-review.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

// 背景のプロセスは差し替える
vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

const FILE = "docs/log.md";
const SUBJECT = `統括役: 取り込みで変わった${FILE}の行の並びを戻す`;
const CANNOT = `警告：${FILE} の行の並びを戻せませんでした`;

/** T12 と T14 が、追記だけのファイルの末尾に1行ずつ足す。T14 は T12 のあとで union の取り込みを受ける */
async function setup(options: { t14Text?: string; chain?: boolean } = {}) {
  const root = await makeRepo(
    {
      maxActiveTasks: 5,
      appendOnlyFiles: [FILE],
      verify: ["true"],
    },
    { [FILE]: "a\n", ".gitattributes": `${FILE} merge=union\n` },
  );
  const wts: Record<string, { path: string }> = {};
  for (const [id, src, text] of [
    ["T12", "src/shop/a.ts", "a\nt12\n"],
    ["T14", "src/shop/b.ts", options.t14Text ?? "a\nt14\n"],
  ] as const) {
    const wt = await addTaskWorktree(root, id, "shop", {
      [`docs/tasks/${id}.md`]: specDoc(id, { allowed: ["src/shop/"] }),
    });
    await writeFiles(wt.path, {
      [src]: `export const x = "${id}";\n`,
      [`docs/tasks/reports/${id}.md`]: "# 報告\n",
      [FILE]: text,
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", `${id}: 作る`);
    wts[id] = wt;
  }
  if (options.chain !== false)
    await writeMergeOrder(testRunner, root, {
      chains: [
        [
          { id: "T12", integrated: false, mergeCommit: null },
          { id: "T14", integrated: false, mergeCommit: null },
        ],
      ],
    });
  return { root, wt12: wts.T12!, wt14: wts.T14! };
}

async function verify(wt: { path: string }) {
  const result = await runCli(["verify"], {
    cwd: wt.path,
    runner: fakeOrca().runner,
  });
  expect(result.code).toBe(0);
}

async function integrate(
  root: string,
  id: string,
  wt: { path: string },
  args: string[] = [],
) {
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
  });
}

const mainText = (root: string) => git(root, "show", `main:${FILE}`);

describe("integrate：取り込みで変わった追記だけのファイルの行の並びを戻す", () => {
  it("記録を使わない道（--verify-here）の取り込みで、main の行のあとにタスクの行が並ぶ", async () => {
    const { root, wt12, wt14 } = await setup({ chain: false });
    expect((await integrate(root, "T12", wt12, ["--verify-here"])).code).toBe(
      0,
    );
    const result = await integrate(root, "T14", wt14, ["--verify-here"]);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("警告");
    expect(await mainText(root)).toBe("a\nt12\nt14");
    const log = await git(wt14.path, "log", "--format=%s", "-20");
    expect(log.split("\n").filter((s) => s === SUBJECT)).toHaveLength(1);
  });

  it("記録を使う道で main が動いて取り込みがかかるときも、並びが戻る", async () => {
    const { root, wt12, wt14 } = await setup({ chain: false });
    await verify(wt14);
    await verify(wt12);
    expect((await integrate(root, "T12", wt12)).code).toBe(0);
    const result = await integrate(root, "T14", wt14);
    expect(result.code).toBe(0);
    expect(result.out).toContain("のコンソールで通った記録を使います");
    expect(await mainText(root)).toBe("a\nt12\nt14");
  });

  it("両側が同じ行を足して union で並びが入れ替わると、戻せない警告と並びの警告を出してマージする", async () => {
    const { root, wt12, wt14 } = await setup({
      chain: false,
      t14Text: "a\nx\ny\n",
    });
    await writeFiles(wt12.path, { [FILE]: "a\nm1\nx\n" });
    await git(wt12.path, "commit", "--quiet", "-am", "T12: 足す");
    expect((await integrate(root, "T12", wt12, ["--verify-here"])).code).toBe(
      0,
    );
    const result = await integrate(root, "T14", wt14, ["--verify-here"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain(CANNOT);
    expect(result.err).toContain(
      `警告：main の ${FILE} が、タスクのブランチの ${FILE} の先頭と同じではありません`,
    );
    expect(await isMergedBranch(root)).toBe(true);
  });

  it("鎖の取り込み（前のタスクの取り込み）のあとに並びが戻り、見直しの記録が今の先頭で書き直される", async () => {
    const { root, wt12, wt14 } = await setup();
    await verify(wt12);
    await verify(wt14);
    await verify(wt12);
    expect((await integrate(root, "T12", wt12)).code).toBe(0);
    const result = await integrate(root, "T14", wt14);
    expect(result.code).toBe(0);
    expect(result.out).toContain("見直しの記録を今の先頭で書き直して");
    expect(await mainText(root)).toBe("a\nt12\nt14");
    const text = await readFile(path.join(wt14.path, FILE), "utf8");
    expect(text).toBe("a\nt12\nt14\n");
    const record = await readReviewed(testRunner, root, "T14");
    expect(record).not.toBeNull();
    expect(record!.head).toBe(await git(wt14.path, "rev-parse", "HEAD"));
  });
});

async function isMergedBranch(root: string) {
  return (
    (
      await testRunner(
        "git",
        ["merge-base", "--is-ancestor", "task/T14-shop", "main"],
        { cwd: root },
      )
    ).code === 0
  );
}
