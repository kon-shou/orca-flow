import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeOrderFile, writeMergeOrder } from "../../src/lib/merge-order.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const setup = async () => {
  const root = await makeRepo();
  const tasks: Record<string, string> = {};
  for (const id of ["T12", "T14", "T15"])
    tasks[id] = (await addTaskWorktree(root, id, "x")).path;
  return { root, tasks };
};
const item = (id: string, integrated = false) => ({
  id,
  integrated,
  mergeCommit: null,
});
const order = (args: string[], cwd: string) =>
  runCli(["order", ...args], { cwd, runner: fakeOrca().runner });

describe("order", () => {
  it("鎖を足し、並べ、外し、消す", async () => {
    const { root } = await setup();
    const added = await order(["T12,T14,T15"], root);
    expect(added.code).toBe(0);
    const listed = await order([], root);
    expect(listed.out).toContain("T12 → T14 → T15");
    const json = JSON.parse((await order(["--json"], root)).out);
    expect(json.chains[0].map((i: { id: string }) => i.id)).toEqual([
      "T12",
      "T14",
      "T15",
    ]);
    expect((await order(["--remove", "T14"], root)).code).toBe(0);
    expect((await order([], root)).out).toContain("T12 → T15");
    expect((await order(["--remove", "T99"], root)).code).toBe(1);
    expect((await order(["--clear"], root)).code).toBe(0);
    expect((await order([], root)).out).toContain("ありません");
    expect(existsSync(await mergeOrderFile(testRunner, root))).toBe(false);
  });

  it("ID の形・重複・1つだけ・作業中でない ID で終了コード1", async () => {
    const { root } = await setup();
    const cases: [string, string][] = [
      ["T12", "2つ以上"],
      ["T12,T12", "ID が重なっています：T12"],
      ["T12,x1", "x1"],
      ["T12,T99", "作業中のタスクではありません：T99"],
      ["T12,", "（空）"],
    ];
    for (const [arg, message] of cases) {
      const r = await order([arg], root);
      expect(r.code, arg).toBe(1);
      expect(r.err, arg).toContain(message);
    }
    expect(existsSync(await mergeOrderFile(testRunner, root))).toBe(false);
  });

  it("全部含む鎖は置き換え、一部だけなら終了コード1", async () => {
    const { root } = await setup();
    await order(["T12,T14"], root);
    const replaced = await order(["T12,T14,T15"], root);
    expect(replaced.code).toBe(0);
    expect(JSON.parse((await order(["--json"], root)).out).chains).toHaveLength(
      1,
    );
    await order(["--clear"], root);
    await order(["T12,T14"], root);
    const partial = await order(["T14,T15"], root);
    expect(partial.code).toBe(1);
    expect(partial.err).toContain("先に");
  });

  it("メインの作業ツリーでなければ、足す・外す・消すは終了コード2、一覧はできる", async () => {
    const { root, tasks } = await setup();
    await order(["T12,T14"], root);
    const cwd = tasks.T12!;
    expect((await order(["T12,T14,T15"], cwd)).code).toBe(2);
    expect((await order(["--remove", "T12"], cwd)).code).toBe(2);
    expect((await order(["--clear"], cwd)).code).toBe(2);
    const listed = await order([], cwd);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("T12 → T14");
  });

  it("一覧に「（統合済み）」の添え書きが出る", async () => {
    const { root } = await setup();
    await writeMergeOrder(testRunner, root, {
      chains: [[item("T12", true), item("T14")]],
    });
    expect((await order([], root)).out).toContain("T12（統合済み） → T14");
  });

  it("統合済みの ID を含む鎖を伸ばせて、印は引き継がれる。統合済みを後ろに置く並びは弾く", async () => {
    const { root } = await setup();
    await writeMergeOrder(testRunner, root, {
      chains: [[item("T12", true), item("T14")]],
    });
    // T12 は作業中でない（統合済み）が、伸ばせる
    const added = await order(["T12,T14,T15"], root);
    expect(added.code).toBe(0);
    const chain = JSON.parse((await order(["--json"], root)).out).chains[0];
    expect(
      chain.map((i: { id: string; integrated: boolean }) => [
        i.id,
        i.integrated,
      ]),
    ).toEqual([
      ["T12", true],
      ["T14", false],
      ["T15", false],
    ]);
    const bad = await order(["T14,T12,T15"], root);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("統合済み");
  });

  it("壊れた順のファイルでは一覧も足すも止まり、書き換えない。--clear で直せる", async () => {
    const { root } = await setup();
    const file = await mergeOrderFile(testRunner, root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ broken");
    for (const args of [[], ["T12,T14"], ["--remove", "T12"]]) {
      const r = await order(args, root);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain(file);
      expect(r.err).toContain("--clear");
    }
    expect(await readFile(file, "utf8")).toBe("{ broken");
    expect((await order(["--clear"], root)).code).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});
