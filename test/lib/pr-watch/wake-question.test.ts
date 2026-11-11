import { describe, expect, it } from "vitest";
import { run } from "../../../src/commands/pr-watch.ts";
import { appendStage } from "../../../src/lib/stage-log.ts";
import { readState } from "../../../src/lib/pr-watch/store.ts";
import { testRunner } from "../../helpers/runner.ts";
import { gitCommonDir } from "../../../src/lib/git.ts";
import {
  SECRET_MARK,
  comments,
  harness,
  taskWithRecord,
  type FakePr,
  type Harness,
} from "./helpers.ts";

const round = (h: Harness) => run(h.ctx(["--root", h.root]));
const background = (h: Harness) => run(h.ctx(["background", "--root", h.root]));
const minutes = (h: Harness, m: number) => {
  h.now = new Date(h.now.getTime() + m * 60_000);
};

let tick = 0;
function review(pr: FakePr) {
  tick++;
  pr.updatedAt = `2026-11-04T05:${String(tick % 60).padStart(2, "0")}:${String(Math.floor(tick / 60)).padStart(2, "0")}Z`;
  pr.reviews.push({ id: `r${tick}`, author: "alice", body: SECRET_MARK });
}

async function setup(h: Harness, id = "T07", n = 7) {
  const { wt, head } = await taskWithRecord(h, id, n);
  const pr = h.gh.add({ number: n, branch: wt.branch, head });
  await round(h);
  return { id, pr, wt: wt.path };
}

const stage = async (h: Harness, id: string, state: string) => {
  const common = await gitCommonDir(testRunner, h.root);
  await appendStage(common, id, {
    at: h.now.toISOString(),
    state,
    note: null,
    command: "status",
  });
};

const lead = (h: Harness, wt: string) =>
  h.orca.terminals.push({
    handle: "term_lead",
    worktreePath: wt,
    agentIdentity: "claude",
  });
const sends = (h: Harness) => h.orca.callsOf("terminal", "send");
const launches = (h: Harness) => h.orca.callsOf("agent", "launch");

describe("人の答え待ちのあいだは起こさない", () => {
  it("最後が question でターミナルがあれば、send も launch も呼ばず、待ちの起こしが question で残る。一言に理由が付く", async () => {
    const h = await harness();
    const t = await setup(h);
    lead(h, t.wt);
    await stage(h, t.id, "question");
    review(t.pr);
    await round(h);
    await background(h);
    expect(sends(h)).toEqual([]);
    expect(launches(h)).toEqual([]);
    const w = (await readState(h.dir)).wakes["7"]!;
    expect(w).toMatchObject({ pending: true, wait: "question" });
    expect(comments(h.orca).at(-1)).toBe(
      "レビュー待ち：PR #7（レビュー1件）（起こせていません：人の答えを待っています）",
    );
  });

  it("responding の行を足した次の回に、respond を1回だけ送り、一言を元に戻す", async () => {
    const h = await harness();
    const t = await setup(h);
    lead(h, t.wt);
    await stage(h, t.id, "question");
    review(t.pr);
    await round(h);
    await background(h);
    minutes(h, 1);
    await stage(h, t.id, "responding");
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(sends(h)[0]![sends(h)[0]!.indexOf("--text") + 1]).toBe(
      "/orca-flow:respond T07",
    );
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(launches(h)).toEqual([]);
    expect((await readState(h.dir)).wakes["7"]).toMatchObject({
      pending: false,
      wait: null,
    });
    expect(comments(h.orca).at(-1)).toBe("レビュー待ち：PR #7（レビュー1件）");
  });

  it("question のまま6時間回しても待ちの起こしは消えず、外れた回に送られる", async () => {
    const h = await harness();
    const t = await setup(h);
    lead(h, t.wt);
    await stage(h, t.id, "question");
    review(t.pr);
    await round(h);
    for (let i = 0; i < 24; i++) {
      await background(h);
      minutes(h, 15);
    }
    expect(sends(h)).toEqual([]);
    expect((await readState(h.dir)).wakes["7"]).toMatchObject({
      pending: true,
      wait: "question",
    });
    await stage(h, t.id, "integrate-wait");
    await background(h);
    expect(sends(h)).toHaveLength(1);
  });

  it("最後が question でも、ターミナルがなければ新しい会話を立てる", async () => {
    const h = await harness();
    const t = await setup(h);
    await stage(h, t.id, "question");
    review(t.pr);
    await round(h);
    await background(h);
    expect(sends(h)).toEqual([]);
    expect(launches(h)).toHaveLength(1);
  });

  it("段の記録がなければ、今までどおり起こす", async () => {
    const h = await harness();
    const t = await setup(h);
    lead(h, t.wt);
    review(t.pr);
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);
  });

  it("読めない行だけの記録は question でないとみなして起こす", async () => {
    const h = await harness();
    const t = await setup(h);
    lead(h, t.wt);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const common = await gitCommonDir(testRunner, h.root);
    await mkdir(`${common}/orca-flow/stages`, { recursive: true });
    await writeFile(`${common}/orca-flow/stages/${t.id}.jsonl`, "{broken\n");
    review(t.pr);
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);
  });
});
