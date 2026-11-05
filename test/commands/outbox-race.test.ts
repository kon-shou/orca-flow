import { describe, expect, it } from "vitest";
import { createOutbox, run as runOutbox } from "../../src/commands/outbox.ts";
import { createSend } from "../../src/commands/send.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { readItem, withOutboxLock } from "../../src/lib/outbox.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";
import path from "node:path";

async function setup() {
  const root = await makeRepo({
    outbound: { interval: { seconds: 3, perBatch: 5 } },
  });
  await addTaskWorktree(root, "T01", "x", { "a.txt": "a\n" });
  return { root, common: path.join(root, ".git") };
}

const orca = fakeOrca().runner;
const ghOk: Runner = async (cmd, args, opts) =>
  cmd === "gh"
    ? { code: 0, stdout: "ok", stderr: "", timedOut: false }
    : orca(cmd, args, opts);

async function run(
  command: ReturnType<typeof createOutbox> | ReturnType<typeof createSend>,
  cwd: string,
  argv: string[],
) {
  const out: string[] = [];
  const ctx: CommandContext = {
    argv,
    cwd,
    json: false,
    runner: ghOk,
    env: {},
    stdout: (t) => out.push(t),
    stderr: () => {},
    now: () => new Date("2026-11-03T00:00:00Z"),
  };
  try {
    const r = await command(ctx);
    return { code: r.code, out: out.join("\n"), err: "" };
  } catch (error) {
    const e = error as { code?: number; message: string };
    return { code: e.code ?? 1, out: out.join("\n"), err: e.message };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 待つ長さを短くした outbox コマンド */
const outbox = createOutbox({ lockWaitMs: 100 });

describe("outbox add・withdraw と send のロック", () => {
  it("send がロックを持っている間の outbox withdraw は終了コード2で、「取り下げました」を出さない", async () => {
    const { root, common } = await setup();
    expect(
      (
        await runCli(["outbox", "add", "T01", "push"], {
          cwd: root,
          runner: orca,
        })
      ).code,
    ).toBe(0);
    const res = await withOutboxLock(common, () =>
      run(outbox, root, ["withdraw", "T01", "push-v1"]),
    );
    expect(res.code).toBe(2);
    expect(res.out).not.toContain("取り下げました");
    expect(res.err).toContain("ほかの send が動いています");
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("queued");
  });

  it("send がロックを持っている間の outbox add は終了コード2で、「積みました」を出さない", async () => {
    const { root, common } = await setup();
    const res = await withOutboxLock(common, () =>
      run(outbox, root, ["add", "T01", "push"]),
    );
    expect(res.code).toBe(2);
    expect(res.out).not.toContain("積みました");
    expect(res.err).toContain("ほかの send が動いています");
    expect(await readItem(common, "T01", "push-v1")).toBeNull();
  });

  it("ロックがなければ、積む・取り下げるは通る", async () => {
    const { root, common } = await setup();
    const added = await run(outbox, root, ["add", "T01", "push"]);
    expect(added.code).toBe(0);
    const gone = await run(outbox, root, ["withdraw", "T01", "push-v1"]);
    expect(gone.code).toBe(0);
    expect(gone.out).toContain("取り下げました");
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("withdrawn");
  });

  it("outbox add がロックを持っている間の send は終了コード2で、「ほかの send が動いています」と出さない", async () => {
    const { root, common } = await setup();
    await run(outbox, root, ["add", "T01", "push"]);
    const shown = await runCli(["outbox", "show", "T01", "--json"], {
      cwd: root,
      runner: orca,
    });
    const v = JSON.parse(shown.out) as {
      bundleFingerprint: string;
      head: string;
    };
    const res = await withOutboxLock(
      common,
      () =>
        run(createSend(), root, [
          "T01",
          "--expect",
          v.bundleFingerprint,
          "--head",
          v.head,
        ]),
      { kind: "add" },
    );
    expect(res.code).toBe(2);
    expect(res.err).not.toContain("ほかの send が動いています");
    expect(res.err).toContain("outbox add");
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("queued");
  });
});

describe("既定の待ち（run）", () => {
  it("少しあとにロックが外れれば、outbox withdraw も add も通る", async () => {
    const { root, common } = await setup();
    expect((await run(runOutbox, root, ["add", "T01", "push"])).code).toBe(0);
    const held = withOutboxLock(common, () => sleep(100));
    await sleep(20);
    const gone = await run(runOutbox, root, ["withdraw", "T01", "push-v1"]);
    await held;
    expect(gone.code).toBe(0);
    expect(gone.out).toContain("取り下げました");
    const held2 = withOutboxLock(common, () => sleep(100));
    await sleep(20);
    const added = await run(runOutbox, root, ["add", "T01", "push"]);
    await held2;
    expect(added.code).toBe(0);
    expect(added.out).toContain("積みました");
  });
});
