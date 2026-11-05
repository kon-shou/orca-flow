import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cardForWork } from "../../../src/lib/pr-watch/background.ts";
import type { WorkItem } from "../../../src/lib/pr-watch/types.ts";
import { run } from "../../../src/commands/pr-watch.ts";
import { readPushRecord, writePushRecord } from "../../../src/lib/finish.ts";
import { currentBootAt } from "../../../src/lib/lock.ts";
import { addItem, readItems, updateState } from "../../../src/lib/outbox.ts";
import { createPush } from "../../../src/commands/push.ts";
import { readState } from "../../../src/lib/pr-watch/store.ts";
import { testRunner } from "../../helpers/runner.ts";
import { git, tempDir } from "../../helpers/repo.ts";
import {
  comments,
  harness,
  taskWithRecord,
  withOrigin,
  type Harness,
} from "./helpers.ts";

const round = (h: Harness) => run(h.ctx(["--root", h.root]));
const background = (h: Harness) => run(h.ctx(["background", "--root", h.root]));

const OPEN_WINDOW = {
  outbound: {
    window: { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "23:59" },
  },
};

/** origin（本物の bare）つきのタスクを作り、PR を開いた状態にする */
async function mergeable(config: Record<string, unknown> = {}) {
  const h = await harness({ integrateVerify: "before-merge", ...config });
  const origin = await withOrigin(h);
  const { wt, head } = await taskWithRecord(h, "T12", 7);
  await git(wt.path, "push", "--quiet", "origin", wt.branch);
  const pr = h.gh.add({ number: 7, branch: wt.branch, head });
  return { h, origin, wt, head, pr };
}

/** GitHub でマージされた状態を origin に作る。マージのコミットを返す */
async function mergeOnGithub(origin: string, branch: string) {
  const clone = path.join(await tempDir("orca-flow-clone-"), "c");
  await git(path.dirname(clone), "clone", "--quiet", origin, clone);
  await git(clone, "config", "user.name", "GH");
  await git(clone, "config", "user.email", "gh@example.com");
  await git(
    clone,
    "merge",
    "--quiet",
    "--no-ff",
    "-m",
    "Merge PR",
    `origin/${branch}`,
  );
  await git(clone, "push", "--quiet", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
}

describe("背景：マージとクローズ", () => {
  it("マージなら背景で後始末が mergeCommit・mergedAt つきで走り、precheck の中では走らない", async () => {
    const { h, origin, wt, pr } = await mergeable();
    await round(h);
    const merge = await mergeOnGithub(origin, wt.branch);
    pr.state = "MERGED";
    pr.mergeCommit = merge;
    pr.mergedAt = "2026-11-04T02:30:00Z";
    await round(h);
    // precheck の中では Orca にも後始末にも触れない（記録に mergeCommit がまだない）
    expect(h.orca.calls).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
    expect(
      (await readPushRecord(testRunner, h.root, "T12"))?.mergeCommit,
    ).toBeUndefined();
    expect(h.orca.launches).toHaveLength(1);

    const result = await background(h);
    expect(result.code).toBe(0);
    const record = await readPushRecord(testRunner, h.root, "T12");
    expect(record?.mergeCommit).toBe(merge);
    expect(record?.mergedAt).toBe("2026-11-04T02:30:00Z");
    expect(existsSync(wt.path)).toBe(false);
    expect((await readState(h.dir)).work).toEqual({});
  });

  it("後始末が済んだ PR（push の記録に mergeCommit がある）の仕事は、worktree が残っていても二重の後始末を呼ばない", async () => {
    const { h, origin, wt, pr } = await mergeable();
    await round(h);
    const merge = await mergeOnGithub(origin, wt.branch);
    pr.state = "MERGED";
    pr.mergeCommit = merge;
    // 後始末は済んでいるが worktree はまだある（タスクが見つかるので mergeCommit の守りを通る）
    await writePushRecord(testRunner, h.root, "T12", {
      id: "T12",
      mergeCommit: merge,
    });
    const dir = h.dir;
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        ...(await readState(dir)),
        work: {
          "7": {
            number: 7,
            url: "u",
            taskId: "T12",
            branch: wt.branch,
            rev: 1,
            counts: { review: 0, comment: 0, resolved: 0, push: 0 },
            ciChanged: false,
            ci: "passed",
            isDraft: false,
            head: null,
            release: false,
            refresh: false,
            end: "merged",
            mergeCommit: merge,
            mergedAt: null,
            at: "x",
          },
        },
      }),
    );
    const mainBefore = await git(h.root, "rev-parse", "HEAD");
    const result = await background(h);
    expect(result.code).toBe(0);
    expect(existsSync(wt.path)).toBe(true);
    expect(h.orca.callsOf("worktree", "rm")).toEqual([]);
    expect(h.orca.calls).toEqual([]);
    expect(await git(h.root, "rev-parse", "HEAD")).toBe(mainBefore);
    expect((await readState(dir)).work).toEqual({});
  });

  it("クローズなら後始末は走らず、カードが「PR が閉じられた」になる", async () => {
    const { h, origin, wt, pr } = await mergeable();
    void origin;
    await round(h);
    pr.state = "CLOSED";
    await round(h);
    await background(h);
    expect(comments(h.orca)).toEqual(["PR が閉じられた：PR #7"]);
    expect(existsSync(wt.path)).toBe(true);
    const record = await readPushRecord(testRunner, h.root, "T12");
    expect(record?.mergeCommit).toBeUndefined();
    expect(record?.watch).toMatchObject({ status: "closed" });
    expect(h.orca.callsOf("worktree", "rm")).toEqual([]);
    // 閉じた PR は、もう問い合わせない
    const before = h.gh.stage2;
    await round(h);
    expect(h.gh.stage2).toBe(before);
  });

  it("古いタスクごとの待ち受けが生きている PR は後始末せず、仕事を残す", async () => {
    const { h, origin, wt, pr } = await mergeable();
    await round(h);
    const merge = await mergeOnGithub(origin, wt.branch);
    pr.state = "MERGED";
    pr.mergeCommit = merge;
    await round(h);
    // push/T12.lock の持ち主が生きている（このプロセス）
    await writeFile(
      path.join(h.root, ".git", "orca-flow", "push", "T12.lock"),
      `${process.pid} ${currentBootAt()}\n`,
    );
    const result = await background(h);
    expect(result.code).toBe(1);
    expect(existsSync(wt.path)).toBe(true);
    expect(
      (await readPushRecord(testRunner, h.root, "T12"))?.mergeCommit,
    ).toBeUndefined();
    expect((await readState(h.dir)).work["7"]).toBeDefined();
  });
});

/** 人が send で承認した「承認済み・CI 待ち」の pr-ready の案を置く */
async function approveReady(
  h: Harness,
  wt: { path: string; branch: string },
  id = "T12",
) {
  const common = path.join(h.root, ".git");
  const current = await git(wt.path, "rev-parse", "HEAD");
  const { item } = await addItem(
    common,
    {
      taskId: id,
      kind: "pr-ready",
      body: "",
      head: current,
      target: { remote: "origin", branch: wt.branch, base: "main", pr: 7 },
      afterCi: true,
    },
    {},
    new Date("2026-11-04T00:00:00Z"),
  );
  await updateState(common, item, "ci-wait", new Date("2026-11-04T00:00:00Z"), {
    approvedHead: current,
    approvedFingerprint: item.fingerprint,
  });
  return current;
}

describe("背景：見張りの pr-ready", () => {
  it("CI が通った下書きの PR は、承認済みの案があれば背景で見張りの入口を通して下書きを外す", async () => {
    const h = await harness({ prReady: "after-ci", ...OPEN_WINDOW });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    const pr = h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "PENDING",
    });
    await round(h);
    await approveReady(h, wt);
    // CI が通るまでは外さない
    await round(h);
    await background(h);
    expect(h.gh.ready).toEqual([]);
    pr.ci = "SUCCESS";
    await round(h);
    // precheck の中では送らない
    expect(h.gh.ready).toEqual([]);
    expect(h.orca.launches.length).toBeGreaterThan(0);
    await background(h);
    expect(h.gh.ready).toEqual([["pr", "ready", "7"]]);
    expect(
      (await readItems(path.join(h.root, ".git"), "T12")).find(
        (i) => i.kind === "pr-ready",
      )?.state,
    ).toBe("sent");
  });

  it("案がなければ背景を起こさず、下書きも外さない", async () => {
    const h = await harness({ prReady: "after-ci", ...OPEN_WINDOW });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "SUCCESS",
    });
    await round(h);
    await round(h);
    await round(h);
    expect(h.gh.ready).toEqual([]);
    expect(h.orca.launches).toEqual([]);
  });

  it("承認のときと今の先頭が違えば送らず、案を積んだ状態に戻してカードを「送る前の確認待ち」にする", async () => {
    const h = await harness({ prReady: "after-ci", ...OPEN_WINDOW });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    const pr = h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "PENDING",
    });
    await round(h);
    await approveReady(h, wt);
    // 承認のあとで先頭が進んだ
    await writeFile(path.join(wt.path, "later.ts"), "later\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: あとの変更");
    pr.ci = "SUCCESS";
    await round(h);
    await background(h);
    expect(h.gh.ready).toEqual([]);
    const item = (await readItems(path.join(h.root, ".git"), "T12")).find(
      (i) => i.kind === "pr-ready",
    );
    expect(item?.state).toBe("queued");
    expect(comments(h.orca).at(-1)).toContain("送る前の確認待ち");
  });

  it("送る時間帯の外では案を承認済み・CI 待ちのまま残す", async () => {
    const h = await harness({
      prReady: "after-ci",
      outbound: { window: { days: [], from: "09:00", to: "09:00" } },
    });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    const pr = h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "PENDING",
    });
    await round(h);
    await approveReady(h, wt);
    pr.ci = "SUCCESS";
    await round(h);
    await background(h);
    expect(h.gh.ready).toEqual([]);
    const item = (await readItems(path.join(h.root, ".git"), "T12")).find(
      (i) => i.kind === "pr-ready",
    );
    expect(item?.state).toBe("ci-wait");
  });
});

describe("背景：カードの書き直し", () => {
  it("send が置いた書き直しの印があれば、動きがなくてもカードを今の状態で書き直し、印を外す", async () => {
    const h = await harness();
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    h.gh.add({ number: 7, branch: wt.branch, head, ci: "PENDING" });
    await round(h);
    await writePushRecord(testRunner, h.root, "T12", {
      id: "T12",
      watch: {
        status: "ci-wait",
        detail: null,
        reason: "card-reset",
        ci: null,
        draft: null,
        updatedAt: "x",
      },
    });
    await round(h);
    expect(h.orca.launches).toHaveLength(1);
    await background(h);
    expect(comments(h.orca)).toEqual(["CI 待ち：PR #7"]);
    const record = await readPushRecord(testRunner, h.root, "T12");
    expect((record?.watch as { reason: unknown }).reason).toBeNull();
  });
});

describe("背景：見張りの pr-ready の外し方", () => {
  it("prReady が既定（manual）なら、承認済みの案があっても gh pr ready を呼ばない", async () => {
    const h = await harness({ ...OPEN_WINDOW });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    const pr = h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "PENDING",
    });
    await round(h);
    await approveReady(h, wt);
    pr.ci = "SUCCESS";
    await round(h);
    await round(h);
    await background(h);
    expect(h.gh.ready).toEqual([]);
  });

  it("CI が failed のままなら外さない", async () => {
    const h = await harness({ prReady: "after-ci", ...OPEN_WINDOW });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "FAILURE",
    });
    await round(h);
    await approveReady(h, wt);
    await round(h);
    await round(h);
    await background(h);
    expect(h.gh.ready).toEqual([]);
    const item = (await readItems(path.join(h.root, ".git"), "T12")).find(
      (i) => i.kind === "pr-ready",
    );
    expect(item?.state).toBe("ci-wait");
  });

  it("CI のない下書きが2回続けて見えたら外す（1回目では外さない）", async () => {
    const h = await harness({ prReady: "after-ci", ...OPEN_WINDOW });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    h.gh.add({ number: 7, branch: wt.branch, head, isDraft: true, ci: null });
    await approveReady(h, wt);
    await round(h);
    await background(h);
    expect(h.gh.ready).toEqual([]);
    await round(h);
    expect(h.orca.launches.length).toBeGreaterThan(0);
    await background(h);
    expect(h.gh.ready).toEqual([["pr", "ready", "7"]]);
  });

  it("20件を超えて次の回に回した PR の下書きは、前回の値のまま外さない", async () => {
    const h = await harness({ prReady: "after-ci", ...OPEN_WINDOW });
    for (let n = 1; n <= 21; n++)
      h.gh.add({ number: n, branch: `task/T${String(n).padStart(2, "0")}-x` });
    const { wt, head } = await taskWithRecord(h, "T22", 22);
    const pr = h.gh.add({
      number: 22,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "SUCCESS",
    });
    // 全部を2段目で読み終える（20本ずつ）
    for (let i = 0; i < 3; i++) await round(h);
    await approveReady(h, wt, "T22");
    // 22本とも動き、22 は先頭も変わる。22 は21番目以降なので次の回に回る
    for (const p of h.gh.prs.values()) p.updatedAt = "2026-11-04T03:00:00Z";
    pr.head = "9".repeat(40);
    h.now = new Date(h.now.getTime() + 300_000);
    await round(h);
    expect(h.gh.stage2Numbers.at(-1)).not.toContain(22);
    const state = await readState(h.dir);
    expect(state.work["22"]).toBeUndefined();
    expect(h.orca.launches).toEqual([]);
    await background(h);
    expect(h.gh.ready).toEqual([]);
  });

  it("断られた解除で、背景が毎回起き続けない。先頭か CI が変わったら立て直す", async () => {
    const h = await harness({ prReady: "after-ci", ...OPEN_WINDOW });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    const pr = h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "PENDING",
    });
    await round(h);
    // 案の PR の番号が違うので、見張りの入口が断る
    const common = path.join(h.root, ".git");
    const { item } = await addItem(
      common,
      {
        taskId: "T12",
        kind: "pr-ready",
        body: "",
        head,
        target: { remote: "origin", branch: wt.branch, base: "main", pr: 99 },
        afterCi: true,
      },
      {},
      new Date("2026-11-04T00:00:00Z"),
    );
    await updateState(common, item, "ci-wait", new Date(), {
      approvedHead: head,
      approvedFingerprint: item.fingerprint,
    });
    pr.ci = "SUCCESS";
    await round(h);
    expect(h.orca.launches).toHaveLength(1);
    await background(h);
    expect(h.gh.ready).toEqual([]);
    for (let i = 0; i < 4; i++) {
      await round(h);
      await background(h);
    }
    expect(h.orca.launches).toHaveLength(1);
    expect((await readState(h.dir)).work).toEqual({});
    // CI が変わって通り直したら、もう一度試す
    pr.ci = "PENDING";
    await round(h);
    pr.ci = "SUCCESS";
    await round(h);
    expect((await readState(h.dir)).work["7"]?.release).toBe(true);
  });

  it("送る時間帯の外では背景を起こさず、案は残す。時間帯に入ったら起こす", async () => {
    const h = await harness({
      prReady: "after-ci",
      outbound: {
        window: { days: [0, 1, 2, 3, 4, 5, 6], from: "09:00", to: "20:00" },
      },
    });
    h.now = new Date(2026, 10, 4, 3, 0, 0);
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    const pr = h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "PENDING",
    });
    await round(h);
    await approveReady(h, wt);
    pr.ci = "SUCCESS";
    // CI の変わりの仕事は1回だけ。そのあとは時間帯の外のあいだ背景を起こさない
    h.now = new Date(h.now.getTime() + 300_000);
    await round(h);
    await background(h);
    const launched = h.orca.launches.length;
    for (let i = 0; i < 4; i++) {
      h.now = new Date(h.now.getTime() + 300_000);
      await round(h);
      await background(h);
    }
    expect(h.orca.launches).toHaveLength(launched);
    expect(
      (await readItems(path.join(h.root, ".git"), "T12")).find(
        (i) => i.kind === "pr-ready",
      )?.state,
    ).toBe("ci-wait");
    h.now = new Date(2026, 10, 4, 10, 0, 0);
    await round(h);
    expect(h.orca.launches).toHaveLength(launched + 1);
    await background(h);
    expect(h.gh.ready).toEqual([["pr", "ready", "7"]]);
  });
});

describe("背景：終わらない仕事の上限", () => {
  async function stuck() {
    const { h, origin, wt, pr } = await mergeable();
    await round(h);
    const merge = await mergeOnGithub(origin, wt.branch);
    pr.state = "MERGED";
    pr.mergeCommit = merge;
    await round(h);
    // 古い待ち受けが生きていて、後始末が毎回待ちになる
    await writeFile(
      path.join(h.root, ".git", "orca-flow", "push", "T12.lock"),
      `${process.pid} ${currentBootAt()}\n`,
    );
    return { h, wt, merge };
  }

  it("試した回数が上限（12回）を超えた仕事は外し、lastBackground に理由を残す", async () => {
    const { h } = await stuck();
    for (let i = 0; i < 11; i++) await background(h);
    expect((await readState(h.dir)).work["7"]).toBeDefined();
    await background(h);
    const state = await readState(h.dir);
    expect(state.work["7"]).toBeUndefined();
    expect(state.lastBackground?.ok).toBe(false);
    expect(state.lastBackground?.reason).toContain("上限");
    // 外したあとは背景を起こさない
    const launches = h.orca.launches.length;
    await round(h);
    expect(h.orca.launches.length).toBe(launches);
  });

  it("最初の時刻から1時間を過ぎた仕事も外す", async () => {
    const { h } = await stuck();
    await background(h);
    expect((await readState(h.dir)).work["7"]).toBeDefined();
    h.now = new Date(h.now.getTime() + 61 * 60_000);
    await background(h);
    const state = await readState(h.dir);
    expect(state.work["7"]).toBeUndefined();
    expect(state.lastBackground?.reason).toContain("上限");
  });

  it("12回目に外すと、push の記録とカードが「後始末で止まった」になり、未読の印がつく", async () => {
    const { h } = await stuck();
    for (let i = 0; i < 11; i++) await background(h);
    expect(h.orca.callsOf("worktree", "set")).toEqual([]);
    await background(h);
    const record = await readPushRecord(testRunner, h.root, "T12");
    expect(record?.watch).toMatchObject({
      status: "cleanup-stopped",
      reason: "limit",
    });
    expect(comments(h.orca)).toEqual([
      "後始末で止まった：PR #7（push をもう一度打つとやり直します）",
    ]);
    expect(h.orca.callsOf("worktree", "set").at(-1)).toContain("--unread");
  });

  it("1時間を過ぎて外したときも、記録とカードが「後始末で止まった」になる", async () => {
    const { h } = await stuck();
    await background(h);
    h.now = new Date(h.now.getTime() + 61 * 60_000);
    await background(h);
    expect(
      (await readPushRecord(testRunner, h.root, "T12"))?.watch,
    ).toMatchObject({ status: "cleanup-stopped", reason: "limit" });
    expect(comments(h.orca).join("\n")).toContain("後始末で止まった：PR #7");
  });

  it("上限のとき、待ちを決めたあとにほかの者が後始末を済ませていたら（記録に mergeCommit）、止まったにしない", async () => {
    const { h } = await stuck();
    for (let i = 0; i < 11; i++) await background(h);
    // 12回目：handle は mergeCommit のない記録を読んで待ちを返す。上限の警告を出した直後（止まったを書く前）に、
    // ほかの者が後始末を済ませた形で mergeCommit を書く
    const ctx = h.ctx(["background", "--root", h.root]);
    let injected = false;
    ctx.stderr = (t) => {
      h.err.push(t);
      if (!injected && t.includes("上限")) {
        injected = true;
        const file = path.join(h.root, ".git", "orca-flow", "push", "T12.json");
        const record = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(
          file,
          JSON.stringify({ ...record, mergeCommit: "c".repeat(40) }),
        );
      }
    };
    await run(ctx);
    expect(injected).toBe(true);
    const record = await readPushRecord(testRunner, h.root, "T12");
    expect(record?.mergeCommit).toBe("c".repeat(40));
    expect(record?.watch).not.toMatchObject({ status: "cleanup-stopped" });
    expect(comments(h.orca)).toEqual([]);
  });

  it("上限で外したあと、orca-flow push を打ち直すと後始末をやり直す（push の入口を通る）", async () => {
    const { h, wt, merge } = await stuck();
    for (let i = 0; i < 12; i++) await background(h);
    expect(
      (await readPushRecord(testRunner, h.root, "T12"))?.watch,
    ).toMatchObject({ status: "cleanup-stopped" });
    // 古い待ち受けが終わった形にする
    await rm(path.join(h.root, ".git", "orca-flow", "push", "T12.lock"));
    expect(
      (await readPushRecord(testRunner, h.root, "T12"))?.mergeCommit,
    ).toBeUndefined();
    // 偽物の gh の pr list は mergeCommit を返さないので、応答に足す
    const base = h.runner;
    const ctx = h.ctx(["T12"]);
    ctx.runner = async (cmd, args, opts) => {
      const out = await base(cmd, args, opts);
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return {
          ...out,
          stdout: JSON.stringify(
            (JSON.parse(out.stdout) as object[]).map((p) => ({
              ...p,
              mergeCommit: { oid: merge },
            })),
          ),
        };
      return out;
    };
    const result = await createPush()(ctx);
    expect(result.code).toBe(0);
    const record = await readPushRecord(testRunner, h.root, "T12");
    expect(record?.watch).toMatchObject({ status: "merged" });
    expect(record?.mergeCommit).toBe(merge);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("上限で外したあと、state.json の項が30日で消えても、回は2段目に入れず後始末も走らない", async () => {
    const { h, wt } = await stuck();
    for (let i = 0; i < 12; i++) await background(h);
    // 項を消す（30日が過ぎた形）
    const st = await readState(h.dir);
    delete st.prs["7"];
    await writeFile(path.join(h.dir, "state.json"), JSON.stringify(st));
    const launches = h.orca.launches.length;
    const stage2 = h.gh.stage2;
    await round(h);
    expect(h.gh.stage2).toBe(stage2);
    expect(h.orca.launches.length).toBe(launches);
    expect((await readState(h.dir)).work).toEqual({});
    expect(existsSync(wt.path)).toBe(true);
  });
});

describe("背景：送る直前の CI の食い違い", () => {
  it("回が通ったを見たあと、送る直前の CI がまだなら止めた印は pending になり、次の回に通ったを見たらまた外す", async () => {
    const h = await harness({ prReady: "after-ci", ...OPEN_WINDOW });
    const { wt, head } = await taskWithRecord(h, "T12", 7);
    const pr = h.gh.add({
      number: 7,
      branch: wt.branch,
      head,
      isDraft: true,
      ci: "PENDING",
    });
    await round(h);
    await approveReady(h, wt);
    pr.ci = "SUCCESS";
    await round(h);
    expect((await readState(h.dir)).work["7"]?.release).toBe(true);
    // 回のあと背景の前に、GitHub の CI がまだに戻る
    pr.ci = "PENDING";
    await background(h);
    expect(h.gh.ready).toEqual([]);
    const entry = (await readState(h.dir)).prs["7"]!;
    expect(entry.releasePending).toBe(false);
    expect(entry.releaseStop).toMatchObject({ ci: "pending" });
    // 次の回に通ったを見たら、もう一度外しに行く
    pr.ci = "SUCCESS";
    await round(h);
    expect((await readState(h.dir)).work["7"]?.release).toBe(true);
    await background(h);
    expect(h.gh.ready).toEqual([["pr", "ready", "7"]]);
  });
});

describe("背景：マージ待ちの detail", () => {
  const item = (review: number): WorkItem => ({
    number: 7,
    url: "u",
    taskId: "T12",
    branch: "b",
    rev: 1,
    counts: { review, comment: 0, resolved: 0, push: 0 },
    ciChanged: false,
    ci: "passed",
    isDraft: false,
    head: null,
    release: false,
    refresh: false,
    allOk: true,
    end: null,
    mergeCommit: null,
    mergedAt: null,
    at: "x",
  });

  it("動きの件数がある回でも detail は「マージ待ち」で始まる", () => {
    expect(cardForWork(item(1)).detail).toBe("マージ待ち（レビュー1件）");
    expect(cardForWork(item(0)).detail).toBe("マージ待ち");
  });
});
