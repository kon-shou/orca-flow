import type { Runner, RunResult } from "../../src/lib/exec.ts";

const done = (code: number, stdout = "", stderr = ""): RunResult => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

export interface FakeComment {
  id: string;
  body: string;
  path: string;
  line: number | null;
  replyTo: string;
  /** 返す先のコメントの本文（他人の文章。CLI が読まないことを確かめるために持たせる） */
  replyToBody?: string;
  /** 返す先のコメントの書き手。省くと reviewer-a（User）。null なら読めない */
  author?: { login: string; __typename: string } | null;
}

export interface FakeGithubState {
  review: null | { id: string; body: string; comments: FakeComment[] };
  /** api の呼び出しの query 文 */
  queries: string[];
  /** gh の呼び出し（引数をつないだもの） */
  calls: string[];
  /** submitPullRequestReview が流れた回数 */
  submitted: number;
  /** submitPullRequestReview に渡された本文（渡さなかった回は null） */
  submittedBodies: (string | null)[];
  next: number;
  /** pr list が返す PR の番号 */
  prNumber: number;
  /** 失敗させる読み：repo（リポジトリ名）・prlist（PR の検索）・read（保留中のレビューの読み） */
  fail: Set<string>;
  /** 自分（viewer）のログイン名 */
  viewer: string;
  /** PR の URL */
  prUrl: string;
  /** PR の先頭（headRefOid）。null なら返さない */
  headSha: string | null;
  /** 返信を足したときの返す先の書き手（省くと reviewer-a） */
  replyAuthor: { login: string; __typename: string } | null;
  /** 流れを交互にするため、api の呼び出しを待たせる長さ（ミリ秒） */
  delayMs: number;
}

export interface FakeGithubOptions {
  /** 初めから保留中のレビューにあるコメント（渡すと R1 のレビューが最初からある） */
  comments?: FakeComment[];
  /**
   * テストごとの足しの答え。gh の呼び出しを記録したあと、ほかより先に聞く。
   * undefined を返すと、ふつうの答えに進む
   */
  answer?: (
    args: readonly string[],
    state: FakeGithubState,
  ) => RunResult | undefined | Promise<RunResult | undefined>;
}

/** 偽の GitHub（保留中のレビューを1つだけ持つ） */
export function fakeGithub(start: FakeGithubOptions = {}) {
  const state: FakeGithubState = {
    review: start.comments
      ? { id: "R1", body: "", comments: [...start.comments] }
      : null,
    queries: [],
    calls: [],
    submitted: 0,
    submittedBodies: [],
    next: 1,
    prNumber: 7,
    fail: new Set<string>(),
    delayMs: 0,
    viewer: "me-user",
    prUrl: "https://github.com/o/r/pull/7",
    headSha: "a".repeat(40),
    replyAuthor: { login: "reviewer-a", __typename: "User" },
  };
  const runner: Runner = async (cmd, args) => {
    if (cmd !== "gh") return done(127);
    state.calls.push(args.join(" "));
    const extra = await start.answer?.(args, state);
    if (extra) return extra;
    if (state.delayMs > 0 && args[0] === "api")
      await new Promise((r) => setTimeout(r, state.delayMs));
    if (args[0] === "--version" || args[0] === "auth") return done(0, "ok");
    if (args[0] === "repo")
      return state.fail.has("repo")
        ? done(1, "", "boom")
        : done(0, '{"nameWithOwner":"o/r"}');
    if (args[0] === "pr" && args[1] === "list")
      return state.fail.has("prlist")
        ? done(1, "", "boom")
        : done(
            0,
            JSON.stringify([
              {
                number: state.prNumber,
                url: state.prUrl,
                isDraft: false,
                state: "OPEN",
                ...(state.headSha === null
                  ? {}
                  : { headRefOid: state.headSha }),
                statusCheckRollup: [],
                isCrossRepository: false,
              },
            ]),
          );
    if (args[0] !== "api") return done(0);
    const query = args[3]!.replace(/^query=/, "");
    state.queries.push(query);
    const vars: Record<string, string> = {};
    for (let i = 4; i < args.length; i += 2)
      vars[args[i + 1]!.split("=")[0]!] = args[i + 1]!.slice(
        args[i + 1]!.indexOf("=") + 1,
      );
    const data = (value: unknown) => done(0, JSON.stringify({ data: value }));
    if (query.includes("addPullRequestReview(")) {
      state.review = { id: "R1", body: "", comments: [] };
      return data({
        addPullRequestReview: {
          pullRequestReview: { id: "R1", state: "PENDING" },
        },
      });
    }
    if (query.includes("addPullRequestReviewThreadReply(")) {
      const id = `C${state.next++}`;
      state.review!.comments.push({
        id,
        body: vars.body!,
        path: "a.ts",
        line: 3,
        replyTo: "C0",
        author: state.replyAuthor,
      });
      return data({
        addPullRequestReviewThreadReply: { comment: { id, state: "PENDING" } },
      });
    }
    if (query.includes("updatePullRequestReviewComment(")) {
      state.review!.comments.find((c) => c.id === vars.id)!.body = vars.body!;
      return data({ updatePullRequestReviewComment: {} });
    }
    if (query.includes("deletePullRequestReviewComment(")) {
      state.review!.comments = state.review!.comments.filter(
        (c) => c.id !== vars.id,
      );
      return data({ deletePullRequestReviewComment: {} });
    }
    if (query.includes("updatePullRequestReview(")) {
      // 本物に合わせ、本文なしで作ったレビューの本文は書き換えられない
      if (state.review!.body === "")
        return done(
          0,
          JSON.stringify({
            data: null,
            errors: [
              { message: "Could not edit a review with a missing body." },
            ],
          }),
        );
      state.review!.body = vars.body!;
      return data({ updatePullRequestReview: {} });
    }
    if (query.includes("submitPullRequestReview(")) {
      state.submitted++;
      state.submittedBodies.push(vars.body ?? null);
      return data({ submitPullRequestReview: {} });
    }
    // 読む
    if (state.fail.has("read")) return done(1, "", "boom");
    return data({
      viewer: { login: state.viewer },
      repository: {
        pullRequest: {
          id: "PR_1",
          url: state.prUrl,
          reviews: {
            nodes: state.review
              ? [
                  {
                    id: state.review.id,
                    body: state.review.body,
                    viewerDidAuthor: true,
                    comments: {
                      pageInfo: { hasNextPage: false },
                      nodes: state.review.comments.map((c) => ({
                        id: c.id,
                        body: c.body,
                        path: c.path,
                        line: c.line,
                        replyTo: {
                          id: c.replyTo,
                          ...(c.replyToBody === undefined
                            ? {}
                            : { body: c.replyToBody }),
                          author:
                            c.author === undefined
                              ? { login: "reviewer-a", __typename: "User" }
                              : c.author,
                        },
                      })),
                    },
                  },
                ]
              : [],
          },
        },
      },
    });
  };
  return { state, runner };
}
