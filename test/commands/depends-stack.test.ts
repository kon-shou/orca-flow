import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStack, writeStackAt } from "../../src/lib/stack.ts";
import { runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");

const depends = (cwd: string, ...args: string[]) =>
  runCli(["depends", ...args], { cwd, runner: testRunner });

async function stacked() {
  const root = await makeRepo();
  const front = await addTaskWorktree(root, "T01", "front", {
    "front.txt": "a\n",
  });
  const back = await addTaskWorktree(root, "T02", "back");
  await writeStackAt(
    path.join(root, ".git"),
    "T02",
    { id: "T01", branch: front.branch },
    T0,
  );
  return { root, front, back };
}

describe("depends 〈ID〉：乗せた先を出す", () => {
  it("乗せていれば乗せた先と枝を出す。乗せていなければ今までの形", async () => {
    const { root, front } = await stacked();
    const r = await depends(root, "T02");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`乗せた先：T01（${front.branch}）`);
    const j = JSON.parse((await depends(root, "T02", "--json")).out);
    expect(j.stackOn).toEqual({
      id: "T01",
      branch: front.branch,
      at: T0.toISOString(),
    });
    const plain = JSON.parse((await depends(root, "T01", "--json")).out);
    expect(plain).toEqual({ id: "T01", depends: [] });
  });
});

describe("depends 〈ID〉 --base", () => {
  it("乗せていなければ baseBranch を1行で出す", async () => {
    const root = await makeRepo();
    const r = await depends(root, "T02", "--base");
    expect(r.code).toBe(0);
    expect(r.out).toBe("main");
  });

  it("乗せた先が入る前は乗せた先の枝、入ったあとは baseBranch", async () => {
    const { root, front, back } = await stacked();
    const before = await depends(back.path, "T02", "--base");
    expect(before.code).toBe(0);
    expect(before.out).toBe(front.branch);
    const j = JSON.parse(
      (await depends(back.path, "T02", "--base", "--json")).out,
    );
    expect(j).toMatchObject({
      id: "T02",
      base: front.branch,
      stackOn: "T01",
      state: "open",
    });

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
    await git(root, "branch", "-D", front.branch);
    const after = await depends(back.path, "T02", "--base");
    expect(after.code).toBe(0);
    expect(after.out).toBe("main");
  });

  it("乗せた先が作業中にも baseBranch にもなければ終了コード2で --unstack を案内する", async () => {
    const { root, front } = await stacked();
    await git(root, "worktree", "remove", "--force", front.path);
    await git(root, "branch", "-D", front.branch);
    const r = await depends(root, "T02", "--base");
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("orca-flow depends T02 --unstack");
  });

  it("乗せた先の枝が危ない名前に変わったら、名前を出さずに終了コード1で止める", async () => {
    const { front, back } = await stacked();
    await git(front.path, "branch", "-m", "task/T01-x$(id)");
    const r = await depends(back.path, "T02", "--base");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).not.toContain("$(id)");
    expect(r.err).toContain("orca-flow depends T02 --unstack");
  });

  it("ほかの引数と一緒には付けられない", async () => {
    const root = await makeRepo();
    expect((await depends(root, "T02", "--base", "--add", "T01")).code).toBe(1);
    expect((await depends(root, "T02", "--base", "--unstack")).code).toBe(1);
    expect((await depends(root, "--on", "T01", "--base")).code).toBe(1);
  });
});

describe("depends 〈ID〉 --unstack", () => {
  it("乗せた先がまだ作業中なら終了コード2で消さない", async () => {
    const { root } = await stacked();
    const r = await depends(root, "T02", "--unstack");
    expect(r.code).toBe(2);
    expect(r.err).toContain("T01 はまだ作業中");
    expect(await readStack(testRunner, root, "T02")).not.toBeNull();
  });

  it("乗せた先が入ったあとは消し、順と依存の外し方を案内する。なければそう言う", async () => {
    const { root, front } = await stacked();
    await git(
      root,
      "merge",
      "--no-ff",
      "--quiet",
      "-m",
      "統括役: T01 をマージする",
      front.branch,
    );
    const r = await depends(root, "T02", "--unstack");
    expect(r.code).toBe(0);
    expect(r.out).toContain("消しました");
    expect(r.out).not.toContain("残っています（");
    expect(r.out).toContain("orca-flow order --remove T02");
    expect(r.out).toContain("orca-flow merge T02 --drop-depend T01");
    expect(await readStack(testRunner, root, "T02")).toBeNull();
    expect((await depends(root, "T02", "--base")).out).toBe("main");
    const again = await depends(root, "T02", "--unstack", "--json");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toEqual({ id: "T02", removed: false });
  });

  it("乗せた先がなくなったら消し、後ろの枝に残る前の枝のコミットの数を添える", async () => {
    const root = await makeRepo();
    const front = await addTaskWorktree(root, "T01", "front", {
      "front.txt": "a\n",
    });
    const backPath = path.join(path.dirname(root), "T02-back");
    await git(
      root,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "task/T02-back",
      backPath,
      front.branch,
    );
    await writeStackAt(
      path.join(root, ".git"),
      "T02",
      { id: "T01", branch: front.branch },
      T0,
    );
    await git(root, "worktree", "remove", "--force", front.path);
    const r = await depends(root, "T02", "--unstack");
    expect(r.code).toBe(0);
    expect(r.out).toContain("消しました");
    expect(r.out).toContain(
      "前の枝のコミットが後ろの枝に残っています（1 件）。外すか、自分の変更として扱うかを決めてください",
    );
    expect(r.out).toContain("orca-flow order --remove T02");
    expect(await readStack(testRunner, root, "T02")).toBeNull();
    await writeStackAt(
      path.join(root, ".git"),
      "T02",
      { id: "T01", branch: front.branch },
      T0,
    );
    const j = JSON.parse(
      (await depends(root, "T02", "--unstack", "--json")).out,
    );
    expect(j).toEqual({
      id: "T02",
      removed: true,
      stackOn: "T01",
      leftoverCommits: 1,
    });
  });

  it("壊れた記録も消せる", async () => {
    const { root } = await stacked();
    await writeFile(
      path.join(root, ".git", "orca-flow", "stack", "T02.json"),
      "{",
    );
    const r = await depends(root, "T02", "--unstack");
    expect(r.code).toBe(0);
    expect(r.out).toContain("消しました");
    expect(await readStack(testRunner, root, "T02")).toBeNull();
  });

  it("タスクの worktree では終了コード2で消さない", async () => {
    const { root, back } = await stacked();
    const r = await depends(back.path, "T02", "--unstack");
    expect(r.code).toBe(2);
    expect(await readStack(testRunner, root, "T02")).not.toBeNull();
  });
});
