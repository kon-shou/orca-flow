import { mkdir, writeFile } from "node:fs/promises";
import { tempDir } from "../helpers/repo.ts";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type FlowConfig } from "../../src/config.ts";
import type { Runner } from "../../src/lib/exec.ts";
import {
  addItem,
  buildSenders,
  bundleFingerprint,
  readItem,
  readItems,
  selectBundle,
  updateState,
  type AddInput,
  type OutboxItem,
  type Senders,
} from "../../src/lib/outbox.ts";
import {
  NotSentError,
  checkSendEntry,
  sendItems,
  type Clock,
} from "../../src/lib/send-guard.ts";

const HEAD = "a".repeat(40);
// 2026-11-03 は火曜日
const TUE_10 = new Date(2026, 10, 3, 10, 0);
const tmp = () => tempDir("orca-flow-outbox-");

const config = (over: Partial<FlowConfig["outbound"]> = {}): FlowConfig => ({
  ...DEFAULT_CONFIG,
  outbound: { ...DEFAULT_CONFIG.outbound, ...over },
});

const input = (
  kind: AddInput["kind"],
  over: Partial<AddInput> = {},
): AddInput => ({
  taskId: "T01",
  kind,
  body: kind === "push" ? "" : "本文",
  head: HEAD,
  target: { remote: "origin", branch: "task/T01-x", base: "main", pr: 7 },
  ...over,
});

async function seed(
  kinds: AddInput["kind"][] = ["pr-create", "push", "pr-ready"],
) {
  const common = await tmp();
  for (const kind of kinds) await addItem(common, input(kind), {}, TUE_10);
  return common;
}

function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { clock, sleeps };
}

const TARGET = { remote: "origin", branch: "task/T01-x", base: "main" };

const shown = (items: OutboxItem[], perBatch = 5) =>
  bundleFingerprint(selectBundle(items, perBatch).selected);

describe("send の入口", () => {
  it("束の指紋と先頭が合えば、送る順の集合を返す。時間帯は見ない", async () => {
    const common = await seed();
    const items = await readItems(common, "T01");
    const closed = config({
      window: { days: [], from: "09:00", to: "20:00" },
    });
    const selected = checkSendEntry({
      config: closed,
      items,
      expect: shown(items),
      head: HEAD,
      currentHead: HEAD,
      expectedTarget: TARGET,
    });
    expect(selected.map((i) => i.kind)).toEqual([
      "push",
      "pr-create",
      "pr-ready",
    ]);
  });

  it("束の指紋が違えば止まる（本文が変わった・足された）", async () => {
    const common = await seed(["push", "pr-create"]);
    const before = await readItems(common, "T01");
    const expectFp = shown(before);
    const base = {
      config: config(),
      expect: expectFp,
      head: HEAD,
      currentHead: HEAD,
      expectedTarget: TARGET,
    };
    expect(() =>
      checkSendEntry({
        ...base,
        items: before.map((i) => ({ ...i, body: "x" })),
      }),
    ).toThrow("束の指紋");
    expect(() => checkSendEntry({ ...base, items: [] })).toThrow(
      "送る案がありません",
    );
    // 見せたあとに足された案：足したあとの置き場を読み直して渡すと、束の指紋で止まる
    await addItem(common, input("pr-ready"), {}, TUE_10);
    const added = await readItems(common, "T01");
    expect(added).toHaveLength(3); // push・pr-create・足された pr-ready
    expect(() => checkSendEntry({ ...base, items: added })).toThrow("束の指紋");
  });

  it("案の送り先が今のタスクのブランチ・base・リモートと違えば止まる", async () => {
    const common = await seed();
    const items = await readItems(common, "T01");
    const base = {
      config: config(),
      items,
      expect: shown(items),
      head: HEAD,
      currentHead: HEAD,
    };
    for (const want of [
      { ...TARGET, branch: "task/T02-y" },
      { ...TARGET, base: "develop" },
      { ...TARGET, remote: "upstream" },
    ])
      expect(() => checkSendEntry({ ...base, expectedTarget: want })).toThrow(
        "送り先が今のタスクと違います",
      );
  });

  it("先頭が違えば止まる", async () => {
    const common = await seed();
    const items = await readItems(common, "T01");
    const base = {
      config: config(),
      items,
      expect: shown(items),
      head: HEAD,
      expectedTarget: TARGET,
    };
    expect(() =>
      checkSendEntry({ ...base, currentHead: "b".repeat(40) }),
    ).toThrow("先頭が違います");
    expect(() =>
      checkSendEntry({
        ...base,
        head: "b".repeat(40),
        currentHead: "b".repeat(40),
      }),
    ).toThrow("案の先頭");
  });

  it("許可リストにない種類は止まる", async () => {
    const common = await seed();
    const items = await readItems(common, "T01");
    expect(() =>
      checkSendEntry({
        config: config({ allow: ["push"] }),
        items,
        expect: shown(items),
        head: HEAD,
        currentHead: HEAD,
        expectedTarget: TARGET,
      }),
    ).toThrow("許可リスト");
  });

  it("6件積むと5件だけ選ばれ、残りは積んだまま", async () => {
    const common = await tmp();
    for (const kind of ["push", "pr-create", "pr-ready"] as const)
      await addItem(common, input(kind), {}, TUE_10);
    const items = await readItems(common, "T01");
    const six = [
      ...items,
      ...items.map((i) => ({ ...i, id: `${i.id}-b`, version: i.version + 1 })),
    ];
    const { selected, rest } = selectBundle(six, 5);
    expect(selected).toHaveLength(5);
    expect(rest).toHaveLength(1);
  });
});

describe("古い CI の印つきの pr-ready", () => {
  it("CI 待ちにせず、ほかの案と同じに送る（続く案も送られる）", async () => {
    const common = await tmp();
    const { item } = await addItem(
      common,
      input("pr-ready", { afterCi: true }),
      {},
      TUE_10,
    );
    const { item: next } = await addItem(common, input("push"), {}, TUE_10);
    const calls: string[] = [];
    const out = await sendItems(
      {
        common,
        outbound: config().outbound,
        env: {},
        senders: {
          "pr-ready": async () => void calls.push("pr-ready"),
          push: async () => void calls.push("push"),
        },
      },
      [item, next],
    );
    expect(out.sent).toEqual([item.id, next.id]);
    expect(out.failed).toBeNull();
    expect(calls).toEqual(["pr-ready", "push"]);
    expect((await readItem(common, "T01", next.id))!.state).toBe("sent");
    expect((await readItem(common, "T01", item.id))!.state).toBe("sent");
  });
});

describe("sendItems", () => {
  const recorder = () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const senders: Senders = {};
    for (const kind of ["push", "pr-create", "pr-ready"] as const)
      senders[kind] = async (item, body) => {
        calls.push(kind);
        bodies.push(body);
        void item;
      };
    return { calls, bodies, senders };
  };
  const deps = (common: string, senders: Senders, clock?: Clock) => ({
    common,
    outbound: config().outbound,
    env: {},
    senders,
    clock,
  });
  const all = async (common: string) =>
    selectBundle(await readItems(common, "T01"), 5).selected;

  it("push → PR の作成 → 下書きを外す の順に呼び、送った状態を書く", async () => {
    const common = await seed();
    const r = recorder();
    const out = await sendItems(deps(common, r.senders), await all(common));
    expect(r.calls).toEqual(["push", "pr-create", "pr-ready"]);
    expect(out.sent).toHaveLength(3);
    expect((await readItems(common, "T01")).map((i) => i.state)).toEqual([
      "sent",
      "sent",
      "sent",
    ]);
  });

  it("途中の1件が落ちたら残りは呼ばれず、積んだまま。落ちた案は確かでない", async () => {
    const common = await seed();
    const r = recorder();
    r.senders["pr-create"] = async () => {
      r.calls.push("pr-create");
      throw new Error("gh が落ちた");
    };
    const out = await sendItems(deps(common, r.senders), await all(common));
    expect(r.calls).toEqual(["push", "pr-create"]);
    expect(out.failed).toMatchObject({
      id: "pr-create-v1",
      state: "uncertain",
    });
    expect(out.remaining).toEqual(["pr-ready-v1"]);
    const states = Object.fromEntries(
      (await readItems(common, "T01")).map((i) => [i.kind, i.state]),
    );
    expect(states).toEqual({
      push: "sent",
      "pr-create": "uncertain",
      "pr-ready": "queued",
    });
  });

  it("何も書かずに落ちたと言う送る関数の案は、送らなかった", async () => {
    const common = await seed(["push"]);
    const r = recorder();
    r.senders.push = async () => {
      throw new NotSentError("push を断られた");
    };
    const out = await sendItems(deps(common, r.senders), await all(common));
    expect(out.failed?.state).toBe("skipped");
  });

  it("2回目は送らない。確かでない案も自動では送らない", async () => {
    const common = await seed(["push", "pr-create"]);
    const r = recorder();
    const items = await all(common);
    await sendItems(deps(common, r.senders), items);
    expect(r.calls).toHaveLength(2);
    const again = await sendItems(deps(common, r.senders), items);
    expect(r.calls).toHaveLength(2);
    expect(again.failed?.reason).toContain("二重には送りません");
    // 確かでない
    const c2 = await seed(["push"]);
    const [one] = await all(c2);
    await updateState(c2, one!, "uncertain", TUE_10);
    const again2 = await sendItems(deps(c2, r.senders), [one!]);
    expect(r.calls).toHaveLength(2);
    expect(again2.failed?.state).toBe("uncertain");
    expect(selectBundle(await readItems(c2, "T01"), 5).selected).toEqual([]);
  });

  it("送る直前の本文も、環境変数のトークンを伏せ字にする", async () => {
    const common = await tmp();
    const { item } = await addItem(
      common,
      input("pr-create", { body: "tok supersecret-token-value" }),
      {},
      TUE_10,
    );
    expect(item.body).toContain("supersecret-token-value");
    const r = recorder();
    await sendItems(
      {
        ...deps(common, r.senders),
        env: { GH_TOKEN: "supersecret-token-value" },
      },
      [item],
    );
    expect(r.bodies[0]).not.toContain("supersecret-token-value");
  });

  it("書き込みの間が interval.seconds 空く（偽物の時計）", async () => {
    const common = await seed();
    const r = recorder();
    const { clock, sleeps } = fakeClock();
    await sendItems(deps(common, r.senders, clock), await all(common));
    // 1件目は前の書き込みがないので待たず、2件目・3件目の前に1秒ずつ待つ
    expect(sleeps).toEqual([1000, 1000]);
    const { clock: c2, sleeps: s2 } = fakeClock();
    const common2 = await seed();
    await sendItems(
      {
        ...deps(common2, r.senders, c2),
        outbound: {
          ...config().outbound,
          interval: { seconds: 3, perBatch: 5 },
        },
      },
      await all(common2),
    );
    expect(s2).toEqual([3000, 3000]);
  });

  it("送る関数がない・許可リストにない案は、何も書く前に投げる", async () => {
    const common = await seed(["push"]);
    await expect(
      sendItems(deps(common, {}), await all(common)),
    ).rejects.toThrow("送る手段がありません");
    expect((await readItems(common, "T01"))[0]!.state).toBe("queued");
  });
});

describe("sendItems の守り（追加）", () => {
  const okSenders = (calls: string[]): Senders => ({
    push: async () => void calls.push("push"),
    "pr-create": async () => void calls.push("pr-create"),
    "pr-ready": async () => void calls.push("pr-ready"),
  });
  const deps = (common: string, senders: Senders, clock?: Clock) => ({
    common,
    outbound: config().outbound,
    env: {},
    senders,
    clock,
  });

  it("「送っている」のまま残った案は、もう一度送らない", async () => {
    const common = await seed(["push"]);
    const [one] = await readItems(common, "T01");
    await updateState(common, one!, "sending", TUE_10);
    const calls: string[] = [];
    const out = await sendItems(deps(common, okSenders(calls)), [one!]);
    expect(calls).toEqual([]);
    expect(out.failed).toMatchObject({ id: "push-v1", state: "sending" });
    expect((await readItem(common, "T01", "push-v1"))?.state).toBe("sending");
  });

  it("同時に流した2つの send は、同じ案を二重に送らない（置き場全体のロック）", async () => {
    const common = await seed(["push"]);
    const items = await readItems(common, "T01");
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: Senders = {
      push: async () => {
        calls.push("push");
        await gate;
      },
    };
    const first = sendItems(deps(common, slow), items);
    // 1つ目がロックを取って送り始めるまで待つ
    while (calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    await expect(
      sendItems(deps(common, okSenders(calls)), items),
    ).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining("ほかの send"),
    });
    release();
    expect((await first).sent).toEqual(["push-v1"]);
    expect(calls).toEqual(["push"]);
    // 終わればロックは外れている
    const again = await seed(["push"]);
    expect(
      (
        await sendItems(
          deps(again, okSenders([])),
          await readItems(again, "T01"),
        )
      ).sent,
    ).toEqual(["push-v1"]);
  });

  it("ロックは終わり（落ちたときも）に外れる", async () => {
    const common = await seed(["push"]);
    const items = await readItems(common, "T01");
    const out = await sendItems(
      deps(common, {
        push: async () => {
          throw new Error("落ちた");
        },
      }),
      items,
    );
    expect(out.failed?.state).toBe("uncertain");
    const c2 = await seed(["push"]);
    await expect(
      sendItems(deps(c2, okSenders([])), await readItems(c2, "T01")),
    ).resolves.toMatchObject({ sent: ["push-v1"] });
    // 同じ置き場でも、前のロックは残っていない
    const next = await addItem(common, input("push"), {}, TUE_10);
    await expect(
      sendItems(deps(common, okSenders([])), [next.item]),
    ).resolves.toMatchObject({ sent: ["push-v2"] });
  });

  it("前の書き込みの時刻が未来にずれていても、間の長さを越えては待たない", async () => {
    const common = await seed(["push", "pr-create"]);
    const { clock, sleeps } = fakeClock(1_000_000);
    await mkdir(path.join(common, "orca-flow", "outbox"), { recursive: true });
    await writeFile(
      path.join(common, "orca-flow", "outbox", "last-write"),
      `${1_000_000 + 3_600_000}\n`,
    );
    await sendItems(
      deps(common, okSenders([]), clock),
      selectBundle(await readItems(common, "T01"), 5).selected,
    );
    expect(sleeps.length).toBeGreaterThan(0);
    for (const ms of sleeps) expect(ms).toBeLessThanOrEqual(1000);
  });
});

describe("表の送る関数（偽物の Runner）", () => {
  const done = (code: number, stdout = "", stderr = "") => ({
    code,
    stdout,
    stderr,
    timedOut: false,
  });
  const make = (
    respond: (cmd: string, args: readonly string[]) => ReturnType<typeof done>,
  ) => {
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return respond(cmd, args);
    };
    const senders = buildSenders({
      g: { runner, cwd: "/x", env: {} },
      task: { id: "T01", branch: "task/T01-x" },
      config: config(),
      root: "/x",
    });
    return { senders, calls };
  };
  const item = async (kind: AddInput["kind"], over: Partial<AddInput> = {}) => {
    const common = await tmp();
    return (await addItem(common, input(kind, over), {}, TUE_10)).item;
  };

  it("表のすべての種類に送る関数がある", () => {
    const { senders } = make(() => done(0));
    expect(Object.keys(senders).sort()).toEqual([
      "pr-create",
      "pr-ready",
      "push",
      "reply",
      "rerequest",
    ]);
  });

  it("push は承認した SHA を送る", async () => {
    const { senders, calls } = make(() => done(0));
    await senders.push(await item("push"), "");
    expect(calls).toEqual([
      ["git", "push", "origin", `${HEAD}:refs/heads/task/T01-x`],
    ]);
  });

  it("push が non-fast-forward で断られたら、送らなかった（リモートは変わっていない）", async () => {
    for (const stderr of [
      " ! [rejected]        a -> task/T01-x (non-fast-forward)",
      "hint: Updates were rejected because the tip is behind (non-fast-forward)",
    ]) {
      const { senders } = make(() => done(1, "", stderr));
      const error = await senders
        .push(await item("push"), "")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSentError);
      expect((error as Error).message).toContain("積み直して");
      expect((error as Error).message).toContain("--force-with-lease");
    }
    // ほかの失敗は、送れたか分からない（NotSentError にしない）
    const other = make(() => done(1, "", "fatal: unable to access"));
    const error = await other.senders
      .push(await item("push"), "")
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NotSentError);
  });

  it("pr-ready は PR の番号がタスクのブランチの PR と違えば送らない", async () => {
    const prs = (n: number) =>
      JSON.stringify([
        { number: n, url: "u", isDraft: true, state: "OPEN", headRefOid: HEAD },
      ]);
    const wrong = make((cmd, args) =>
      args[1] === "list" ? done(0, prs(9)) : done(0),
    );
    const error = await wrong.senders["pr-ready"](
      await item("pr-ready"),
      "",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotSentError);
    expect(wrong.calls.some((c) => c[1] === "pr" && c[2] === "ready")).toBe(
      false,
    );

    const right = make((cmd, args) =>
      args[1] === "list" ? done(0, prs(7)) : done(0),
    );
    await right.senders["pr-ready"](await item("pr-ready"), "");
    expect(right.calls.at(-1)).toEqual(["gh", "pr", "ready", "7"]);

    const none = make(() => done(0, "[]"));
    await expect(
      none.senders["pr-ready"](await item("pr-ready"), ""),
    ).rejects.toBeInstanceOf(NotSentError);
  });

  it("pr-ready は PR が下書きでなければ gh pr ready を呼ばず、送ったとして終える", async () => {
    const open = make((cmd, args) =>
      args[1] === "list"
        ? done(
            0,
            JSON.stringify([
              {
                number: 7,
                url: "u",
                isDraft: false,
                state: "OPEN",
                headRefOid: HEAD,
              },
            ]),
          )
        : done(0),
    );
    await open.senders["pr-ready"](await item("pr-ready"), "");
    expect(open.calls.some((c) => c[1] === "pr" && c[2] === "ready")).toBe(
      false,
    );
  });

  it("pr-create は案の題をそのまま使い、秘密は伏せ字にする", async () => {
    const secret = "supersecret-token-value";
    const common = await tmp();
    const { item: created } = await addItem(
      common,
      input("pr-create", {
        target: {
          remote: "origin",
          branch: "task/T01-x",
          base: "main",
          pr: null,
          title: `T01: 題 ${secret}`,
        },
      }),
      {},
      TUE_10,
    );
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return done(0, "https://github.com/o/r/pull/3\n");
    };
    const senders = buildSenders({
      g: { runner, cwd: "/x", env: { GH_TOKEN: secret } },
      task: { id: "T01", branch: "task/T01-x" },
      config: config(),
      root: "/x",
    });
    await senders["pr-create"](created, "本文");
    const args = calls[0]!;
    const title = args[args.indexOf("--title") + 1]!;
    expect(title).toContain("T01: 題");
    expect(title).not.toContain(secret);
  });
});
