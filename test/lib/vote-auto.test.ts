import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AUTO_MAX_PENDING,
  AUTO_MIN_AGREED,
  AUTO_MIN_RATE_PERCENT,
  applyAutoAnswer,
  applyAutoCast,
  autoPath,
  countAuto,
  currentAutoState,
  disableKind,
  enableKind,
  meetsFloor,
  readAutoState,
} from "../../src/lib/vote-auto.ts";
import type { KindStats } from "../../src/lib/vote.ts";
import { tempDir } from "../helpers/repo.ts";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const stats = (bothAgree: number, bothAgreeHuman: number): KindStats =>
  ({ bothAgree, bothAgreeHuman }) as KindStats;

const NOW = "2026-02-01T00:00:00.000Z";
const cast = (id: string, target: string) => ({
  id,
  target,
  kind: "comment" as const,
  key: "fix" as const,
  now: NOW,
  agreed: true,
  floorMet: true,
});

describe("下限", () => {
  it("定数は20件・95%・確かめ待ち5件", () => {
    expect(AUTO_MIN_AGREED).toBe(20);
    expect(AUTO_MIN_RATE_PERCENT).toBe(95);
    expect(AUTO_MAX_PENDING).toBe(5);
  });

  it("20件で1件の外れまでは満たし、2件の外れは満たさない", () => {
    expect(meetsFloor(stats(20, 20))).toBe(true);
    expect(meetsFloor(stats(20, 19))).toBe(true);
    expect(meetsFloor(stats(20, 18))).toBe(false);
    expect(meetsFloor(stats(19, 19))).toBe(false);
    expect(meetsFloor(undefined)).toBe(false);
  });
});

describe("自動の記録", () => {
  it("ないときは全部切りで、読んでも作らない", async () => {
    const common = await tempDir();
    expect(await readAutoState(common)).toEqual({ status: "missing" });
    expect(await currentAutoState(common)).toEqual({ kinds: {}, items: [] });
    await expect(readFile(autoPath(common), "utf8")).rejects.toThrow();
  });

  it("壊れた記録は broken で、全部切りとして読む。自動で決める側は書き換えない", async () => {
    const common = await tempDir();
    await mkdir(path.join(common, "orca-flow"), { recursive: true });
    await writeFile(autoPath(common), "{壊れた");
    expect((await readAutoState(common)).status).toBe("broken");
    expect((await currentAutoState(common)).items).toEqual([]);
    expect(await applyAutoCast(common, cast("T01", "A"))).toBe(false);
    expect(await readFile(autoPath(common), "utf8")).toBe("{壊れた");
  });

  it("入れた種類にだけ自動の件を足し、同じ対象のやり直しは1つのまま", async () => {
    const common = await tempDir();
    expect(await applyAutoCast(common, cast("T01", "A"))).toBe(false);
    await enableKind(common, "comment", NOW);
    expect(await applyAutoCast(common, cast("T01", "A"))).toBe(true);
    expect(await applyAutoCast(common, cast("T01", "A"))).toBe(true);
    const state = await currentAutoState(common);
    expect(state.items).toHaveLength(1);
    expect(state.kinds.comment).toEqual({ on: true, at: NOW, why: null });
  });

  it("別のキーで一致したやり直しは、件を1つのまま新しいキーにする", async () => {
    const common = await tempDir();
    await enableKind(common, "comment", NOW);
    await applyAutoCast(common, cast("T01", "A"));
    expect(
      await applyAutoCast(common, { ...cast("T01", "A"), key: "wontfix" }),
    ).toBe(true);
    const { items } = await currentAutoState(common);
    expect(items).toHaveLength(1);
    expect(items[0]!.key).toBe("wontfix");
  });

  it("下限を割った・一致しなかった cast は自動で決めず、前の件を消す", async () => {
    const common = await tempDir();
    await enableKind(common, "comment", NOW);
    await applyAutoCast(common, cast("T01", "A"));
    expect(
      await applyAutoCast(common, { ...cast("T01", "A"), floorMet: false }),
    ).toBe(false);
    expect((await currentAutoState(common)).items).toEqual([]);
    expect(
      await applyAutoCast(common, { ...cast("T01", "B"), agreed: false }),
    ).toBe(false);
  });

  it("確かめ待ちが5件で止まり、確かめると再開する", async () => {
    const common = await tempDir();
    await enableKind(common, "comment", NOW);
    for (let i = 0; i < 5; i++)
      expect(await applyAutoCast(common, cast("T01", `A${i}`))).toBe(true);
    expect(await applyAutoCast(common, cast("T01", "A5"))).toBe(false);
    // 待ちの1件のやり直しは数に入れない
    expect(await applyAutoCast(common, cast("T01", "A0"))).toBe(true);
    await applyAutoAnswer(common, {
      id: "T01",
      target: "A1",
      human: "fix",
      now: NOW,
    });
    expect(await applyAutoCast(common, cast("T01", "A5"))).toBe(true);
    expect(countAuto(await currentAutoState(common), "comment")).toEqual({
      total: 6,
      checked: 1,
      missed: 0,
      pending: 5,
    });
  });

  it("違うキーの答えで切れ、理由は miss", async () => {
    const common = await tempDir();
    await enableKind(common, "comment", NOW);
    await applyAutoCast(common, cast("T01", "A"));
    const r = await applyAutoAnswer(common, {
      id: "T01",
      target: "A",
      human: "ask",
      now: "2026-03-01T00:00:00.000Z",
    });
    expect(r).toEqual({ kind: "comment", missed: true });
    const state = await currentAutoState(common);
    expect(state.kinds.comment).toEqual({
      on: false,
      at: "2026-03-01T00:00:00.000Z",
      why: "miss",
    });
    expect(countAuto(state, "comment").missed).toBe(1);
  });

  it("自動の件でない答えは何も変えず、null", async () => {
    const common = await tempDir();
    await enableKind(common, "comment", NOW);
    expect(
      await applyAutoAnswer(common, {
        id: "T01",
        target: "X",
        human: "fix",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("disableKind は記録がなければ作らず、あれば人の理由で切る", async () => {
    const common = await tempDir();
    expect(await disableKind(common, "comment", NOW, "human")).toBe(false);
    await expect(readFile(autoPath(common), "utf8")).rejects.toThrow();
    await enableKind(common, "comment", NOW);
    expect(await disableKind(common, "comment", NOW, "human")).toBe(true);
    expect((await currentAutoState(common)).kinds.comment?.why).toBe("human");
  });
});
