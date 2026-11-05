import { describe, expect, it } from "vitest";
import {
  addOlderThreadsPage,
  countUnresolvedThreads,
  readNewerThreads,
  THREAD_PAGE,
  type OlderThreads,
} from "../../src/common/threads.ts";

const nodes = (n: number) => Array.from({ length: n }, () => ({ id: "t" }));

describe("新しい側の読み", () => {
  it("前のページがあれば、読みきれておらず起点を返す", () => {
    const r = readNewerThreads({
      totalCount: 50,
      pageInfo: { hasPreviousPage: true, startCursor: "c1" },
      nodes: nodes(30),
    });
    expect(r.total).toBe(50);
    expect(r.older).toEqual({ read: 0, unresolved: 0, complete: false });
    expect(r.before).toBe("c1");
    expect(r.nodes).toHaveLength(30);
  });

  it("合計がなく満杯なら、読みきれていない（起点はない）", () => {
    const r = readNewerThreads({
      pageInfo: { hasPreviousPage: false, startCursor: "c1" },
      nodes: nodes(THREAD_PAGE),
    });
    expect(r.total).toBeNull();
    expect(r.older.complete).toBe(false);
    expect(r.before).toBeNull();
  });

  it("合計があって前がなければ読みきれていて、合計は読めた件数より小さくならない", () => {
    const r = readNewerThreads({
      totalCount: 1,
      pageInfo: { hasPreviousPage: false, startCursor: "c1" },
      nodes: nodes(3),
    });
    expect(r.total).toBe(3);
    expect(r.older.complete).toBe(true);
    expect(r.before).toBeNull();
  });

  it("合計がなく満杯でなければ読みきれている。答えが空でも落ちない", () => {
    expect(readNewerThreads({ nodes: nodes(2) }).older.complete).toBe(true);
    const r = readNewerThreads(undefined);
    expect(r).toMatchObject({ nodes: [], total: null, before: null });
  });
});

describe("古い側の足し込み", () => {
  const fresh = (): OlderThreads => ({
    read: 0,
    unresolved: 0,
    complete: false,
  });

  it("次のページがあれば数えて次の起点を返す", () => {
    const o = fresh();
    const next = addOlderThreadsPage(o, {
      pageInfo: { hasPreviousPage: true, startCursor: "c2" },
      nodes: [{ isResolved: true }, { isResolved: false }, {}],
    });
    expect(next).toBe("c2");
    expect(o).toEqual({ read: 3, unresolved: 2, complete: false });
  });

  it("前がないと答えたら、最後まで読めた印を立てる", () => {
    const o = { read: 5, unresolved: 1, complete: false };
    const next = addOlderThreadsPage(o, {
      pageInfo: { hasPreviousPage: false, startCursor: "c3" },
      nodes: [{ isResolved: false }],
    });
    expect(next).toBeNull();
    expect(o).toEqual({ read: 6, unresolved: 2, complete: true });
  });

  it("答えに PR がないときは数えず、読みきれた印も立てない", () => {
    const o = fresh();
    expect(addOlderThreadsPage(o, null)).toBeNull();
    expect(o).toEqual({ read: 0, unresolved: 0, complete: false });
  });

  it("印がない・起点がない・空のページでは印を立てず、めくりも続けない", () => {
    const o = fresh();
    expect(
      addOlderThreadsPage(o, { nodes: [{ isResolved: true }] }),
    ).toBeNull();
    expect(
      addOlderThreadsPage(o, {
        pageInfo: { hasPreviousPage: true },
        nodes: [{}],
      }),
    ).toBeNull();
    expect(
      addOlderThreadsPage(o, {
        pageInfo: { hasPreviousPage: true, startCursor: "c" },
        nodes: [],
      }),
    ).toBeNull();
    expect(o.complete).toBe(false);
    expect(o.read).toBe(2);
  });
});

describe("未解決の数え", () => {
  it("合計に届かなければ数えきれない", () => {
    expect(
      countUnresolvedThreads({
        threads: [{ resolved: false }, { resolved: true }],
        threadTotal: 5,
        olderThreads: { read: 1, unresolved: 1, complete: true },
      }),
    ).toEqual({ unresolved: 2, truncated: true, total: 5 });
  });
  it("合計が読めなければ total は null", () => {
    expect(
      countUnresolvedThreads({
        threads: [],
        threadTotal: null,
        olderThreads: { read: 0, unresolved: 0, complete: false },
      }),
    ).toEqual({ unresolved: 0, truncated: true, total: null });
  });
});
