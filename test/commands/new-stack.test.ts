import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { readDepends } from "../../src/lib/depends.ts";
import {
  mergeOrderFile,
  readMergeOrder,
  writeMergeOrder,
} from "../../src/lib/merge-order.ts";
import { readStack } from "../../src/lib/stack.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

async function setup() {
  const root = await makeRepo({ maxActiveTasks: 5 });
  const front = await addTaskWorktree(root, "T01", "front", {
    "front.txt": "前\n",
  });
  return { root, front };
}

const item = (id: string) => ({ id, integrated: false, mergeCommit: null });

describe("new --stack-on：乗せて始める", () => {
  it("乗せた先の枝を土台に作り、依存・乗せる記録・マージの順を書く", async () => {
    const { root, front } = await setup();
    const orca = fakeOrca();
    const r = await runCli(
      ["new", "--title", "b", "--slug", "back", "--stack-on", "T01"],
      { cwd: root, runner: orca.runner },
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const [create] = orca.callsOf("worktree", "create");
    expect(create![create!.indexOf("--base-branch") + 1]).toBe(front.branch);
    const wt = path.join(path.dirname(root), "T02-back");
    expect(await readFile(path.join(wt, "front.txt"), "utf8")).toBe("前\n");

    expect(await readDepends(testRunner, root, "T02")).toEqual(["T01"]);
    expect(await readStack(testRunner, root, "T02")).toMatchObject({
      id: "T02",
      on: "T01",
      branch: front.branch,
    });
    expect(await readMergeOrder(testRunner, root)).toEqual({
      chains: [[item("T01"), item("T02")]],
    });
  });

  it("依存を重ねず、乗せた先が鎖にいればその鎖の末尾に足す", async () => {
    const { root } = await setup();
    await addTaskWorktree(root, "T03", "mid");
    await writeMergeOrder(testRunner, root, {
      chains: [[item("T01"), item("T03")]],
    });
    const r = await runCli(
      [
        "new",
        "--title",
        "b",
        "--slug",
        "back",
        "--depends",
        "T01,T00",
        "--stack-on",
        "T01",
      ],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.code).toBe(0);
    expect(await readDepends(testRunner, root, "T04")).toEqual(["T01", "T00"]);
    expect(await readMergeOrder(testRunner, root)).toEqual({
      chains: [[item("T01"), item("T03"), item("T04")]],
    });
  });

  it("乗せないときは同じ ID の古い乗せる記録を消す", async () => {
    const { root } = await setup();
    const first = await runCli(
      ["new", "--title", "b", "--slug", "back", "--stack-on", "T01"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(first.code).toBe(0);
    const wt = path.join(path.dirname(root), "T02-back");
    await git(root, "worktree", "remove", "--force", wt);
    await git(root, "branch", "-D", "task/T02-back");
    const again = await runCli(
      ["new", "--title", "c", "--slug", "again", "--id", "T02"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(again.code).toBe(0);
    expect(await readStack(testRunner, root, "T02")).toBeNull();
  });
});

describe("new：マージの順の名残", () => {
  it("乗せずに始めると、同じ ID の名残を順から外す", async () => {
    const { root } = await setup();
    await addTaskWorktree(root, "T03", "mid");
    await writeMergeOrder(testRunner, root, {
      chains: [[item("T01"), item("T03"), item("T04")]],
    });
    const r = await runCli(
      ["new", "--title", "c", "--slug", "again", "--id", "T04"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.code).toBe(0);
    expect(await readMergeOrder(testRunner, root)).toEqual({
      chains: [[item("T01"), item("T03")]],
    });
  });

  it("順がなければ、乗せずに始めても順の記録を作らない", async () => {
    const { root } = await setup();
    const r = await runCli(["new", "--title", "c", "--slug", "plain"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(r.code).toBe(0);
    await expect(
      stat(path.join(root, ".git", "orca-flow", "merge-order.json")),
    ).rejects.toThrow();
  });

  it("順のファイルが壊れていても、乗せずに始めると警告だけで作る", async () => {
    const { root } = await setup();
    const file = await mergeOrderFile(testRunner, root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{");
    const orca = fakeOrca();
    const r = await runCli(["new", "--title", "c", "--slug", "plain"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(r.code).toBe(0);
    expect(orca.callsOf("worktree", "create")).toHaveLength(1);
    expect(r.err).toContain(
      "警告：マージの順から同じ ID の名残を外せませんでした",
    );
    expect(await readFile(file, "utf8")).toBe("{");
  });

  it("順のファイルが壊れていると、乗せて始めるのは終了コード1で止まり worktree を作らない", async () => {
    const { root } = await setup();
    const file = await mergeOrderFile(testRunner, root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{");
    const orca = fakeOrca();
    const r = await runCli(
      ["new", "--title", "b", "--slug", "back", "--stack-on", "T01"],
      { cwd: root, runner: orca.runner },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("マージの順のファイルが壊れています");
    expect(orca.callsOf("worktree", "create")).toEqual([]);
  });

  it("Orca が失敗したあと、乗せずにやり直すと鎖が残らない", async () => {
    const { root } = await setup();
    const down = fakeOrca();
    down.unavailable = true;
    const failed = await runCli(
      ["new", "--title", "b", "--slug", "back", "--stack-on", "T01"],
      { cwd: root, runner: down.runner },
    );
    expect(failed.code).not.toBe(0);
    const again = await runCli(
      ["new", "--title", "b", "--slug", "back", "--id", "T02"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(again.code).toBe(0);
    expect(await readMergeOrder(testRunner, root)).toEqual({ chains: [] });
  });

  it("Orca が失敗したあと、乗せてやり直しても ID は1回だけ並ぶ", async () => {
    const { root } = await setup();
    const down = fakeOrca();
    down.unavailable = true;
    const args = ["new", "--title", "b", "--slug", "back", "--stack-on", "T01"];
    expect(
      (await runCli(args, { cwd: root, runner: down.runner })).code,
    ).not.toBe(0);
    const again = await runCli([...args, "--id", "T02"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(again.code).toBe(0);
    expect(await readMergeOrder(testRunner, root)).toEqual({
      chains: [[item("T01"), item("T02")]],
    });
  });
});

describe("new --stack-on：断るとき", () => {
  /** 断ったとき、Orca を呼ばず、記録も順も作らない */
  async function refused(root: string, args: string[], text: string) {
    const orca = fakeOrca();
    const r = await runCli(["new", "--title", "b", "--slug", "back", ...args], {
      cwd: root,
      runner: orca.runner,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain(text);
    expect(orca.callsOf("worktree", "create")).toEqual([]);
    const common = path.join(root, ".git", "orca-flow");
    for (const kind of ["stack", "depends"]) {
      const files = await readdir(path.join(common, kind)).catch(() => []);
      expect(files).toEqual([]);
    }
    await expect(stat(path.join(common, "merge-order.json"))).rejects.toThrow();
  }

  it("統合済みの ID", async () => {
    const { root, front } = await setup();
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
    await refused(root, ["--stack-on", "T01"], "統合済み");
  });

  it("作業中でない ID", async () => {
    const { root } = await setup();
    await refused(root, ["--stack-on", "T07"], "作業中");
  });

  it("自分の ID", async () => {
    const { root } = await setup();
    await refused(root, ["--id", "T05", "--stack-on", "T05"], "自分");
  });

  it("形の外れた ID", async () => {
    const { root } = await setup();
    await refused(root, ["--stack-on", "X1"], "形");
    await refused(root, ["--stack-on", ""], "--stack-on");
  });

  it("乗せた先のブランチ名に安全でない文字がある", async () => {
    const { root, front } = await setup();
    await git(front.path, "branch", "-m", "task/T01-x$(id)");
    await refused(root, ["--stack-on", "T01"], "ブランチ名");
  });

  it("2つ以上の ID", async () => {
    const { root } = await setup();
    await addTaskWorktree(root, "T03", "mid");
    await refused(root, ["--stack-on", "T01,T03"], "1つ");
  });
});
