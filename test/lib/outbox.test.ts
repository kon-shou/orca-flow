import { readFile, readdir, writeFile } from "node:fs/promises";
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
  renderShow,
  selectBundle,
  stackItem,
  updateState,
  withdrawItem,
  withOutboxLock,
  type AddContext,
  type AddInput,
} from "../../src/lib/outbox.ts";
import { DEFAULT_CONFIG, OUTBOUND_KINDS } from "../../src/config.ts";
import { createHash } from "node:crypto";
import type { CaptureRef } from "../../src/lib/pr-captures.ts";
import { e2eCapturesDir } from "../../src/lib/preview-base.ts";

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

describe("録画を載せる案", () => {
  const capture = (
    side: "before" | "after",
    over: Partial<CaptureRef> = {},
  ): CaptureRef => ({
    flow: "cart",
    side,
    name: `cart-${side}.webm`,
    size: 10,
    sha256: (side === "before" ? "1" : "2").repeat(64),
    path: `/captures/cart-${side}.webm`,
    ...over,
  });
  const captures = [capture("before"), capture("after")];
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const addContext: AddContext = {
    taskId: "T01",
    branch: "task/T01-x",
    defaultTitle: async () => "T01: x",
    bodyProblems: () => [],
    expectedRemoteHead: async () => null,
  };
  const where = {
    head: "a".repeat(40),
    target: { remote: "origin", branch: "task/T01-x", base: "main" },
  };

  it("録画のない pr-create の指紋は前と同じ形のまま", async () => {
    const common = await tmp();
    const { item } = await addItem(
      common,
      input({ target: { ...input().target, title: "T01: x" } }),
      {},
      NOW,
    );
    const before = sha(
      JSON.stringify({
        kind: "pr-create",
        parts: {
          remote: "origin",
          branch: "task/T01-x",
          base: "main",
          title: "T01: x",
        },
        body: normalizeBody("本文"),
      }),
    );
    expect(item.fingerprint).toBe(before);
    expect(
      computeFingerprint({ ...item, target: { ...item.target, captures: [] } }),
    ).toBe(before);
  });

  it("pr-create は録画の一覧を案に入れ、一覧（名前・大きさ・sha256）が変わると指紋が変わる。手元のパスは指紋に入らない", async () => {
    const common = await tmp();
    const { item } = await stackItem(
      common,
      "pr-create",
      { body: "本文", pr: null, afterCi: false, title: null, captures },
      addContext,
      where,
      {},
      NOW,
    );
    expect(item.target.captures?.map((c) => c.name)).toEqual([
      "cart-before.webm",
      "cart-after.webm",
    ]);
    const plain = computeFingerprint({
      ...item,
      target: { ...item.target, captures: undefined },
    });
    expect(item.fingerprint).not.toBe(plain);
    const changed = (over: Partial<CaptureRef>) =>
      computeFingerprint({
        ...item,
        target: {
          ...item.target,
          captures: [capture("before", over), captures[1]!],
        },
      });
    expect(changed({ sha256: "3".repeat(64) })).not.toBe(item.fingerprint);
    expect(changed({ size: 11 })).not.toBe(item.fingerprint);
    expect(changed({ name: "cart-before.mp4" })).not.toBe(item.fingerprint);
    expect(changed({ path: "/elsewhere/cart-before.webm" })).toBe(
      item.fingerprint,
    );
  });

  it("pr-edit は push だけが積む。outbox add の入力では終了コード1で「push が積みます」", async () => {
    const common = await tmp();
    await expect(
      stackItem(
        common,
        "pr-edit",
        { body: "", pr: 7, afterCi: false, title: null },
        addContext,
        where,
        {},
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 1,
      message: expect.stringContaining("push が積みます"),
    });
    expect(await readItems(common, "T01")).toEqual([]);
  });

  it("pr-edit は読んだ本文の sha256 と録画を指紋に入れ、送る順は下書きを外すのあと、返信の前", async () => {
    const common = await tmp();
    const { item } = await stackItem(
      common,
      "pr-edit",
      {
        body: "新しい本文",
        pr: 7,
        afterCi: false,
        title: null,
        prEdit: { prBodySha: sha("前の本文"), captures },
      },
      addContext,
      where,
      {},
      NOW,
    );
    expect(item.id).toBe("pr-edit-v1");
    expect(item.target.prBodySha).toBe(sha("前の本文"));
    expect(
      computeFingerprint({
        ...item,
        target: { ...item.target, prBodySha: sha("人が直した本文") },
      }),
    ).not.toBe(item.fingerprint);
    expect(
      computeFingerprint({
        ...item,
        target: { ...item.target, captures: [captures[0]!] },
      }),
    ).not.toBe(item.fingerprint);
    expect(KIND_TABLE["pr-edit"].order).toBeGreaterThan(
      KIND_TABLE["pr-ready"].order,
    );
    expect(KIND_TABLE["pr-edit"].order).toBeLessThan(KIND_TABLE.reply.order);
  });

  it("show は案ごとの録画の一覧（流れ・前か後か・大きさ・手元のパス）を出し、録画の中身は出さない", async () => {
    const common = await tmp();
    await stackItem(
      common,
      "pr-create",
      { body: "本文", pr: null, afterCi: false, title: null, captures },
      addContext,
      where,
      {},
      NOW,
    );
    const text = renderShow(
      "T01",
      buildShowSet(await readItems(common, "T01"), 5, "a".repeat(40)),
      DEFAULT_CONFIG,
    ).join("");
    const dir = e2eCapturesDir(common, "T01");
    expect(text).toContain("録画");
    expect(text).toContain(
      `cart 前：10 バイト  ${path.join(dir, "cart-before.webm")}`,
    );
    expect(text).toContain(
      `cart 後：10 バイト  ${path.join(dir, "cart-after.webm")}`,
    );
    expect(text).not.toContain("1".repeat(64));
  });

  it("show の録画のパスは置き場とファイル名から組み立て、案に書かれたパス・流れ・側は使わない", async () => {
    const common = await tmp();
    const { item } = await stackItem(
      common,
      "pr-create",
      { body: "本文", pr: null, afterCi: false, title: null, captures },
      addContext,
      where,
      {},
      NOW,
    );
    const file = path.join(
      common,
      "orca-flow",
      "outbox",
      "T01",
      `${item.id}.json`,
    );
    const saved = JSON.parse(await readFile(file, "utf8"));
    // 手元のパスは案に保存しない（送るのは置き場の録画なので、照らしの正にしない）
    for (const c of saved.target.captures) expect(c.path).toBeUndefined();
    saved.target.captures[0].path = "/elsewhere/innocent.webm";
    saved.target.captures[0].flow = "other";
    saved.target.captures[0].side = "after";
    await writeFile(file, JSON.stringify(saved));
    const items = await readItems(common, "T01");
    expect(items[0]!.fingerprint).toBe(item.fingerprint);
    const text = renderShow(
      "T01",
      buildShowSet(items, 5, "a".repeat(40)),
      DEFAULT_CONFIG,
    ).join("");
    const dir = e2eCapturesDir(common, "T01");
    expect(text).toContain(
      `cart 前：10 バイト  ${path.join(dir, "cart-before.webm")}`,
    );
    expect(text).not.toContain("/elsewhere/innocent.webm");
    expect(text).not.toContain("other");
  });

  it("show は置き場の名前の形でない録画にパスを出さず、送られないことを書く", async () => {
    const common = await tmp();
    const { item } = await stackItem(
      common,
      "pr-create",
      { body: "本文", pr: null, afterCi: false, title: null, captures },
      addContext,
      where,
      {},
      NOW,
    );
    const file = path.join(
      common,
      "orca-flow",
      "outbox",
      "T01",
      `${item.id}.json`,
    );
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.target.captures[0].name = "../../secret.webm";
    await writeFile(file, JSON.stringify(saved));
    const text = renderShow(
      "T01",
      buildShowSet(await readItems(common, "T01"), 5, "a".repeat(40)),
      DEFAULT_CONFIG,
    ).join("");
    expect(text).toContain("../../secret.webm");
    expect(text).toContain("名前の形が正しくない");
    expect(text).not.toContain(path.join(common, "orca-flow", "secret.webm"));
  });
});
