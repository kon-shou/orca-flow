import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import {
  ciResultOf,
  createDraftPr,
  findPr,
  markPrReady,
  pushTaskBranch,
  redactSecrets,
  requireGh,
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
