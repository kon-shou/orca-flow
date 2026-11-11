import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../../src/commands/pr-watch.ts";
import { writePushRecord } from "../../../src/lib/finish.ts";
import {
  readState,
  readUsage,
  usageDates,
} from "../../../src/lib/pr-watch/store.ts";
import { testRunner } from "../../helpers/runner.ts";
import { addTaskWorktree } from "../../helpers/repo.ts";
import {
  SECRET_MARK,
  comments,
  harness,
  taskWithRecord,
  type Harness,
} from "./helpers.ts";

const round = (h: Harness) => run(h.ctx(["--root", h.root]));

async function usage(h: Harness) {
  const lines = [];
  for (const d of await usageDates(h.dir))
    lines.push(...(await readUsage(h.dir, d)));
  return lines;
}

/** 偽物の PR をまとめて足す（タスクの記録つき。タスクは T01〜） */
async function addTasks(h: Harness, count: number, first = 1) {
  for (let i = 0; i < count; i++) {
    const n = first + i;
    const id = `T${String(n).padStart(2, "0")}`;
    h.gh.add({ number: n, branch: `task/${id}-x` });
  }
}

describe("見張りの1回：動きのない回", () => {
  it("動きのない回は0以外で終わり、カード・背景・会話の呼び出しが1つも起きない", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    h.gh.add({ number: 7, branch: "task/T07-x" });
    const first = await round(h);
    const second = await round(h);
    expect(first.code).not.toBe(0);
    expect(second.code).not.toBe(0);
    expect(h.orca.calls).toEqual([]);
    expect(h.orca.launches).toEqual([]);
    expect(h.gh.ready).toEqual([]);
    // 2回目は動きがないので2段目を呼ばない
    expect(h.gh.stage1).toBe(2);
    expect(h.gh.stage2).toBe(1);
    const lines = await usage(h);
    expect(lines.map((l) => l.result)).toEqual(["success", "success"]);
    expect(lines[1]!.launched).toBe(false);
  });

  it("50本の PR を持つ偽物で12回流した点数の合計が、上限5000の5%（250）以下に収まる", async () => {
    const h = await harness();
    await addTasks(h, 50);
    for (let i = 0; i < 12; i++) {
      // 毎回3本が動く（更新の時刻だけ変わる）
      for (let k = 1; k <= 3; k++)
        h.gh.prs.get(((i * 3 + k) % 50) + 1)!.updatedAt =
          `2026-11-04T02:${String(i).padStart(2, "0")}:0${k}Z`;
      h.now = new Date(h.now.getTime() + 5 * 60_000);
      await round(h);
    }
    const lines = await usage(h);
    expect(lines).toHaveLength(12);
    const total = lines.reduce((sum, l) => sum + l.cost, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(250);
  });
});

describe("見張りの1回：残りと上限の印", () => {
  it("残りが minRemaining を切った回は GraphQL を呼ばずに飛ばしたと記録する", async () => {
    const h = await harness({ prWatch: { minRemaining: 1000 } });
    h.gh.remaining = 999;
    await addTasks(h, 2);
    const result = await round(h);
    expect(result.code).not.toBe(0);
    expect(h.gh.stage1 + h.gh.stage2).toBe(0);
    expect(h.gh.calls.map((c) => c[1])).toEqual(["rate_limit"]);
    const [line] = await usage(h);
    expect(line).toMatchObject({ result: "skipped", remaining: 999 });
    expect(line!.reason).toContain("minRemaining");
  });

  it("上限の印のあとは、戻る時刻まで gh を1つも呼ばない。戻ったら動く", async () => {
    const h = await harness();
    await addTasks(h, 1);
    h.gh.rateLimited = true;
    await round(h);
    const state = await readState(h.dir);
    expect(state.lastRun?.result).toBe("rate-limited");
    const until = Date.parse(state.rateLimitedUntil!);
    expect(until).toBeGreaterThan(h.now.getTime());
    const before = h.gh.calls.length;
    h.gh.rateLimited = false;
    h.now = new Date(h.now.getTime() + 60_000);
    await round(h);
    expect(h.gh.calls.length).toBe(before);
    expect((await usage(h)).at(-1)).toMatchObject({ result: "skipped" });
    h.now = new Date(until + 1000);
    await round(h);
    expect(h.gh.calls.length).toBeGreaterThan(before);
    expect((await readState(h.dir)).rateLimitedUntil).toBeNull();
  });
});

describe("見張りの1回：上限の印と戻る時刻", () => {
  it("上限の印のとき rate_limit の戻る時刻まで待ち、その前は gh を呼ばない", async () => {
    const h = await harness();
    await addTasks(h, 1);
    const resetAt = h.now.getTime() + 45 * 60_000;
    h.gh.resetAt = Math.floor(resetAt / 1000);
    h.gh.rateLimited = true;
    await round(h);
    const state = await readState(h.dir);
    expect(state.lastRun?.result).toBe("rate-limited");
    expect(state.rateLimitedUntil).toBe(new Date(resetAt).toISOString());
    // 戻る時刻の前は、gh を1つも呼ばない（既定の10分を過ぎても）
    const before = h.gh.calls.length;
    h.now = new Date(h.now.getTime() + 30 * 60_000);
    await round(h);
    expect(h.gh.calls.length).toBe(before);
    expect((await usage(h)).at(-1)).toMatchObject({ result: "skipped" });
    // 戻ったあとは問い合わせる
    h.gh.rateLimited = false;
    h.now = new Date(resetAt + 1000);
    await round(h);
    expect(h.gh.calls.length).toBeGreaterThan(before);
    expect((await usage(h)).at(-1)).toMatchObject({ result: "success" });
  });
});

describe("見張りの1回：動きの記録と背景", () => {
  it("レビューとコメントの動きを記録し、precheck の中ではカードに触れず、背景を1回だけ起こす", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    await round(h);
    pr.updatedAt = "2026-11-04T02:00:00Z";
    pr.reviews.push({
      id: "r1",
      author: "alice",
      body: `指摘です ${SECRET_MARK}`,
    });
    pr.comments.push({
      id: "c1",
      author: "bob",
      body: `コメント ${SECRET_MARK}`,
    });
    pr.comments.push({
      id: "c2",
      author: "me",
      body: `自分の返信 ${SECRET_MARK}`,
    });
    const result = await round(h);
    expect(result.code).not.toBe(0);
    expect(h.orca.calls).toEqual([]);
    expect(h.orca.launches).toHaveLength(1);
    // 起動役の本文（script）に、背景の入口と --root が渡っている
    expect(h.orca.launches[0]![1]).toContain(
      `"pr-watch", "background", "--root", ${JSON.stringify(h.root)}`,
    );
    const state = await readState(h.dir);
    expect(state.work["7"]).toMatchObject({
      taskId: "T07",
      counts: { review: 1, comment: 1, resolved: 0, push: 0 },
    });
  });

  it("背景がカードに状態・一言・未読の印をつけ、push の記録の watch にも書く。本文の印の文字はどこにも出ない", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    await round(h);
    pr.updatedAt = "2026-11-04T02:00:00Z";
    pr.reviews.push({ id: "r1", author: "alice", body: SECRET_MARK });
    pr.threads.push({
      id: "t1",
      resolvedBy: null,
      comments: [{ id: "tc1", author: "alice", body: SECRET_MARK }],
    });
    pr.comments.push({ id: "c1", author: "bob", body: SECRET_MARK });
    await round(h);
    const bg = await run(h.ctx(["background", "--root", h.root]));
    expect(bg.code).toBe(0);
    const sets = h.orca.callsOf("worktree", "set");
    expect(sets).toHaveLength(1);
    const call = sets[0]!;
    expect(call[call.indexOf("--comment") + 1]).toBe(
      "レビュー待ち：PR #7（レビュー1件・コメント2件）",
    );
    expect(call).toContain("--unread");
    expect(call[call.indexOf("--workspace-status") + 1]).toBe("in-review");
    // push の記録の watch キー（push --show が読む）
    const record = JSON.parse(
      await readFile(
        path.join(h.root, ".git", "orca-flow", "push", "T07.json"),
        "utf8",
      ),
    );
    expect(record.watch).toMatchObject({
      status: "review-wait",
      detail: "レビュー1件・コメント2件",
    });
    // 仕事は済んでいる
    expect((await readState(h.dir)).work).toEqual({});
    // 本文の印の文字が、カード・標準出力・標準エラー・記録のどれにも出ない
    const files = [
      "state.json",
      ...(await usageDates(h.dir)).map((d) => `usage-${d}.jsonl`),
    ];
    const texts = [
      JSON.stringify(h.orca.calls),
      h.out.join("\n"),
      h.err.join("\n"),
      JSON.stringify(record),
      ...(await Promise.all(
        files.map((f) => readFile(path.join(h.dir, f), "utf8")),
      )),
    ];
    for (const t of texts) expect(t).not.toContain(SECRET_MARK);
  });

  it("更新の時刻が変わらず CI の要約の状態だけが変わった PR を2段目に入れ、カードを CI の状態にする", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x", ci: "PENDING" });
    await round(h);
    expect(h.gh.stage2Numbers).toEqual([[7]]);
    pr.ci = "FAILURE";
    await round(h);
    expect(h.gh.stage2Numbers).toEqual([[7], [7]]);
    await run(h.ctx(["background", "--root", h.root]));
    const call = h.orca.callsOf("worktree", "set")[0]!;
    expect(call[call.indexOf("--comment") + 1]).toBe("CI が落ちた：PR #7");
    expect(call).toContain("--unread");
  });

  it("自分のアカウントの書き込みと send が送った push の先頭だけで動いた PR は、動きに数えずカードを変えない", async () => {
    const h = await harness();
    const { head } = await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x", head });
    await round(h);
    // 自分の返信・レビュー・スレッドの解決、send が送った新しい先頭
    const sent = "f".repeat(40);
    await writePushRecord(testRunner, h.root, "T07", {
      id: "T07",
      pushedHead: sent,
    });
    pr.head = sent;
    pr.updatedAt = "2026-11-04T02:00:00Z";
    pr.reviews.push({ id: "r1", author: "me", body: SECRET_MARK });
    pr.comments.push({ id: "c1", author: "me", body: SECRET_MARK });
    pr.threads.push({
      id: "t1",
      resolvedBy: "me",
      comments: [{ id: "tc1", author: "me", body: SECRET_MARK }],
    });
    await round(h);
    expect(h.gh.stage2Numbers).toEqual([[7], [7]]);
    expect((await readState(h.dir)).work).toEqual({});
    expect(h.orca.launches).toEqual([]);
    expect(h.orca.calls).toEqual([]);
  });

  it("他人の push・スレッドの解決は動きに数える", async () => {
    const h = await harness();
    const { head } = await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x", head });
    pr.threads.push({
      id: "t1",
      resolvedBy: null,
      comments: [{ id: "tc1", author: "me", body: "x" }],
    });
    await round(h);
    pr.head = "e".repeat(40);
    pr.updatedAt = "2026-11-04T02:00:00Z";
    pr.threads[0]!.resolvedBy = "alice";
    await round(h);
    expect((await readState(h.dir)).work["7"]!.counts).toEqual({
      review: 0,
      comment: 0,
      resolved: 1,
      push: 1,
    });
  });
});

describe("見張りの1回：2段目に入れる PR", () => {
  it("開いている一覧から消えた PR と、一度も1段目で見ない push の記録の番号だけの PR を2段目で取る", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    await taskWithRecord(h, "T09", 9);
    const seen = h.gh.add({ number: 7, branch: "task/T07-x" });
    // 9 は1段目に一度も出ないまま閉じられた（push の記録の番号だけがある）
    h.gh.add({ number: 9, branch: "task/T09-x", state: "CLOSED" });
    await round(h);
    expect(h.gh.stage2Numbers[0]!.sort()).toEqual([7, 9]);
    expect((await readState(h.dir)).work["9"]).toMatchObject({ end: "closed" });
    // 7 はマージされて開いている一覧から消えた
    seen.state = "MERGED";
    seen.mergeCommit = "a".repeat(40);
    await round(h);
    expect(h.gh.stage2Numbers[1]).toEqual([7]);
    const state = await readState(h.dir);
    expect(state.work["7"]).toMatchObject({
      end: "merged",
      mergeCommit: "a".repeat(40),
    });
    expect(h.orca.calls).toEqual([]);
    // 閉じた 9 はもう問い合わせない
    await round(h);
    expect(h.gh.stage2).toBe(2);
  });

  it("後始末が済んだ PR（push の記録に mergeCommit がある）は、見つけても仕事にしない", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    await round(h);
    await writePushRecord(testRunner, h.root, "T07", {
      id: "T07",
      mergeCommit: "a".repeat(40),
    });
    pr.state = "MERGED";
    pr.mergeCommit = "a".repeat(40);
    await round(h);
    expect((await readState(h.dir)).work).toEqual({});
    expect(h.orca.launches).toEqual([]);
    // 記録の番号だけの PR も、mergeCommit があれば2段目に入れない
    await taskWithRecord(h, "T09", 9);
    await writePushRecord(testRunner, h.root, "T09", {
      id: "T09",
      mergeCommit: "b".repeat(40),
    });
    h.gh.add({ number: 9, branch: "task/T09-x", state: "MERGED" });
    const before = h.gh.stage2;
    await round(h);
    expect(h.gh.stage2).toBe(before);
  });

  it("20件を超えた回は、次の回に回した PR の前回の値を変えず、次の回でその動きを取る。消えた PR が先", async () => {
    const h = await harness();
    await addTasks(h, 24);
    await round(h); // 最初の回：24本とも見る（20本ずつ）
    await round(h);
    expect(h.gh.stage2Numbers.map((n) => n.length)).toEqual([20, 4]);
    const base = h.gh.stage2;
    // 22本が動き、1本が消える（クローズ）
    for (let n = 1; n <= 22; n++) {
      h.gh.prs.get(n)!.updatedAt = "2026-11-04T03:00:00Z";
      h.gh.prs
        .get(n)!
        .reviews.push({ id: `r${n}`, author: "alice", body: "x" });
    }
    h.gh.prs.get(24)!.state = "CLOSED";
    await round(h);
    const picked = h.gh.stage2Numbers[base]!;
    expect(picked).toHaveLength(20);
    expect(picked[0]).toBe(24);
    let state = await readState(h.dir);
    const deferred = [...Array(22).keys()]
      .map((i) => i + 1)
      .filter((n) => !picked.includes(n));
    expect(deferred).toHaveLength(3);
    for (const n of deferred) {
      expect(state.prs[String(n)]!.updatedAt).not.toBe("2026-11-04T03:00:00Z");
      expect(state.work[String(n)]).toBeUndefined();
    }
    await round(h);
    expect(h.gh.stage2Numbers.at(-1)!.sort((a, b) => a - b)).toEqual(deferred);
    state = await readState(h.dir);
    for (const n of deferred)
      expect(state.work[String(n)]!.counts.review).toBe(1);
  });

  it("タスクでない PR（branchPrefix に合わない・フォーク・別のリポジトリ）は2段目に入れない", async () => {
    const h = await harness();
    h.gh.add({ number: 1, branch: "feature/x" });
    h.gh.add({ number: 2, branch: "task/T02-x", cross: true });
    h.gh.add({ number: 3, branch: "task/T03-x", repo: "x/other" });
    h.gh.add({ number: 4, branch: "task/T04-x" });
    await round(h);
    expect(h.gh.stage2Numbers).toEqual([[4]]);
  });

  it("branchPrefix に合うが ID の形でないブランチ（task/fix-typo）の PR は、何回流しても2段目に入れない", async () => {
    const h = await harness();
    h.gh.add({ number: 1, branch: "task/fix-typo" });
    for (let i = 0; i < 4; i++) await round(h);
    expect(h.gh.stage1).toBe(4);
    expect(h.gh.stage2).toBe(0);
    h.gh.add({ number: 4, branch: "task/T04-x" });
    await round(h);
    expect(h.gh.stage2Numbers).toEqual([[4]]);
  });

  it("閉じたあと開き直された PR は、前に見たレビューを新しい動きに数えない", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    pr.reviews.push({
      id: "r1",
      author: "alice",
      body: "x",
      at: "2026-11-04T00:10:00Z",
    });
    // 自分が返したあと：初めての回でも答えていないものはない
    pr.comments.push({
      id: "c1",
      author: "me",
      body: "返信",
      at: "2026-11-04T00:20:00Z",
    });
    await round(h);
    pr.state = "CLOSED";
    await round(h);
    expect((await readState(h.dir)).prs["7"]!.final).toBe("closed");
    pr.state = "OPEN";
    pr.updatedAt = "2026-11-04T05:00:00Z";
    await round(h);
    const state = await readState(h.dir);
    expect(state.prs["7"]!.final).toBeNull();
    expect(state.work["7"]!.counts.review).toBe(0);
    // 新しいレビューは数える
    pr.updatedAt = "2026-11-04T06:00:00Z";
    pr.reviews.push({ id: "r2", author: "alice", body: "y" });
    await round(h);
    expect((await readState(h.dir)).work["7"]!.counts.review).toBe(1);
  });
});

describe("見張りの1回：失敗と同時の回", () => {
  it("失敗した回の理由と最後に成功した時刻が pr-watch usage に出る", async () => {
    const h = await harness();
    await addTasks(h, 1);
    await round(h);
    const okAt = h.now.toISOString();
    h.now = new Date(h.now.getTime() + 300_000);
    h.gh.failStderr = "boom token ghp_abcdefghijklmnop1234";
    const failed = await round(h);
    expect(failed.code).not.toBe(0);
    h.out.length = 0;
    const result = await run(h.ctx(["usage", "--root", h.root]));
    expect(result.code).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(okAt);
    expect(text).toContain("boom");
    expect(text).not.toContain("ghp_abcdefghijklmnop1234");
    expect(text).toContain("失敗 1");
  });

  it("同じ時に2つの回が走っても state.json が壊れず、片方は飛ばしたと記録する", async () => {
    const h = await harness();
    await addTasks(h, 3);
    const inner = h.runner;
    h.runner = async (cmd, args, opts) => {
      if (cmd === "gh" && args[1] === "rate_limit")
        await new Promise((r) => setTimeout(r, 300));
      return inner(cmd, args, opts);
    };
    await Promise.all([round(h), round(h)]);
    const results = (await usage(h)).map((l) => l.result).sort();
    expect(results).toEqual(["skipped", "success"]);
    const raw = await readFile(path.join(h.dir, "state.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(Object.keys(JSON.parse(raw).prs)).toHaveLength(3);
  });
});

describe("見張りの1回：失敗の記録と締め切り", () => {
  it("2段目で落ちた回は、1段目の回数と点数を使った回数に残す", async () => {
    const h = await harness();
    await addTasks(h, 2);
    const inner = h.runner;
    h.runner = async (cmd, args, opts) => {
      if (cmd === "gh" && args.some((a) => a.includes("pr_1:")))
        return { code: 1, stdout: "", stderr: "boom", timedOut: false };
      return inner(cmd, args, opts);
    };
    await round(h);
    const [line] = await usage(h);
    expect(line).toMatchObject({ result: "failed" });
    expect(line!.calls).toBe(1);
    expect(line!.cost).toBeGreaterThan(0);
    expect(line!.remaining).not.toBeNull();
  });

  it("背景の起動で落ちた回も、1段目と2段目の回数と点数を残す", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    await round(h);
    pr.updatedAt = "2026-11-04T02:00:00Z";
    pr.reviews.push({ id: "r1", author: "alice", body: "x" });
    const inner = h.runner;
    h.runner = async (cmd, args, opts) =>
      cmd === process.execPath
        ? { code: 1, stdout: "", stderr: "no node", timedOut: false }
        : inner(cmd, args, opts);
    await round(h);
    const last = (await usage(h)).at(-1)!;
    expect(last).toMatchObject({ result: "failed", calls: 2 });
    expect(last.cost).toBeGreaterThan(0);
    // 仕事は記録に残り、次の回に起こし直す
    expect((await readState(h.dir)).work["7"]).toBeDefined();
  });

  it("設定の誤りで落ちた回も、使った回数と最後の回に失敗と理由を残す", async () => {
    const h = await harness({ prWatch: { minRemaining: -1 } });
    const result = await round(h);
    expect(result.code).not.toBe(0);
    const [line] = await usage(h);
    expect(line).toMatchObject({ result: "failed" });
    expect(line!.reason).toContain("minRemaining");
    const state = await readState(h.dir);
    expect(state.lastRun).toMatchObject({ result: "failed" });
    expect(state.lastFailure?.reason).toContain("minRemaining");
  });

  it("回の全体に締め切りがあり、超えたら2段目に進まず時間切れとして記録する。gh の時間切れは残りの時間に合わせる", async () => {
    const h = await harness();
    await addTasks(h, 2);
    const inner = h.runner;
    const timeouts: (number | undefined)[] = [];
    h.runner = async (cmd, args, opts) => {
      if (cmd === "gh") timeouts.push(opts?.timeoutMs);
      const result = await inner(cmd, args, opts);
      // 1段目の問い合わせに50秒かかった
      if (cmd === "gh" && args.some((a) => a.includes("search(")))
        h.now = new Date(h.now.getTime() + 50_000);
      return result;
    };
    await round(h);
    expect(h.gh.stage1).toBe(1);
    expect(h.gh.stage2).toBe(0);
    const [line] = await usage(h);
    expect(line).toMatchObject({ result: "failed", calls: 1 });
    expect(line!.reason).toContain("時間切れ");
    expect((await readState(h.dir)).prs).toEqual({});
    // どの gh も、締め切りより長い時間切れは持たない
    for (const t of timeouts) expect(t).toBeLessThanOrEqual(45_000);
  });
});

describe("見張りの1回：古い使った回数の記録", () => {
  it("30日より古い日付の usage は回の終わりに消し、新しいものは残す", async () => {
    const h = await harness();
    await addTasks(h, 1);
    await round(h);
    await writeFile(path.join(h.dir, "usage-2026-09-01.jsonl"), "{}\n");
    await writeFile(path.join(h.dir, "usage-2026-10-20.jsonl"), "{}\n");
    await round(h);
    const files = await readdir(h.dir);
    expect(files).not.toContain("usage-2026-09-01.jsonl");
    expect(files).toContain("usage-2026-10-20.jsonl");
    expect(files).toContain("usage-2026-11-04.jsonl");
  });
});

describe("見張りの1回：タスクの worktree から打つ", () => {
  it("--root がなくても、タスクの worktree の中からメインの作業ツリーを見張り、背景にもメインを渡す", async () => {
    const h = await harness();
    const wt = await addTaskWorktree(h.root, "T01", "x", { "a.ts": "a\n" });
    const pr = h.gh.add({ number: 1, branch: wt.branch });
    const inWorktree = () => ({ ...h.ctx([]), cwd: wt.path });
    await run(inWorktree());
    expect((await readState(h.dir)).lastRun?.result).toBe("success");
    pr.updatedAt = "2026-11-04T02:00:00Z";
    pr.reviews.push({ id: "r1", author: "alice", body: "x" });
    await run(inWorktree());
    expect(h.orca.launches).toHaveLength(1);
    expect(h.orca.launches[0]![1]).toContain(
      `"pr-watch", "background", "--root", ${JSON.stringify(h.root)}`,
    );
  });
});

describe("見張りの1回：マージ待ち", () => {
  const APPROVED = { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" };

  it("全員 OK の PR は、動きの件数が0の回でもカードを「マージ待ち」（未読）にし、外れたら今までの印に戻る", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    await round(h);
    // 判定が変わっただけ（レビュー・コメントの動きなし）
    pr.updatedAt = "2026-11-04T02:00:00Z";
    Object.assign(pr, APPROVED);
    await round(h);
    expect(Object.values((await readState(h.dir)).work)[0]?.counts).toEqual({
      review: 0,
      comment: 0,
      resolved: 0,
      push: 0,
    });
    expect(h.orca.launches).toHaveLength(1);
    await run(h.ctx(["background", "--root", h.root]));
    const sets = h.orca.callsOf("worktree", "set");
    expect(sets).toHaveLength(1);
    expect(sets[0]![sets[0]!.indexOf("--comment") + 1]).toBe(
      "マージ待ち：PR #7",
    );
    expect(sets[0]).toContain("--unread");
    // 変更を求めるレビューで外れたら、今までの印（レビュー待ち）に戻る
    pr.updatedAt = "2026-11-04T03:00:00Z";
    pr.reviewDecision = "CHANGES_REQUESTED";
    pr.mergeStateStatus = "BLOCKED";
    await round(h);
    await run(h.ctx(["background", "--root", h.root]));
    expect(comments(h.orca).at(-1)).toBe("レビュー待ち：PR #7");
  });

  it("変更を求めるレビュー・未解決のスレッド・下書きの PR はマージ待ちにならない", async () => {
    for (const over of [
      { reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "CLEAN" },
      { isDraft: true },
      {
        threads: [
          {
            id: "t1",
            resolvedBy: null,
            comments: [{ id: "c", author: "alice", body: SECRET_MARK }],
          },
        ],
      },
    ]) {
      const h = await harness();
      await taskWithRecord(h, "T07", 7);
      const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
      await round(h);
      pr.updatedAt = "2026-11-04T02:00:00Z";
      Object.assign(pr, APPROVED, over);
      await round(h);
      await run(h.ctx(["background", "--root", h.root]));
      expect(comments(h.orca).join("\n")).not.toContain("マージ待ち");
    }
  });

  it("45件のスレッドが全部解決済みの PR はマージ待ちになり、めくった問い合わせも使った回数と点数に入る", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    await round(h);
    pr.updatedAt = "2026-11-04T02:00:00Z";
    Object.assign(pr, APPROVED);
    pr.threads = Array.from({ length: 45 }, (_, i) => ({
      id: `t${i}`,
      resolvedBy: "alice",
      comments: [],
    }));
    const before = (await usage(h)).length;
    await round(h);
    await run(h.ctx(["background", "--root", h.root]));
    expect(comments(h.orca).at(-1)).toBe("マージ待ち：PR #7");
    expect(h.gh.older).toBe(1);
    const last = (await usage(h)).at(-1)!;
    expect((await usage(h)).length).toBe(before + 1);
    // 1段目1回・2段目1回・めくり1回
    expect(last.calls).toBe(3);
    expect(last.cost).toBe(h.gh.costOf(1, 1) + h.gh.costOf(2, 1) + 1);
  });

  it("めくる問い合わせだけが失敗しても、それまでの回数と点数が使い方の記録に残り、回は失敗か上限の印になる", async () => {
    for (const mode of ["error", "rate-limit"] as const) {
      const h = await harness();
      await taskWithRecord(h, "T07", 7);
      const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
      await round(h);
      pr.updatedAt = "2026-11-04T02:00:00Z";
      Object.assign(pr, APPROVED);
      pr.threads = Array.from({ length: 45 }, (_, i) => ({
        id: `t${i}`,
        resolvedBy: "alice",
        comments: [],
      }));
      h.gh.failOlder = mode;
      await round(h);
      expect(h.gh.olderFailed).toBe(1);
      const last = (await usage(h)).at(-1)!;
      expect(last.result).toBe(mode === "error" ? "failed" : "rate-limited");
      // 1段目1回・2段目1回（めくりは通らなかったので数えない）
      expect(last.calls).toBe(2);
      expect(last.cost).toBe(h.gh.costOf(1, 1) + h.gh.costOf(2, 1));
      // 全員 OK を揺らさない：マージ待ちのカードは立たない
      await run(h.ctx(["background", "--root", h.root]));
      expect(comments(h.orca).join("\n")).not.toContain("マージ待ち");
    }
  });

  it("古いスレッドに未解決が1件あれば、45件でもマージ待ちにならない", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x" });
    await round(h);
    pr.updatedAt = "2026-11-04T02:00:00Z";
    Object.assign(pr, APPROVED);
    pr.threads = Array.from({ length: 45 }, (_, i) => ({
      id: `t${i}`,
      resolvedBy: i === 0 ? null : "alice",
      comments: [],
    }));
    await round(h);
    await run(h.ctx(["background", "--root", h.root]));
    expect(comments(h.orca).join("\n")).not.toContain("マージ待ち");
  });

  it("merge が後始末を済ませたあとに見張りの回がその PR のマージを見ても、後始末の仕事を立てない", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: "task/T07-x", ...APPROVED });
    await round(h);
    await run(h.ctx(["background", "--root", h.root]));
    expect(comments(h.orca)).toEqual(["マージ待ち：PR #7"]);
    h.orca.launches.length = 0;
    // merge のコマンドが GitHub でマージし、後始末まで済ませた（push の記録に mergeCommit）
    await writePushRecord(testRunner, h.root, "T07", {
      id: "T07",
      mergeCommit: "a".repeat(40),
      mergedAt: "2026-11-04T02:00:00Z",
    });
    pr.state = "MERGED";
    pr.mergeCommit = "a".repeat(40);
    pr.updatedAt = "2026-11-04T02:00:00Z";
    await round(h);
    expect((await readState(h.dir)).work).toEqual({});
    expect(h.orca.launches).toEqual([]);
  });
});
