import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { testRunner as realRunner } from "../helpers/runner.ts";
import {
  activeTasks,
  diffNames,
  isMainWorktree,
  rebaseOrAbort,
  requireIntegratorPlace,
} from "../../src/lib/git.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";

const config = structuredClone(DEFAULT_CONFIG);

describe("git：統括役の場所の確認", () => {
  it("baseBranch だけの値（型の押し付けなし）で呼べる", async () => {
    const root = await makeRepo();
    await expect(
      requireIntegratorPlace(realRunner, root, { baseBranch: "main" }),
    ).resolves.toBe(root);
  });

  it("main のメインの作業ツリーで、変更がなければ通る（追跡していないファイルはよい）", async () => {
    const root = await makeRepo();
    await writeFile(path.join(root, "scratch.txt"), "x");
    await expect(
      requireIntegratorPlace(realRunner, root, config),
    ).resolves.toBe(root);
    // 下のフォルダから呼んでもトップを返す
    await writeFiles(root, { "sub/a.txt": "a" });
    await expect(
      requireIntegratorPlace(realRunner, path.join(root, "sub"), config),
    ).resolves.toBe(root);
  });

  it("baseBranch 以外のブランチなら終了コード2", async () => {
    const root = await makeRepo();
    await git(root, "switch", "--quiet", "-c", "other");
    await expect(
      requireIntegratorPlace(realRunner, root, config),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("worktree の中なら終了コード2", async () => {
    const root = await makeRepo();
    const wt = path.join(path.dirname(root), "wt-main");
    // main を別の worktree に出すため、メインは別のブランチにしておく
    await git(root, "switch", "--quiet", "-c", "hold");
    await git(root, "worktree", "add", "--quiet", wt, "main");
    expect(await isMainWorktree(realRunner, wt)).toBe(false);
    await expect(
      requireIntegratorPlace(realRunner, wt, config),
    ).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining("worktree"),
    });
  });

  it("追跡中のファイルに未コミットの変更があれば終了コード2", async () => {
    const root = await makeRepo();
    await writeFile(path.join(root, "README.md"), "変えた\n");
    await expect(
      requireIntegratorPlace(realRunner, root, config),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe("git：作業中のタスク", () => {
  it("worktree のあるタスクのブランチを並べ、マージ済みは含めない", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T01", "fresh"); // コミットがまだない
    const t02 = await addTaskWorktree(root, "T02", "done", { "a.txt": "a" });
    await addTaskWorktree(root, "T03", "doing", { "b.txt": "b" });
    // worktree のないタスクのブランチは含めない
    await git(root, "branch", "task/T04-nowt");
    await git(
      root,
      "merge",
      "--quiet",
      "--no-ff",
      t02.branch,
      "-m",
      "merge T02",
    );

    const tasks = await activeTasks(realRunner, root, config);
    expect(tasks.map((t) => t.id)).toEqual(["T01", "T03"]);
    expect(tasks[1]!.branch).toBe("task/T03-doing");
  });
});

describe("git：rebase", () => {
  it("競合したら abort して終了コード3、worktree は元のまま", async () => {
    const root = await makeRepo({}, { "x.txt": "元\n" });
    const wt = await addTaskWorktree(root, "T01", "a", { "x.txt": "タスク\n" });
    await writeFile(path.join(root, "x.txt"), "main\n");
    await git(root, "commit", "--quiet", "-am", "main を進める");
    const headBefore = await git(wt.path, "rev-parse", "HEAD");

    await expect(
      rebaseOrAbort(realRunner, wt.path, "main", "T01"),
    ).rejects.toMatchObject({
      code: 3,
      message: expect.stringContaining("x.txt"),
    });

    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "branch", "--show-current")).toBe(wt.branch);
    const gitDir = await git(wt.path, "rev-parse", "--absolute-git-dir");
    expect(existsSync(path.join(gitDir, "rebase-merge"))).toBe(false);
    expect(existsSync(path.join(gitDir, "rebase-apply"))).toBe(false);
  });

  it("競合しなければ main の上に載る", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T01", "a", { "a.txt": "a\n" });
    await writeFiles(root, { "b.txt": "b\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "main を進める");
    await rebaseOrAbort(realRunner, wt.path, "main", "T01");
    expect(
      await git(wt.path, "merge-base", "--is-ancestor", "main", "HEAD").then(
        () => true,
      ),
    ).toBe(true);
    expect(await diffNames(realRunner, root, "main", wt.branch)).toEqual([
      "a.txt",
    ]);
  });
});

describe("git：diffNames", () => {
  it("git mv したファイルは、移動元と移動先の両方を返す", async () => {
    const root = await makeRepo({}, { "old/a.txt": "同じ内容\n".repeat(5) });
    const wt = await addTaskWorktree(root, "T01", "a");
    await mkdir(path.join(wt.path, "new"), { recursive: true });
    await git(wt.path, "mv", "old/a.txt", "new/a.txt");
    await git(wt.path, "commit", "--quiet", "-m", "移す");
    expect(
      (await diffNames(realRunner, root, "main", wt.branch)).sort(),
    ).toEqual(["new/a.txt", "old/a.txt"]);
  });
});
