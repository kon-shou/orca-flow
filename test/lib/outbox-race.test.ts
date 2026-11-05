import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  addItem,
  readItem,
  readItems,
  selectBundle,
  taskOutboxDir,
  OUTBOX_LOCK_WAIT_MS,
  withOutboxLock,
  withdrawItem,
  writeItem,
  type AddInput,
  type Senders,
} from "../../src/lib/outbox.ts";
import { sendItems, type Clock } from "../../src/lib/send-guard.ts";
import { tempDir } from "../helpers/repo.ts";

const HEAD = "a".repeat(40);
const TUE_10 = new Date(2026, 10, 3, 10, 0);
const input = (kind: AddInput["kind"]): AddInput => ({
  taskId: "T01",
  kind,
  body: kind === "push" ? "" : "本文",
  head: HEAD,
  target: { remote: "origin", branch: "task/T01-x", base: "main", pr: 7 },
});

async function seed(kinds: AddInput["kind"][]) {
  const common = await tempDir("orca-flow-race-");
  for (const kind of kinds) await addItem(common, input(kind), {}, TUE_10);
  return common;
}

/** 間隔の待ちに入ったとき onSleep を呼ぶ偽物の時計 */
function clockWith(onSleep: (n: number) => Promise<void>) {
  let t = 1_000_000;
  let n = 0;
  const clock: Clock = {
    now: () => t,
    sleep: async (ms) => {
      await onSleep(n++);
      t += ms;
    },
  };
  return clock;
}

const recorder = () => {
  const calls: string[] = [];
  const senders: Senders = {};
  for (const kind of ["push", "pr-create", "pr-ready"] as const)
    senders[kind] = async () => void calls.push(kind);
  return { calls, senders };
};

const deps = (common: string, senders: Senders, clock: Clock) => ({
  common,
  outbound: DEFAULT_CONFIG.outbound,
  env: {},
  senders,
  clock,
  mode: "send" as const,
  head: HEAD,
});

const bundle = async (common: string) =>
  selectBundle(await readItems(common, "T01"), 5).selected;

/** ロックの中に入ってから返す（取りに来る側が先に取らないように）。holder は外したあとに await する */
async function holdLock(
  common: string,
  kind?: "send" | "add" | "withdraw" | "watch",
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const holder = withOutboxLock(
    common,
    () => {
      entered();
      return gate;
    },
    kind ? { kind } : {},
  );
  await Promise.race([inside, holder]); // 取れずに reject したらここで落ちる
  return { release, holder };
}

/** 結果を例外も含めて受ける */
const settle = async <T>(p: Promise<T>) =>
  p.then(
    (value) => ({
      value,
      error: null as null | { code: number; message: string },
    }),
    (error) => ({
      value: null as T | null,
      error: error as { code: number; message: string },
    }),
  );

describe("send の待ちの間の書き換え", () => {
  it("待ちの間の withdrawItem はロックが取れず終了コード2。案は取り下げにならず、送られる", async () => {
    const common = await seed(["push", "pr-create"]);
    const r = recorder();
    let attempt: Awaited<ReturnType<typeof settle>> | null = null;
    const clock = clockWith(async () => {
      attempt = await settle(
        withdrawItem(common, "T01", "pr-create-v1", TUE_10, { lockWaitMs: 0 }),
      );
    });
    const out = await sendItems(
      deps(common, r.senders, clock),
      await bundle(common),
    );
    expect(attempt!.error?.code).toBe(2);
    expect(attempt!.error?.message).toContain("ほかの send が動いています");
    expect(out.sent).toEqual(["push-v1", "pr-create-v1"]);
    expect(r.calls).toEqual(["push", "pr-create"]);
    expect((await readItem(common, "T01", "pr-create-v1"))!.state).toBe("sent");
  });

  it("待ちの間にロックを通さず「取り下げた」に書き換えられた案は、送らず、上書きしない", async () => {
    const common = await seed(["push", "pr-create"]);
    const r = recorder();
    const clock = clockWith(async () => {
      const item = (await readItem(common, "T01", "pr-create-v1"))!;
      await writeItem(common, {
        ...item,
        state: "withdrawn",
        note: "手で取り下げた",
      });
    });
    const out = await sendItems(
      deps(common, r.senders, clock),
      await bundle(common),
    );
    expect(r.calls).toEqual(["push"]);
    expect(out.sent).toEqual(["push-v1"]);
    expect(out.failed).toMatchObject({
      id: "pr-create-v1",
      state: "withdrawn",
    });
    const after = (await readItem(common, "T01", "pr-create-v1"))!;
    expect(after.state).toBe("withdrawn");
    expect(after.note).toBe("手で取り下げた");
  });

  it("待ちの間に中身を書き換えられた案は、指紋が違うので送らない", async () => {
    const common = await seed(["push", "pr-create"]);
    const r = recorder();
    const clock = clockWith(async () => {
      const item = (await readItem(common, "T01", "pr-create-v1"))!;
      await writeItem(common, { ...item, body: "すり替えた本文" });
    });
    const out = await sendItems(
      deps(common, r.senders, clock),
      await bundle(common),
    );
    expect(r.calls).toEqual(["push"]);
    expect(out.failed).toMatchObject({ id: "pr-create-v1", state: "queued" });
    expect((await readItem(common, "T01", "pr-create-v1"))!.state).toBe(
      "queued",
    );
  });

  it("待ちの間の addItem は終了コード2。前の版は取り下げにならず、新しい版のファイルもできない", async () => {
    const common = await seed(["push", "pr-create"]);
    const r = recorder();
    let attempt: Awaited<ReturnType<typeof settle>> | null = null;
    const clock = clockWith(async () => {
      attempt = await settle(
        addItem(common, input("pr-create"), {}, TUE_10, { lockWaitMs: 0 }),
      );
    });
    const out = await sendItems(
      deps(common, r.senders, clock),
      await bundle(common),
    );
    expect(attempt!.error?.code).toBe(2);
    expect(out.sent).toEqual(["push-v1", "pr-create-v1"]);
    const files = await readdir(taskOutboxDir(common, "T01"));
    expect(files.sort()).toEqual(["pr-create-v1.json", "push-v1.json"]);
    expect((await readItem(common, "T01", "pr-create-v1"))!.state).toBe("sent");
  });
});

describe("ロックの待ち", () => {
  it("持つ側が待つ長さのうちに外せば、取り下げるは通る", async () => {
    const common = await seed(["push"]);
    const { release, holder } = await holdLock(common);
    setTimeout(release, 120);
    const out = await withdrawItem(common, "T01", "push-v1", TUE_10, {
      lockWaitMs: 3000,
    });
    await holder;
    expect(out.state).toBe("withdrawn");
  });

  it("持つ側が外さなければ、待つ長さのあと終了コード2で止まり、案は変わらない", async () => {
    const common = await seed(["push"]);
    const { release, holder } = await holdLock(common);
    const started = Date.now();
    const res = await settle(
      withdrawItem(common, "T01", "push-v1", TUE_10, { lockWaitMs: 150 }),
    );
    const elapsed = Date.now() - started;
    release();
    await holder;
    expect(res.error?.code).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("queued");
  });

  it("持つ側が外せば、積むも通る", async () => {
    const common = await seed(["push"]);
    const { release, holder } = await holdLock(common);
    setTimeout(release, 120);
    const out = await addItem(common, input("push"), {}, TUE_10, {
      lockWaitMs: 3000,
    });
    await holder;
    expect(out.item.id).toBe("push-v2");
  });

  it("積むがロックを持っている間の send は終了コード2で、「ほかの send が動いています」と出さず、積むを名指す", async () => {
    const common = await seed(["push"]);
    const { release, holder } = await holdLock(common, "add");
    const r = recorder();
    const res = await settle(
      sendItems(
        deps(
          common,
          r.senders,
          clockWith(async () => {}),
        ),
        await bundle(common),
      ),
    );
    release();
    await holder;
    expect(res.error?.code).toBe(2);
    expect(res.error?.message).not.toContain("ほかの send が動いています");
    expect(res.error?.message).toContain("outbox add");
    expect(r.calls).toEqual([]);
  });

  it("取り下げるがロックを持っているときは、取り下げるを名指す", async () => {
    const common = await seed(["push"]);
    const { release, holder } = await holdLock(common, "withdraw");
    const res = await settle(
      addItem(common, input("push"), {}, TUE_10, { lockWaitMs: 0 }),
    );
    release();
    await holder;
    expect(res.error?.code).toBe(2);
    expect(res.error?.message).toContain("outbox withdraw");
    expect(res.error?.message).not.toContain("ほかの send が動いています");
  });

  it("見張りがロックを持っている間の send は終了コード2で、「見張りが動いています」と出す", async () => {
    const common = await seed(["push"]);
    const { release, holder } = await holdLock(common, "watch");
    const r = recorder();
    const res = await settle(
      sendItems(
        deps(
          common,
          r.senders,
          clockWith(async () => {}),
        ),
        await bundle(common),
      ),
    );
    release();
    await holder;
    expect(res.error?.code).toBe(2);
    expect(res.error?.message).toContain("見張りが動いています");
    expect(res.error?.message).not.toContain("ほかの send が動いています");
    expect(r.calls).toEqual([]);
  });

  it("種類の書いていない古いロックは、特定の相手を名指さない", async () => {
    const common = await seed(["push"]);
    const lock = path.join(common, "orca-flow", "outbox", "send.lock");
    await writeFile(lock, `${process.pid}\n`);
    const res = await settle(
      withdrawItem(common, "T01", "push-v1", TUE_10, { lockWaitMs: 0 }),
    );
    expect(res.error?.code).toBe(2);
    expect(res.error?.message).not.toContain("ほかの send が動いています");
  });
});

describe("同時に積む", () => {
  it("2つの addItem を同時に呼んでも、版が別々になり、両方のファイルが残る", async () => {
    const common = await tempDir("orca-flow-race-");
    const [a, b] = await Promise.all([
      addItem(common, input("pr-create"), {}, TUE_10, { lockWaitMs: 5000 }),
      addItem(common, input("pr-create"), {}, TUE_10, { lockWaitMs: 5000 }),
    ]);
    expect([a.item.version, b.item.version].sort()).toEqual([1, 2]);
    const files = await readdir(taskOutboxDir(common, "T01"));
    expect(files.sort()).toEqual(["pr-create-v1.json", "pr-create-v2.json"]);
  });
});

describe("取り下げの待ちの間に状態が変わったとき", () => {
  it("待ちの間に送る関数が落ちて「確かでない」になった案は、取り下げずに終了コード1で止まる", async () => {
    const common = await seed(["push"]);
    let attempt: Promise<Awaited<ReturnType<typeof settle>>> | null = null;
    const senders: Senders = {
      push: async () => {
        // send がロックを持っている間に、取り下げが待ち始める
        attempt = settle(
          withdrawItem(common, "T01", "push-v1", TUE_10, { lockWaitMs: 3000 }),
        );
        await new Promise((r) => setTimeout(r, 120));
        throw new Error("通信が切れた");
      },
    };
    const out = await sendItems(
      deps(
        common,
        senders,
        clockWith(async () => {}),
      ),
      await bundle(common),
    );
    expect(out.failed).toMatchObject({ id: "push-v1", state: "uncertain" });
    const res = await attempt!;
    expect(res.error?.code).toBe(1);
    expect(res.error?.message).toContain("状態が変わりました");
    expect(res.value).toBeNull();
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("uncertain");
  });
});

describe("既定の待ち", () => {
  it("OUTBOX_LOCK_WAIT_MS は 5000", () => {
    expect(OUTBOX_LOCK_WAIT_MS).toBe(5000);
  });

  it("待つ長さを渡さなくても、少しあとに外されれば取り下げるも積むも通る", async () => {
    const common = await seed(["push"]);
    const first = await holdLock(common);
    setTimeout(first.release, 100);
    const gone = await withdrawItem(common, "T01", "push-v1", TUE_10);
    await first.holder;
    expect(gone.state).toBe("withdrawn");
    const second = await holdLock(common);
    setTimeout(second.release, 100);
    const added = await addItem(common, input("push"), {}, TUE_10);
    await second.holder;
    expect(added.item.id).toBe("push-v2");
  });
});
