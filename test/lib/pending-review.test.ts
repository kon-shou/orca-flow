import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GhContext } from "../../src/lib/github.ts";
import {
  deleteDraftComment,
  draftThreadReply,
  draftsPath,
  editDraftComment,
  loadPendingDrafts,
  readDrafts,
  setReviewSummary,
  type BodyGuard,
} from "../../src/lib/pending-review.ts";
import { fakeGithub, type FakeComment } from "../helpers/fake-github.ts";
import { tempDir } from "../helpers/repo.ts";

const guard = (root = "/home/someone/repo"): BodyGuard => ({
  env: {},
  problems: (body) => (body.includes(root) ? ["リポジトリのパス"] : []),
});

async function setup(start?: { comments?: FakeComment[] }) {
  const common = await tempDir();
  const gh = fakeGithub(start);
  const g: GhContext = { runner: gh.runner, cwd: "/x", env: {} };
  return { common, gh, g, store: { common, taskId: "T01" } };
}

describe("pending-review", () => {
  it("返信を足し、直し、消す。流すのは保留への書き込みだけで、レビューの送信を流さない", async () => {
    const { gh, g, store, common } = await setup();
    const added = await draftThreadReply(
      g,
      store,
      { pr: 7, threadId: "PRRT_1", body: "直しました" },
      guard(),
    );
    expect(added.reviewId).toBe("R1");
    await editDraftComment(
      g,
      store,
      { pr: 7, commentId: added.commentId, body: "直しました（修正）" },
      guard(),
    );
    await setReviewSummary(g, store, { pr: 7, body: "全体の返事" }, guard());
    const loaded = await loadPendingDrafts(g, store, 7);
    expect(loaded.mine.map((c) => c.body)).toEqual(["直しました（修正）"]);
    expect(loaded.body).toBe("全体の返事");
    expect(loaded.foreign).toEqual([]);
    await deleteDraftComment(g, store, { pr: 7, commentId: added.commentId });
    expect((await loadPendingDrafts(g, store, 7)).mine).toEqual([]);

    const all = gh.state.queries.join("\n");
    expect(all).not.toContain("submitPullRequestReview");
    expect(all).not.toMatch(/event\s*:/);
    // 返信はレビューを指して足す（指さなければ即時に投稿される）
    expect(gh.state.queries.find((q) => q.includes("ThreadReply("))).toContain(
      "pullRequestReviewId: $reviewId",
    );
    const file = JSON.parse(await readFile(draftsPath(common, "T01"), "utf8"));
    expect(file.prs["7"].reviewId).toBe("R1");
    expect(file.prs["7"].commentIds).toEqual([]);
  });

  it("respond が書いたコメントの ID を作業ツリーの外に残し、書いていないものは foreign に分ける", async () => {
    const { g, store, common } = await setup({
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
    const added = await draftThreadReply(
      g,
      store,
      { pr: 7, threadId: "PRRT_1", body: "返事" },
      guard(),
    );
    const loaded = await loadPendingDrafts(g, store, 7);
    expect(loaded.mine.map((c) => c.id)).toEqual([added.commentId]);
    expect(loaded.foreign.map((c) => c.id)).toEqual(["H1"]);
    expect(draftsPath(common, "T01")).toBe(
      path.join(common, "orca-flow", "respond", "T01", "drafts.json"),
    );
    // 人が書いたコメントは直しも消しもしない
    await expect(
      editDraftComment(
        g,
        store,
        { pr: 7, commentId: "H1", body: "上書き" },
        guard(),
      ),
    ).rejects.toThrow("respond が書いた");
    await expect(
      deleteDraftComment(g, store, { pr: 7, commentId: "H1" }),
    ).rejects.toThrow("respond が書いた");
  });

  it("秘密らしい値は伏せ字にし、手元のパスがあれば書かずに終了コード1", async () => {
    const { gh, g, store } = await setup();
    await draftThreadReply(
      g,
      store,
      {
        pr: 7,
        threadId: "PRRT_1",
        body: "token ghp_abcdefghijklmnopqrstuvwxyz0123 を使った",
      },
      guard(),
    );
    const body = (await loadPendingDrafts(g, store, 7)).mine[0]!.body;
    expect(body).not.toContain("ghp_");
    expect(body).toContain("〈");

    const before = gh.state.queries.length;
    await expect(
      draftThreadReply(
        g,
        store,
        { pr: 7, threadId: "PRRT_1", body: "/home/someone/repo/a.ts を見て" },
        guard(),
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      setReviewSummary(
        g,
        store,
        { pr: 7, body: "/home/someone/repo/a.ts" },
        guard(),
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(gh.state.queries.length).toBe(before);
  });

  it("並べて流しても drafts.json の記録が消えない", async () => {
    const { gh, g, store, common } = await setup({
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
    gh.state.delayMs = 3;
    // 記録がまだないところから3つ同時に流す
    await Promise.all(
      ["a", "b", "c"].map((b) =>
        draftThreadReply(
          g,
          store,
          { pr: 7, threadId: "PRRT_1", body: b },
          guard(),
        ),
      ),
    );
    const loaded = await loadPendingDrafts(g, store, 7);
    expect(loaded.mine.map((c) => c.body).sort()).toEqual(["a", "b", "c"]);
    expect(loaded.foreign.map((c) => c.id)).toEqual(["H1"]);
    const file = JSON.parse(await readFile(draftsPath(common, "T01"), "utf8"));
    expect(file.prs["7"].commentIds).toHaveLength(3);
    // 消す・足すも並べて流せる
    const [first] = loaded.mine;
    await Promise.all([
      deleteDraftComment(g, store, { pr: 7, commentId: first!.id }),
      draftThreadReply(
        g,
        store,
        { pr: 7, threadId: "PRRT_1", body: "d" },
        guard(),
      ),
      setReviewSummary(g, store, { pr: 7, body: "全体" }, guard()),
    ]);
    const after = await loadPendingDrafts(g, store, 7);
    expect(after.mine).toHaveLength(3);
    expect(after.foreign.map((c) => c.id)).toEqual(["H1"]);
  });

  it("drafts.json が壊れていれば黙って空にせず、パスを示して FlowError(1)。ないときは空", async () => {
    const { g, store, common } = await setup();
    expect(await readDrafts(common, "T01")).toEqual({ prs: {} });
    const file = draftsPath(common, "T01");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ broken");
    const error = await readDrafts(common, "T01").catch((e: Error) => e);
    expect(error).toMatchObject({ code: 1 });
    expect((error as Error).message).toContain(file);
    await expect(
      draftThreadReply(
        g,
        store,
        { pr: 7, threadId: "PRRT_1", body: "返事" },
        guard(),
      ),
    ).rejects.toMatchObject({ code: 1 });
    // 壊れた記録を上書きしていない
    expect(await readFile(file, "utf8")).toBe("{ broken");
  });

  it("本投稿の関数をこのファイルは持たない", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "../../src/lib/pending-review.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/submitPending|submitPullRequestReview/);
    // コメントを除いて確かめる
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/submit/i);
  });
});
