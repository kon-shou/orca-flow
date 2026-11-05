import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireConfig } from "../../../src/config.ts";
import { run } from "../../../src/commands/pr-watch.ts";
import { writePushRecord } from "../../../src/lib/finish.ts";
import { processWakes } from "../../../src/lib/pr-watch/wake.ts";
import { readState } from "../../../src/lib/pr-watch/store.ts";
import type { Runner } from "../../../src/lib/exec.ts";
import type { WatchFile } from "../../../src/lib/pr-watch/types.ts";
import { bashScreen, claudeScreen } from "../../helpers/fake-orca.ts";
import { testRunner } from "../../helpers/runner.ts";
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
/** 偽物の PR を動かす（更新の時刻を進める） */
function touch(pr: FakePr) {
  tick++;
  pr.updatedAt = `2026-11-04T03:${String(tick % 60).padStart(2, "0")}:${String(Math.floor(tick / 60)).padStart(2, "0")}Z`;
}
function review(pr: FakePr, author = "alice") {
  touch(pr);
  pr.reviews.push({ id: `r${tick}`, author, body: `指摘 ${SECRET_MARK}` });
}

/** タスクの worktree・push の記録・PR を置き、初めての回（最初の中身を数えない）を済ませる */
async function setupTasks(h: Harness, ids: [string, number][]) {
  const out: { id: string; pr: FakePr; wt: string; head: string }[] = [];
  for (const [id, n] of ids) {
    const { wt, head } = await taskWithRecord(h, id, n);
    const pr = h.gh.add({ number: n, branch: wt.branch, head });
    out.push({ id, pr, wt: wt.path, head });
  }
  await round(h);
  return out;
}

const leadTerminal = (h: Harness, wt: string, handle = "term_lead") =>
  h.orca.terminals.push({
    handle,
    worktreePath: wt,
    agentIdentity: "claude",
  });

const sends = (h: Harness) => h.orca.callsOf("terminal", "send");
const launches = (h: Harness) => h.orca.callsOf("agent", "launch");
const flagValue = (call: string[], name: string) =>
  call[call.indexOf(name) + 1];

describe("起こす道：送る・立てる", () => {
  it("生きたタスク長がいて入力欄が空なら、/orca-flow:respond 〈ID〉 を1回送り、agent launch を呼ばない", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    leadTerminal(h, t!.wt);
    review(t!.pr);
    await round(h);
    expect(sends(h)).toEqual([]);
    const result = await background(h);
    expect(result.code).toBe(0);
    expect(sends(h)).toHaveLength(1);
    const call = sends(h)[0]!;
    expect(flagValue(call, "--terminal")).toBe("term_lead");
    expect(flagValue(call, "--text")).toBe("/orca-flow:respond T07");
    expect(launches(h)).toEqual([]);
    const state = await readState(h.dir);
    expect(state.wakes["7"]).toMatchObject({ pending: false, wait: null });
    expect(state.wakes["7"]!.lastWokeAt).toBe(h.now.toISOString());
  });

  it("生きたタスク長がいなければ、agent launch を --worktree と --prompt つきで1回だけ呼ぶ。--workspace・--reuse-session は含まない", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    review(t!.pr);
    await round(h);
    await background(h);
    expect(sends(h)).toEqual([]);
    expect(launches(h)).toHaveLength(1);
    const call = launches(h)[0]!;
    expect(flagValue(call, "--worktree")).toBe(`path:${t!.wt}`);
    expect(flagValue(call, "--prompt")).toBe("/orca-flow:respond T07");
    expect(call).not.toContain("--workspace");
    expect(call).not.toContain("--reuse-session");
    // 見張りが立てた会話として記録する
    expect((await readState(h.dir)).launched["T07"]).toMatchObject({
      taskId: "T07",
    });
  });

  it("送る文・prompt・カード・記録に、他人の文章も件数も入らない", async () => {
    const h = await harness();
    const [a, b] = await setupTasks(h, [
      ["T07", 7],
      ["T08", 8],
    ]);
    leadTerminal(h, a!.wt);
    review(a!.pr);
    review(b!.pr);
    a!.pr.comments.push({ id: "c1", author: "bob", body: SECRET_MARK });
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(sends(h)[0]!, "--text")).toBe("/orca-flow:respond T07");
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe(
      "/orca-flow:respond T08",
    );
    const text = JSON.stringify(h.orca.calls) + (await readStateText(h));
    expect(text).not.toContain(SECRET_MARK);
  });

  it("CI が赤に変わったら起こす。緑・スレッドの解決・他人の push だけでは起こさない", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    // 他人の push と CI の緑（passed → pending → passed）、スレッドの解決
    touch(t!.pr);
    t!.pr.head = "other-head";
    t!.pr.ci = "PENDING";
    await round(h);
    await background(h);
    touch(t!.pr);
    t!.pr.ci = "SUCCESS";
    t!.pr.threads.push({ id: "th1", resolvedBy: "alice", comments: [] });
    await round(h);
    await background(h);
    expect(sends(h)).toEqual([]);
    expect(launches(h)).toEqual([]);
    expect((await readState(h.dir)).wakes).toEqual({});
    // 赤に変わる
    touch(t!.pr);
    t!.pr.ci = "FAILURE";
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe(
      "/orca-flow:respond T07",
    );
  });

  it("CI が赤のままの回に、スレッドの解決や他人の push だけがあっても、間隔のあとに起こさない", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    leadTerminal(h, t!.wt);
    touch(t!.pr);
    t!.pr.ci = "FAILURE";
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    // 間隔（15分）を越えてから、CI は赤のままスレッドの解決と他人の push だけ
    minutes(h, 30);
    touch(t!.pr);
    t!.pr.threads.push({ id: "th1", resolvedBy: "alice", comments: [] });
    await round(h);
    await background(h);
    minutes(h, 30);
    touch(t!.pr);
    t!.pr.head = "other-head";
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(launches(h)).toEqual([]);
    expect((await readState(h.dir)).wakes["7"]).toMatchObject({
      pending: false,
    });
  });
});

async function readStateText(h: Harness) {
  return readFile(path.join(h.dir, "state.json"), "utf8");
}

describe("起こさない・待つ", () => {
  const cases: {
    name: string;
    setup: (h: Harness, wt: string) => void;
    reason: string;
  }[] = [
    {
      name: "入力欄に打ちかけがある",
      setup: (h, wt) => {
        h.orca.terminals.push({
          handle: "term_lead",
          worktreePath: wt,
          agentIdentity: "claude",
          screen: claudeScreen(`書きかけ ${SECRET_MARK}`),
        });
      },
      reason: "入力欄に打ちかけがあります",
    },
    {
      name: "bash モード",
      setup: (h, wt) => {
        h.orca.terminals.push({
          handle: "term_lead",
          worktreePath: wt,
          agentIdentity: "claude",
          screen: bashScreen(),
        });
      },
      reason: "入力欄が bash モードです",
    },
    {
      name: "入力欄を確かめられない",
      setup: (h, wt) => {
        h.orca.terminals.push({
          handle: "term_lead",
          worktreePath: wt,
          agentIdentity: "claude",
          screen: ["許可を求める画面"],
        });
      },
      reason: "入力欄を確かめられません",
    },
    {
      name: "ターミナルが2つ以上",
      setup: (h, wt) => {
        leadTerminal(h, wt, "term_a");
        leadTerminal(h, wt, "term_b");
      },
      reason: "ターミナルが1つに決まりません",
    },
  ];
  for (const c of cases) {
    it(`${c.name}ときは送らず立てず、カードの一言に理由が入り、直したら次の回で起こす`, async () => {
      const h = await harness();
      const [t] = await setupTasks(h, [["T07", 7]]);
      c.setup(h, t!.wt);
      review(t!.pr);
      await round(h);
      await background(h);
      expect(sends(h)).toEqual([]);
      expect(launches(h)).toEqual([]);
      const notes = comments(h.orca);
      expect(notes.at(-1)).toBe(
        `レビュー待ち：PR #7（レビュー1件）（起こせていません：${c.reason}）`,
      );
      const state = await readState(h.dir);
      expect(state.wakes["7"]).toMatchObject({ pending: true });
      // 打ちかけの文も他人の文章も、カードにも記録にも入らない
      expect(JSON.stringify(h.orca.calls)).not.toContain(SECRET_MARK);
      expect(await readStateText(h)).not.toContain(SECRET_MARK);

      // 次の回：待ちの起こしだけがあるので、回は背景を起こす
      const before = h.orca.launches.length;
      await round(h);
      expect(h.orca.launches.length).toBe(before + 1);
      // 同じ理由のままなら一言を書き直さない
      const setCount = comments(h.orca).length;
      await background(h);
      expect(comments(h.orca).length).toBe(setCount);
      // 直す
      h.orca.terminals = [];
      leadTerminal(h, t!.wt);
      await background(h);
      expect(sends(h)).toHaveLength(1);
      expect(comments(h.orca).at(-1)).toBe(
        "レビュー待ち：PR #7（レビュー1件）",
      );
      expect((await readState(h.dir)).wakes["7"]).toMatchObject({
        pending: false,
      });
    });
  }

  it("Orca の呼び出しが失敗したときは待ちに回し、次の背景でやり直す", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: t!.wt,
      agentIdentity: "claude",
      screen: claudeScreen("書きかけ"),
    });
    review(t!.pr);
    await round(h);
    await background(h);
    h.orca.unavailable = true;
    await background(h);
    expect(h.err.join("\n")).toContain("起こせませんでした");
    expect((await readState(h.dir)).wakes["7"]).toMatchObject({
      pending: true,
      wait: "failed",
    });
    h.orca.unavailable = false;
    h.orca.terminals = [];
    await background(h);
    expect(launches(h)).toHaveLength(1);
  });
});

describe("待ちの一言の写し・失敗の扱い", () => {
  const draftTerminal = (h: Harness, wt: string) =>
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt,
      agentIdentity: "claude",
      screen: claudeScreen("書きかけ"),
    });

  it("待ちの間に起こさない仕事でカードが書き直されたら、一言の写しも新しいカードになり、起こせたあとも古い一言に戻らない", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    draftTerminal(h, t!.wt);
    review(t!.pr);
    await round(h);
    await background(h);
    expect(comments(h.orca).at(-1)).toBe(
      "レビュー待ち：PR #7（レビュー1件）（起こせていません：入力欄に打ちかけがあります）",
    );
    // 他人の push で CI 待ち（起こさない仕事）：背景がカードを書き直す
    touch(t!.pr);
    t!.pr.head = "other-head";
    t!.pr.ci = "PENDING";
    await round(h);
    await background(h);
    const rewritten = comments(h.orca).at(-1)!;
    expect(rewritten).toContain("CI 待ち");
    expect(rewritten).toContain(
      "（起こせていません：入力欄に打ちかけがあります）",
    );
    expect(rewritten).not.toContain("レビュー待ち");
    const base = rewritten.replace(
      "（起こせていません：入力欄に打ちかけがあります）",
      "",
    );
    expect((await readState(h.dir)).wakes["7"]).toMatchObject({
      baseComment: base,
    });
    // 打ちかけを消す：起こせて、一言は新しいカードのまま
    h.orca.terminals = [];
    leadTerminal(h, t!.wt);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(comments(h.orca).at(-1)).toBe(base);
  });

  it("タスクを探す git が一時的に失敗しても起こしを捨てず、待ちに回して次の背景でやり直す", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    draftTerminal(h, t!.wt);
    review(t!.pr);
    await round(h);
    await background(h);
    const good: Runner = h.runner;
    h.runner = async (cmd, args, opts) =>
      cmd === "git" && args[0] === "worktree"
        ? { code: 1, stdout: "", stderr: "fatal: boom", timedOut: false }
        : good(cmd, args, opts);
    const result = await background(h);
    expect(result.code).toBe(0);
    expect((await readState(h.dir)).wakes["7"]).toMatchObject({
      pending: true,
      wait: "failed",
    });
    h.runner = good;
    h.orca.terminals = [];
    leadTerminal(h, t!.wt);
    await background(h);
    expect(sends(h)).toHaveLength(1);
  });

  it("起こす道が止まったら、終了コード1で、記録の lastBackground も失敗のまま残す", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    leadTerminal(h, t!.wt);
    review(t!.pr);
    await round(h);
    const ctx = h.ctx(["background", "--root", h.root]);
    ctx.stdout = (text) => {
      if (text.startsWith("起こし：")) throw new Error("出力が止まった");
    };
    const result = await run(ctx);
    expect(result.code).toBe(1);
    const state = await readState(h.dir);
    expect(state.lastBackground).toMatchObject({
      ok: false,
      reason: "出力が止まった",
    });
  });

  it("タスクがもうなければ、待ちの起こしを捨てる", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    draftTerminal(h, t!.wt);
    review(t!.pr);
    await round(h);
    await background(h);
    expect((await readState(h.dir)).wakes["7"]?.pending).toBe(true);
    const good: Runner = h.runner;
    h.runner = async (cmd, args, opts) => {
      const r = await good(cmd, args, opts);
      return cmd === "git" && args[0] === "worktree" && args[1] === "list"
        ? { ...r, stdout: "" }
        : r;
    };
    await background(h);
    expect((await readState(h.dir)).wakes).toEqual({});
  });
});

describe("自分の動きは起こさない", () => {
  it("自分のコメント・レビュー・スレッドの解決と、send が送った push の先頭だけでは起こさない", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    touch(t!.pr);
    t!.pr.reviews.push({ id: "mine1", author: "me", body: SECRET_MARK });
    t!.pr.comments.push({ id: "mine2", author: "me", body: SECRET_MARK });
    t!.pr.threads.push({
      id: "th1",
      resolvedBy: "me",
      comments: [{ id: "mine3", author: "me", body: SECRET_MARK }],
    });
    // send が送った push：記録の先頭が変わり、PR の先頭がそこへ動く
    await writePushRecord(testRunner, h.root, "T07", {
      id: "T07",
      pushedHead: "sent-head",
    });
    t!.pr.head = "sent-head";
    await round(h);
    await background(h);
    await round(h);
    await background(h);
    expect(sends(h)).toEqual([]);
    expect(launches(h)).toEqual([]);
    expect((await readState(h.dir)).wakes).toEqual({});
  });
});

describe("同じ PR の間隔", () => {
  it("起こしたあと間隔（見張りの間隔の3回分）の中では2回目を起こさず、その間の動きは間隔のあとに1回にまとめて起こす", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    leadTerminal(h, t!.wt);
    review(t!.pr);
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);

    // 間隔の中で2つ動く：起こさず、一言に理由が入る
    minutes(h, 5);
    review(t!.pr);
    await round(h);
    await background(h);
    minutes(h, 5);
    review(t!.pr, "carol");
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(comments(h.orca).at(-1)).toContain(
      "起こせていません：前に起こしてから間隔の中です",
    );
    // まだ間隔の中の回は背景を起こすが、起こさない
    minutes(h, 4);
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);

    // 間隔（15分）のあと：1回にまとめて起こす
    minutes(h, 2);
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(2);
    await background(h);
    expect(sends(h)).toHaveLength(2);
    expect(comments(h.orca).at(-1)).toBe("レビュー待ち：PR #7（レビュー1件）");
  });

  it("intervalMinutes を変えれば、間隔もそれに従う", async () => {
    const h = await harness({ prWatch: { intervalMinutes: 1 } });
    const [t] = await setupTasks(h, [["T07", 7]]);
    leadTerminal(h, t!.wt);
    review(t!.pr);
    await round(h);
    await background(h);
    minutes(h, 2);
    review(t!.pr);
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    minutes(h, 2);
    await background(h);
    expect(sends(h)).toHaveLength(2);
  });

  it("同じ仕事を背景が2回読んでも、1回しか起こさない", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    leadTerminal(h, t!.wt);
    review(t!.pr);
    await round(h);
    const before: WatchFile = await readState(h.dir);
    expect(before.work["7"]).toBeDefined();
    await background(h);
    expect(sends(h)).toHaveLength(1);
    // 仕事が残ったまま（記録の書き戻しに失敗したときなど）、間隔のあとにもう一度読む
    minutes(h, 30);
    const now: WatchFile = await readState(h.dir);
    now.work = before.work;
    await writeFile(path.join(h.dir, "state.json"), JSON.stringify(now));
    await background(h);
    expect(sends(h)).toHaveLength(1);
  });
});

describe("同時に起こす会話の上限", () => {
  it("上限に届いていたら新しい会話を立てずに待たせる。ターミナルが消えたら数から外し、次の回に立てる。立てた直後でターミナルが見えない会話も数に入れる", async () => {
    const h = await harness({ prWatch: { maxLaunches: 2 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
      ["T03", 3],
    ]);
    for (const t of ts) review(t.pr);
    await round(h);
    await background(h);
    // 2つ立てて、3つ目は待つ
    expect(launches(h)).toHaveLength(2);
    expect(comments(h.orca).at(-1)).toBe(
      "レビュー待ち：PR #3（レビュー1件）（起こせていません：同時に起こす会話の上限（2）に届いています）",
    );
    expect((await readState(h.dir)).wakes["3"]).toMatchObject({
      pending: true,
      wait: "limit",
    });

    // 立てた直後でターミナルがまだ見えなくても数に入れる
    minutes(h, 1);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(2);

    // 少し経って、T01 のターミナルだけが生きている（T02 は消えた）：T02 を数から外して T03 を立てる
    minutes(h, 3);
    leadTerminal(h, ts[0]!.wt);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(3);
    expect(flagValue(launches(h)[2]!, "--prompt")).toBe(
      "/orca-flow:respond T03",
    );
    const state = await readState(h.dir);
    expect(Object.keys(state.launched).sort()).toEqual(["T01", "T03"]);
  });

  it("agentIdentity のないターミナルと orphaned のターミナルだけが残る会話は数に入れず、次の会話を立てる", async () => {
    const h = await harness({ prWatch: { maxLaunches: 1 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
    ]);
    for (const t of ts) review(t.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect((await readState(h.dir)).wakes["2"]).toMatchObject({
      wait: "limit",
    });
    // 立てた会話の worktree に、会話ではないターミナルだけがある
    minutes(h, 3);
    h.orca.terminals.push(
      { handle: "term_plain", worktreePath: ts[0]!.wt },
      {
        handle: "term_orphan",
        worktreePath: ts[0]!.wt,
        agentIdentity: "claude",
        orphaned: true,
      },
    );
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    expect(flagValue(launches(h)[1]!, "--prompt")).toBe(
      "/orca-flow:respond T02",
    );
    expect(Object.keys((await readState(h.dir)).launched)).toEqual(["T02"]);
  });

  it("上限に届いていても、生きたタスク長がいる PR には送る（新しい会話ではないため）", async () => {
    const h = await harness({ prWatch: { maxLaunches: 1 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
    ]);
    leadTerminal(h, ts[1]!.wt);
    for (const t of ts) review(t.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect(sends(h)).toHaveLength(1);
  });
});

describe("PR が終わったとき・待ちだけの回", () => {
  it("PR がマージかクローズになったら、その PR の待ちの起こしを捨てる", async () => {
    for (const end of ["MERGED", "CLOSED"] as const) {
      const h = await harness();
      const [t] = await setupTasks(h, [["T07", 7]]);
      h.orca.terminals.push({
        handle: "term_lead",
        worktreePath: t!.wt,
        agentIdentity: "claude",
        screen: claudeScreen("書きかけ"),
      });
      review(t!.pr);
      await round(h);
      await background(h);
      expect((await readState(h.dir)).wakes["7"]?.pending).toBe(true);
      touch(t!.pr);
      t!.pr.state = end;
      await round(h);
      expect((await readState(h.dir)).wakes).toEqual({});
      await background(h);
      expect(sends(h)).toEqual([]);
      expect((await readState(h.dir)).wakes).toEqual({});
    }
  });

  it("待ちの起こしだけがあり新しい動きがない回でも、背景を起こす", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: t!.wt,
      agentIdentity: "claude",
      screen: claudeScreen("書きかけ"),
    });
    review(t!.pr);
    await round(h);
    await background(h);
    expect((await readState(h.dir)).work).toEqual({});
    const before = h.orca.launches.length;
    const result = await round(h);
    expect(result.data).toMatchObject({ launched: true });
    expect(h.orca.launches.length).toBe(before + 1);
  });

  it("待ちも仕事もない回は、背景を起こさない", async () => {
    const h = await harness();
    await setupTasks(h, [["T07", 7]]);
    const before = h.orca.launches.length;
    await round(h);
    expect(h.orca.launches.length).toBe(before);
  });
});

const launchedIds = async (h: Harness) =>
  Object.keys((await readState(h.dir)).launched).sort();
const merge = (pr: FakePr) => {
  touch(pr);
  pr.state = "MERGED";
};

describe("会話の記録の掃除", () => {
  it("PR がマージになった回のあと、ターミナルの一覧が失敗を返していても、そのタスクの会話の記録が消える", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    review(t!.pr);
    await round(h);
    await background(h);
    expect(await launchedIds(h)).toEqual(["T07"]);
    h.orca.terminalListFailsFor = [t!.wt];
    merge(t!.pr);
    await round(h);
    await background(h);
    expect(await launchedIds(h)).toEqual([]);
  });

  it("記録が上限の数だけあり、どのタスクの PR もマージ済みで一覧が失敗を返すとき、別のタスクの動きで新しい会話が1つ立つ", async () => {
    const h = await harness({ prWatch: { maxLaunches: 2 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
      ["T03", 3],
    ]);
    review(ts[0]!.pr);
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    minutes(h, 3);
    h.orca.terminalListFailsFor = [ts[0]!.wt, ts[1]!.wt];
    merge(ts[0]!.pr);
    merge(ts[1]!.pr);
    review(ts[2]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(3);
    expect(flagValue(launches(h)[2]!, "--prompt")).toBe(
      "/orca-flow:respond T03",
    );
    expect(await launchedIds(h)).toEqual(["T03"]);
  });

  it("タスクがもう見つからず待ちの起こしを捨てた回に、そのタスクの会話の記録も消える", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    review(t!.pr);
    await round(h);
    await background(h);
    // 間隔の中の2つ目の動きで、待ちの起こしが残る
    minutes(h, 1);
    review(t!.pr);
    await round(h);
    await background(h);
    expect((await readState(h.dir)).wakes["7"]?.pending).toBe(true);
    expect(await launchedIds(h)).toEqual(["T07"]);
    const good: Runner = h.runner;
    h.runner = async (cmd, args, opts) => {
      const r = await good(cmd, args, opts);
      return cmd === "git" && args[0] === "worktree" && args[1] === "list"
        ? { ...r, stdout: "" }
        : r;
    };
    await background(h);
    const state = await readState(h.dir);
    expect(state.wakes).toEqual({});
    expect(state.launched).toEqual({});
  });

  it("同じタスクの待ちの起こしが残っているあいだ（起こし済みで待っていないものを含む）は、会話の記録を消さない", async () => {
    const h = await harness();
    const [t] = await setupTasks(h, [["T07", 7]]);
    review(t!.pr);
    await round(h);
    await background(h);
    expect((await readState(h.dir)).wakes["7"]).toMatchObject({
      pending: false,
    });
    h.orca.terminalListFailsFor = [t!.wt];
    minutes(h, 5);
    await background(h);
    await background(h);
    expect(await launchedIds(h)).toEqual(["T07"]);
  });

  it("捨てるタスクの番号が小さいとき、その会話は同じ回の数に入らず、あとのタスクが立つ", async () => {
    const h = await harness({ prWatch: { maxLaunches: 1 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
    ]);
    review(ts[0]!.pr);
    await round(h);
    await background(h);
    minutes(h, 1);
    review(ts[0]!.pr);
    await round(h);
    await background(h);
    expect((await readState(h.dir)).wakes["1"]?.pending).toBe(true);
    expect(launches(h)).toHaveLength(1);
    minutes(h, 3);
    h.orca.terminalListFailsFor = [ts[0]!.wt];
    const good: Runner = h.runner;
    h.runner = async (cmd, args, opts) => {
      const r = await good(cmd, args, opts);
      return cmd === "git" && args[0] === "worktree" && args[1] === "list"
        ? {
            ...r,
            stdout: r.stdout
              .split("\n\n")
              .filter((block) => !block.includes(ts[0]!.wt))
              .join("\n\n"),
          }
        : r;
    };
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    expect(flagValue(launches(h)[1]!, "--prompt")).toBe(
      "/orca-flow:respond T02",
    );
    expect(await launchedIds(h)).toEqual(["T02"]);
  });

  it("先に数えたあとで捨てるタスクの会話は、同じ回のあとのタスクの数から外れ、立つ", async () => {
    const h = await harness({ prWatch: { maxLaunches: 2 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
      ["T03", 3],
    ]);
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(await launchedIds(h)).toEqual(["T02"]);
    minutes(h, 3);
    h.orca.terminalListFailsFor = [ts[1]!.wt];
    minutes(h, 1);
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect((await readState(h.dir)).wakes["2"]?.pending).toBe(true);
    minutes(h, 3);
    const good: Runner = h.runner;
    h.runner = async (cmd, args, opts) => {
      const r = await good(cmd, args, opts);
      return cmd === "git" && args[0] === "worktree" && args[1] === "list"
        ? {
            ...r,
            stdout: r.stdout
              .split("\n\n")
              .filter((block) => !block.includes(ts[1]!.wt))
              .join("\n\n"),
          }
        : r;
    };
    review(ts[0]!.pr);
    review(ts[2]!.pr);
    await round(h);
    await background(h);
    expect(await launchedIds(h)).toEqual(["T01", "T03"]);
    expect((await readState(h.dir)).wakes["2"]).toBeUndefined();
  });

  it("待ちも記録もない回は state.json を書き直さない", async () => {
    const h = await harness();
    await setupTasks(h, [["T07", 7]]);
    const file = path.join(h.dir, "state.json");
    const before = await stat(file);
    await new Promise((r) => setTimeout(r, 25));
    const out = await processWakes(
      h.ctx(),
      h.root,
      await requireConfig(h.root),
      h.dir,
    );
    expect(out).toEqual({ woke: 0, waiting: 0 });
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("ターミナルを確かめられない会話の期限", () => {
  /** maxLaunches 1：T01 を立て、T02 を上限で待たせる。立てて3分あとから始める */
  async function limitedByUnverifiable() {
    const h = await harness({ prWatch: { maxLaunches: 1 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
    ]);
    review(ts[0]!.pr);
    await round(h);
    await background(h);
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect((await readState(h.dir)).wakes["2"]).toMatchObject({
      wait: "limit",
    });
    minutes(h, 3);
    h.orca.terminalListFailsFor = [ts[0]!.wt];
    return { h, ts };
  }

  it("一覧が失敗し続けると、最初の失敗から1時間までは数に入って立てず、1時間を過ぎた回に外れて立つ", async () => {
    const { h } = await limitedByUnverifiable();
    const first = h.now.toISOString();
    await background(h);
    expect((await readState(h.dir)).launched["T01"]).toMatchObject({
      unverifiableSince: first,
    });
    expect(launches(h)).toHaveLength(1);
    minutes(h, 59);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect((await readState(h.dir)).launched["T01"]?.unverifiableSince).toBe(
      first,
    );
    minutes(h, 2);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    expect(await launchedIds(h)).toEqual(["T02"]);
  });

  it("一覧が途中で一度確かめられれば最初の失敗の時刻は消え、次の失敗から数え直す", async () => {
    const { h, ts } = await limitedByUnverifiable();
    await background(h);
    minutes(h, 30);
    h.orca.terminalListFailsFor = [];
    leadTerminal(h, ts[0]!.wt);
    // 会話のターミナルが見える：数に入ったまま、時刻だけ消える
    await background(h);
    const ok = (await readState(h.dir)).launched["T01"]!;
    expect(ok.unverifiableSince).toBeUndefined();
    expect(launches(h)).toHaveLength(1);
    minutes(h, 1);
    h.orca.terminalListFailsFor = [ts[0]!.wt];
    await background(h);
    const second = h.now.toISOString();
    expect((await readState(h.dir)).launched["T01"]?.unverifiableSince).toBe(
      second,
    );
    // 最初の失敗からは1時間を過ぎたが、数え直しているので外れない
    minutes(h, 40);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    minutes(h, 21);
    await background(h);
    expect(launches(h)).toHaveLength(2);
  });

  it("一覧が空を返し、立ててから2分を過ぎた会話は、数から外れて記録から消える", async () => {
    const h = await harness({ prWatch: { maxLaunches: 1 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
    ]);
    review(ts[0]!.pr);
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    minutes(h, 1);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect(await launchedIds(h)).toEqual(["T01"]);
    minutes(h, 2);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    expect(await launchedIds(h)).toEqual(["T02"]);
  });

  it("前の版の記録（最初の失敗の時刻がない）をそのまま読める", async () => {
    const h = await harness({ prWatch: { maxLaunches: 1 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
    ]);
    review(ts[0]!.pr);
    await round(h);
    await background(h);
    const raw = JSON.parse(await readStateText(h)) as WatchFile;
    expect(raw.launched["T01"]).toBeDefined();
    expect("unverifiableSince" in raw.launched["T01"]!).toBe(false);
    minutes(h, 3);
    h.orca.terminalListFailsFor = [ts[0]!.wt];
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
  });
});

describe("会話を立てる呼び出しが時間切れ", () => {
  const timedOutLaunch = async (maxLaunches = 3) => {
    const h = await harness({ prWatch: { maxLaunches } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
    ]);
    h.orca.launchTimesOut = true;
    review(ts[0]!.pr);
    await round(h);
    await background(h);
    h.orca.launchTimesOut = false;
    return { h, ts };
  };

  it("その回は待ちに回り、会話の記録に立てた時刻が残る。間隔の中の次の回では agent launch を呼ばない", async () => {
    const { h } = await timedOutLaunch();
    expect(launches(h)).toHaveLength(1);
    const state = await readState(h.dir);
    expect(state.wakes["1"]).toMatchObject({
      pending: true,
      wait: "failed",
      lastWokeAt: h.now.toISOString(),
    });
    expect(state.launched["T01"]).toMatchObject({
      taskId: "T01",
      at: h.now.toISOString(),
    });
    expect(comments(h.orca).at(-1)).toBe(
      "レビュー待ち：PR #1（レビュー1件）（起こせていません：Orca の呼び出しに失敗しました）",
    );
    minutes(h, 5);
    await background(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect((await readState(h.dir)).wakes["1"]).toMatchObject({
      pending: true,
      wait: "interval",
    });
  });

  it("間隔を過ぎた回に、会話のターミナルが見えていればそこへ送り、agent launch を呼ばない", async () => {
    const { h, ts } = await timedOutLaunch();
    minutes(h, 16);
    leadTerminal(h, ts[0]!.wt);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect(sends(h)).toHaveLength(1);
    expect(flagValue(sends(h)[0]!, "--text")).toBe("/orca-flow:respond T01");
  });

  it("間隔を過ぎた回に、ターミナルが見えなければ1回だけ立て直す", async () => {
    const { h } = await timedOutLaunch();
    minutes(h, 16);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    const state = await readState(h.dir);
    expect(state.wakes["1"]).toMatchObject({ pending: false });
    expect(state.launched["T01"]!.at).toBe(h.now.toISOString());
  });

  it("ほかのタスクが会話を立てて記録が消えても、間隔の中は立て直さない", async () => {
    const { h, ts } = await timedOutLaunch();
    minutes(h, 3);
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    expect(await launchedIds(h)).toEqual(["T02"]);
    minutes(h, 1);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    expect((await readState(h.dir)).wakes["1"]).toMatchObject({
      pending: true,
      wait: "interval",
    });
  });

  it("同じ回に2つのタスクがあり、1つ目が時間切れでも、その会話が上限の数に入り2つ目は待つ", async () => {
    const h = await harness({ prWatch: { maxLaunches: 1 } });
    const ts = await setupTasks(h, [
      ["T01", 1],
      ["T02", 2],
    ]);
    h.orca.launchTimesOut = true;
    review(ts[0]!.pr);
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    const state = await readState(h.dir);
    expect(state.wakes["1"]).toMatchObject({ wait: "failed" });
    expect(state.wakes["2"]).toMatchObject({ wait: "limit" });
  });

  it("時間切れで記録した会話は、立ててから2分のあいだ上限の数に入る", async () => {
    const { h, ts } = await timedOutLaunch(1);
    minutes(h, 1);
    review(ts[1]!.pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect((await readState(h.dir)).wakes["2"]).toMatchObject({
      wait: "limit",
    });
    minutes(h, 2);
    await background(h);
    expect(launches(h)).toHaveLength(2);
    expect(flagValue(launches(h)[1]!, "--prompt")).toBe(
      "/orca-flow:respond T02",
    );
  });
});
