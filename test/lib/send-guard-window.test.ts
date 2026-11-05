import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  addItem,
  readItem,
  writeLastWrite,
  type Senders,
} from "../../src/lib/outbox.ts";
import { sendItems, type Clock } from "../../src/lib/send-guard.ts";
import { tempDir } from "../helpers/repo.ts";

const HEAD = "a".repeat(40);
// 2026-11-03 は火曜日
const WINDOW = { days: [2], from: "09:00", to: "20:00" };
const outbound = {
  ...DEFAULT_CONFIG.outbound,
  window: WINDOW,
  interval: { ...DEFAULT_CONFIG.outbound.interval, seconds: 30 },
};

async function waiting() {
  const common = await tempDir("orca-flow-window-");
  const { item } = await addItem(
    common,
    {
      taskId: "T01",
      kind: "pr-ready",
      body: "本文",
      head: HEAD,
      target: { remote: "origin", branch: "task/T01-x", base: "main", pr: 7 },
      afterCi: true,
    },
    {},
    new Date(2026, 10, 3, 10, 0),
  );
  await sendItems(
    { common, outbound, env: {}, senders: {}, mode: "send", head: HEAD },
    [item],
  );
  return { common, item: (await readItem(common, "T01", item.id))! };
}

function clockAt(date: Date) {
  let t = date.getTime();
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

describe("sendItems：間隔を待ったあとの時間帯", () => {
  it("待つ間に時間帯の終わりを越えたら、送らず状態も変えない", async () => {
    const { common, item } = await waiting();
    const start = new Date(2026, 10, 3, 19, 59, 50);
    await writeLastWrite(common, start.getTime());
    const { clock, sleeps } = clockAt(start);
    const calls: string[] = [];
    const senders: Senders = {
      "pr-ready": async () => {
        calls.push("pr-ready");
      },
    };
    const out = await sendItems(
      {
        common,
        outbound,
        env: {},
        senders,
        clock,
        mode: "watch",
        head: HEAD,
      },
      [item],
    );
    expect(sleeps).toEqual([30_000]);
    expect(calls).toEqual([]);
    expect(out.sent).toEqual([]);
    expect(out.failed).toBeNull();
    expect(out.held?.id).toBe(item.id);
    expect(out.held?.why).toBe("window");
    expect(out.held?.reason).toContain("送る時間帯の外");
    const after = (await readItem(common, "T01", item.id))!;
    expect(after).toEqual(item);
  });

  it("待っても時間帯の中なら送る", async () => {
    const { common, item } = await waiting();
    const start = new Date(2026, 10, 3, 12, 0, 0);
    await writeLastWrite(common, start.getTime());
    const { clock } = clockAt(start);
    const calls: string[] = [];
    const out = await sendItems(
      {
        common,
        outbound,
        env: {},
        senders: {
          "pr-ready": async () => {
            calls.push("pr-ready");
          },
        },
        clock,
        mode: "watch",
        head: HEAD,
      },
      [item],
    );
    expect(calls).toEqual(["pr-ready"]);
    expect(out.sent).toEqual([item.id]);
  });
});
