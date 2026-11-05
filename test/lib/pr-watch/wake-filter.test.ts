import { describe, expect, it } from "vitest";
import {
  fetchPrDetails,
  olderThreadsQuery,
  stage2Query,
  type PrDetail,
} from "../../../src/lib/github-read.ts";
import { run } from "../../../src/commands/pr-watch.ts";
import { classifyDetail } from "../../../src/lib/pr-watch/classify.ts";
import { readState } from "../../../src/lib/pr-watch/store.ts";
import { wakeWorthy } from "../../../src/lib/pr-watch/wake.ts";
import {
  NO_COUNTS,
  type Counts,
  type PrEntry,
  type WorkItem,
} from "../../../src/lib/pr-watch/types.ts";
import { testRunner } from "../../helpers/runner.ts";
import {
  SECRET_MARK,
  comments,
  fakeGh,
  ghRunner,
  harness,
  taskWithRecord,
  type Harness,
} from "./helpers.ts";

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  number: 7,
  url: "",
  state: "open",
  isDraft: false,
  head: "h1",
  branch: "task/T07-x",
  updatedAt: "t",
  mergedAt: null,
  mergeCommit: null,
  reviewDecision: null,
  mergeStateStatus: null,
  ci: "passed",
  reviews: [],
  comments: [],
  threads: [],
  threadTotal: 0,
  olderThreads: { read: 0, unresolved: 0, complete: true },
  threadsBefore: null,
  ...over,
});

const classify = (d: Partial<PrDetail>) =>
  classifyDetail({
    viewer: "me",
    prev: undefined,
    ownHeads: new Set(),
    detail: detail(d),
  });

const item = (counts: Partial<Counts>, over: Partial<WorkItem> = {}) =>
  ({
    number: 7,
    url: "",
    taskId: "T07",
    branch: "b",
    rev: 1,
    counts: { ...NO_COUNTS, ...counts },
    ciChanged: false,
    ci: "passed",
    isDraft: false,
    head: "h",
    release: false,
    refresh: false,
    end: null,
    mergeCommit: null,
    mergedAt: null,
    at: "t",
    ...over,
  }) satisfies WorkItem;

describe("2段目の問い合わせと読み取り：立場と bot の印", () => {
  it("レビュー・コメント・スレッドのコメントに authorAssociation と __typename があり、body はない", () => {
    const q = stage2Query([7]);
    expect(q).toContain("reviews(last: 30) { nodes { id authorAssociation");
    expect(q).toContain("comments(last: 30) { nodes { id authorAssociation");
    expect(q).toContain("comments(last: 20) { nodes { id authorAssociation");
    expect(q.match(/authorAssociation/g)).toHaveLength(3);
    expect(q.match(/__typename/g)).toHaveLength(3);
    expect(q.match(/author \{ login __typename \}/g)).toHaveLength(3);
    expect(q).not.toMatch(/\bbody|bodyText|bodyHTML/);
  });

  it("古いスレッドをめくる問い合わせは書いた人を取らない", () => {
    const q = olderThreadsQuery([7]);
    expect(q).not.toMatch(/authorAssociation|__typename|author|body/);
  });

  it("偽物の答えから立場と bot の印が読める。印のない答えは null と false", async () => {
    const gh = fakeGh();
    gh.add({
      number: 7,
      reviews: [
        { id: "r1", author: "a", body: SECRET_MARK, association: "OWNER" },
        { id: "r2", author: "b", body: SECRET_MARK },
      ],
      comments: [
        {
          id: "c1",
          author: "c",
          body: SECRET_MARK,
          association: "NONE",
          bot: true,
        },
      ],
      threads: [
        {
          id: "t1",
          resolvedBy: null,
          comments: [
            {
              id: "c2",
              author: "d",
              body: SECRET_MARK,
              association: "MEMBER",
              bot: false,
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
    expect(d.reviews[0]).toMatchObject({ association: "OWNER", bot: false });
    expect(d.reviews[1]).toMatchObject({ association: null, bot: false });
    expect(d.comments[0]).toMatchObject({ association: "NONE", bot: true });
    expect(d.threads[0]!.comments[0]).toMatchObject({
      association: "MEMBER",
      bot: false,
    });
    expect(JSON.stringify(d)).not.toContain(SECRET_MARK);
  });
});

describe("動きの見分け：起こさない分の数え", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "%s のレビュー・コメントは起こさない分に数えない",
    (association) => {
      const r = classify({
        reviews: [{ id: "r1", author: "bob", association, bot: false }],
        comments: [{ id: "c1", author: "bob", association, bot: false }],
      });
      expect(r.counts).toMatchObject({ review: 1, comment: 1 });
      expect(r.counts.quiet ?? 0).toBe(0);
    },
  );

  it.each([
    "CONTRIBUTOR",
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "NONE",
    "MANNEQUIN",
  ])(
    "%s のレビュー・コメントは件数に入り、起こさない分にも数える",
    (association) => {
      const r = classify({
        reviews: [{ id: "r1", author: "bob", association, bot: false }],
        threads: [
          {
            id: "t1",
            resolved: false,
            resolvedBy: null,
            comments: [{ id: "c1", author: "bob", association, bot: false }],
          },
        ],
      });
      expect(r.counts).toMatchObject({ review: 1, comment: 1, quiet: 2 });
    },
  );

  it("Bot は立場が OWNER でも起こさない分に数える", () => {
    const r = classify({
      comments: [
        { id: "c1", author: "x", association: "OWNER", bot: true },
        { id: "c2", author: "y", association: null, bot: true },
      ],
    });
    expect(r.counts).toMatchObject({ comment: 2, quiet: 2 });
  });

  it.each([
    "coderabbitai",
    "copilot-pull-request-reviewer",
    "github-actions",
    "CodeRabbitAI",
    "coderabbitai[bot]",
    "Copilot-Pull-Request-Reviewer[BOT]",
    "github-actions[bot]",
  ])("許す bot（%s）は立場が NONE でも起こさない分に数えない", (author) => {
    const r = classify({
      reviews: [{ id: "r1", author, association: "NONE", bot: true }],
      comments: [{ id: "c1", author, association: "NONE", bot: true }],
      threads: [
        {
          id: "t1",
          resolved: false,
          resolvedBy: null,
          comments: [{ id: "c2", author, association: "NONE", bot: true }],
        },
      ],
    });
    expect(r.counts).toMatchObject({ review: 1, comment: 2 });
    expect(r.counts.quiet ?? 0).toBe(0);
  });

  it("許す名前でない Bot（dependabot）は立場が OWNER でも起こさない分に数える", () => {
    const r = classify({
      comments: [
        { id: "c1", author: "dependabot", association: "OWNER", bot: true },
        { id: "c2", author: "dependabot[bot]", association: null, bot: true },
      ],
    });
    expect(r.counts).toMatchObject({ comment: 2, quiet: 2 });
  });

  it("Bot でない User が許す名前と同じログイン名でも、外の人なら起こさない分に数える", () => {
    const r = classify({
      reviews: [
        { id: "r1", author: "coderabbitai", association: "NONE", bot: false },
      ],
      comments: [
        { id: "c1", author: "github-actions", association: "NONE", bot: false },
      ],
    });
    expect(r.counts).toMatchObject({ review: 1, comment: 1, quiet: 2 });
  });

  it("許す名前に近い別の名前（前方一致・部分一致）は許さない", () => {
    const r = classify({
      comments: [
        { id: "c1", author: "coderabbitai-x", association: "NONE", bot: true },
        {
          id: "c2",
          author: "my-github-actions",
          association: "NONE",
          bot: true,
        },
      ],
    });
    expect(r.counts).toMatchObject({ comment: 2, quiet: 2 });
  });

  it("立場が答えにない（読めない）ものは起こす分", () => {
    const r = classify({
      reviews: [{ id: "r1", author: "bob" }],
      comments: [{ id: "c1", author: "bob", association: null, bot: false }],
    });
    expect(r.counts).toMatchObject({ review: 1, comment: 1 });
    expect(r.counts.quiet ?? 0).toBe(0);
  });

  it("自分の書き込みは立場によらず数えない", () => {
    const r = classify({
      comments: [{ id: "c1", author: "me", association: "NONE", bot: true }],
    });
    expect(r.counts).toMatchObject({ comment: 0 });
    expect(r.counts.quiet ?? 0).toBe(0);
  });

  it("前回見たものは起こさない分にも数えない", () => {
    const prev = {
      seen: { reviews: [], comments: ["c1"], resolved: [] },
    } as unknown as PrEntry;
    const r = classifyDetail({
      viewer: "me",
      prev,
      ownHeads: new Set(),
      detail: detail({
        comments: [{ id: "c1", author: "b", association: "NONE", bot: false }],
      }),
    });
    expect(r.counts.comment).toBe(0);
    expect(r.counts.quiet ?? 0).toBe(0);
  });

  it("記録に立場と bot の印は入らない（seen は ID だけ）", () => {
    const r = classify({
      comments: [{ id: "c1", author: "b", association: "NONE", bot: true }],
    });
    expect(r.seen.comments).toEqual(["c1"]);
    expect(JSON.stringify(r)).not.toContain("NONE");
    expect(JSON.stringify(r)).not.toContain("Bot");
  });
});

describe("起こす動きかの判断", () => {
  it("起こす分（合計−起こさない分）があれば起こす", () => {
    expect(wakeWorthy(item({ comment: 2, quiet: 1 }))).toBe(true);
    expect(wakeWorthy(item({ review: 1, comment: 1, quiet: 1 }))).toBe(true);
  });

  it("起こさない分だけなら起こさない", () => {
    expect(wakeWorthy(item({ comment: 2, quiet: 2 }))).toBe(false);
    expect(wakeWorthy(item({ review: 1, comment: 1, quiet: 2 }))).toBe(false);
  });

  it("起こさない分だけでも、CI の赤なら起こす", () => {
    expect(
      wakeWorthy(
        item({ comment: 1, quiet: 1 }, { ciChanged: true, ci: "failed" }),
      ),
    ).toBe(true);
  });

  it("起こさない件数のない古い記録は、レビュー・コメントがあれば起こす", () => {
    expect(wakeWorthy(item({ comment: 1 }))).toBe(true);
    expect(wakeWorthy(item({ review: 1 }))).toBe(true);
    expect(wakeWorthy(item({}))).toBe(false);
  });

  it("終わった仕事は起こさない", () => {
    expect(wakeWorthy(item({ comment: 1 }, { end: "merged" }))).toBe(false);
  });
});

describe("見張りの回：仕事を重ねたときの足し合わせ", () => {
  async function setup(): Promise<{
    h: Harness;
    pr: ReturnType<Harness["gh"]["add"]>;
  }> {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    await run(h.ctx(["--root", h.root]));
    return { h, pr };
  }
  let n = 0;
  const comment = (
    pr: ReturnType<Harness["gh"]["add"]>,
    association?: string,
    bot?: boolean,
    login?: string,
  ) => {
    n++;
    pr.updatedAt = `2026-11-04T05:${String(n % 60).padStart(2, "0")}:${String(Math.floor(n / 60)).padStart(2, "0")}Z`;
    pr.comments.push({
      id: `pc${n}`,
      author: login ?? `u${n}`,
      body: SECRET_MARK,
      ...(association === undefined ? {} : { association }),
      ...(bot === undefined ? {} : { bot }),
    });
  };

  it("外の人だけの回を重ねても起こさない。共同作業者の回が来たら起こす。件数の合計は全部数える", async () => {
    const { h, pr } = await setup();
    comment(pr, "NONE");
    await run(h.ctx(["--root", h.root]));
    comment(pr, "FIRST_TIMER", true);
    await run(h.ctx(["--root", h.root]));
    const quietOnly = (await readState(h.dir)).work["7"]!;
    expect(quietOnly.counts).toMatchObject({ comment: 2, quiet: 2 });
    expect(wakeWorthy(quietOnly)).toBe(false);
    comment(pr, "COLLABORATOR");
    await run(h.ctx(["--root", h.root]));
    const mixed = (await readState(h.dir)).work["7"]!;
    expect(mixed.counts).toMatchObject({ comment: 3, quiet: 2 });
    expect(wakeWorthy(mixed)).toBe(true);
  });

  it("同じ回に外の人と共同作業者が来たら起こす", async () => {
    const { h, pr } = await setup();
    comment(pr, "NONE");
    comment(pr, "COLLABORATOR");
    await run(h.ctx(["--root", h.root]));
    const w = (await readState(h.dir)).work["7"]!;
    expect(w.counts).toMatchObject({ comment: 2, quiet: 1 });
    expect(wakeWorthy(w)).toBe(true);
  });

  it("古い記録（quiet のない仕事）に外の人の分を重ねると、古い分は起こす分として読む", async () => {
    const { h, pr } = await setup();
    comment(pr, "COLLABORATOR");
    await run(h.ctx(["--root", h.root]));
    comment(pr, "NONE");
    await run(h.ctx(["--root", h.root]));
    const w = (await readState(h.dir)).work["7"]!;
    expect(w.counts).toMatchObject({ comment: 2, quiet: 1 });
    expect(wakeWorthy(w)).toBe(true);
  });

  it("背景を流しても、外の人と bot の分だけでは起こさずカードに出し、共同作業者が来たら起こす", async () => {
    const { h, pr } = await setup();
    const background = () => run(h.ctx(["background", "--root", h.root]));
    comment(pr, "NONE");
    pr.reviews.push({
      id: "rv1",
      author: "robot",
      body: SECRET_MARK,
      association: "OWNER",
      bot: true,
    });
    await run(h.ctx(["--root", h.root]));
    await background();
    expect((await readState(h.dir)).wakes).toEqual({});
    expect(h.orca.callsOf("agent", "launch")).toEqual([]);
    expect(h.orca.callsOf("terminal", "send")).toEqual([]);
    const last = h.orca.callsOf("worktree", "set").at(-1)!;
    expect(last).toContain("--unread");
    const note = comments(h.orca).at(-1)!;
    expect(note).toContain("コメント1件");
    expect(note).toContain("レビュー1件");
    comment(pr, "COLLABORATOR");
    await run(h.ctx(["--root", h.root]));
    await background();
    const woke =
      Object.keys((await readState(h.dir)).wakes).length > 0 ||
      h.orca.callsOf("agent", "launch").length > 0 ||
      h.orca.callsOf("terminal", "send").length > 0;
    expect(woke).toBe(true);
  });

  it("背景を流すと、許す bot のコメントだけの回でタスク長を起こし、ほかの bot だけの回では起こさない", async () => {
    const { h, pr } = await setup();
    const background = () => run(h.ctx(["background", "--root", h.root]));
    const woke = async () =>
      Object.keys((await readState(h.dir)).wakes).length > 0 ||
      h.orca.callsOf("agent", "launch").length > 0 ||
      h.orca.callsOf("terminal", "send").length > 0;
    comment(pr, "NONE", true, "dependabot[bot]");
    await run(h.ctx(["--root", h.root]));
    await background();
    expect(await woke()).toBe(false);
    comment(pr, "NONE", true, "CodeRabbitAI[bot]");
    await run(h.ctx(["--root", h.root]));
    await background();
    expect(await woke()).toBe(true);
  });
});
