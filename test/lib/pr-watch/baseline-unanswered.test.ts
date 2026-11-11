import { describe, expect, it } from "vitest";
import { run } from "../../../src/commands/pr-watch.ts";
import { readState } from "../../../src/lib/pr-watch/store.ts";
import {
  SECRET_MARK,
  harness,
  taskWithRecord,
  type FakePr,
  type FakeWho,
  type Harness,
} from "./helpers.ts";

const round = (h: Harness) => run(h.ctx(["--root", h.root]));
const background = (h: Harness) => run(h.ctx(["background", "--root", h.root]));
const launches = (h: Harness) => h.orca.callsOf("agent", "launch");
const sends = (h: Harness) => h.orca.callsOf("terminal", "send");
const flagValue = (call: string[], name: string) =>
  call[call.indexOf(name) + 1];

const MEMBER = { association: "MEMBER" };
const t = (hhmm: string) => `2026-11-03T${hhmm}:00Z`;

/** タスクの worktree・push の記録・PR を置く（初めての回はまだ流さない） */
async function place(h: Harness, id: string, n: number) {
  const { wt, head } = await taskWithRecord(h, id, n);
  const pr = h.gh.add({ number: n, branch: wt.branch, head });
  return { id, pr, wt: wt.path };
}

const other = (id: string, at?: string, who: FakeWho = MEMBER) => ({
  id,
  author: "alice",
  body: SECRET_MARK,
  ...(at === undefined ? {} : { at }),
  ...who,
});
const mine = (id: string, at?: string) => ({
  id,
  author: "me",
  body: SECRET_MARK,
  ...(at === undefined ? {} : { at }),
});

async function woken(h: Harness, pr: FakePr) {
  await round(h);
  await background(h);
  const prompts = launches(h).map((c) => flagValue(c, "--prompt"));
  return { prompts, work: (await readState(h.dir)).work[String(pr.number)] };
}

describe("初めての回：まだ答えていないものでタスク長を起こす", () => {
  it("未解決のスレッドで最後の発言が自分でない PR は、背景のあと /orca-flow:respond が届く", async () => {
    const h = await harness();
    const a = await place(h, "T07", 7);
    a.pr.threads.push({
      id: "th1",
      resolvedBy: null,
      comments: [other("c1", t("01:00"))],
    });
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: a.wt,
      agentIdentity: "claude",
    });
    await round(h);
    expect(sends(h)).toEqual([]);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(flagValue(sends(h)[0]!, "--text")).toBe("/orca-flow:respond T07");
    expect(JSON.stringify(h.orca.calls)).not.toContain(SECRET_MARK);
  });

  it("自分がそのあとに書いていない PR のコメントか、出したレビューがあれば届く", async () => {
    for (const kind of ["comment", "review"] as const) {
      const h = await harness();
      const a = await place(h, "T07", 7);
      a.pr.comments.push(mine("m1", t("01:00")));
      if (kind === "comment") a.pr.comments.push(other("c1", t("02:00")));
      else a.pr.reviews.push(other("r1", t("02:00")));
      const { prompts } = await woken(h, a.pr);
      expect(prompts).toEqual(["/orca-flow:respond T07"]);
    }
  });

  it("解決済みのスレッド・最後の発言が自分のスレッド・自分があとに書いたコメントだけなら、件数0で起こさない", async () => {
    const h = await harness();
    const a = await place(h, "T07", 7);
    a.pr.threads.push(
      { id: "th1", resolvedBy: "alice", comments: [other("c1", t("01:00"))] },
      {
        id: "th2",
        resolvedBy: null,
        comments: [other("c2", t("01:00")), mine("m2", t("02:00"))],
      },
    );
    a.pr.comments.push(other("c3", t("01:00")), mine("m3", t("03:00")));
    a.pr.reviews.push(other("r1", t("01:30")));
    await round(h);
    const state = await readState(h.dir);
    expect(state.work["7"]).toBeUndefined();
    await background(h);
    expect(launches(h)).toEqual([]);
    expect(sends(h)).toEqual([]);
  });

  it("起こさない書き手（外の人・許していない bot）だけが答えていなければ起こさない。自分の保留中のレビューは答えたことにならない", async () => {
    const h = await harness();
    const a = await place(h, "T07", 7);
    a.pr.comments.push(other("c1", t("01:00"), { association: "NONE" }), {
      ...other("c2", t("01:00"), { bot: true }),
      author: "x-bot",
    });
    const quiet = await woken(h, a.pr);
    expect(quiet.prompts).toEqual([]);

    const h2 = await harness();
    const b = await place(h2, "T08", 8);
    b.pr.comments.push(other("c1", t("01:00")));
    // 保留中の自分のレビュー（出した時刻がない）
    b.pr.reviews.push(mine("pending"));
    const pending = await woken(h2, b.pr);
    expect(pending.prompts).toEqual(["/orca-flow:respond T08"]);
  });

  it("自分の保留中の下書きが最後のスレッドと、それより前の他人のコメントは、答えたことにならず届く", async () => {
    const h = await harness();
    const a = await place(h, "T07", 7);
    a.pr.threads.push({
      id: "th1",
      resolvedBy: null,
      comments: [
        other("c1", t("01:00")),
        { ...mine("draft", t("02:00")), pending: true },
      ],
    });
    a.pr.comments.push(other("c2", t("01:30")));
    const { prompts } = await woken(h, a.pr);
    expect(prompts).toEqual(["/orca-flow:respond T07"]);
  });

  it("CI が赤の PR は起こし、緑・待ちの PR は CI では起こさない", async () => {
    for (const [ci, expected] of [
      ["FAILURE", ["/orca-flow:respond T07"]],
      ["SUCCESS", []],
      ["PENDING", []],
      [null, []],
    ] as const) {
      const h = await harness();
      const a = await place(h, "T07", 7);
      a.pr.ci = ci;
      const { prompts } = await woken(h, a.pr);
      expect(prompts).toEqual(expected);
    }
  });

  it("答えていない PR が maxLaunches より多いときは、上限まで立てて残りは待ちの起こしになる", async () => {
    const h = await harness({ prWatch: { maxLaunches: 2 } });
    for (const [id, n] of [
      ["T01", 1],
      ["T02", 2],
      ["T03", 3],
    ] as const) {
      const a = await place(h, id, n);
      a.pr.comments.push(other(`c${n}`, t("01:00")));
    }
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    expect((await readState(h.dir)).wakes["3"]).toMatchObject({
      pending: true,
      wait: "limit",
    });
  });

  it("2段目の上限（20件）からあふれて次の回に読んだ PR も、同じ数え方になる", async () => {
    const h = await harness();
    for (let n = 1; n <= 22; n++)
      h.gh.add({ number: n, branch: `task/T${String(n).padStart(2, "0")}-x` });
    h.gh.prs.get(22)!.comments.push(other("c22", t("01:00")));
    h.gh.prs
      .get(21)!
      .comments.push(other("c21", t("01:00")), mine("m21", t("02:00")));
    await round(h);
    expect(h.gh.stage2Numbers.map((n) => n.length)).toEqual([20]);
    await round(h);
    expect(h.gh.stage2Numbers.map((n) => n.length)).toEqual([20, 2]);
    expect(h.gh.stage2Numbers[1]).toEqual([21, 22]);
    const state = await readState(h.dir);
    expect(state.work["22"]!.counts.comment).toBe(1);
    expect(state.work["21"]).toBeUndefined();
  });

  it("2回目からの回は新しい ID だけを数える。初めての回に数えたものは数え直さず、自分の書き込みでは起こさない", async () => {
    const h = await harness();
    const a = await place(h, "T07", 7);
    a.pr.comments.push(other("c1", t("01:00")));
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect((await readState(h.dir)).work["7"]).toBeUndefined();

    // 自分の返信だけ
    a.pr.updatedAt = "2026-11-04T05:00:00Z";
    a.pr.comments.push(mine("m1", "2026-11-04T05:00:00Z"));
    await round(h);
    expect((await readState(h.dir)).work["7"]).toBeUndefined();

    // 新しい他人のコメントは1件だけ
    a.pr.updatedAt = "2026-11-04T06:00:00Z";
    a.pr.comments.push(other("c2", "2026-11-04T06:00:00Z"));
    await round(h);
    expect((await readState(h.dir)).work["7"]!.counts).toMatchObject({
      comment: 1,
      review: 0,
    });
  });
});
