import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDepends, writeDependsAt } from "../../src/lib/depends.ts";
import { findMissingTasks } from "../../src/lib/merge-check.ts";
import { runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");

const depends = (cwd: string, ...args: string[]) =>
  runCli(["depends", ...args], { cwd, runner: testRunner });

const recordFile = (root: string, id: string) =>
  path.join(root, ".git", "orca-flow", "depends", `${id}.json`);

describe("depends 〈ID〉", () => {
  it("記録がなければ「依存はありません」", async () => {
    const root = await makeRepo();
    const r = await depends(root, "T02");
    expect(r.code).toBe(0);
    expect(r.out).toContain("依存はありません");
    const j = await depends(root, "T02", "--json");
    expect(JSON.parse(j.out)).toEqual({ id: "T02", depends: [] });
  });

  it("記録の並びを出す。タスクの worktree からでも読める", async () => {
    const root = await makeRepo();
    await writeDependsAt(path.join(root, ".git"), "T02", ["T01", "T01a"], T0);
    const wt = await addTaskWorktree(root, "T02", "x", { "a.txt": "a\n" });
    const r = await depends(wt.path, "T02");
    expect(r.code).toBe(0);
    expect(r.out).toContain("T01、T01a");
  });

  it("記録が壊れていれば終了コード1", async () => {
    const root = await makeRepo();
    await mkdir(path.dirname(recordFile(root, "T02")), { recursive: true });
    await writeFile(recordFile(root, "T02"), "{");
    expect((await depends(root, "T02")).code).toBe(1);
    const add = await depends(root, "T02", "--add", "T01");
    expect(add.code).toBe(1);
    expect(await readFile(recordFile(root, "T02"), "utf8")).toBe("{");
  });
});

describe("depends 〈ID〉 --add", () => {
  it("記録がなければ作り、重ねずに足す", async () => {
    const root = await makeRepo();
    const first = await depends(root, "T02", "--add", "T01,T01a", "--json");
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toEqual({
      id: "T02",
      added: ["T01", "T01a"],
      depends: ["T01", "T01a"],
    });
    const second = await depends(root, "T02", "--add", "T01a,T01b");
    expect(second.code).toBe(0);
    expect(await readDepends(testRunner, root, "T02")).toEqual([
      "T01",
      "T01a",
      "T01b",
    ]);
    const again = await depends(root, "T02", "--add", "T01", "--json");
    expect(JSON.parse(again.out).added).toEqual([]);
    expect(await readDepends(testRunner, root, "T02")).toHaveLength(3);
  });

  it("統括役の場所でなければ終了コード2で書かない", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T03", "x", { "a.txt": "a\n" });
    const r = await depends(wt.path, "T02", "--add", "T01");
    expect(r.code).toBe(2);
    expect(await readDepends(testRunner, root, "T02")).toEqual([]);

    await git(root, "switch", "--quiet", "-c", "other");
    const off = await depends(root, "T02", "--add", "T01");
    expect(off.code).toBe(2);
    expect(await readDepends(testRunner, root, "T02")).toEqual([]);
  });

  it("形の違う ID は終了コード1で、記録を変えない", async () => {
    const root = await makeRepo();
    await writeDependsAt(path.join(root, ".git"), "T02", ["T01"], T0);
    const before = await readFile(recordFile(root, "T02"), "utf8");
    for (const bad of ["../x1", "12", "T01,x", "T02"]) {
      const r = await depends(root, "T02", "--add", bad);
      expect(r.code).toBe(1);
    }
    expect((await depends(root, "../x1", "--add", "T01")).code).toBe(1);
    expect(await readFile(recordFile(root, "T02"), "utf8")).toBe(before);
  });

  it("足した依存で merge の依存の確かめが止まる", async () => {
    const root = await makeRepo();
    const ref = "main";
    expect(
      await findMissingTasks(
        testRunner,
        root,
        { integratorName: "統括役" },
        "T02",
        ref,
      ),
    ).toEqual([]);
    await addTaskWorktree(root, "T01a", "child", { "c.txt": "c\n" });
    expect((await depends(root, "T02", "--add", "T01a")).code).toBe(0);
    const missing = await findMissingTasks(
      testRunner,
      root,
      { integratorName: "統括役" },
      "T02",
      ref,
    );
    expect(missing.map((m) => [m.id, m.via])).toEqual([["T01a", "depend"]]);
  });
});

describe("depends --on 〈ID〉", () => {
  it("その ID を依存に持つ作業中のタスクだけを並べる", async () => {
    const root = await makeRepo();
    const common = path.join(root, ".git");
    await addTaskWorktree(root, "T02", "a", { "a.txt": "a\n" });
    await addTaskWorktree(root, "T03", "b", { "b.txt": "b\n" });
    await addTaskWorktree(root, "T04", "c", { "c.txt": "c\n" });
    await writeDependsAt(common, "T02", ["T01"], T0);
    await writeDependsAt(common, "T03", ["T05"], T0);
    // 作業中でない（worktree がない）タスクの記録は並べない
    await writeDependsAt(common, "T09", ["T01"], T0);
    const r = await depends(root, "--on", "T01");
    expect(r.code).toBe(0);
    expect(r.out).toContain("T02");
    expect(r.out).not.toContain("T03");
    expect(r.out).not.toContain("T09");
    const j = await depends(root, "--on", "T01", "--json");
    expect(JSON.parse(j.out)).toEqual({ on: "T01", tasks: ["T02"] });
  });

  it("作業中のタスクの記録が1つでも壊れていれば終了コード1", async () => {
    const root = await makeRepo();
    const common = path.join(root, ".git");
    await addTaskWorktree(root, "T02", "a", { "a.txt": "a\n" });
    await addTaskWorktree(root, "T03", "b", { "b.txt": "b\n" });
    await writeDependsAt(common, "T02", ["T01"], T0);
    await mkdir(path.dirname(recordFile(root, "T03")), { recursive: true });
    await writeFile(recordFile(root, "T03"), "{");
    expect((await depends(root, "--on", "T01")).code).toBe(1);
    expect((await depends(root, "--on", "T01", "--json")).code).toBe(1);
  });

  it("持つタスクがなければ空", async () => {
    const root = await makeRepo();
    const j = await depends(root, "--on", "T01", "--json");
    expect(JSON.parse(j.out)).toEqual({ on: "T01", tasks: [] });
  });

  it("ID と一緒には使えない", async () => {
    const root = await makeRepo();
    expect((await depends(root, "T02", "--on", "T01")).code).toBe(1);
    expect((await depends(root)).code).toBe(1);
  });
});
