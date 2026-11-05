import { readdir } from "node:fs/promises";
import { tempDir } from "../helpers/repo.ts";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIND_TABLE,
  addItem,
  buildShowSet,
  describeItem,
  bundleFingerprint,
  computeFingerprint,
  decideExpectedRemoteHead,
  normalizeBody,
  readItem,
  readItems,
  selectBundle,
  updateState,
  withdrawItem,
  withOutboxLock,
  type AddInput,
} from "../../src/lib/outbox.ts";
import { OUTBOUND_KINDS } from "../../src/config.ts";

const NOW = new Date("2026-11-03T01:00:00Z");
const tmp = () => tempDir("orca-flow-outbox-");

const input = (over: Partial<AddInput> = {}): AddInput => ({
  taskId: "T01",
  kind: "pr-create",
  body: "本文",
  head: "a".repeat(40),
  target: { remote: "origin", branch: "task/T01-x", base: "main", pr: null },
  ...over,
});

const OLD = "b".repeat(40);

describe("outbox の置き場", () => {
  it("1件1ファイルで積み、同じ種類を積み直すと版が上がり前の案は取り下げになる", async () => {
    const common = await tmp();
    const first = await addItem(common, input(), {}, NOW);
    expect(first.item.id).toBe("pr-create-v1");
    const second = await addItem(common, input({ body: "直した" }), {}, NOW);
    expect(second.item.version).toBe(2);
    expect(second.withdrawn.map((w) => w.id)).toEqual(["pr-create-v1"]);
    expect((await readItem(common, "T01", "pr-create-v1"))?.state).toBe(
      "withdrawn",
    );
    expect(
      await readdir(path.join(common, "orca-flow", "outbox", "T01")),
    ).toEqual(["pr-create-v1.json", "pr-create-v2.json"]);
  });

  it("送った案は積み直しても取り下げにならない", async () => {
    const common = await tmp();
    const { item } = await addItem(common, input(), {}, NOW);
    await updateState(common, item, "sent", NOW);
    const next = await addItem(common, input(), {}, NOW);
    expect(next.withdrawn).toEqual([]);
    expect((await readItem(common, "T01", item.id))?.state).toBe("sent");
  });

  it("積み直すと、送らなかった案は取り下げになり、確かでない・送っている案は残る", async () => {
    for (const [state, withdrawn] of [
      ["skipped", true],
      ["uncertain", false],
      ["sending", false],
    ] as const) {
      const dir = await tmp();
      const { item } = await addItem(dir, input({ kind: "push" }), {}, NOW);
      await updateState(dir, item, state, NOW);
      const next = await addItem(dir, input({ kind: "push" }), {}, NOW);
      expect(next.withdrawn.map((w) => w.id)).toEqual(
        withdrawn ? ["push-v1"] : [],
      );
      expect((await readItem(dir, "T01", "push-v1"))?.state).toBe(
        withdrawn ? "withdrawn" : state,
      );
    }
  });

  it("積むとき本文の秘密の形を伏せ字にする", async () => {
    const common = await tmp();
    const secret = "ghp_" + "A".repeat(30);
    const { item } = await addItem(
      common,
      input({ body: `token ${secret}` }),
      {},
      NOW,
    );
    expect(item.body).not.toContain(secret);
    expect(JSON.stringify(await readItems(common, "T01"))).not.toContain(
      secret,
    );
  });

  it("取り下げは、送った案と取り下げ済みの案以外（確かでない・送っている・送らなかった案は人が確かめたあと片づける）", async () => {
    const common = await tmp();
    for (const state of [
      "uncertain",
      "sending",
      "skipped",
      "ci-wait",
    ] as const) {
      const { item } = await addItem(common, input(), {}, NOW);
      await updateState(common, item, state, NOW);
      const out = await withdrawItem(common, "T01", item.id, NOW);
      expect(out.state).toBe("withdrawn");
    }
    const { item: done } = await addItem(common, input(), {}, NOW);
    await updateState(common, done, "withdrawn", NOW);
    await expect(withdrawItem(common, "T01", done.id, NOW)).rejects.toThrow(
      "取り下げられません",
    );
  });

  it("送っている案の取り下げは、ほかの send が動いている間は断る", async () => {
    const common = await tmp();
    const { item } = await addItem(common, input(), {}, NOW);
    await updateState(common, item, "sending", NOW);
    let inner: unknown;
    await withOutboxLock(common, async () => {
      inner = await withdrawItem(common, "T01", item.id, NOW, {
        lockWaitMs: 0,
      }).catch((e) => e);
    });
    expect(inner).toMatchObject({ code: 2 });
    expect((await readItem(common, "T01", item.id))?.state).toBe("sending");
    expect((await withdrawItem(common, "T01", item.id, NOW)).state).toBe(
      "withdrawn",
    );
  });

  it("積み直しの単位は表の鍵。鍵が違う案は取り下げにならず、版は種類の中で一意", async () => {
    const common = await tmp();
    const spec = KIND_TABLE.push;
    const original = spec.unitKey;
    // 返信と再依頼は PR ごとに単位が分かれる。ほかの種類は種類の名前
    for (const kind of OUTBOUND_KINDS)
      expect(KIND_TABLE[kind].unitKey({ ...input().target, pr: 7 })).toBe(
        kind === "reply" || kind === "rerequest" ? `${kind}:7` : kind,
      );
    try {
      // 返信のように、送り先の欄で単位が分かれる種類を想定する
      spec.unitKey = (t) => `push:${(t as { thread?: string }).thread ?? ""}`;
      const at = (thread: string) =>
        input({
          kind: "push",
          body: "",
          target: { ...input().target, thread } as AddInput["target"],
        });
      const a = await addItem(common, at("t1"), {}, NOW);
      const b = await addItem(common, at("t2"), {}, NOW);
      expect(b.withdrawn).toEqual([]);
      expect([a.item.id, b.item.id]).toEqual(["push-v1", "push-v2"]);
      const c = await addItem(common, at("t1"), {}, NOW);
      expect(c.withdrawn.map((w) => w.id)).toEqual(["push-v1"]);
      expect((await readItem(common, "T01", "push-v2"))?.state).toBe("queued");
    } finally {
      spec.unitKey = original;
    }
  });

  it("push の期待値は指紋に入る（ないときは前の指紋と同じ）", async () => {
    const common = await tmp();
    const push = (expectedRemoteHead?: string | null) =>
      input({
        kind: "push",
        body: "",
        target: { ...input().target, expectedRemoteHead },
      });
    const none = (await addItem(common, push(), {}, NOW)).item;
    const nul = (await addItem(common, push(null), {}, NOW)).item;
    const one = (await addItem(common, push("c".repeat(40)), {}, NOW)).item;
    const two = (await addItem(common, push("d".repeat(40)), {}, NOW)).item;
    expect(nul.fingerprint).toBe(none.fingerprint);
    expect(one.fingerprint).not.toBe(none.fingerprint);
    expect(two.fingerprint).not.toBe(one.fingerprint);
    expect(KIND_TABLE.push.destination(one)).toContain("--force-with-lease");
  });

  it("期待値は、記録の先頭が今の先頭の祖先でないときだけ決まる", async () => {
    const calls: string[][] = [];
    const runner = async (_c: string, args: readonly string[]) => {
      calls.push([...args]);
      return {
        code: args[2] === OLD ? 1 : 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    };
    expect(
      await decideExpectedRemoteHead(runner, "/x", null, "new"),
    ).toBeNull();
    expect(
      await decideExpectedRemoteHead(runner, "/x", "new", "new"),
    ).toBeNull();
    expect(
      await decideExpectedRemoteHead(runner, "/x", "a".repeat(40), "new"),
    ).toBeNull();
    expect(await decideExpectedRemoteHead(runner, "/x", OLD, "new")).toBe(OLD);
    // 40〜64桁の16進でない値は積まずに終了コード1で止める
    for (const bad of ["old", "g".repeat(40), "a".repeat(39), "A".repeat(40)])
      await expect(
        decideExpectedRemoteHead(runner, "/x", bad, "new"),
      ).rejects.toMatchObject({ code: 1 });
  });

  it("pr-create の題は指紋に入り、秘密は伏せ字になる", async () => {
    const common = await tmp();
    const secret = "ghp_" + "B".repeat(30);
    const target = (title: string) => ({ ...input().target, title });
    const a = (
      await addItem(common, input({ target: target("T01: 甲") }), {}, NOW)
    ).item;
    const b = (
      await addItem(common, input({ target: target("T01: 乙") }), {}, NOW)
    ).item;
    expect(a.fingerprint).not.toBe(b.fingerprint);
    const c = (
      await addItem(
        common,
        input({ target: target(`T01: ${secret}`) }),
        {},
        NOW,
      )
    ).item;
    expect(JSON.stringify(c)).not.toContain(secret);
  });

  it("取り下げは積んだ案だけ", async () => {
    const common = await tmp();
    const { item } = await addItem(common, input(), {}, NOW);
    await updateState(common, item, "sent", NOW);
    await expect(withdrawItem(common, "T01", item.id, NOW)).rejects.toThrow(
      "取り下げられません",
    );
    await expect(withdrawItem(common, "T01", "nothing", NOW)).rejects.toThrow(
      "見つかりません",
    );
  });

  it("壊れたファイルや危ない名前は読まない", async () => {
    const common = await tmp();
    expect(await readItems(common, "T01")).toEqual([]);
    await expect(readItem(common, "../x", "a")).rejects.toThrow(
      "形が正しくありません",
    );
  });
});

describe("種類の表と指紋", () => {
  it("許可できる種類すべてに表の行があり、送る順は push → pr-create → pr-ready", () => {
    for (const kind of OUTBOUND_KINDS) expect(KIND_TABLE[kind]).toBeDefined();
    const order = (k: keyof typeof KIND_TABLE) => KIND_TABLE[k].order;
    expect(order("push")).toBeLessThan(order("pr-create"));
    expect(order("pr-create")).toBeLessThan(order("pr-ready"));
  });

  it("本文の正規化（改行・行末の空白・前後の空行）を同じ指紋にし、本文か送り先の違いは別の指紋にする", async () => {
    const common = await tmp();
    const a = (await addItem(common, input({ body: "a \r\nb\n\n" }), {}, NOW))
      .item;
    const b = (await addItem(common, input({ body: "a\nb" }), {}, NOW)).item;
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
    expect(normalizeBody("\n x \r\n")).toBe(" x");
    const c = { ...b, body: "a\nc" };
    expect(computeFingerprint(c)).not.toBe(computeFingerprint(b));
    const d = { ...b, target: { ...b.target, branch: "task/T02-x" } };
    expect(computeFingerprint(d)).not.toBe(computeFingerprint(b));
    const e = { ...b, target: { ...b.target, base: "develop" } };
    expect(computeFingerprint(e)).not.toBe(computeFingerprint(b));
  });

  it("push の指紋に先頭が入る", async () => {
    const common = await tmp();
    const p = (
      await addItem(common, input({ kind: "push", body: "" }), {}, NOW)
    ).item;
    expect(computeFingerprint({ ...p, head: "b".repeat(40) })).not.toBe(
      computeFingerprint(p),
    );
  });
});

describe("show の集合", () => {
  it("送る順に最大 perBatch 件で、残りは範囲の外。束の指紋は中身が変わると変わる", async () => {
    const common = await tmp();
    await addItem(common, input({ kind: "pr-ready" }), {}, NOW);
    await addItem(common, input({ kind: "pr-create" }), {}, NOW);
    await addItem(common, input({ kind: "push", body: "" }), {}, NOW);
    const items = await readItems(common, "T01");
    const set = buildShowSet(items, 2, "h");
    expect(set.items.map((i) => i.kind)).toEqual(["push", "pr-create"]);
    expect(set.rest.map((i) => i.kind)).toEqual(["pr-ready"]);
    expect(set.bundleFingerprint).toBe(bundleFingerprint(set.items));
    const changed = items.map((i) =>
      i.kind === "push" ? { ...i, head: "z".repeat(40) } : i,
    );
    expect(buildShowSet(changed, 2, "h").bundleFingerprint).not.toBe(
      set.bundleFingerprint,
    );
  });

  it("積んだ案だけ選び、確かでない案は別に出す", async () => {
    const common = await tmp();
    const a = (
      await addItem(common, input({ kind: "push", body: "" }), {}, NOW)
    ).item;
    await addItem(common, input(), {}, NOW);
    const sent = await updateState(common, a, "uncertain", NOW);
    const items = await readItems(common, "T01");
    expect(selectBundle(items, 5).selected.map((i) => i.id)).toEqual([
      "pr-create-v1",
    ]);
    expect(buildShowSet(items, 5, "h").uncertain.map((i) => i.id)).toEqual([
      sent.id,
    ]);
  });

  it("古い承認済み・CI 待ちの案は stale に出て、束にも指紋にも入らない。describeItem は「CI が通ったら外す」と言わない", async () => {
    const common = await tmp();
    const stale = (
      await addItem(common, input({ kind: "pr-ready", afterCi: true }), {}, NOW)
    ).item;
    await addItem(common, input(), {}, NOW);
    const queuedSet = buildShowSet(await readItems(common, "T01"), 5, "h");
    for (const i of queuedSet.items)
      expect(describeItem(i)).not.toContain("CI が通ったら外す");
    const before = buildShowSet(
      (await readItems(common, "T01")).filter((i) => i.kind !== "pr-ready"),
      5,
      "h",
    );
    await updateState(common, stale, "ci-wait", NOW);
    const set = buildShowSet(await readItems(common, "T01"), 5, "h");
    expect(set.stale.map((i) => i.id)).toEqual(["pr-ready-v1"]);
    expect(set.items.map((i) => i.id)).toEqual(["pr-create-v1"]);
    expect(set.bundleFingerprint).toBe(before.bundleFingerprint);
    expect(describeItem(set.stale[0]!)).toContain("もう送られません");
    expect(describeItem(set.stale[0]!)).not.toContain("CI が通ったら外す");
  });
});
