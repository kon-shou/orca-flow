import { describe, expect, it } from "vitest";
import { createSend } from "../../src/commands/send.ts";
import type { Runner } from "../../src/lib/exec.ts";
import type { GhContext } from "../../src/lib/github.ts";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  NotSentError,
  addItem,
  buildSenders,
  normalizeBody,
  readItem,
  readItems,
  type OutboxItem,
} from "../../src/lib/outbox.ts";
import {
  draftThreadReply,
  readDrafts,
  setReviewSummary,
  writeDrafts,
  type BodyGuard,
} from "../../src/lib/pending-review.ts";
import type { Clock } from "../../src/lib/send-guard.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeGithub } from "../helpers/fake-github.ts";
import { makeTmpDir } from "../helpers/tmp/index.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const guard: BodyGuard = { env: {}, problems: () => [] };

const clock: Clock = { now: () => 1_700_000_000_000, sleep: async () => {} };

async function setup(allow?: string[]) {
  const root = await makeRepo({
    outbound: {
      interval: { seconds: 1, perBatch: 5 },
      ...(allow ? { allow } : {}),
    },
  });
  await addTaskWorktree(root, "T01", "x", { "a.txt": "a\n" });
  const gh = fakeGithub();
  const orca = fakeOrca();
  const runner: Runner = (cmd, args, opts) =>
    cmd === "gh" ? gh.runner(cmd, args, opts) : orca.runner(cmd, args, opts);
  const g: GhContext = { runner: gh.runner, cwd: root, env: {} };
  const store = { common: `${root}/.git`, taskId: "T01" };
  const cli = (...argv: string[]) => runCli(argv, { cwd: root, runner });
  const sendNow = async () => {
    const shown = JSON.parse(
      (await cli("outbox", "show", "T01", "--json")).out,
    ) as { bundleFingerprint: string; head: string };
    const err: string[] = [];
    const ctx: CommandContext = {
      argv: ["T01", "--expect", shown.bundleFingerprint, "--head", shown.head],
      cwd: root,
      json: true,
      runner,
      env: {},
      stdout: () => {},
      stderr: (t) => err.push(t),
      now: () => new Date("2026-11-03T00:00:00Z"),
    };
    try {
      const result = await createSend({ clock })(ctx);
      return { code: result.code, err: err.join("\n") };
    } catch (error) {
      const e = error as { code?: number; message: string };
      return { code: e.code ?? 1, err: e.message };
    }
  };
  const draft = (body = "直しました") =>
    draftThreadReply(g, store, { pr: 7, threadId: "PRRT_1", body }, guard);
  const summary = (body: string) =>
    setReviewSummary(g, store, { pr: 7, body }, guard);
  return { root, gh, cli, sendNow, draft, summary, store };
}

const WITH = ["push", "pr-create", "pr-ready", "reply", "rerequest"];

describe("send reply", () => {
  it("許可リストにあれば、保留中のレビューを COMMENT で本投稿する", async () => {
    const { root, gh, cli, sendNow, draft } = await setup(WITH);
    await draft();
    expect((await cli("outbox", "add", "T01", "reply", "--pr", "7")).code).toBe(
      0,
    );
    // 積んだだけでは送らない
    expect(gh.state.submitted).toBe(0);
    const sent = await sendNow();
    expect(sent.err).toBe("");
    expect(sent.code).toBe(0);
    expect(gh.state.submitted).toBe(1);
    const submit = gh.state.queries.find((q) =>
      q.includes("submitPullRequestReview("),
    )!;
    expect(submit).toContain("event: COMMENT");
    expect((await readItem(`${root}/.git`, "T01", "reply-v1"))!.state).toBe(
      "sent",
    );
  });

  it("記録の本文を本投稿の body として渡す。本文がなければ body を渡さない", async () => {
    const one = await setup(WITH);
    await one.draft();
    await one.summary("全体の返事");
    await one.cli("outbox", "add", "T01", "reply", "--pr", "7");
    expect((await one.sendNow()).code).toBe(0);
    expect(one.gh.state.submittedBodies).toEqual(["全体の返事"]);
    expect(
      one.gh.state.queries.find((q) => q.includes("submitPullRequestReview(")),
    ).toContain("body: $body");

    const two = await setup(WITH);
    await two.draft();
    await two.cli("outbox", "add", "T01", "reply", "--pr", "7");
    expect((await two.sendNow()).code).toBe(0);
    expect(two.gh.state.submittedBodies).toEqual([null]);
  });

  it("積んだあとに記録の本文を変えると、本投稿せずに断る", async () => {
    const { gh, cli, sendNow, draft, summary } = await setup(WITH);
    await draft();
    await summary("全体の返事");
    await cli("outbox", "add", "T01", "reply", "--pr", "7");
    await summary("あとから変えた");
    const sent = await sendNow();
    expect(sent.code).toBe(1);
    expect(sent.err).toContain("変わっています");
    expect(gh.state.submitted).toBe(0);
  });

  it("積んだあとに保留中のコメントを直すと、送らず「送らなかった」になる", async () => {
    const { root, gh, cli, sendNow, draft } = await setup(WITH);
    await draft();
    await cli("outbox", "add", "T01", "reply", "--pr", "7");
    gh.state.review!.comments[0]!.body = "あとから直した";
    const sent = await sendNow();
    expect(sent.code).toBe(1);
    expect(sent.err).toContain("変わっています");
    expect(gh.state.submitted).toBe(0);
    expect((await readItem(`${root}/.git`, "T01", "reply-v1"))!.state).toBe(
      "skipped",
    );
  });

  it("積んだあとに人が保留中のコメントを足しても送らない", async () => {
    const { gh, cli, sendNow, draft } = await setup(WITH);
    await draft();
    await cli("outbox", "add", "T01", "reply", "--pr", "7");
    gh.state.review!.comments.push({
      id: "H1",
      body: "人の書きかけ",
      path: "b.ts",
      line: 1,
      replyTo: "C0",
    });
    expect((await sendNow()).code).toBe(1);
    expect(gh.state.submitted).toBe(0);
  });

  it("許可リストにない（既定のまま）と send で止まり、何も書かない", async () => {
    const { root, gh, cli, sendNow, draft } = await setup();
    await draft();
    await cli("outbox", "add", "T01", "reply", "--pr", "7");
    await cli(
      "outbox",
      "add",
      "T01",
      "rerequest",
      "--pr",
      "7",
      "--reviewers",
      "bob",
    );
    const sent = await sendNow();
    expect(sent.code).not.toBe(0);
    expect(gh.state.submitted).toBe(0);
    expect(gh.state.calls.some((c) => c.startsWith("pr edit"))).toBe(false);
    expect((await readItem(`${root}/.git`, "T01", "reply-v1"))!.state).toBe(
      "queued",
    );
  });

  it("rerequest は許可リストにあれば、相手を再依頼する", async () => {
    const { gh, cli, sendNow } = await setup(WITH);
    await cli(
      "outbox",
      "add",
      "T01",
      "rerequest",
      "--pr",
      "7",
      "--reviewers",
      "bob,alice",
    );
    const sent = await sendNow();
    expect(sent.code).toBe(0);
    expect(gh.state.calls).toContain("pr edit 7 --add-reviewer alice,bob");
    expect(gh.state.submitted).toBe(0);
  });

  it("CI の印つきの古い pr-ready は、PR が下書きでなければ gh pr ready を呼ばずに送ったになり、続く rerequest も送られる", async () => {
    const { root, gh, cli, sendNow } = await setup(WITH);
    const common = `${root}/.git`;
    const branch = "task/T01-x";
    const shownHead = (
      JSON.parse((await cli("outbox", "show", "T01", "--json")).out) as {
        head: string;
      }
    ).head;
    await addItem(
      common,
      {
        taskId: "T01",
        kind: "pr-ready",
        body: "",
        head: shownHead,
        target: {
          remote: "origin",
          branch,
          base: "main",
          pr: 7,
        },
        afterCi: true,
      },
      {},
      new Date(),
    );
    await cli(
      "outbox",
      "add",
      "T01",
      "rerequest",
      "--pr",
      "7",
      "--reviewers",
      "bob",
    );
    const sent = await sendNow();
    expect(sent.err).toBe("");
    expect(sent.code).toBe(0);
    expect((await readItem(common, "T01", "pr-ready-v1"))!.state).toBe("sent");
    expect((await readItem(common, "T01", "rerequest-v1"))!.state).toBe("sent");
    expect(gh.state.calls.some((c) => c.startsWith("pr ready"))).toBe(false);
    expect(gh.state.calls).toContain("pr edit 7 --add-reviewer bob");
  });

  it("積んだあとに保留中のコメントを GitHub で直接直して秘密を入れても、本投稿しない", async () => {
    const { root, gh, cli, sendNow, draft } = await setup(WITH);
    await draft();
    await cli("outbox", "add", "T01", "reply", "--pr", "7");
    gh.state.review!.comments[0]!.body =
      "token ghp_abcdefghijklmnopqrstuvwxyz0123 を使った";
    const sent = await sendNow();
    expect(sent.code).toBe(1);
    expect(sent.err).not.toContain("ghp_");
    expect(gh.state.submitted).toBe(0);
    expect((await readItem(`${root}/.git`, "T01", "reply-v1"))!.state).toBe(
      "skipped",
    );
  });

  it("レビューの本文に手元のパスが入っても本投稿しない", async () => {
    const { root, gh, cli, sendNow, draft } = await setup(WITH);
    await draft();
    gh.state.review!.body = "ふつうの本文";
    await cli("outbox", "add", "T01", "reply", "--pr", "7");
    gh.state.review!.body = `見てください ${root}/a.ts`;
    const sent = await sendNow();
    expect(sent.code).toBe(1);
    expect(gh.state.submitted).toBe(0);
    expect((await readItem(`${root}/.git`, "T01", "reply-v1"))!.state).toBe(
      "skipped",
    );
  });

  it("本投稿・再依頼の前の読みが落ちたら、何も書かずに「送らなかった」になる", async () => {
    const cases: [string, string][] = [
      ["reply", "repo"],
      ["reply", "prlist"],
      ["reply", "read"],
      ["rerequest", "prlist"],
    ];
    for (const [kind, failing] of cases) {
      const { root, gh, cli, sendNow, draft } = await setup(WITH);
      if (kind === "reply") {
        await draft();
        await cli("outbox", "add", "T01", "reply", "--pr", "7");
      } else {
        await cli(
          "outbox",
          "add",
          "T01",
          "rerequest",
          "--pr",
          "7",
          "--reviewers",
          "bob",
        );
      }
      gh.state.fail.add(failing);
      const sent = await sendNow();
      expect(sent.code).not.toBe(0);
      expect(gh.state.submitted).toBe(0);
      expect(gh.state.calls.some((c) => c.startsWith("pr edit"))).toBe(false);
      const item = (await readItem(`${root}/.git`, "T01", `${kind}-v1`))!;
      expect(item.state, `${kind}/${failing}`).toBe("skipped");
      expect(sent.err).toContain("何も");
    }
  });

  it("タスクのブランチの PR が案の PR と違えば、reply も rerequest も送らない", async () => {
    for (const kind of ["reply", "rerequest"]) {
      const { root, gh, cli, sendNow, draft } = await setup(WITH);
      if (kind === "reply") {
        await draft();
        await cli("outbox", "add", "T01", "reply", "--pr", "7");
      } else {
        await cli(
          "outbox",
          "add",
          "T01",
          "rerequest",
          "--pr",
          "7",
          "--reviewers",
          "bob",
        );
      }
      gh.state.prNumber = 8;
      await sendNow();
      expect(gh.state.submitted).toBe(0);
      expect(gh.state.calls.some((c) => c.startsWith("pr edit"))).toBe(false);
      expect(
        (await readItem(`${root}/.git`, "T01", `${kind}-v1`))!.state,
        kind,
      ).toBe("skipped");
    }
  });

  it("記録の本文が空白だけで GitHub の本文に手元のパスがあると、案を積まず本投稿もしない", async () => {
    const { root, gh, cli, draft, store } = await setup(WITH);
    await draft();
    const record = await readDrafts(store.common, "T01");
    record.prs["7"]!.summary = "  \n ";
    await writeDrafts(store.common, "T01", record);
    gh.state.review!.body = `${root}/a.ts を見て`;
    const added = await cli("outbox", "add", "T01", "reply", "--pr", "7");
    expect(added.code).toBe(1);
    expect(added.err).toContain("が含まれています");
    expect(added.err).not.toContain(root);
    expect(await readItems(store.common, "T01")).toEqual([]);
    expect(gh.state.submitted).toBe(0);
  });

  it("書く側（保留の書き込み）だけでは本投稿されない", async () => {
    const { gh, draft } = await setup(WITH);
    await draft();
    expect(gh.state.submitted).toBe(0);
  });

  it("送る関数は読み直した中身（コメントの秘密・手元のパス、記録の本文の手元のパス）にも確かめをかけ、当たれば本投稿しない", async () => {
    const sha = (t: string) =>
      createHash("sha256").update(normalizeBody(t)).digest("hex");
    const cases: {
      name: string;
      comment: string;
      summary: string;
      github?: string;
    }[] = [
      {
        name: "コメントの秘密",
        comment: "token ghp_abcdefghijklmnopqrstuvwxyz0123",
        summary: "",
      },
      {
        name: "コメントの手元のパス",
        comment: "/work/repo/a.ts を見て",
        summary: "",
      },
      {
        name: "記録の本文が空白だけのときの GitHub の本文の手元のパス",
        comment: "直しました",
        summary: "  \n ",
        github: "/work/repo/a.ts を見て",
      },
      {
        name: "記録の本文の手元のパス",
        comment: "直しました",
        summary: "/work/repo/a.ts を見て",
      },
    ];
    for (const { name, comment, summary, github } of cases) {
      const gh = fakeGithub({
        comments: [
          { id: "C1", body: comment, path: "a.ts", line: 3, replyTo: "C0" },
        ],
      });
      // 記録の本文が空白だけのときは、記録がないものとして GitHub の本文が積まれ、送られる
      if (github !== undefined) gh.state.review!.body = github;
      const common = await makeTmpDir("of-send-reply-");
      // 記録の本文は、GitHub には書かず記録にだけある。指紋（summarySha）は読み直した中身と合わせる
      await writeDrafts(common, "T01", {
        prs: { "7": { reviewId: "R1", commentIds: ["C1"], summary } },
      });
      const senders = buildSenders({
        g: { runner: gh.runner, cwd: "/work/repo", env: {} },
        task: { id: "T01", branch: "task/T01-x", path: "/work/repo-wt" },
        config: DEFAULT_CONFIG,
        root: "/work/repo",
        common,
      });
      const item = {
        id: "reply-v1",
        taskId: "T01",
        kind: "reply",
        version: 1,
        target: {
          remote: "origin",
          branch: "task/T01-x",
          base: "main",
          pr: 7,
          pending: {
            reviewId: "R1",
            summarySha: sha(github ?? summary),
            comments: [
              {
                id: "C1",
                bodySha: sha(comment),
                path: "a.ts",
                line: 3,
                replyToId: "C0",
              },
            ],
          },
        },
        body: "",
      } as unknown as OutboxItem;
      const error = await senders.reply(item, "").catch((e: Error) => e);
      expect(error, name).toBeInstanceOf(NotSentError);
      const message = (error as Error).message;
      expect(message, name).toContain("が含まれています");
      expect(message, name).not.toContain("変わっています");
      expect(message, name).not.toContain("ghp_");
      expect(message, name).not.toContain("/work/repo");
      expect(gh.state.submitted, name).toBe(0);
    }
  });
});
