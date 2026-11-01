import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addChain,
  mergeOrderFile,
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
