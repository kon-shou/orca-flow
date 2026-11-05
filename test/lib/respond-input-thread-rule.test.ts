import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import {
  fetchRespondSource,
  fetchTargetSource,
} from "../../src/lib/respond-input.ts";

const done = (stdout: string) => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
});
const PR = "https://github.com/o/r/pull/7";

const c = (body: string, login = "bob") => ({ body, author: { login } });

/** 同じスレッドのデータを、両方の読みに渡す */
async function both(thread: Record<string, unknown>) {
  const runner: Runner = async (_cmd, args) => {
    if (args[0] === "repo") return done('{"nameWithOwner":"o/r"}');
    if (args[0] === "pr")
      return done(JSON.stringify({ statusCheckRollup: [] }));
    const isTarget = args.some((a) => a.startsWith("id="));
    return done(
      JSON.stringify({
        data: {
          viewer: { login: "me" },
          ...(isTarget
            ? {
                node: {
                  __typename: "PullRequestReviewThread",
                  pullRequest: { url: PR, title: "t" },
                  ...thread,
                },
              }
            : {
                repository: {
                  pullRequest: {
                    url: PR,
                    reviews: { totalCount: 0, nodes: [] },
                    comments: { totalCount: 0, nodes: [] },
                    reviewThreads: {
                      totalCount: 1,
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{ id: "PRRT_1", isResolved: false, ...thread }],
                    },
                  },
                },
              }),
        },
      }),
    );
  };
  const g = { runner, cwd: "/x" };
  const src = await fetchRespondSource(g, 7);
  const target = await fetchTargetSource(g, PR, "PRRT_1");
  const t = src.threads[0]!;
  return {
    input: t,
    target,
    inputBodies: t.comments.filter((x) => !x.mine).map((x) => x.body),
    targetBodies: target.comments.map((x) => x.body),
  };
}

describe("スレッドの返信の読みの決まり（両方の読みで同じ）", () => {
  it("返信が新しい側に収まるとき、先頭を足さない", async () => {
    const r = await both({
      path: "a.ts",
      line: 4,
      head: { nodes: [c("1")] },
      tail: { totalCount: 3, nodes: [c("1"), c("2"), c("3")] },
    });
    expect(r.inputBodies).toEqual(["1", "2", "3"]);
    expect(r.targetBodies).toEqual(r.inputBodies);
    expect(r.input.moreComments).toBe(false);
    expect(r.target.line).toBe(r.input.line);
  });

  it("間を飛ばすとき、先頭と新しい側を合わせ、飛ばした件数を数える", async () => {
    const r = await both({
      path: "a.ts",
      line: 4,
      head: { nodes: [c("1")] },
      tail: { totalCount: 30, nodes: [c("12"), c("13")] },
    });
    expect(r.inputBodies).toEqual(["1", "12", "13"]);
    expect(r.targetBodies).toEqual(["1", "12", "13"]);
    expect(r.input.moreComments).toBe(true);
    expect(r.input.skippedComments).toBe(27);
  });

  it("行がなく元の行だけあるとき、同じ元の行になる", async () => {
    const r = await both({
      path: "a.ts",
      line: null,
      originalLine: 9,
      head: { nodes: [c("1")] },
      tail: { totalCount: 1, nodes: [c("1")] },
    });
    expect(r.input.line).toBe(9);
    expect(r.target.line).toBe(9);
    expect(r.target.path).toBe(r.input.path);
  });

  it("自分の返信と下書きを外すのは1件を引く読みだけ", async () => {
    const r = await both({
      path: "a.ts",
      line: 4,
      head: { nodes: [c("1")] },
      tail: {
        totalCount: 4,
        nodes: [
          c("1"),
          c("自分の返信", "me"),
          { body: "下書き", state: "PENDING", author: { login: "bob" } },
          c("4"),
        ],
      },
    });
    expect(r.input.comments.map((x) => x.body)).toEqual([
      "1",
      "自分の返信",
      "下書き",
      "4",
    ]);
    expect(r.targetBodies).toEqual(["1", "4"]);
  });
});
