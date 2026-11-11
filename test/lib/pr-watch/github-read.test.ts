import { describe, expect, it } from "vitest";
import {
  fetchPrDetails,
  olderThreadsQuery,
  stage2Query,
} from "../../../src/lib/github-read.ts";
import {
  countUnresolvedThreads,
  judgeAllOk,
} from "../../../src/lib/pr-watch/classify.ts";
import { testRunner } from "../../helpers/runner.ts";
import { fakeGh, ghRunner, SECRET_MARK, type FakeThread } from "./helpers.ts";

describe("2段目の問い合わせ", () => {
  it("スレッドとその返信は、古い順の先頭でなく新しい側（last）から読む", () => {
    const q = stage2Query([1, 2]);
    expect(q).toContain("reviewThreads(last: 30)");
    expect(q).toContain("comments(last: 20)");
    expect(q).not.toContain("first:");
  });

  it("スレッドの合計と、前のページがあるかの印を取る", () => {
    const q = stage2Query([1]);
    expect(q).toContain("totalCount");
    expect(q).toContain("hasPreviousPage startCursor");
  });

  it("めくる問い合わせは解決の印と pageInfo だけで、本文・作者・ID を取らない", () => {
    const q = olderThreadsQuery([7, 9]);
    expect(q).toContain("pr_7: pullRequest(number: 7)");
    expect(q).toContain("pr_9: pullRequest(number: 9)");
    expect(q).toContain("nodes { isResolved }");
    expect(q).not.toMatch(/\bbody|author|login|\bid\b|comments/);
  });

  it("めくる問い合わせの1ページは GitHub の上限の100件で、変数のカーソルから前へ読む", () => {
    const q = olderThreadsQuery([7, 9]);
    expect(q).toContain("reviewThreads(last: 100, before: $c_7)");
    expect(q).toContain("reviewThreads(last: 100, before: $c_9)");
    for (const m of q.matchAll(/last: (\d+)/g))
      expect(Number(m[1])).toBeLessThanOrEqual(100);
  });
});

/** 古い側から並べたスレッド。unresolved に入れた番号（0 が最も古い）だけ未解決 */
function threads(count: number, unresolved: number[] = []): FakeThread[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    resolvedBy: unresolved.includes(i) ? null : "alice",
    comments: [{ id: `c${i}`, author: "alice", body: SECRET_MARK }],
  }));
}

async function read(specs: Record<number, FakeThread[]>): Promise<{
  gh: ReturnType<typeof fakeGh>;
  result: Awaited<ReturnType<typeof fetchPrDetails>>;
}> {
  const gh = fakeGh();
  for (const [n, t] of Object.entries(specs))
    gh.add({ number: Number(n), threads: t });
  const result = await fetchPrDetails(
    { runner: ghRunner(gh, testRunner), cwd: process.cwd() },
    "o/r",
    Object.keys(specs).map(Number),
  );
  return { gh, result };
}

const ok = { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" };
const judge = (d: Parameters<typeof countUnresolvedThreads>[0]) => {
  const c = countUnresolvedThreads(d);
  return {
    c,
    r: judgeAllOk({
      ...ok,
      unresolvedThreads: c.unresolved,
      threadsTruncated: c.truncated,
      threadTotal: c.total,
    }),
  };
};

describe("古いスレッドをめくって数える", () => {
  it("45件で全部解決済みなら、未解決0・数えきれて、全員 OK の判定が通る", async () => {
    const { gh, result } = await read({ 7: threads(45) });
    const { c, r } = judge(result.details.get(7)!);
    expect(c).toEqual({ unresolved: 0, truncated: false, total: 45 });
    expect(r.ok).toBe(true);
    expect(gh.older).toBe(1);
    expect(result.calls).toBe(2);
  });

  it("45件でいちばん古い1件だけ未解決なら、未解決1件で通らない", async () => {
    const { result } = await read({ 7: threads(45, [0]) });
    const { c, r } = judge(result.details.get(7)!);
    expect(c.unresolved).toBe(1);
    expect(c.truncated).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.reasons.join("")).toContain("未解決のスレッドが1件");
  });

  it("合計が330件を超えると、3回めくっても読みきれず、数えきれないとして通らず、理由に合計が出る", async () => {
    const { gh, result } = await read({ 7: threads(331) });
    expect(gh.older).toBe(3);
    const { c, r } = judge(result.details.get(7)!);
    expect(c).toEqual({ unresolved: 0, truncated: true, total: 331 });
    expect(r.ok).toBe(false);
    expect(r.reasons.join("")).toContain("スレッドが331件あり");
    expect(r.reasons.join("")).toContain("数えきれません");
  });

  it("ちょうど330件なら3回めくって数えきれる", async () => {
    const { gh, result } = await read({ 7: threads(330, [100]) });
    expect(gh.older).toBe(3);
    const { c } = judge(result.details.get(7)!);
    expect(c).toEqual({ unresolved: 1, truncated: false, total: 330 });
  });

  it("前のページがない PR（29件・ちょうど30件）は、めくる問い合わせを流さない", async () => {
    for (const n of [0, 29, 30]) {
      const { gh, result } = await read({ 7: threads(n) });
      expect(gh.older).toBe(0);
      expect(result.calls).toBe(1);
      expect(judge(result.details.get(7)!).c.truncated).toBe(false);
    }
  });

  it("めくる PR が複数でも1つの問い合わせにまとまり、3回を超えず、前のない PR は入らない", async () => {
    const { gh, result } = await read({
      7: threads(45),
      8: threads(400),
      9: threads(10),
      10: threads(150, [20]),
    });
    expect(gh.older).toBe(3);
    expect(gh.olderNumbers[0]).toEqual([7, 8, 10]);
    // 7 は1回で読みきり、2回目からは入らない
    expect(gh.olderNumbers[1]).toEqual([8, 10]);
    expect(gh.olderNumbers[2]).toEqual([8]);
    expect(gh.stage2).toBe(1);
    expect(result.calls).toBe(4);
    expect(result.cost).toBeGreaterThanOrEqual(4);
    for (const q of gh.olderQueries) expect(q).not.toContain("body");
    expect(judge(result.details.get(10)!).c.unresolved).toBe(1);
    expect(judge(result.details.get(8)!).c.truncated).toBe(true);
  });
});

describe("合計（totalCount）が読めない応答は、安全側に倒して数えきれないにする", () => {
  async function readOmitting(
    flags: { totalCount?: boolean; pageInfo?: boolean },
    count: number,
    unresolved: number[] = [],
  ) {
    const gh = fakeGh();
    gh.omitTotalCount = flags.totalCount === true;
    gh.omitPageInfo = flags.pageInfo === true;
    gh.add({ number: 7, threads: threads(count, unresolved) });
    const result = await fetchPrDetails(
      { runner: ghRunner(gh, testRunner), cwd: process.cwd() },
      "o/r",
      [7],
    );
    return { gh, result, ...judge(result.details.get(7)!) };
  }

  it("totalCount がなく、400件で古い1件が未解決でも、通らない（めくりが3回で終わるため数えきれない）", async () => {
    const { c, r, gh } = await readOmitting({ totalCount: true }, 400, [0]);
    expect(gh.older).toBe(3);
    expect(c.truncated).toBe(true);
    expect(c.total).toBeNull();
    expect(r.ok).toBe(false);
    expect(r.reasons.join("")).toContain("数えきれません");
    expect(r.reasons.join("")).not.toMatch(/スレッドが\d+件/);
  });

  it("totalCount がなくても、前が最後まで読めた45件は数えきれる", async () => {
    const { c, r } = await readOmitting({ totalCount: true }, 45, [0]);
    expect(c).toEqual({ unresolved: 1, truncated: false, total: null });
    expect(r.ok).toBe(false);
    const all = await readOmitting({ totalCount: true }, 45);
    expect(all.c.truncated).toBe(false);
    expect(all.r.ok).toBe(true);
  });

  it("totalCount も pageInfo もない45件は、30件読めても前が分からず数えきれない", async () => {
    const { c, r, gh } = await readOmitting(
      { totalCount: true, pageInfo: true },
      45,
    );
    expect(gh.older).toBe(0);
    expect(c.truncated).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("totalCount も pageInfo もなくても、30件未満なら読みきれている", async () => {
    const { c } = await readOmitting({ totalCount: true, pageInfo: true }, 29);
    expect(c.truncated).toBe(false);
  });

  it("前があるのに startCursor がない・めくりの答えに PR が欠けたときは、数えきれない", async () => {
    const gh = fakeGh();
    gh.add({ number: 7, threads: threads(45) });
    const inner = ghRunner(gh, testRunner);
    const mangle =
      (edit: (q: string, out: string) => string) =>
      async (...a: Parameters<typeof inner>) => {
        const res = await inner(...a);
        const q = a[1].find((x) => x.startsWith("query=")) ?? "";
        return { ...res, stdout: edit(q, res.stdout) };
      };
    for (const edit of [
      // 前のページの印はあるが、カーソルがない
      (q: string, out: string) =>
        q.includes("before:")
          ? out
          : out.replace(/"startCursor":"cur\d+"/, '"startCursor":null'),
      // めくりの答えから PR が消える
      (q: string, out: string) =>
        q.includes("before:")
          ? JSON.stringify({
              data: { rateLimit: { cost: 1 }, repository: {} },
            })
          : out,
    ]) {
      const result = await fetchPrDetails(
        { runner: mangle(edit), cwd: process.cwd() },
        "o/r",
        [7],
      );
      const { c, r } = judge(result.details.get(7)!);
      expect(c.truncated).toBe(true);
      expect(r.ok).toBe(false);
    }
  });
});

describe("2段目の読み：書いた時刻", () => {
  it("問い合わせにコメントとスレッドの発言の createdAt とレビューの submittedAt があり、本文はない", () => {
    const q = stage2Query([7]);
    expect(q.match(/createdAt/g)).toHaveLength(2);
    expect(q.match(/submittedAt/g)).toHaveLength(1);
    expect(q).toContain("createdAt state } }");
    expect(q).not.toMatch(/\bbody|bodyText|bodyHTML/);
  });

  it("時刻を中身に持たせる。保留中のレビューや時刻のない書き込みは null で、本文は持たない", async () => {
    const gh = fakeGh();
    gh.add({
      number: 7,
      reviews: [
        {
          id: "r1",
          author: "alice",
          body: SECRET_MARK,
          at: "2026-11-04T01:00:00Z",
        },
        { id: "r2", author: "me", body: SECRET_MARK },
      ],
      comments: [
        {
          id: "c1",
          author: "bob",
          body: SECRET_MARK,
          at: "2026-11-04T02:00:00Z",
        },
      ],
      threads: [
        {
          id: "t1",
          resolvedBy: null,
          comments: [
            {
              id: "c2",
              author: "alice",
              body: SECRET_MARK,
              at: "2026-11-04T03:00:00Z",
            },
          ],
        },
      ],
    });
    const result = await fetchPrDetails(
      { runner: ghRunner(gh, testRunner), cwd: process.cwd() },
      "o/r",
      [7],
    );
    const d = result.details.get(7)!;
    expect(d.reviews.map((r) => r.at ?? null)).toEqual([
      "2026-11-04T01:00:00Z",
      null,
    ]);
    expect(d.comments[0]!.at).toBe("2026-11-04T02:00:00Z");
    expect(d.threads[0]!.comments[0]!.at).toBe("2026-11-04T03:00:00Z");
    expect(JSON.stringify(d)).not.toContain(SECRET_MARK);
  });

  it("スレッドの発言の保留中の印（state）を読み、本文は持たない", async () => {
    const gh = fakeGh();
    gh.add({
      number: 7,
      threads: [
        {
          id: "t1",
          resolvedBy: null,
          comments: [
            {
              id: "c1",
              author: "alice",
              body: SECRET_MARK,
              at: "2026-11-04T01:00:00Z",
            },
            {
              id: "c2",
              author: "me",
              body: SECRET_MARK,
              at: "2026-11-04T02:00:00Z",
              pending: true,
            },
          ],
        },
      ],
    });
    const result = await fetchPrDetails(
      { runner: ghRunner(gh, testRunner), cwd: process.cwd() },
      "o/r",
      [7],
    );
    const cs = result.details.get(7)!.threads[0]!.comments;
    expect(cs.map((c) => c.pending === true)).toEqual([false, true]);
    expect(JSON.stringify(result.details.get(7))).not.toContain(SECRET_MARK);
  });
});
