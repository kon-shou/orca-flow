import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  addChain,
  applyAutoOrder,
  mergeOrderFile,
  mergeOrderLockFile,
  planAutoOrder,
  withOrderLock,
  orderBefore,
  orderRelation,
  readMergeOrder,
  recordIntegrated,
  removeId,
  writeMergeOrder,
  type MergeOrder,
} from "../../src/lib/merge-order.ts";
import { makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const item = (id: string, integrated = false) => ({
  id,
  integrated,
  mergeCommit: null,
});
const order = (...chains: string[][]): MergeOrder => ({
  chains: chains.map((c) => c.map((id) => item(id))),
});

describe("addChain", () => {
  it("鎖を足す", () => {
    const r = addChain(order(["T01", "T02"]), ["T12", "T14", "T15"]);
    expect(r.ok && r.order.chains).toHaveLength(2);
  });
  it("2つ未満・重複は失敗", () => {
    expect(addChain(order(), ["T12"]).ok).toBe(false);
    expect(addChain(order(), ["T12", "T12"]).ok).toBe(false);
  });
  it("全部含めば置き換え、印を引き継ぐ。一部だけなら失敗", () => {
    const base: MergeOrder = {
      chains: [[item("T12", true), item("T14")]],
    };
    const r = addChain(base, ["T12", "T14", "T15"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.replaced).toBe(true);
      expect(r.order.chains).toHaveLength(1);
      expect(r.order.chains[0]![0]!.integrated).toBe(true);
    }
    const bad = addChain(base, ["T12", "T20"]);
    expect(bad.ok).toBe(false);
  });
  it("統合済みが未統合より後ろに来る並びは失敗", () => {
    const base: MergeOrder = {
      chains: [[item("T12", true), item("T14")]],
    };
    expect(addChain(base, ["T14", "T12"]).ok).toBe(false);
    expect(addChain(base, ["T12", "T14", "T15"]).ok).toBe(true);
  });
});

describe("orderBefore・orderRelation・removeId", () => {
  const o = order(["T12", "T14", "T15"]);
  it("前の項目を返す", () => {
    expect(orderBefore(o, "T15").map((i) => i.id)).toEqual(["T12", "T14"]);
    expect(orderBefore(o, "T12")).toEqual([]);
    expect(orderBefore(o, "T99")).toEqual([]);
  });
  it("前後を返す", () => {
    expect(orderRelation(o, "T14", "T12")).toBe("before");
    expect(orderRelation(o, "T14", "T15")).toBe("after");
    expect(orderRelation(o, "T14", "T99")).toBeNull();
    expect(orderRelation(o, "T99", "T12")).toBeNull();
  });
  it("外して1つになった鎖は消える", () => {
    expect(removeId(o, "T14").chains[0]!.map((i) => i.id)).toEqual([
      "T12",
      "T15",
    ]);
    expect(removeId(order(["T12", "T14"]), "T12").chains).toEqual([]);
  });
});

describe("ファイル", () => {
  it("読むだけではファイルを作らない", async () => {
    const root = await makeRepo();
    expect((await readMergeOrder(testRunner, root)).chains).toEqual([]);
    expect(existsSync(await mergeOrderFile(testRunner, root))).toBe(false);
  });
  it("recordIntegrated は印をつけ、全部済んだら鎖を消す", async () => {
    const root = await makeRepo();
    await writeMergeOrder(testRunner, root, order(["T12", "T14"]));
    expect(path.basename(await mergeOrderFile(testRunner, root))).toBe(
      "merge-order.json",
    );
    await recordIntegrated(testRunner, root, "T12", "abc123");
    let read = await readMergeOrder(testRunner, root);
    expect(read.chains[0]![0]).toEqual({
      id: "T12",
      integrated: true,
      mergeCommit: "abc123",
    });
    await recordIntegrated(testRunner, root, "T14", null);
    read = await readMergeOrder(testRunner, root);
    expect(read.chains).toEqual([]);
    expect(existsSync(await mergeOrderFile(testRunner, root))).toBe(false);
  });
  it("順にない ID ではファイルを作らない", async () => {
    const root = await makeRepo();
    await recordIntegrated(testRunner, root, "T12", null);
    expect(existsSync(await mergeOrderFile(testRunner, root))).toBe(false);
  });
  it("壊れたファイル・形の違う項目は FlowError、ファイルは書き換えない", async () => {
    const root = await makeRepo();
    const file = await mergeOrderFile(testRunner, root);
    await mkdir(path.dirname(file), { recursive: true });
    for (const text of [
      "{ broken",
      '{"chains":[[{"id":"T12"}]]}',
      '{"chains":"x"}',
      "null",
    ]) {
      await writeFile(file, text);
      await expect(readMergeOrder(testRunner, root), text).rejects.toThrow(
        file,
      );
      expect(await readFile(file, "utf8")).toBe(text);
    }
  });
  it("書いたあとに一時ファイルが残らない", async () => {
    const root = await makeRepo();
    await writeMergeOrder(testRunner, root, order(["T12", "T14"]));
    const file = await mergeOrderFile(testRunner, root);
    expect(await readdir(path.dirname(file))).toEqual(["merge-order.json"]);
  });
});

describe("planAutoOrder・applyAutoOrder", () => {
  it("相手も自分も鎖にいなければ新しい鎖、相手が1つの鎖にいれば最後に足す", () => {
    expect(planAutoOrder(order(), "T02", ["T01"])).toEqual({
      ok: true,
      kind: "new",
      ids: ["T01", "T02"],
    });
    expect(planAutoOrder(order(["T01", "T03"]), "T02", ["T01", "T03"])).toEqual(
      { ok: true, kind: "append", ids: ["T01", "T03", "T02"] },
    );
  });
  it("決めきれない4つの場合は理由つきで失敗する", () => {
    const fails = [
      planAutoOrder(order(["T02", "T09"]), "T02", ["T01"]),
      planAutoOrder(order(["T01", "T08"], ["T03", "T09"]), "T02", [
        "T01",
        "T03",
      ]),
      planAutoOrder(order(["T01", "T08"]), "T02", ["T01", "T03"]),
      planAutoOrder(order(), "T02", ["T01", "T03"]),
    ];
    for (const plan of fails) {
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).not.toBe("");
    }
  });
  it("自分の項目だけに印をつけ、ほかの鎖は変えない", () => {
    const base = order(["T05", "T06"], ["T01"].concat("T03"));
    const plan = planAutoOrder(base, "T02", ["T03"]);
    if (!plan.ok) throw new Error("足せるはず");
    const next = applyAutoOrder(base, plan, "2026-01-01T00:00:00.000Z");
    expect(next.chains[0]).toEqual(base.chains[0]);
    expect(next.chains[1]!.map((i) => i.id)).toEqual(["T01", "T03", "T02"]);
    expect(next.chains[1]!.filter((i) => i.auto).map((i) => i.id)).toEqual([
      "T02",
    ]);
    // 元は変えない
    expect(base.chains[1]).toHaveLength(2);
  });
  it("印のある鎖を order で足し直すと印が消え、印のない古いファイルも読める", () => {
    const marked: MergeOrder = {
      chains: [[item("T01"), { ...item("T02"), auto: { at: "x" } }]],
    };
    const r = addChain(marked, ["T01", "T02", "T03"]);
    expect(r.ok && r.order.chains[0]!.some((i) => i.auto)).toBe(false);
  });
});

describe("withOrderLock", () => {
  it("取って外す。fn の結果を返す", async () => {
    const root = await makeRepo();
    const lock = await mergeOrderLockFile(testRunner, root);
    const value = await withOrderLock(testRunner, root, async () => {
      expect(existsSync(lock)).toBe(true);
      expect(await readFile(lock, "utf8")).toMatch(
        new RegExp(`^${process.pid} \\d+\n$`),
      );
      return 7;
    });
    expect(value).toBe(7);
    expect(existsSync(lock)).toBe(false);
  });
  it("fn が失敗してもロックを外す", async () => {
    const root = await makeRepo();
    await expect(
      withOrderLock(testRunner, root, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(existsSync(await mergeOrderLockFile(testRunner, root))).toBe(false);
  });
  it("生きていないプロセスのロックは取り直す", async () => {
    const root = await makeRepo();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "2147483646 0\n");
    await withOrderLock(testRunner, root, async () => undefined);
    expect(existsSync(lock)).toBe(false);
  });
  it("生きているロックが外れなければ、待ったあと終了コード1で fn を流さない", async () => {
    const root = await makeRepo();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, `${process.pid}\n`);
    let ran = false;
    const error = await withOrderLock(
      testRunner,
      root,
      async () => {
        ran = true;
      },
      150,
    ).catch((e: unknown) => e);
    expect(ran).toBe(false);
    expect(error).toMatchObject({ code: 1 });
    expect(existsSync(lock)).toBe(true);
  });
  it("recordIntegrated も同じロックを通す（生きているロックがある間は順を変えず、外れたあとに書く）", async () => {
    const root = await makeRepo();
    await writeMergeOrder(testRunner, root, order(["T01", "T02"]));
    const file = await mergeOrderFile(testRunner, root);
    const before = await readFile(file, "utf8");
    const lock = await mergeOrderLockFile(testRunner, root);
    await writeFile(lock, `${process.pid}\n`);
    let done = false;
    const pending = recordIntegrated(testRunner, root, "T01", null).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(done).toBe(false);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(
      (await readMergeOrder(testRunner, root)).chains[0]![0]!.integrated,
    ).toBe(false);
    await rm(lock, { force: true });
    await pending;
    expect(
      (await readMergeOrder(testRunner, root)).chains[0]![0]!.integrated,
    ).toBe(true);
  });
  it("中身が空のロックは、新しい間は生きているとみなして奪わない", async () => {
    const root = await makeRepo();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "");
    let ran = false;
    const error = await withOrderLock(
      testRunner,
      root,
      async () => {
        ran = true;
      },
      150,
    ).catch((e: unknown) => e);
    expect(ran).toBe(false);
    expect(error).toMatchObject({ code: 1 });
    expect(existsSync(lock)).toBe(true);
  });
  it("中身が空・読めない形のロックでも、古ければ取り直す", async () => {
    const root = await makeRepo();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(path.dirname(lock), { recursive: true });
    for (const text of ["", "garbage\n"]) {
      await writeFile(lock, text);
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      let ran = false;
      await withOrderLock(testRunner, root, async () => {
        ran = true;
      });
      expect(ran, text).toBe(true);
      expect(existsSync(lock)).toBe(false);
    }
  });
  it("外すとき、他人のロックに替わっていたら消さない", async () => {
    const root = await makeRepo();
    const lock = await mergeOrderLockFile(testRunner, root);
    await withOrderLock(testRunner, root, async () => {
      await writeFile(lock, `${process.pid} 1\n`);
    });
    expect(await readFile(lock, "utf8")).toBe(`${process.pid} 1\n`);
  });
  describe.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "外すときの失敗",
    () => {
      const readonlyInside = async (root: string, restore: string[]) => {
        const lock = await mergeOrderLockFile(testRunner, root);
        const dir = path.dirname(lock);
        restore.push(dir);
        await chmod(dir, 0o555);
      };
      it("fn の結果を上書きせず、順は変えていませんとは言わずに警告する", async () => {
        const root = await makeRepo();
        const restore: string[] = [];
        const write = vi
          .spyOn(process.stderr, "write")
          .mockImplementation(() => true);
        try {
          const value = await withOrderLock(testRunner, root, async () => {
            await readonlyInside(root, restore);
            return 7;
          });
          expect(value).toBe(7);
          const warned = write.mock.calls.map((c) => String(c[0])).join("");
          expect(warned).toContain(await mergeOrderLockFile(testRunner, root));
          expect(warned).not.toContain("順は変えていません");
          expect(warned).not.toContain("順の書き込みは済んでいます");
        } finally {
          write.mockRestore();
          for (const d of restore) await chmod(d, 0o755);
        }
      });
      it("fn が失敗したときは、外す失敗で上書きせず元のエラーを残す", async () => {
        const root = await makeRepo();
        const restore: string[] = [];
        const write = vi
          .spyOn(process.stderr, "write")
          .mockImplementation(() => true);
        try {
          const error = await withOrderLock(testRunner, root, async () => {
            await readonlyInside(root, restore);
            throw new Error("元のエラー");
          }).catch((e: unknown) => e);
          expect((error as Error).message).toBe("元のエラー");
        } finally {
          write.mockRestore();
          for (const d of restore) await chmod(d, 0o755);
        }
      });
    },
  );
  it("ロックのパスがディレクトリなら、無限に回らず終了コード1で止まる", async () => {
    const root = await makeRepo();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(lock, { recursive: true });
    const error = await withOrderLock(
      testRunner,
      root,
      async () => undefined,
      150,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 1 });
    expect((error as Error).message).toContain(lock);
  });
  it("取れないときのメッセージに、ロックのパスと消し方を書く", async () => {
    const root = await makeRepo();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, `${process.pid}\n`);
    const error = await withOrderLock(
      testRunner,
      root,
      async () => undefined,
      100,
    ).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain(`プロセス ${process.pid} がいなければ`);
    expect(message).toContain(`${lock} を消してやり直してください`);
  });
});
