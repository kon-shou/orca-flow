import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { activeTasks, requireActiveTask } from "../../src/lib/git.ts";
import { stackState, writeStackAt } from "../../src/lib/stack.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const config = structuredClone(DEFAULT_CONFIG);
const T0 = new Date("2026-01-01T00:00:00.000Z");
const common = (root: string) => path.join(root, ".git");

/** 乗せた先の枝から後ろのタスクの worktree を作り、乗せる記録を書く（自分のコミットはまだない） */
async function addStackedWorktree(
  root: string,
  id: string,
  slug: string,
  on: { id: string; branch: string },
): Promise<{ path: string; branch: string }> {
  const branch = `task/${id}-${slug}`;
  const wt = path.join(path.dirname(root), `${id}-${slug}`);
  await git(root, "worktree", "add", "--quiet", "-b", branch, wt, on.branch);
  await writeStackAt(common(root), id, on, T0);
  return { path: wt, branch };
}

async function commitIn(wt: string, file: string, message: string) {
  await writeFiles(wt, { [file]: `${message}\n` });
  await git(wt, "add", "-A");
  await git(wt, "commit", "--quiet", "-m", message);
}

const mergeNoFf = (root: string, branch: string, message: string) =>
  git(root, "merge", "--no-ff", "--quiet", "-m", message, branch);

const ids = async (root: string) =>
  (await activeTasks(testRunner, root, config)).map((t) => t.id);

/** 前（T01）と、それに乗せて自分のコミットのない後ろ（T02）。前を --no-ff で main に入れる（枝は残す） */
async function frontMergedBeforeBackCommits() {
  const root = await makeRepo();
  const front = await addTaskWorktree(root, "T01", "front", {
    "front.txt": "a\n",
  });
  const back = await addStackedWorktree(root, "T02", "back", {
    id: "T01",
    branch: front.branch,
  });
  await mergeNoFf(root, front.branch, "統括役: T01 をマージする");
  return { root, front, back };
}

describe("乗せたタスクの作業中の見分け", () => {
  it("自分のコミットがないうちに乗せた先が入っても、後ろは作業中に残る", async () => {
    const { root, back } = await frontMergedBeforeBackCommits();
    // 前提：後ろの先頭は main の祖先になっている
    await git(root, "merge-base", "--is-ancestor", back.branch, "main");
    expect(await ids(root)).toEqual(["T02"]);
    const task = await requireActiveTask(testRunner, root, config, "T02");
    expect(task).toMatchObject({ id: "T02", branch: back.branch });
  });

  it("後ろが自分のコミットを持ち、乗せた先のあとに入ったら作業中から外れる", async () => {
    const { root, back } = await frontMergedBeforeBackCommits();
    await commitIn(back.path, "back.txt", "T02: 設計書を書く");
    expect(await ids(root)).toContain("T02");
    await mergeNoFf(root, back.branch, "統括役: T02 をマージする");
    expect(await ids(root)).not.toContain("T02");
  });

  it("乗せていないタスクは、件名を問わず --no-ff で入ればマージ済み、コミットがなければ作業中", async () => {
    const root = await makeRepo();
    const done = await addTaskWorktree(root, "T01", "done", {
      "done.txt": "a\n",
    });
    await addTaskWorktree(root, "T02", "empty");
    await mergeNoFf(root, done.branch, "手で");
    expect(await ids(root)).toEqual(["T02"]);
  });

  it("乗せた先の枝が手元になければ、乗せたタスクも祖先で見分ける", async () => {
    const { root, front } = await frontMergedBeforeBackCommits();
    await git(root, "worktree", "remove", "--force", front.path);
    await git(root, "branch", "-D", front.branch);
    expect(await ids(root)).toEqual([]);
  });

  it("乗せる記録が壊れていても投げず、先頭が main の祖先の乗せたタスクを一覧に残す", async () => {
    const { root } = await frontMergedBeforeBackCommits();
    const file = path.join(common(root), "orca-flow", "stack", "T02.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{");
    expect(await ids(root)).toEqual(["T02"]);
    await writeFile(file, JSON.stringify({ id: "T02", on: "T01" }));
    expect(await ids(root)).toEqual(["T02"]);
  });

  it("前・中・後ろと2段に乗せ、中と後ろにコミットがないうちに前が入っても、後ろの土台は中の枝のまま", async () => {
    const root = await makeRepo();
    const front = await addTaskWorktree(root, "T01", "front", {
      "front.txt": "a\n",
    });
    const middle = await addStackedWorktree(root, "T02", "middle", {
      id: "T01",
      branch: front.branch,
    });
    const back = await addStackedWorktree(root, "T03", "back", {
      id: "T02",
      branch: middle.branch,
    });
    await mergeNoFf(root, front.branch, "統括役: T01 をマージする");
    expect(await ids(root)).toEqual(["T02", "T03"]);
    const state = await stackState(testRunner, back.path, config, "T03");
    expect(state).toMatchObject({
      kind: "open",
      base: middle.branch,
      task: { id: "T02", branch: middle.branch },
    });
    expect(await stackState(testRunner, root, config, "T02")).toMatchObject({
      kind: "merged",
      base: "main",
    });
  });
});
