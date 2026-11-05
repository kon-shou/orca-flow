import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import {
  CI_FAILED_CONCLUSIONS,
  addPendingThreadReply,
  chooseMergeMethod,
  ciResultOf,
  createDraftPr,
  createPendingReviewOn,
  ghGraphql,
  repoOwnerName,
  findPr,
  markPrReady,
  mergePr,
  pushApprovedSha,
  pushTaskBranch,
  readAllowedMergeMethods,
  redactSecrets,
  readPendingReviewOf,
  requestReviewers,
  requireGh,
  submitPendingReview,
} from "../../src/lib/github.ts";

const done = (code: number, stdout = "", stderr = "") => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

function recorder(
  reply: (cmd: string, args: readonly string[]) => ReturnType<typeof done>,
) {
  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return reply(cmd, args);
  };
  return { runner, calls };
}

describe("github", () => {
  it("トークンらしい値を伏せる", () => {
    const text = redactSecrets(
      "token ghp_abcdefghijklmnopqrstuvwxyz0123 と github_pat_ABCDEFGHIJ0123456789 と https://user:secretpw@github.com/x と GH_TOKEN=abcdef123456",
      ["my-own-secret-value"],
    );
    expect(text).not.toMatch(/ghp_abc|github_pat_ABC|secretpw|abcdef123456/);
    expect(
      redactSecrets("a my-own-secret-value b", ["my-own-secret-value"]),
    ).toBe("a 〈伏せた〉 b");
  });

  it("gh がないと終了コード2、ログインしていなくても2。トークンは出ない", async () => {
    const missing = recorder(() => done(127, "", "spawn gh ENOENT"));
    await expect(
      requireGh({ runner: missing.runner, cwd: "/x" }),
    ).rejects.toMatchObject({ code: 2 });

    const out = recorder((_c, args) =>
      args[0] === "--version"
        ? done(0, "gh 2.0")
        : done(1, "", "token ghp_abcdefghijklmnopqrstuvwxyz0123 invalid"),
    );
    const error = await requireGh({ runner: out.runner, cwd: "/x" }).catch(
      (e: Error) => e,
    );
    expect(error).toMatchObject({ code: 2 });
    expect((error as Error).message).not.toContain("ghp_");
  });

  it("gh の失敗の文からトークンを伏せる", async () => {
    const r = recorder(() =>
      done(1, "", "bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123"),
    );
    const error = await markPrReady({ runner: r.runner, cwd: "/x" }, 3).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toContain("下書きの解除に失敗");
    expect((error as Error).message).not.toContain("ghp_");
  });

  it("push はタスクのブランチだけを渡し、base へは出さない。force は lease だけ", async () => {
    const r = recorder(() => done(0));
    const g = { runner: r.runner, cwd: "/x" };
    await pushTaskBranch(g, "task/T1-a", "main");
    await pushTaskBranch(g, "task/T1-a", "main", { expectedRemoteHead: "abc" });
    expect(r.calls).toEqual([
      ["git", "push", "--set-upstream", "origin", "task/T1-a"],
      [
        "git",
        "push",
        "--force-with-lease=task/T1-a:abc",
        "--set-upstream",
        "origin",
        "task/T1-a",
      ],
    ]);
    await expect(pushTaskBranch(g, "main", "main")).rejects.toThrow();
  });

  it("承認した SHA を明示して push し、base へは出さない", async () => {
    const r = recorder(() => done(0));
    const g = { runner: r.runner, cwd: "/x" };
    const sha = "a".repeat(40);
    await pushApprovedSha(g, "task/T1-a", "main", sha);
    expect(r.calls).toEqual([
      ["git", "push", "origin", `${sha}:refs/heads/task/T1-a`],
    ]);
    await expect(pushApprovedSha(g, "main", "main", sha)).rejects.toThrow();
    await expect(
      pushApprovedSha(g, "task/T1-a", "main", "HEAD"),
    ).rejects.toThrow();
    expect(r.calls).toHaveLength(1);
  });

  it("期待値つきの承認した SHA の push は --force-with-lease で、形の悪い期待値は断る", async () => {
    const r = recorder(() => done(0));
    const g = { runner: r.runner, cwd: "/x" };
    const sha = "a".repeat(40);
    const expected = "b".repeat(40);
    await pushApprovedSha(g, "task/T1-a", "main", sha, {
      expectedRemoteHead: expected,
    });
    expect(r.calls).toEqual([
      [
        "git",
        "push",
        `--force-with-lease=refs/heads/task/T1-a:${expected}`,
        "origin",
        `${sha}:refs/heads/task/T1-a`,
      ],
    ]);
    await expect(
      pushApprovedSha(g, "task/T1-a", "main", sha, {
        expectedRemoteHead: "HEAD",
      }),
    ).rejects.toThrow();
    expect(r.calls).toHaveLength(1);
  });

  it("下書きの PR を出し、番号を URL から読む", async () => {
    const r = recorder(() => done(0, "https://github.com/o/r/pull/42\n"));
    const pr = await createDraftPr(
      { runner: r.runner, cwd: "/x" },
      {
        base: "main",
        head: "task/T1-a",
        title: "T1: 名前",
        bodyFile: "/tmp/b.md",
      },
    );
    expect(pr).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
    expect(r.calls[0]).toEqual([
      "gh",
      "pr",
      "create",
      "--draft",
      "--base",
      "main",
      "--head",
      "task/T1-a",
      "--title",
      "T1: 名前",
      "--body-file",
      "/tmp/b.md",
    ]);
  });

  it("PR を探し、開いているものを先にして CI の結果を読む", async () => {
    const list = JSON.stringify([
      {
        number: 1,
        url: "u1",
        isDraft: false,
        state: "CLOSED",
        headRefOid: "a",
        statusCheckRollup: [],
      },
      {
        number: 2,
        url: "u2",
        isDraft: true,
        state: "OPEN",
        headRefOid: "b",
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { state: "SUCCESS" },
        ],
      },
    ]);
    const r = recorder(() => done(0, list));
    const pr = await findPr({ runner: r.runner, cwd: "/x" }, "task/T1-a");
    expect(pr).toMatchObject({
      number: 2,
      isDraft: true,
      state: "open",
      ci: "passed",
      headSha: "b",
    });
    const none = recorder(() => done(0, "[]"));
    expect(await findPr({ runner: none.runner, cwd: "/x" }, "b")).toBeNull();
  });

  it("CI の結果：失敗が1つでもあれば failed、実行中があれば pending、なければ none", () => {
    expect(ciResultOf([])).toBe("none");
    expect(ciResultOf([{ status: "IN_PROGRESS", conclusion: "" }])).toBe(
      "pending",
    );
    expect(
      ciResultOf([
        { status: "IN_PROGRESS", conclusion: "" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failed");
    expect(ciResultOf([{ state: "PENDING" }])).toBe("pending");
  });

  it("フォークからの PR（isCrossRepository）は、同じ名前のブランチでもタスクの PR として拾わない", async () => {
    const r = recorder(() =>
      done(
        0,
        JSON.stringify([
          { number: 9, state: "OPEN", url: "u9", isCrossRepository: true },
          { number: 3, state: "OPEN", url: "u3", isCrossRepository: false },
        ]),
      ),
    );
    const pr = await findPr({ runner: r.runner, cwd: "/x" }, "task/T1-a");
    expect(pr?.number).toBe(3);
    expect(r.calls[0]!.join(" ")).toContain("isCrossRepository");
    const onlyFork = recorder(() =>
      done(
        0,
        JSON.stringify([
          { number: 9, state: "OPEN", url: "u9", isCrossRepository: true },
        ]),
      ),
    );
    expect(
      await findPr({ runner: onlyFork.runner, cwd: "/x" }, "task/T1-a"),
    ).toBeNull();
  });
});

describe("マージの呼び出し", () => {
  it("許された方式を merge・squash・rebase の順に選ぶ。なければ null", () => {
    expect(chooseMergeMethod(["rebase", "squash", "merge"])).toBe("merge");
    expect(chooseMergeMethod(["rebase", "squash"])).toBe("squash");
    expect(chooseMergeMethod(["rebase"])).toBe("rebase");
    expect(chooseMergeMethod([])).toBeNull();
  });

  it("リポジトリの設定から許された方式を読む", async () => {
    const { runner, calls } = recorder(() =>
      done(
        0,
        JSON.stringify({
          mergeCommitAllowed: false,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
        }),
      ),
    );
    expect(await readAllowedMergeMethods({ runner, cwd: "/x" })).toEqual([
      "squash",
      "rebase",
    ]);
    expect(calls[0]!.slice(0, 3)).toEqual(["gh", "repo", "view"]);
  });

  it("gh pr merge に方式と --match-head-commit をつけ、ブランチは消さない", async () => {
    const { runner, calls } = recorder(() => done(0));
    const head = "a".repeat(40);
    await mergePr({ runner, cwd: "/x" }, 7, "squash", head);
    expect(calls).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", head],
    ]);
  });

  it("gh pr merge が時間切れなら FlowError(1)で、マージできたか分からないと伝える", async () => {
    const { runner } = recorder(() => ({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const error = await mergePr(
      { runner, cwd: "/x" },
      7,
      "merge",
      "b".repeat(40),
    ).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 1 });
    expect((error as Error).message).toContain("時間内に終わりませんでした");
    expect((error as Error).message).toContain("マージできたか分からない");
  });

  it("先頭の形が違えば呼ばない。失敗は FlowError(1) で、トークンを伏せる", async () => {
    const { runner, calls } = recorder(() =>
      done(1, "", "boom ghp_abcdefghij1234567890"),
    );
    await expect(
      mergePr({ runner, cwd: "/x" }, 7, "merge", "--bad"),
    ).rejects.toMatchObject({ code: 1 });
    expect(calls).toEqual([]);
    const error = await mergePr(
      { runner, cwd: "/x" },
      7,
      "merge",
      "b".repeat(40),
    ).catch((e: Error) => e);
    expect((error as Error).message).toContain("失敗しました");
    expect((error as Error).message).not.toContain("ghp_abcdefghij");
  });

  describe("保留中のレビュー", () => {
    const readReply = (comments: unknown, hasNext = false) =>
      recorder((_cmd, args) =>
        args[0] === "repo"
          ? done(0, '{"nameWithOwner":"o/r"}')
          : done(
              0,
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      id: "PR_1",
                      reviews: {
                        nodes: [
                          {
                            id: "R1",
                            body: "本文",
                            viewerDidAuthor: true,
                            comments: {
                              pageInfo: { hasNextPage: hasNext },
                              nodes: comments,
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            ),
      );
    const g = (runner: Runner) => ({ runner, cwd: "/x" });

    it("保留中のレビューとコメントの場所を読む", async () => {
      const r = readReply([
        {
          id: "C1",
          body: "b",
          path: "a.ts",
          line: null,
          originalLine: 4,
          replyTo: { id: "C0" },
        },
      ]);
      const read = await readPendingReviewOf(g(r.runner), 7);
      expect(read.prId).toBe("PR_1");
      expect(read.review?.comments).toEqual([
        { id: "C1", body: "b", path: "a.ts", line: 4, replyToId: "C0" },
      ]);
      // 読むだけ：mutation を流さない
      expect(r.calls.flat().join(" ")).not.toContain("mutation");
    });

    it("コメントが読みきれないときは黙って落とさず止まる", async () => {
      const r = readReply([], true);
      await expect(readPendingReviewOf(g(r.runner), 7)).rejects.toThrow(
        "100件",
      );
    });

    it("本投稿は COMMENT で流し、再依頼はログイン名の形を確かめる", async () => {
      const r = recorder(() => done(0, '{"data":{}}'));
      await submitPendingReview(g(r.runner), "R1");
      expect(r.calls[0]!.join(" ")).toContain("event: COMMENT");
      const e = recorder(() => done(0));
      await requestReviewers(g(e.runner), 7, ["alice", "bob"]);
      expect(e.calls[0]).toEqual([
        "gh",
        "pr",
        "edit",
        "7",
        "--add-reviewer",
        "alice,bob",
      ]);
      await expect(requestReviewers(g(e.runner), 7, ["a;b"])).rejects.toThrow(
        "形が正しくありません",
      );
      await expect(requestReviewers(g(e.runner), 7, [])).rejects.toThrow();
    });

    it("読む問い合わせに PR の番号と owner・name が入る", async () => {
      const r = readReply([]);
      await readPendingReviewOf(g(r.runner), 7);
      const call = r.calls.find((c) => c[1] === "api")!;
      const text = call.join("\n");
      expect(text).toContain("pullRequest(number: 7)");
      expect(text).not.toContain("PR_NUMBER");
      expect(call).toContain("owner=o");
      expect(call).toContain("name=r");
    });

    it("返信の変数に threadId・reviewId・body が入り、本投稿の id が正しい", async () => {
      const r = recorder(() =>
        done(
          0,
          JSON.stringify({
            data: {
              addPullRequestReviewThreadReply: {
                comment: { id: "C9", state: "PENDING" },
              },
              submitPullRequestReview: {},
            },
          }),
        ),
      );
      await addPendingThreadReply(g(r.runner), "R5", "T3", "本文");
      const reply = r.calls[0]!;
      expect(reply).toContain("reviewId=R5");
      expect(reply).toContain("threadId=T3");
      expect(reply).toContain("body=本文");
      await submitPendingReview(g(r.runner), "R5");
      expect(r.calls[1]).toContain("id=R5");
    });

    it("作ったレビューが保留でなければ失敗する（ID を返さない）", async () => {
      for (const state of ["COMMENTED", "SUBMITTED"]) {
        const r = recorder(() =>
          done(
            0,
            JSON.stringify({
              data: {
                addPullRequestReview: {
                  pullRequestReview: { id: "R1", state },
                },
              },
            }),
          ),
        );
        await expect(
          createPendingReviewOn(g(r.runner), "PR_1"),
        ).rejects.toMatchObject({ code: 1 });
      }
    });

    it("足した返信が保留でなければ失敗する", async () => {
      for (const state of ["SUBMITTED", "COMMENTED"]) {
        const r = recorder(() =>
          done(
            0,
            JSON.stringify({
              data: {
                addPullRequestReviewThreadReply: {
                  comment: { id: "C1", state },
                },
              },
            }),
          ),
        );
        await expect(
          addPendingThreadReply(g(r.runner), "R1", "T1", "b"),
        ).rejects.toMatchObject({ code: 1 });
      }
    });

    it("GraphQL が終了コード0で errors を返したら FlowError(1) で、トークンを出さない", async () => {
      const r = recorder(() =>
        done(
          0,
          JSON.stringify({
            data: { x: 1 },
            errors: [
              { message: "bad ghp_abcdefghijklmnopqrstuvwxyz0123 here" },
            ],
          }),
        ),
      );
      const error = await ghGraphql(
        g(r.runner),
        "query { x }",
        {},
        "テスト",
      ).catch((e: Error) => e);
      expect(error).toMatchObject({ code: 1 });
      expect((error as Error).message).toContain("テストに失敗しました");
      expect((error as Error).message).not.toContain("ghp_");
      // data がなくても失敗する
      const none = recorder(() => done(0, "not json"));
      await expect(
        ghGraphql(g(none.runner), "query { x }", {}, "テスト"),
      ).rejects.toMatchObject({ code: 1 });
    });

    it("ghGraphql は data を返し、repoOwnerName は owner と name を返す", async () => {
      const r = recorder((_c, args) =>
        args[0] === "repo"
          ? done(0, '{"nameWithOwner":"o/r"}')
          : done(0, '{"data":{"a":1}}'),
      );
      expect(
        await ghGraphql(g(r.runner), "query { a }", { v: "1" }, "x"),
      ).toEqual({
        a: 1,
      });
      expect(r.calls[0]).toContain("v=1");
      expect(await repoOwnerName(g(r.runner))).toEqual({
        owner: "o",
        name: "r",
      });
      const bad = recorder(() => done(0, '{"nameWithOwner":"x"}'));
      await expect(repoOwnerName(g(bad.runner))).rejects.toMatchObject({
        code: 1,
      });
    });

    it("CI の失敗に数える結論の一覧を出し、ciResultOf が同じ一覧を使う", () => {
      expect(CI_FAILED_CONCLUSIONS).toContain("ACTION_REQUIRED");
      for (const verdict of CI_FAILED_CONCLUSIONS)
        expect(ciResultOf([{ conclusion: verdict, status: "COMPLETED" }])).toBe(
          "failed",
        );
    });
  });
});
