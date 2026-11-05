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
  const plan = (o: MergeOrder, self: string, partners: string[]) => {
    const p = planAutoOrder(o, self, partners);
    if (!p.ok) throw new Error(`足せるはず：${p.reason}`);
    return p.ids;
  };
  it("自分が鎖 X にいて、鎖にいない相手 P と重なれば、X の最後に P を足す（X の並びは変わらない）", () => {
    expect(plan(order(["T02", "T09"]), "T02", ["T01"])).toEqual([
      "T02",
      "T09",
      "T01",
    ]);
  });
  it("相手が別々の鎖にいれば1本につなぐ。先頭の ID の数の小さい鎖が前、統合済みが前に寄り、各鎖の中は保たれる", () => {
    expect(
      plan(order(["T03", "T09"], ["T01", "T08"]), "T02", ["T03", "T01"]),
    ).toEqual(["T01", "T08", "T03", "T09", "T02"]);
    const o: MergeOrder = {
      chains: [
        [item("T01"), item("T08")],
        [item("T05", true), item("T06")],
      ],
    };
    expect(plan(o, "T02", ["T01", "T05"])).toEqual([
      "T05",
      "T01",
      "T08",
      "T06",
      "T02",
    ]);
  });
  it("鎖にいる相手といない相手が混ざれば「鎖＋鎖にいない相手＋自分」、いない相手が2つ以上なら「相手（数の順）＋自分」", () => {
    expect(plan(order(["T01", "T08"]), "T02", ["T04", "T01", "T03"])).toEqual([
      "T01",
      "T08",
      "T03",
      "T04",
      "T02",
    ]);
    expect(plan(order(), "T02", ["T10", "T03"])).toEqual(["T03", "T10", "T02"]);
    expect(planAutoOrder(order(), "T02", ["T10", "T03"])).toMatchObject({
      kind: "new",
    });
  });
  it("自分が鎖にいて相手が別の鎖にいても、つないで足す", () => {
    expect(plan(order(["T02", "T04"], ["T01", "T08"]), "T02", ["T01"])).toEqual(
      ["T01", "T08", "T02", "T04"],
    );
  });
  it("つなぐ鎖が2つ以上で、未統合の後ろに統合済みがあれば理由つきで失敗する。鎖が1つならそのまま足す", () => {
    const bad: MergeOrder = {
      chains: [
        [item("T01"), item("T08", true)],
        [item("T03"), item("T09")],
      ],
    };
    const p = planAutoOrder(bad, "T02", ["T01", "T03"]);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain("T01 → T08");
    expect(plan({ chains: [bad.chains[0]!] }, "T02", ["T01"])).toEqual([
      "T01",
      "T08",
      "T02",
    ]);
  });
  it("桁の違う ID は数の順に並べる（文字の順にしない）", () => {
    expect(plan(order(), "T20", ["T10", "T9"])).toEqual(["T9", "T10", "T20"]);
    expect(
      plan(order(["T10", "T12"], ["T9", "T11"]), "T20", ["T10", "T9"]),
    ).toEqual(["T9", "T11", "T10", "T12", "T20"]);
  });
  it("英字つきの ID は数だけで並べ、数が同じなら ID の文字の順", () => {
    expect(plan(order(), "T20", ["T13", "T12a"])).toEqual([
      "T12a",
      "T13",
      "T20",
    ]);
    expect(plan(order(), "T20", ["T12a", "T12"])).toEqual([
      "T12",
      "T12a",
      "T20",
    ]);
    expect(
      plan(order(["T13", "T14"], ["T12a", "T15"]), "T20", ["T13", "T12a"]),
    ).toEqual(["T12a", "T15", "T13", "T14", "T20"]);
  });
  it("2026-11-05 の例：I → A → B に C、続いて E を足す", () => {
    const base: MergeOrder = {
      chains: [[item("T01", true), item("T10"), item("T11")]],
    };
    const c = planAutoOrder(base, "T13", ["T10", "T14"]);
    if (!c.ok) throw new Error("足せるはず");
    expect(c.ids).toEqual(["T01", "T10", "T11", "T14", "T13"]);
    const o2 = applyAutoOrder(base, c, "t1", "T13");
    const e = planAutoOrder(o2, "T15", ["T10", "T11", "T13", "T14"]);
    if (!e.ok) throw new Error("足せるはず");
    expect(e.ids).toEqual(["T01", "T10", "T11", "T14", "T13", "T15"]);
  });
  it("足した項目と自分に at と by の印をつけ、もとからいた項目の印は変えない", () => {
    const base: MergeOrder = {
      chains: [[item("T01"), { ...item("T03"), auto: { at: "old" } }]],
    };
    const p = planAutoOrder(base, "T02", ["T01", "T04"]);
    if (!p.ok) throw new Error("足せるはず");
    const next = applyAutoOrder(base, p, "NOW", "T02");
    expect(next.chains).toHaveLength(1);
    expect(next.chains[0]).toEqual([
      base.chains[0]![0],
      base.chains[0]![1],
      { ...item("T04"), auto: { at: "NOW", by: "T02" } },
      { ...item("T02"), auto: { at: "NOW", by: "T02" } },
    ]);
  });
  it("自分がもう鎖にいるとき、もとからいた項目の印は変わらず、足した項目に by・at がつく", () => {
    const base = order(["T02", "T04"]);
    const p = planAutoOrder(base, "T02", ["T01", "T03"]);
    if (!p.ok) throw new Error("足せるはず");
    const next = applyAutoOrder(base, p, "NOW", "T02");
    expect(next.chains[0]).toEqual([
      item("T02"),
      item("T04"),
      { ...item("T01"), auto: { at: "NOW", by: "T02" } },
      { ...item("T03"), auto: { at: "NOW", by: "T02" } },
    ]);
    expect(next.chains[0]![0]!.auto).toBeUndefined();
    expect(next.chains[0]![1]!.auto).toBeUndefined();
  });
  it("つないだとき、ほかの鎖は残り、つないだ鎖の ID は1つの鎖にだけいる", () => {
    const base = order(["T05", "T06"], ["T01", "T03"], ["T07", "T08"]);
    const p = planAutoOrder(base, "T02", ["T01", "T07"]);
    if (!p.ok) throw new Error("足せるはず");
    const next = applyAutoOrder(base, p, "NOW", "T02");
    expect(next.chains.map((c) => c.map((i) => i.id))).toEqual([
      ["T05", "T06"],
      ["T01", "T03", "T07", "T08", "T02"],
    ]);
  });
  it("今の2つの場合の結果は今と同じ", () => {
    expect(planAutoOrder(order(), "T02", ["T01"])).toEqual({
      ok: true,
      kind: "new",
      ids: ["T01", "T02"],
    });
    expect(planAutoOrder(order(["T01", "T03"]), "T02", ["T01", "T03"])).toEqual(
      { ok: true, kind: "append", ids: ["T01", "T03", "T02"] },
    );
    expect(planAutoOrder(order(), "T02", []).ok).toBe(false);
  });
  it("自分の項目だけに印をつけ、ほかの鎖は変えない", () => {
    const base = order(["T05", "T06"], ["T01"].concat("T03"));
    const p = planAutoOrder(base, "T02", ["T03"]);
    if (!p.ok) throw new Error("足せるはず");
    const next = applyAutoOrder(base, p, "2026-01-01T00:00:00.000Z");
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
