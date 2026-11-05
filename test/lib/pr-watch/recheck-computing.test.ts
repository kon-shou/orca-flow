import { describe, expect, it } from "vitest";
import { run } from "../../../src/commands/pr-watch.ts";
import { MAX_STAGE2 } from "../../../src/lib/pr-watch/round.ts";
import { readPushRecord, writePushRecord } from "../../../src/lib/finish.ts";
import { testRunner } from "../../helpers/runner.ts";
import { readState } from "../../../src/lib/pr-watch/store.ts";
import {
  SECRET_MARK,
  comments,
  harness,
  taskWithRecord,
  type Harness,
} from "./helpers.ts";

const round = (h: Harness) => run(h.ctx(["--root", h.root]));
const background = (h: Harness) => run(h.ctx(["background", "--root", h.root]));

const COMPUTING = { reviewDecision: "APPROVED", mergeStateStatus: "UNKNOWN" };
const CLEAN = { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" };

/** 計算中だけで止まった PR #7 を、最初の回で見たところまで進める */
async function computing(over: Record<string, unknown> = {}) {
  const h = await harness();
  await taskWithRecord(h, "T07", 7);
  const pr = h.gh.add({
    number: 7,
    branch: "task/T07-x",
    ...COMPUTING,
    ...over,
  });
  await round(h);
  return { h, pr };
}

/** 動きのない回を1回流し、2段目に渡された PR の番号を返す */
async function nextRound(h: Harness): Promise<number[]> {
  const before = h.gh.stage2Numbers.length;
  h.now = new Date(h.now.getTime() + 5 * 60_000);
  await round(h);
  return h.gh.stage2Numbers.slice(before).flat();
}

describe("計算中の読み直し", () => {
  it("計算中だけで止めた PR は、動かなくても次の回の2段目に入り、済んで全員 OK ならマージ待ちのカードが付く", async () => {
    const { h, pr } = await computing();
    expect((await readState(h.dir)).prs["7"]?.recheckComputing).toBe(true);
    expect(await nextRound(h)).toEqual([7]);
    // まだ計算中：カードは付かない
    await background(h);
    expect(comments(h.orca).join("\n")).not.toContain("マージ待ち");
    Object.assign(pr, CLEAN);
    expect(await nextRound(h)).toEqual([7]);
    await background(h);
    expect(comments(h.orca).at(-1)).toBe("マージ待ち：PR #7");
    // 済んだら印が消え、次の回には入らない
    const entry = (await readState(h.dir)).prs["7"]!;
    expect(entry.recheckComputing).toBeUndefined();
    expect(entry.recheckCount).toBeUndefined();
    expect(await nextRound(h)).toEqual([]);
  });

  it("計算中が続くと読み直しは続けて3回まで。4回目の回では2段目に入らない", async () => {
    const { h } = await computing();
    expect(await nextRound(h)).toEqual([7]);
    expect(await nextRound(h)).toEqual([7]);
    expect(await nextRound(h)).toEqual([7]);
    expect(await nextRound(h)).toEqual([]);
    expect(await nextRound(h)).toEqual([]);
  });

  it("上限のあと PR が動いて、また計算中だけで止まったら、数え直してまた3回まで読み直す", async () => {
    const { h, pr } = await computing();
    for (let i = 0; i < 3; i++) await nextRound(h);
    expect(await nextRound(h)).toEqual([]);
    pr.updatedAt = "2026-11-04T05:00:00Z";
    expect(await nextRound(h)).toEqual([7]);
    expect(await nextRound(h)).toEqual([7]);
    expect(await nextRound(h)).toEqual([7]);
    expect(await nextRound(h)).toEqual([7]);
    expect(await nextRound(h)).toEqual([]);
  });

  it("読み直して計算中でなくなった PR は、全員 OK でなくても印が消え、次の回には入らない", async () => {
    const { h, pr } = await computing();
    pr.mergeStateStatus = "BLOCKED";
    expect(await nextRound(h)).toEqual([7]);
    const entry = (await readState(h.dir)).prs["7"]!;
    expect(entry.recheckComputing).toBeUndefined();
    expect(await nextRound(h)).toEqual([]);
    await background(h);
    expect(comments(h.orca).join("\n")).not.toContain("マージ待ち");
  });

  it("計算中のほかに止める理由（承認がない・下書き・未解決のスレッド）がある PR は、印が付かず読み直さない", async () => {
    for (const over of [
      { reviewDecision: null },
      { reviewDecision: "CHANGES_REQUESTED" },
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
      // 数えきれないスレッド（331件・全部解決済み）
      {
        threads: Array.from({ length: 331 }, (_, i) => ({
          id: `t${i}`,
          resolvedBy: "alice",
          comments: [{ id: `c${i}`, author: "alice", body: SECRET_MARK }],
        })),
      },
    ]) {
      const { h } = await computing(over);
      expect(
        (await readState(h.dir)).prs["7"]?.recheckComputing,
      ).toBeUndefined();
      expect(await nextRound(h)).toEqual([]);
    }
  });

  it("読み直しの PR は、消えた PR・記録の番号だけ・動いた PR のあとに並び、20件からあふれた回は回数に数えない", async () => {
    const h = await harness();
    await taskWithRecord(h, "T07", 7);
    h.gh.add({ number: 7, branch: "task/T07-x", ...COMPUTING });
    await round(h);
    // 動いた PR を20件足す：読み直しの #7 は21番目になり、あふれる
    for (let i = 0; i < MAX_STAGE2; i++)
      h.gh.add({ number: 100 + i, branch: `task/T${100 + i}-x` });
    h.now = new Date(h.now.getTime() + 5 * 60_000);
    await round(h);
    const first = h.gh.stage2Numbers.at(-1)!;
    expect(first).toHaveLength(MAX_STAGE2);
    expect(first).not.toContain(7);
    expect((await readState(h.dir)).prs["7"]?.recheckCount ?? 0).toBe(0);
    // 次の回は動いたものがないので、#7 が読み直される（1回目）
    expect(await nextRound(h)).toEqual([7]);
    expect((await readState(h.dir)).prs["7"]?.recheckCount).toBe(1);
  });

  it("動いた PR のあとに読み直しの PR が並ぶ", async () => {
    const { h } = await computing();
    h.gh.add({ number: 8, branch: "task/T08-x" });
    expect(await nextRound(h)).toEqual([8, 7]);
  });

  it("印の欄がない古い記録の PR は、動くまで読み直さない", async () => {
    const { h } = await computing();
    const { updateState } = await import("../../../src/lib/pr-watch/store.ts");
    await updateState(h.dir, (st) => {
      delete st.prs["7"]!.recheckComputing;
      delete st.prs["7"]!.recheckCount;
      return false;
    });
    expect(await nextRound(h)).toEqual([]);
  });

  it("消えた PR・記録の番号だけの PR・動いた PR・読み直しの PR を混ぜると、この順に並ぶ", async () => {
    const h = await harness();
    await taskWithRecord(h, "T05", 5);
    await taskWithRecord(h, "T07", 7);
    const gone = h.gh.add({ number: 5, branch: "task/T05-x" });
    h.gh.add({ number: 7, branch: "task/T07-x", ...COMPUTING });
    await round(h);
    // 9 は1段目に一度も出ないまま閉じられた
    await taskWithRecord(h, "T09", 9);
    gone.state = "MERGED";
    gone.mergeCommit = "a".repeat(40);
    h.gh.add({ number: 9, branch: "task/T09-x", state: "CLOSED" });
    h.gh.add({ number: 8, branch: "task/T08-x" });
    expect(await nextRound(h)).toEqual([5, 9, 8, 7]);
  });

  it("書き直しの印が置かれた読み直しの PR は、次の回と背景でカードが書き直され、印が外れる", async () => {
    const { h } = await computing();
    await writePushRecord(testRunner, h.root, "T07", {
      id: "T07",
      watch: {
        status: "ci-wait",
        detail: null,
        reason: "card-reset",
        ci: null,
        draft: null,
        updatedAt: "x",
      },
    });
    expect(await nextRound(h)).toEqual([7]);
    expect(h.orca.launches).toHaveLength(1);
    await background(h);
    expect(comments(h.orca)).toHaveLength(1);
    const record = await readPushRecord(testRunner, h.root, "T07");
    expect((record?.watch as { reason: unknown }).reason).toBeNull();
  });
});
