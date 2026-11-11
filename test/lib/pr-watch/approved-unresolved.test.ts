import { describe, expect, it } from "vitest";
import { run } from "../../../src/commands/pr-watch.ts";
import { fetchPrDetails, stage2Query } from "../../../src/lib/github-read.ts";
import { judgeAllOk } from "../../../src/lib/pr-watch/classify.ts";
import { readState } from "../../../src/lib/pr-watch/store.ts";
import { testRunner } from "../../helpers/runner.ts";
import {
  SECRET_MARK,
  comments,
  fakeGh,
  ghRunner,
  harness,
  taskWithRecord,
} from "./helpers.ts";

const round = (h: Awaited<ReturnType<typeof harness>>) =>
  run(h.ctx(["--root", h.root]));

const base = {
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  headApproved: true,
};

describe("承認があるときの全員 OK の判定", () => {
  it("未解決のスレッドが2件あっても全員 OK になり、添え書きに件数が出る", () => {
    const r = judgeAllOk({ ...base, unresolvedThreads: 2 });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.note).toBe(
      "未解決のスレッドが2件あるが、今の先頭に承認があるので数えない",
    );
  });

  it("数えきれないときも全員 OK になり、添え書きに件数を出さない", () => {
    const r = judgeAllOk({
      ...base,
      unresolvedThreads: 0,
      threadsTruncated: true,
      threadTotal: null,
    });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("今の先頭に承認があるので数えない");
    expect(r.note).not.toMatch(/\d+件/);
  });

  it("数えきれないときは、読めた分に未解決があっても添え書きに件数を出さない", () => {
    const r = judgeAllOk({
      ...base,
      unresolvedThreads: 3,
      threadsTruncated: true,
      threadTotal: 340,
    });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("今の先頭に承認があるので数えない");
    expect(r.note).not.toMatch(/\d+件/);
  });

  it("スレッドが無ければ添え書きは出ない", () => {
    expect(judgeAllOk(base).note).toBeNull();
  });

  it.each([
    ["今の先頭への承認がない", { headApproved: false }],
    ["承認の項がない", { headApproved: undefined }],
    ["判定が変更の要求", { reviewDecision: "CHANGES_REQUESTED" }],
    ["判定が空", { reviewDecision: null }],
  ])("%s ときは、未解決のスレッドで今までどおり外れる", (_, over) => {
    const r = judgeAllOk({ ...base, unresolvedThreads: 2, ...over });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons).toContain("未解決のスレッドが2件あります");
    expect(r.note).toBeNull();
  });

  it("数えきれないときも、承認がなければ今までどおり外れる", () => {
    const r = judgeAllOk({
      ...base,
      headApproved: false,
      threadsTruncated: true,
      threadTotal: 120,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join("")).toContain("数えきれません");
  });

  it("下書き・計算中では、スレッドを数えなくても外れる", () => {
    expect(
      judgeAllOk({ ...base, isDraft: true, unresolvedThreads: 1 }).ok,
    ).toBe(false);
    const computing = judgeAllOk({
      ...base,
      mergeStateStatus: "UNKNOWN",
      unresolvedThreads: 1,
    });
    expect(computing.ok).toBe(false);
    expect(computing.reasons.join("")).not.toContain("Resolve");
  });

  it("BLOCKED で未解決のスレッドがあるときは、理由に会話の解決の必須の旨が入る", () => {
    const r = judgeAllOk({
      ...base,
      mergeStateStatus: "BLOCKED",
      unresolvedThreads: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join("")).toContain(
      "ブランチの保護で会話の解決を必須にしていると、Resolve するまでマージできません",
    );
  });

  it.each(["DIRTY", "BEHIND", "UNSTABLE"])(
    "マージの状態が %s のときは、マージできない理由は出て、会話の解決の必須の旨は入らない",
    (state) => {
      const r = judgeAllOk({
        ...base,
        mergeStateStatus: state,
        unresolvedThreads: 2,
      });
      expect(r.ok).toBe(false);
      expect(r.reasons.join("")).toContain(
        `マージできる状態ではありません（${state}）`,
      );
      expect(r.reasons.join("")).not.toContain("Resolve");
    },
  );

  it.each([null, ""])(
    "マージの状態が空（%j）のときも、理由は出て、会話の解決の必須の旨は入らない",
    (state) => {
      const r = judgeAllOk({
        ...base,
        mergeStateStatus: state,
        unresolvedThreads: 2,
      });
      expect(r.ok).toBe(false);
      expect(r.reasons.join("")).toContain("マージできる状態ではありません");
      expect(r.reasons.join("")).not.toContain("Resolve");
    },
  );

  it("BLOCKED でも未解決のスレッドがなければ、その旨は入らない", () => {
    const r = judgeAllOk({ ...base, mergeStateStatus: "BLOCKED" });
    expect(r.reasons.join("")).not.toContain("Resolve");
  });

  it("BLOCKED のほかにも外れがあれば、その旨は足さない", () => {
    const r = judgeAllOk({
      ...base,
      mergeStateStatus: "BLOCKED",
      isDraft: true,
      unresolvedThreads: 2,
    });
    expect(r.reasons.join("")).not.toContain("Resolve");
  });
});

describe("2段目の読み：今の先頭への承認", () => {
  const who = { association: "OWNER" as const };
  async function read(
    reviews: Parameters<ReturnType<typeof fakeGh>["add"]>[0]["reviews"],
  ) {
    const gh = fakeGh();
    gh.add({ number: 7, head: "newhead", reviews });
    const result = await fetchPrDetails(
      { runner: ghRunner(gh, testRunner), cwd: process.cwd() },
      "o/r",
      [7],
    );
    return result.details.get(7)!;
  }
  const review = (over: object) => ({
    id: "r1",
    author: "alice",
    body: SECRET_MARK,
    state: "APPROVED",
    ...who,
    bot: false,
    ...over,
  });

  it("問い合わせは、レビューの種類と出した先のコミットを取り、本文を取らない", () => {
    const q = stage2Query([7]);
    const reviews = /reviews\(last: 30\) \{[^]*?\n/.exec(q)![0];
    expect(reviews).toContain("state");
    expect(reviews).toContain("commit { oid }");
    expect(reviews).not.toContain("body");
  });

  it("今の先頭への人の承認があれば true", async () => {
    expect((await read([review({})])).headApproved).toBe(true);
  });

  it.each([
    ["前の先頭への承認", { commit: "oldhead" }],
    ["bot の承認", { bot: true }],
    ["COMMENTED", { state: "COMMENTED" }],
    ["CHANGES_REQUESTED", { state: "CHANGES_REQUESTED" }],
  ])("%s だけなら false", async (_, over) => {
    expect((await read([review(over)])).headApproved).toBe(false);
  });

  it.each([
    "OWNER",
    "MEMBER",
    "COLLABORATOR",
    "NONE",
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "CONTRIBUTOR",
    "MANNEQUIN",
    undefined,
  ])("書き手の立場が %s でも、人の承認なら true", async (association) => {
    expect((await read([review({ association })])).headApproved).toBe(true);
  });

  it("前の先頭への承認があっても、今の先頭への承認が別にあれば true。レビューが無ければ false", async () => {
    expect(
      (await read([review({ commit: "oldhead" }), review({ id: "r2" })]))
        .headApproved,
    ).toBe(true);
    expect((await read([])).headApproved).toBe(false);
  });
});

describe("見張りの1回：承認があり未解決のスレッドが残る PR", () => {
  const thread = {
    id: "t1",
    resolvedBy: null,
    comments: [{ id: "c", author: "alice", body: SECRET_MARK }],
  };
  const approval = {
    id: "r1",
    author: "alice",
    body: SECRET_MARK,
    state: "APPROVED",
    association: "OWNER",
    bot: false,
  };

  it("今の先頭に承認があればマージ待ちのカードになり、前の先頭への承認だけならならない", async () => {
    for (const [commit, waiting] of [
      [undefined, true],
      ["oldhead", false],
    ] as const) {
      const h = await harness();
      await taskWithRecord(h, "T07", 7);
      const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
      await round(h);
      pr.updatedAt = "2026-11-04T02:00:00Z";
      Object.assign(pr, {
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        threads: [thread],
        reviews: [{ ...approval, commit }],
      });
      await round(h);
      await run(h.ctx(["background", "--root", h.root]));
      expect(comments(h.orca).join("\n").includes("マージ待ち：PR #7")).toBe(
        waiting,
      );
    }
  });

  it("計算中だけで止めたその PR には、読み直しの印が付く。承認がなければ付かない", async () => {
    for (const [commit, marked] of [
      [undefined, true],
      ["oldhead", false],
    ] as const) {
      const h = await harness();
      await taskWithRecord(h, "T07", 7);
      h.gh.add({
        number: 7,
        branch: "task/T07-x",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNKNOWN",
        threads: [thread],
        reviews: [{ ...approval, commit }],
      });
      await round(h);
      expect((await readState(h.dir)).prs["7"]?.recheckComputing === true).toBe(
        marked,
      );
    }
  });
});
