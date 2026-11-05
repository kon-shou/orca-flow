import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import {
  fetchRespondSource,
  renderRespondInput,
} from "../../src/lib/respond-input.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const done = (code: number, stdout = "", stderr = "") => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});
const PR_URL = "https://github.com/o/r/pull/7";

const NODES: Record<string, Record<string, unknown>> = {
  IC_kwConv1: {
    __typename: "IssueComment",
    body: "会話の欄の指摘 CONV-TEXT",
    author: { login: "carol" },
    pullRequest: { url: PR_URL, title: "t" },
  },
  PRR_kwRev1: {
    __typename: "PullRequestReview",
    state: "COMMENTED",
    body: "レビューの指摘 REV-TEXT",
    author: { login: "bob" },
    pullRequest: { url: PR_URL, title: "t" },
  },
};

async function setup() {
  const root = await makeRepo({});
  await addTaskWorktree(root, "T01", "x", { "src/a.ts": "a\n" });
  const claudeCalls: string[] = [];
  const orca = fakeOrca();
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "claude") {
      claudeCalls.push(opts?.input ?? "");
      return done(
        0,
        JSON.stringify({ structured_output: { key: "fix", reason: "r" } }),
      );
    }
    if (cmd !== "gh") return orca.runner(cmd, args, opts);
    if (args[0] === "repo") return done(0, '{"nameWithOwner":"o/r"}');
    if (args[0] === "pr" && args[1] === "list")
      return done(
        0,
        JSON.stringify([
          {
            number: 7,
            url: PR_URL,
            isDraft: false,
            state: "OPEN",
            headRefOid: "a".repeat(40),
            statusCheckRollup: [],
            isCrossRepository: false,
          },
        ]),
      );
    if (args[0] === "pr" && args[1] === "view")
      return done(0, JSON.stringify({ labels: [], statusCheckRollup: [] }));
    if (args[0] === "api") {
      const idArg = args.find((a) => a.startsWith("id="));
      if (idArg)
        return done(
          0,
          JSON.stringify({
            data: {
              viewer: { login: "me" },
              node: NODES[idArg.slice(3)] ?? null,
            },
          }),
        );
      return done(
        0,
        JSON.stringify({
          data: {
            viewer: { login: "me" },
            repository: {
              pullRequest: {
                url: PR_URL,
                reviews: {
                  totalCount: 1,
                  nodes: [{ id: "PRR_kwRev1", ...NODES.PRR_kwRev1 }],
                },
                comments: {
                  totalCount: 1,
                  nodes: [{ id: "IC_kwConv1", ...NODES.IC_kwConv1 }],
                },
                reviewThreads: {
                  totalCount: 0,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        }),
      );
    }
    return done(0);
  };
  const file = `${root}/.git/orca-flow/vote/T01.jsonl`;
  const records = async () =>
    (await readFile(file, "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
  return { root, runner, claudeCalls, records };
}

describe("入力ファイルに出た ID を vote cast に渡す", () => {
  it("会話の欄のコメントとレビューの ID で、それぞれ2票目をとって記録する", async () => {
    const { root, runner, claudeCalls, records } = await setup();
    const src = await fetchRespondSource({ runner, cwd: root }, 7);
    const { text } = renderRespondInput(src, "n");
    const convId = /### コメント 1：ID (\S+)/.exec(text)![1]!;
    const revId = /### レビュー 1：\S+：ID (\S+)/.exec(text)![1]!;
    expect(convId).toBe("IC_kwConv1");
    expect(revId).toBe("PRR_kwRev1");

    for (const [i, target] of [convId, revId].entries()) {
      const r = await runCli(
        [
          "vote",
          "cast",
          "T01",
          "--target",
          target,
          "--kind",
          "comment",
          "--first",
          "fix",
        ],
        { cwd: root, runner },
      );
      expect(r.code).toBe(0);
      expect(claudeCalls).toHaveLength(i + 1);
    }
    expect(claudeCalls[0]).toContain("CONV-TEXT");
    expect(claudeCalls[1]).toContain("REV-TEXT");
    const rec = await records();
    expect(rec.map((e) => e.target)).toEqual([convId, revId]);
    expect(rec.map((e) => e.second)).toEqual([
      { status: "voted", key: "fix" },
      { status: "voted", key: "fix" },
    ]);
  });
});
