import { describe, expect, it } from "vitest";
import {
  classifyDetail,
  describeCounts,
  judgeAllOk,
  countUnresolvedThreads,
} from "../../../src/lib/pr-watch/classify.ts";
import { repoFromRemote, stage2Query } from "../../../src/lib/github-read.ts";
import type { PrDetail } from "../../../src/lib/github-read.ts";

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  number: 7,
  url: "",
  state: "open",
  isDraft: false,
  head: "h1",
  branch: "task/T07-x",
  updatedAt: "t",
  mergedAt: null,
  mergeCommit: null,
  reviewDecision: null,
  mergeStateStatus: null,
  ci: "passed",
  reviews: [],
  comments: [],
  threads: [],
  threadTotal: 0,
  olderThreads: { read: 0, unresolved: 0, complete: true },
  threadsBefore: null,
  ...over,
});

describe("動きの見分け", () => {
  it("自分のアカウントの書き込みは数えず、他人の書き込みと前回に見ていないものだけ数える", () => {
    const result = classifyDetail({
      viewer: "me",
      prev: undefined,
      ownHeads: new Set(),
      detail: detail({
        reviews: [
          { id: "r1", author: "me" },
          { id: "r2", author: "bob" },
        ],
        comments: [
          { id: "c1", author: "me" },
          { id: "c2", author: null },
        ],
        threads: [
          { id: "t1", resolved: true, resolvedBy: "me", comments: [] },
          {
            id: "t2",
            resolved: true,
            resolvedBy: "bob",
            comments: [{ id: "c3", author: "bob" }],
          },
        ],
      }),
    });
    expect(result.counts).toEqual({
      review: 1,
      comment: 2,
      resolved: 1,
      push: 0,
    });
    expect(describeCounts(result.counts)).toEqual([
      "レビュー1件",
      "コメント2件",
      "スレッドの解決1件",
    ]);
  });

  it("前回見たものは数えず、先頭が送った push のものなら数えない", () => {
    const first = classifyDetail({
      viewer: "me",
      prev: undefined,
      ownHeads: new Set(),
      detail: detail({ reviews: [{ id: "r2", author: "bob" }] }),
    });
    const prev = {
      number: 7,
      url: "",
      branch: "b",
      taskId: "T07",
      updatedAt: "t",
      head: "h0",
      ci: "passed" as const,
      isDraft: false,
      seen: first.seen,
      baseline: false,
      final: null,
      finalAt: null,
    };
    const next = classifyDetail({
      viewer: "me",
      prev,
      ownHeads: new Set(["h1"]),
      detail: detail({ reviews: [{ id: "r2", author: "bob" }] }),
    });
    expect(next.counts).toEqual({
      review: 0,
      comment: 0,
      resolved: 0,
      push: 0,
    });
    expect(next.ciChanged).toBe(false);
    const other = classifyDetail({
      viewer: "me",
      prev,
      ownHeads: new Set(),
      detail: detail(),
    });
    expect(other.counts.push).toBe(1);
  });
});

describe("全員 OK の判定", () => {
  it("承認され CLEAN で下書きでないときだけ OK", () => {
    expect(
      judgeAllOk({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }).ok,
    ).toBe(true);
    expect(
      judgeAllOk({
        reviewDecision: "REVIEW_REQUIRED",
        mergeStateStatus: "CLEAN",
      }).ok,
    ).toBe(false);
    expect(
      judgeAllOk({ reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" })
        .reasons,
    ).toHaveLength(1);
    expect(
      judgeAllOk({
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: true,
      }).ok,
    ).toBe(false);
    expect(
      judgeAllOk({ reviewDecision: null, mergeStateStatus: null }).reasons,
    ).toHaveLength(2);
  });

  it("未解決のスレッド・変更の要求・reviewDecision が空・CLEAN でない・下書きのどれでも通らない", () => {
    const base = { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" };
    expect(judgeAllOk({ ...base, unresolvedThreads: 0 }).ok).toBe(true);
    const threads = judgeAllOk({ ...base, unresolvedThreads: 2 });
    expect(threads.ok).toBe(false);
    expect(threads.reasons.join("")).toContain("2");
    expect(
      judgeAllOk({ ...base, reviewDecision: "CHANGES_REQUESTED" }).ok,
    ).toBe(false);
    expect(judgeAllOk({ ...base, reviewDecision: null }).ok).toBe(false);
    expect(judgeAllOk({ ...base, reviewDecision: "" }).ok).toBe(false);
    expect(judgeAllOk({ ...base, mergeStateStatus: "BEHIND" }).ok).toBe(false);
    expect(judgeAllOk({ ...base, isDraft: true }).ok).toBe(false);
  });
});

describe("全員 OK の判定：フックつきと計算中", () => {
  const base = { reviewDecision: "APPROVED", unresolvedThreads: 0 };
  it("HAS_HOOKS でも、承認・下書きでない・未解決0なら OK", () => {
    const r = judgeAllOk({
      ...base,
      mergeStateStatus: "HAS_HOOKS",
      isDraft: false,
    });
    expect(r).toEqual({ ok: true, reasons: [] });
  });
  it("HAS_HOOKS でも未解決のスレッドがあれば OK にならない", () => {
    expect(
      judgeAllOk({
        ...base,
        mergeStateStatus: "HAS_HOOKS",
        unresolvedThreads: 1,
      }).ok,
    ).toBe(false);
  });
  it("UNKNOWN は OK にならず、計算中の趣旨と読み直しの案内が理由に入る", () => {
    const r = judgeAllOk({ ...base, mergeStateStatus: "UNKNOWN" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain("計算中");
    expect(r.reasons[0]).toContain("もう一度確かめ");
  });
});

describe("スレッドの数え方", () => {
  const mk = (n: number, unresolved = 0) =>
    Array.from({ length: n }, (_, i) => ({ resolved: i >= unresolved }));
  const base = { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" };
  const judge = (d: Parameters<typeof countUnresolvedThreads>[0]) => {
    const c = countUnresolvedThreads(d);
    return judgeAllOk({
      ...base,
      unresolvedThreads: c.unresolved,
      threadsTruncated: c.truncated,
      threadTotal: c.total,
    });
  };
  it("新しい30件と古い側の数えを足し、読んだ件数が合計に届くなら数えきれる", () => {
    const c = countUnresolvedThreads({
      threads: mk(30, 1),
      threadTotal: 45,
      olderThreads: { read: 15, unresolved: 2 },
    });
    expect(c).toEqual({ unresolved: 3, truncated: false, total: 45 });
  });
  it("30件ちょうどで合計30なら数えきれて通る", () => {
    const d = {
      threads: mk(30),
      threadTotal: 30,
      olderThreads: { read: 0, unresolved: 0, complete: true },
    };
    expect(countUnresolvedThreads(d).truncated).toBe(false);
    expect(judge(d).ok).toBe(true);
  });
  it("読んだ件数が合計に届かないときだけ数えきれず、理由に合計が出る", () => {
    const r = judge({
      threads: mk(30),
      threadTotal: 400,
      olderThreads: { read: 300, unresolved: 0 },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join("")).toContain(
      "スレッドが400件あり、古い未解決を数えきれません",
    );
  });
});

describe("スレッドの数え方：合計が分からないとき", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, () => ({ resolved: true }));
  it("最後まで読めた印がなければ、合計が分からなくても数えきれない。理由に誤った件数を出さない", () => {
    const c = countUnresolvedThreads({
      threads: mk(30),
      threadTotal: null,
      olderThreads: { read: 300, unresolved: 0, complete: false },
    });
    expect(c).toEqual({ unresolved: 0, truncated: true, total: null });
    const r = judgeAllOk({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      threadsTruncated: c.truncated,
      threadTotal: c.total,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join("")).toContain("合計が分からず");
    expect(r.reasons.join("")).not.toContain("0件");
  });
  it("最後まで読めた印があれば、合計が分からなくても数えきれる", () => {
    const c = countUnresolvedThreads({
      threads: mk(30),
      threadTotal: null,
      olderThreads: { read: 15, unresolved: 0, complete: true },
    });
    expect(c.truncated).toBe(false);
  });
  it("合計が分かっても、最後まで読めた印がなければ数えきれない", () => {
    const c = countUnresolvedThreads({
      threads: mk(30),
      threadTotal: 45,
      olderThreads: { read: 15, unresolved: 0, complete: false },
    });
    expect(c.truncated).toBe(true);
  });
});

describe("読みの問い合わせ", () => {
  it("origin の URL から owner/name を読む", () => {
    expect(repoFromRemote("https://github.com/o/r.git")).toBe("o/r");
    expect(repoFromRemote("git@github.com:o/r.git")).toBe("o/r");
    expect(repoFromRemote("/tmp/origin.git")).toBeNull();
  });

  it("2段目は他人の文章（本文）を取らない", () => {
    const query = stage2Query([7, 9]);
    expect(query).toContain("pr_7: pullRequest(number: 7)");
    expect(query).toContain("pr_9: pullRequest(number: 9)");
    expect(query).not.toMatch(/\bbody|bodyText|bodyHTML|title\b/);
  });
});
