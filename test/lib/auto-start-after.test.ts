import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  approvedSinceSpecReview,
  autoDir,
  listAuto,
  newRecord,
  raiseStartAfterTurns,
  readAuto,
  waitForTurn,
  withOff,
  withTurn,
  writeAuto,
  type RaiseDeps,
} from "../../src/lib/auto.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import {
  newStartAfterCache,
  writeStartAfterAt,
  type StartAfterEntry,
} from "../../src/lib/start-after.ts";
import { makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const config = structuredClone(DEFAULT_CONFIG);
const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const common = (root: string) => path.join(root, ".git");

async function stage(
  root: string,
  id: string,
  state: string,
  s: number,
  command = state === "designing" ? "new" : "status",
) {
  await appendStage(common(root), id, {
    at: at(s).toISOString(),
    state,
    note: null,
    command,
  });
}

const waitImplemented: StartAfterEntry[] = [
  { id: "T01", repo: null, wait: "implemented" },
];

const raiseDeps = (root: string, now = at(100)): RaiseDeps => ({
  runner: testRunner,
  root,
  common: common(root),
  config,
  now,
  cache: newStartAfterCache(),
});

/** 前 T01 を待つ T05 が spec-review にいるリポジトリ */
async function waitingRepo(previousReady: boolean) {
  const root = await makeRepo();
  await writeStartAfterAt(common(root), "T05", waitImplemented, T0);
  await stage(root, "T01", "designing", 1);
  await stage(root, "T01", previousReady ? "integrate-wait" : "working", 2);
  await stage(root, "T05", "designing", 3);
  await stage(root, "T05", "spec-review", 4);
  return root;
}

describe("おまかせの記録の承認だけの欄", () => {
  it("欄のない古い記録は今までどおりのおまかせとして読む", async () => {
    const root = await makeRepo();
    await mkdir(autoDir(common(root)), { recursive: true });
    await writeFile(
      path.join(autoDir(common(root)), "T12.json"),
      JSON.stringify({ auto: true, createdAt: T0.toISOString(), turn: null }),
    );
    expect(await readAuto(common(root), "T12")).toMatchObject({
      auto: true,
      approveOnly: false,
    });
  });

  it("承認だけのおまかせは記録に残り、読み直せる", async () => {
    const root = await makeRepo();
    await writeAuto(common(root), newRecord("T12", T0, true));
    const text = await readFile(
      path.join(autoDir(common(root)), "T12.json"),
      "utf8",
    );
    expect(JSON.parse(text).approveOnly).toBe(true);
    expect((await readAuto(common(root), "T12"))!.approveOnly).toBe(true);
    expect(newRecord("T13", T0).approveOnly).toBe(false);
  });
});

describe("前を待つ印から承認の番を立てる", () => {
  it("前が整い spec-review にいれば、承認だけのおまかせの記録と承認の番を立てる", async () => {
    const root = await waitingRepo(true);
    expect(await raiseStartAfterTurns(raiseDeps(root), ["T05"])).toEqual([
      "T05",
    ]);
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: true,
      approveOnly: true,
      turn: { kind: "approve", picked: false, at: at(100).toISOString() },
    });
  });

  it("前が整っていなければ立てず、記録も作らない", async () => {
    const root = await waitingRepo(false);
    expect(await raiseStartAfterTurns(raiseDeps(root), ["T05"])).toEqual([]);
    expect(await listAuto(common(root))).toEqual([]);
  });

  it("段の記録の最後が spec-review でなければ立てない", async () => {
    const root = await waitingRepo(true);
    await stage(root, "T05", "working", 5);
    expect(await raiseStartAfterTurns(raiseDeps(root), ["T05"])).toEqual([]);
    const fresh = await makeRepo();
    await writeStartAfterAt(common(fresh), "T05", waitImplemented, T0);
    await stage(fresh, "T01", "integrate-wait", 1);
    expect(await raiseStartAfterTurns(raiseDeps(fresh), ["T05"])).toEqual([]);
  });

  it("その spec-review のあとに番を立て済みなら立て直さず、前の spec-review の番なら立て直す", async () => {
    const root = await waitingRepo(true);
    const done = withTurn(newRecord("T05", at(4), true), "approve", at(10));
    done.turn!.picked = true;
    await writeAuto(common(root), done);
    expect(await raiseStartAfterTurns(raiseDeps(root), ["T05"])).toEqual([]);
    expect((await readAuto(common(root), "T05"))!.turn).toEqual(done.turn);

    await stage(root, "T05", "spec-review", 20);
    expect(await raiseStartAfterTurns(raiseDeps(root), ["T05"])).toEqual([
      "T05",
    ]);
    expect((await readAuto(common(root), "T05"))!.turn).toMatchObject({
      picked: false,
      at: at(100).toISOString(),
    });
  });

  it("人が外したおまかせには立てず、もとからのおまかせは承認だけにしない", async () => {
    const root = await waitingRepo(true);
    await writeAuto(common(root), withOff(newRecord("T05", T0), null, T0));
    expect(await raiseStartAfterTurns(raiseDeps(root), ["T05"])).toEqual([]);
    expect((await readAuto(common(root), "T05"))!.turn).toBeNull();

    await writeAuto(common(root), newRecord("T05", T0));
    expect(await raiseStartAfterTurns(raiseDeps(root), ["T05"])).toEqual([
      "T05",
    ]);
    expect(await readAuto(common(root), "T05")).toMatchObject({
      approveOnly: false,
      turn: { kind: "approve" },
    });
  });

  it("壊れた印のタスクは飛ばし、ほかのタスクは続ける", async () => {
    const root = await waitingRepo(true);
    const dir = path.join(common(root), "orca-flow", "start-after");
    await writeFile(path.join(dir, "T06.json"), "{");
    await stage(root, "T06", "spec-review", 5);
    expect(await raiseStartAfterTurns(raiseDeps(root), ["T06", "T05"])).toEqual(
      ["T05"],
    );
  });
});

describe("待ち受けと前を待つタスク", () => {
  function clock() {
    let ms = T0.getTime();
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => new Date(ms),
      sleep: async (n: number) => {
        sleeps.push(n);
        ms += n;
      },
    };
  }

  it("印のある作業中のタスクだけが残っていても、番がなくても終わらずに待つ", async () => {
    const root = await waitingRepo(false);
    const c = clock();
    const seen: string[][] = [];
    const r = await waitForTurn({
      common: common(root),
      activeIds: async () => ["T05"],
      markedIds: async () => ["T05"],
      raise: async (ids) => {
        seen.push([...ids]);
      },
      now: c.now,
      sleep: c.sleep,
      pollMs: 1000,
      maxWaitMs: 3000,
    });
    expect(r).toBeNull();
    expect(c.sleeps.length).toBe(3);
    expect(seen.length).toBe(4);
    expect(seen[0]).toEqual(["T05"]);
  });

  it("作業中でない印だけなら待たずに終わる", async () => {
    const root = await waitingRepo(false);
    const c = clock();
    const r = await waitForTurn({
      common: common(root),
      activeIds: async () => [],
      markedIds: async () => ["T05"],
      raise: async () => {
        throw new Error("呼ばれない");
      },
      now: c.now,
      sleep: c.sleep,
      pollMs: 1000,
      maxWaitMs: 3000,
    });
    expect(r).toBeNull();
    expect(c.sleeps).toEqual([]);
  });

  it("見直しで前が整えば、立てた承認の番を拾う", async () => {
    const root = await waitingRepo(false);
    const c = clock();
    let n = 0;
    const r = await waitForTurn({
      common: common(root),
      activeIds: async () => ["T05"],
      markedIds: async () => ["T05"],
      raise: async (ids) => {
        await raiseStartAfterTurns(raiseDeps(root, c.now()), ids);
      },
      now: c.now,
      sleep: async (ms) => {
        await c.sleep(ms);
        if (++n === 2) await stage(root, "T01", "integrate-wait", 50);
      },
      pollMs: 1000,
      maxWaitMs: 60000,
    });
    expect(r).toMatchObject({ id: "T05", kind: "approve" });
    expect(n).toBe(2);
    expect((await readAuto(common(root), "T05"))!.turn!.picked).toBe(true);
  });

  const once = (root: string, c: ReturnType<typeof clock>) =>
    waitForTurn({
      common: common(root),
      activeIds: async () => ["T05"],
      markedIds: async () => ["T05"],
      raise: async (ids) => {
        await raiseStartAfterTurns(raiseDeps(root, c.now()), ids);
      },
      now: c.now,
      sleep: c.sleep,
      pollMs: 1000,
      maxWaitMs: 3000,
    });

  it("承認が済んだ承認だけのおまかせと印だけのタスクしか残らなければ、上限を待たずに終わる", async () => {
    const root = await waitingRepo(true);
    await stage(root, "T05", "working", 10, "approve");
    const c = clock();
    expect(await once(root, c)).toBeNull();
    expect(c.sleeps).toEqual([]);

    const picked = withTurn(newRecord("T05", T0, true), "approve", at(5));
    picked.turn!.picked = true;
    await writeAuto(common(root), picked);
    const d = clock();
    expect(await once(root, d)).toBeNull();
    expect(d.sleeps).toEqual([]);
  });

  it("承認が済んでも、ふつうのおまかせは統合の番のために待ち続ける", async () => {
    const root = await waitingRepo(true);
    await stage(root, "T05", "working", 10, "approve");
    await writeAuto(common(root), newRecord("T05", T0));
    const c = clock();
    expect(await once(root, c)).toBeNull();
    expect(c.sleeps.length).toBe(3);
  });

  it("おまかせを外した印のタスクには番を立てず、待ち続けもしない", async () => {
    const root = await waitingRepo(true);
    await writeAuto(
      common(root),
      withOff(newRecord("T05", T0, true), null, T0),
    );
    const c = clock();
    expect(await once(root, c)).toBeNull();
    expect(c.sleeps).toEqual([]);
    expect((await readAuto(common(root), "T05"))!.turn).toBeNull();
  });
});

describe("承認が済んだかの見分け", () => {
  const e = (state: string, command = "status") => ({
    at: T0.toISOString(),
    state,
    note: null,
    command,
  });

  it("最後の spec-review のあとの approve の working の行だけを承認と見る", () => {
    expect(approvedSinceSpecReview([])).toBe(false);
    expect(
      approvedSinceSpecReview([e("spec-review"), e("working", "approve")]),
    ).toBe(true);
    expect(approvedSinceSpecReview([e("spec-review"), e("working")])).toBe(
      false,
    );
    expect(
      approvedSinceSpecReview([
        e("spec-review"),
        e("working", "approve"),
        e("spec-review"),
      ]),
    ).toBe(false);
    expect(approvedSinceSpecReview([e("working", "approve")])).toBe(false);
  });
});
