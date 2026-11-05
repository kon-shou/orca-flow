import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import type { GhContext } from "../../src/lib/github.ts";
import { readItem, readItems } from "../../src/lib/outbox.ts";
import {
  draftThreadReply,
  setReviewSummary,
  type BodyGuard,
} from "../../src/lib/pending-review.ts";
import { fakeGithub, type FakeComment } from "../helpers/fake-github.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo, tempDir } from "../helpers/repo.ts";

const guard: BodyGuard = { env: {}, problems: () => [] };

async function setup(start?: { comments?: FakeComment[] }) {
  const root = await makeRepo();
  await addTaskWorktree(root, "T01", "x", { "a.txt": "a\n" });
  const gh = fakeGithub(start);
  const orca = fakeOrca();
  const runner: Runner = (cmd, args, opts) =>
    cmd === "gh" ? gh.runner(cmd, args, opts) : orca.runner(cmd, args, opts);
  const g: GhContext = { runner: gh.runner, cwd: root, env: {} };
  const store = { common: `${root}/.git`, taskId: "T01" };
  const add = (...extra: string[]) =>
    runCli(["outbox", "add", "T01", ...extra], { cwd: root, runner });
  return { root, gh, orca, g, store, add };
}

describe("outbox add reply", () => {
  it("保留中のコメントの ID と本文が指紋に入り、下書きの件数がカードの一言に出る", async () => {
    const { root, gh, orca, g, store, add } = await setup();
    await draftThreadReply(
      g,
      store,
      { pr: 7, threadId: "PRRT_1", body: "直しました" },
      guard,
    );
    await draftThreadReply(
      g,
      store,
      { pr: 7, threadId: "PRRT_2", body: "理由があって直しません" },
      guard,
    );
    await setReviewSummary(g, store, { pr: 7, body: "全体の返事" }, guard);
    const added = await add("reply", "--pr", "7");
    expect(added.code).toBe(0);
    const item = (await readItem(`${root}/.git`, "T01", "reply-v1"))!;
    expect(item.kind).toBe("reply");
    expect(item.target.pending?.comments.map((c) => c.id)).toEqual([
      "C1",
      "C2",
    ]);
    expect(item.target.pending?.reviewId).toBe("R1");
    // 人に見せる本文：自分の下書きの全文と返す先の場所
    expect(item.body).toContain("a.ts:3");
    expect(item.body).toContain("理由があって直しません");
    expect(item.body).toContain("全体の返事");
    // 本投稿はしていない
    expect(gh.state.submitted).toBe(0);
    expect(orca.calls.flat().join(" ")).toContain("下書き 2 件");
  });

  it("積んだあとに保留中のコメントを直すと、指紋が変わる", async () => {
    const { root, gh, g, store, add } = await setup();
    await draftThreadReply(
      g,
      store,
      { pr: 7, threadId: "PRRT_1", body: "直しました" },
      guard,
    );
    expect((await add("reply", "--pr", "7")).code).toBe(0);
    const first = (await readItem(`${root}/.git`, "T01", "reply-v1"))!;
    gh.state.review!.comments[0]!.body = "別の中身";
    expect((await add("reply", "--pr", "7")).code).toBe(0);
    const second = (await readItem(`${root}/.git`, "T01", "reply-v2"))!;
    expect(second.fingerprint).not.toBe(first.fingerprint);
    // 同じ PR の前の案は取り下げになる
    expect((await readItem(`${root}/.git`, "T01", "reply-v1"))!.state).toBe(
      "withdrawn",
    );
  });

  it("respond が書いていないコメントがあれば、積まずに終了コード2", async () => {
    const { root, gh, g, store, add } = await setup({
      comments: [
        {
          id: "H1",
          body: "人の書きかけ",
          path: "b.ts",
          line: 1,
          replyTo: "C0",
        },
      ],
    });
    await draftThreadReply(
      g,
      store,
      { pr: 7, threadId: "PRRT_1", body: "直しました" },
      guard,
    );
    const out = await add("reply", "--pr", "7");
    expect(out.code).toBe(2);
    expect(out.err).toContain("respond の記録にない");
    expect(out.err).toContain("GitHub の画面");
    expect(await readItems(`${root}/.git`, "T01")).toEqual([]);
    expect(gh.state.submitted).toBe(0);
  });

  it("人が GitHub で直して入れた秘密・手元のパスは、積まずに終了コード1（本文を出さない）", async () => {
    const { root, gh, g, store, add } = await setup();
    await draftThreadReply(
      g,
      store,
      { pr: 7, threadId: "PRRT_1", body: "直しました" },
      guard,
    );
    await setReviewSummary(g, store, { pr: 7, body: "全体の返事" }, guard);
    gh.state.review!.comments[0]!.body =
      "token ghp_abcdefghijklmnopqrstuvwxyz0123";
    const secret = await add("reply", "--pr", "7");
    expect(secret.code).toBe(1);
    expect(secret.err).not.toContain("ghp_");
    gh.state.review!.comments[0]!.body = "直しました";
    gh.state.review!.body = `${root}/a.ts を見て`;
    const local = await add("reply", "--pr", "7");
    expect(local.code).toBe(1);
    expect(local.err).not.toContain(root);
    expect(await readItems(`${root}/.git`, "T01")).toEqual([]);
  });

  it("案の記録に生の本文を残さず、指紋の照らしには使える", async () => {
    const { root, g, store, add } = await setup();
    await draftThreadReply(
      g,
      store,
      { pr: 7, threadId: "PRRT_1", body: "ひみつの返事" },
      guard,
    );
    await setReviewSummary(g, store, { pr: 7, body: "全体のひみつ" }, guard);
    expect((await add("reply", "--pr", "7")).code).toBe(0);
    const item = (await readItem(`${root}/.git`, "T01", "reply-v1"))!;
    const target = JSON.stringify(item.target);
    expect(target).not.toContain("ひみつの返事");
    expect(target).not.toContain("全体のひみつ");
    expect(item.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("下書きがない・PR の番号がない・本文を渡すときは積まない", async () => {
    const { root, add } = await setup();
    expect((await add("reply", "--pr", "7")).code).toBe(1);
    expect((await add("reply")).code).toBe(1);
    const file = path.join(await tempDir(), "body.md");
    await writeFile(file, "本文\n");
    const withBody = await add("reply", "--pr", "7", "--body-file", file);
    expect(withBody.code).toBe(1);
    expect(withBody.err).toContain("保留中のレビューから読みます");
    expect(await readItems(`${root}/.git`, "T01")).toEqual([]);
  });
});

describe("outbox add rerequest", () => {
  it("相手のログイン名が指紋に入り、相手が違えば指紋も違う", async () => {
    const { root, add } = await setup();
    expect(
      (await add("rerequest", "--pr", "7", "--reviewers", "bob,alice")).code,
    ).toBe(0);
    const one = (await readItem(`${root}/.git`, "T01", "rerequest-v1"))!;
    expect(one.target.reviewers).toEqual(["alice", "bob"]);
    expect(
      (await add("rerequest", "--pr", "7", "--reviewers", "alice")).code,
    ).toBe(0);
    const two = (await readItem(`${root}/.git`, "T01", "rerequest-v2"))!;
    expect(two.fingerprint).not.toBe(one.fingerprint);
  });

  it("相手・PR の番号がない、ログイン名の形が違う、reply 以外に --reviewers をつけると積まない", async () => {
    const { root, add } = await setup();
    expect((await add("rerequest", "--pr", "7")).code).toBe(1);
    expect((await add("rerequest", "--reviewers", "alice")).code).toBe(1);
    expect(
      (await add("rerequest", "--pr", "7", "--reviewers", "a b;rm")).code,
    ).toBe(1);
    expect((await add("push", "--reviewers", "alice")).code).toBe(1);
    expect(await readItems(`${root}/.git`, "T01")).toEqual([]);
  });
});
