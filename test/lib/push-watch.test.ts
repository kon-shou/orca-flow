import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import {
  readPushRecord,
  tryMainLock,
  writePushRecord,
} from "../../src/lib/finish.ts";
import { acquireLock } from "../../src/lib/lock.ts";
import { requireConfig } from "../../src/config.ts";
import {
  cleanupMergedPr,
  launchPushWatch,
  runPushWatch,
  showPushWatch,
} from "../../src/lib/push-watch.ts";
import type { CommandContext } from "../../src/types.ts";
import { readMergeOrder } from "../../src/lib/merge-order.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

type Ci = "pending" | "passed" | "failed" | "none";
type State = "OPEN" | "MERGED" | "CLOSED";

const rollup = (ci: Ci) =>
  ci === "none"
    ? []
    : ci === "pending"
      ? [{ status: "IN_PROGRESS", conclusion: "" }]
      : [
          {
            status: "COMPLETED",
            conclusion: ci === "passed" ? "SUCCESS" : "FAILURE",
          },
        ];

interface Gh {
  state: State;
  ci: Ci;
  isDraft: boolean;
  ready: string[][];
  views: number;
  missing: boolean;
  /** PR の GitHub 側の先頭 */
  head: string;
  /** 番号ごとの状態（なければ state） */
  stateByNumber: Record<number, State>;
  /** pr view を返す直前に呼ぶ */
  onView: ((number: number) => Promise<void> | void) | null;
  /** gh の失敗の標準エラー（空なら失敗しない） */
  failStderr: string;
}

function harness() {
  const orca = fakeOrca();
  const gh: Gh = {
    state: "OPEN",
    ci: "pending",
    isDraft: true,
    ready: [],
    views: 0,
    missing: false,
    head: "abc",
    stateByNumber: {},
    onView: null,
    failStderr: "",
  };
  const pushes: string[][] = [];
  const runner: Runner = async (cmd, args, opts) => {
    const ok = (stdout = "") => ({
      code: 0,
      stdout,
      stderr: "",
      timedOut: false,
    });
    if (cmd === "gh") {
      if (gh.missing)
        return { code: 127, stdout: "", stderr: "ENOENT", timedOut: false };
      if (args[0] === "--version" || args[0] === "auth") return ok("ok");
      if (args[0] === "pr" && args[1] === "view") {
        gh.views++;
        const number = Number(args[2]);
        if (gh.failStderr)
          return {
            code: 1,
            stdout: "",
            stderr: gh.failStderr,
            timedOut: false,
          };
        const state = gh.stateByNumber[number] ?? gh.state;
        await gh.onView?.(number);
        return ok(
          JSON.stringify({
            number,
            url: `https://github.com/o/r/pull/${number}`,
            isDraft: gh.isDraft,
            state,
            headRefOid: gh.head,
            statusCheckRollup: rollup(gh.ci),
          }),
        );
      }
      if (args[0] === "pr" && args[1] === "ready") {
        gh.ready.push([...args]);
        gh.isDraft = false;
        return ok();
      }
      return ok();
    }
    if (cmd === "git" && args[0] === "push") {
      pushes.push([...args]);
      return ok();
    }
    return orca.runner(cmd, args, opts);
  };
  return { orca, gh, pushes, runner };
}

/** origin（本物の bare）つきのタスクを作り、push の記録まで置く */
async function setup(config: Record<string, unknown> = {}) {
  const root = await makeRepo({ integrateVerify: "before-merge", ...config });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/a.ts": "a\n",
  });
  const origin = path.join(await tempDir("orca-flow-origin-"), "origin.git");
  await git(
    path.dirname(origin),
    "init",
    "--quiet",
    "--bare",
    "-b",
    "main",
    origin,
  );
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "--quiet", "origin", "main");
  await git(wt.path, "push", "--quiet", "origin", wt.branch);
  const head = await git(wt.path, "rev-parse", "HEAD");
  await writePushRecord(testRunner, root, "T12", {
    id: "T12",
    branch: wt.branch,
    base: "main",
    pushedHead: head,
    pushedAt: "2026-11-03T00:00:00Z",
    pr: { number: 7, url: "https://github.com/o/r/pull/7" },
  });
  return { root, wt, origin, head };
}

/** GitHub でマージされた状態を origin に作る（PR のマージ） */
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
  return clone;
}

function context(
  root: string,
  runner: Runner,
  out: string[] = [],
  err: string[] = [],
): CommandContext {
  return {
    argv: [],
    cwd: root,
    json: false,
    runner,
    env: {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => new Date("2026-11-03T00:00:00Z"),
  };
}

/** sleep のたびに step を呼ぶ偽物の時計。時間は進めず、すぐ戻る */
const clock = (step: (n: number) => Promise<void> | void = () => {}) => {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await step(sleeps.length);
    },
  };
};

const comments = (orca: ReturnType<typeof fakeOrca>) =>
  orca
    .callsOf("worktree", "set")
    .map((c) => c[c.indexOf("--comment") + 1] ?? "");

describe("待ち受け：下書きを外す", () => {
  it("CI が通り設定が after-ci なら下書きを外す。それまでは外さない", async () => {
    const { root } = await setup({ prReady: "after-ci" });
    const h = harness();
    // CI が pending のうちは、下書きを外す呼び出しが 0 件
    const readyAtSleep: number[] = [];
    const c = clock((n) => {
      readyAtSleep.push(h.gh.ready.length);
      if (n === 2) h.gh.ci = "passed";
    });
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: c.sleep,
      intervalMs: 5,
      maxPolls: 4,
    });
    expect(result.code).toBe(0);
    expect(readyAtSleep.slice(0, 2)).toEqual([0, 0]);
    expect(h.gh.ready).toEqual([["pr", "ready", "7"]]);
    expect(comments(h.orca)).toEqual(["CI 待ち：PR #7", "レビュー待ち：PR #7"]);
    expect(c.sleeps.every((ms) => ms === 5)).toBe(true);
  });

  it("設定が既定（manual）なら CI が通っても外さず、カードは下書きのままと分かる", async () => {
    const { root } = await setup();
    const h = harness();
    h.gh.ci = "passed";
    await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
      maxPolls: 3,
    });
    expect(h.gh.ready).toEqual([]);
    expect(comments(h.orca)).toEqual(["レビュー待ち：PR #7（下書きのまま）"]);
  });

  it("CI が落ちたら外さず、カードに印をつける。直って通れば外す", async () => {
    const { root } = await setup({ prReady: "after-ci" });
    const h = harness();
    h.gh.ci = "failed";
    const err: string[] = [];
    const c = clock((n) => {
      if (n === 2) h.gh.ci = "passed";
    });
    await runPushWatch(context(root, h.runner, [], err), "T12", {
      sleep: c.sleep,
      intervalMs: 1,
      maxPolls: 4,
    });
    expect(comments(h.orca)).toEqual([
      "CI が落ちた：PR #7",
      "レビュー待ち：PR #7",
    ]);
    expect(h.gh.ready).toHaveLength(1);
    const record = await readPushRecord(testRunner, root, "T12");
    expect((record?.watch as { status: string }).status).toBe("review-wait");
  });

  it("CI が落ちたままなら外さない", async () => {
    const { root } = await setup({ prReady: "after-ci" });
    const h = harness();
    h.gh.ci = "failed";
    await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
      maxPolls: 3,
    });
    expect(h.gh.ready).toEqual([]);
    expect(comments(h.orca)).toEqual(["CI が落ちた：PR #7"]);
  });

  it("チェックがない（none）状態が続けば、通ったと同じに扱う。それまでは CI 待ち", async () => {
    const { root } = await setup({ prReady: "after-ci" });
    const h = harness();
    h.gh.ci = "none";
    const readyAtSleep: number[] = [];
    await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock(() => {
        readyAtSleep.push(h.gh.ready.length);
      }).sleep,
      intervalMs: 1,
      noCiPolls: 3,
      maxPolls: 5,
    });
    // noCiPolls 回に届くまでは外さない
    expect(readyAtSleep.slice(0, 2)).toEqual([0, 0]);
    expect(comments(h.orca)).toEqual(["CI 待ち：PR #7", "レビュー待ち：PR #7"]);
    expect(h.gh.ready).toHaveLength(1);
  });

  it("カードの文は同じ間は書き直さない", async () => {
    const { root } = await setup();
    const h = harness();
    await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
      maxPolls: 5,
    });
    expect(h.orca.callsOf("worktree", "set")).toHaveLength(1);
  });
});

describe("待ち受け：マージと後始末", () => {
  it("マージを見つけると後始末をして、カードを統合済みにし、worktree を消す", async () => {
    const { root, wt, origin, head } = await setup();
    const h = harness();
    h.gh.head = head;
    const c = clock(async (n) => {
      if (n === 1) {
        await mergeOnGithub(origin, wt.branch);
        h.gh.state = "MERGED";
      }
    });
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: c.sleep,
      intervalMs: 1,
    });
    expect(result.code).toBe(0);
    expect(result.data).toMatchObject({ merged: true, sync: "fast-forward" });
    await git(root, "merge-base", "--is-ancestor", "origin/main", "main");
    expect(comments(h.orca).at(-1)).toBe("統合済み");
    expect(h.orca.callsOf("worktree", "rm")).toHaveLength(1);
    expect(existsSync(wt.path)).toBe(false);
    const record = await readPushRecord(testRunner, root, "T12");
    expect((record?.watch as { status: string }).status).toBe("merged");
  });

  it("マージの順に入っていれば、統合済みの印がつく", async () => {
    const { root, wt, origin, head } = await setup();
    await addTaskWorktree(root, "T13", "next", { "src/b.ts": "b\n" });
    const order = await testRunner(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        path.resolve(import.meta.dirname, "../../src/main.ts"),
        "order",
        "T12,T13",
      ],
      { cwd: root },
    );
    expect(order.stderr).toBe("");
    expect(order.code).toBe(0);
    const h = harness();
    h.gh.head = head;
    await mergeOnGithub(origin, wt.branch);
    h.gh.state = "MERGED";
    await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    const items = (await readMergeOrder(testRunner, root)).chains.flat();
    expect(items.find((i) => i.id === "T12")).toMatchObject({
      integrated: true,
    });
    expect(items.find((i) => i.id === "T12")?.mergeCommit).toBeTruthy();
  });

  it("メインの作業ツリーに未コミットの変更があると、main を変えずに止め、記録とカードに理由が残る", async () => {
    const { root, wt, origin, head } = await setup();
    await mergeOnGithub(origin, wt.branch);
    await writeFiles(root, { "README.md": "汚した\n" });
    const before = await git(root, "rev-parse", "main");
    const h = harness();
    h.gh.head = head;
    h.gh.state = "MERGED";
    const err: string[] = [];
    const result = await runPushWatch(context(root, h.runner, [], err), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    expect(result.code).toBe(2);
    expect(await git(root, "rev-parse", "main")).toBe(before);
    expect(existsSync(wt.path)).toBe(true);
    expect(h.orca.callsOf("worktree", "rm")).toEqual([]);
    const card = comments(h.orca).at(-1)!;
    expect(card).toContain("後始末で止まった：PR #7");
    expect(card).toContain("未コミット");
    const record = await readPushRecord(testRunner, root, "T12");
    expect(record?.watch).toMatchObject({
      status: "cleanup-stopped",
      reason: "dirty",
    });
    expect(err.join("\n")).toContain("後始末が止まりました");
  });

  it("取り込みが競合すると、main を変えずに止め、記録とカードに理由が残る", async () => {
    const { root, wt, origin, head } = await setup();
    const clone = await mergeOnGithub(origin, wt.branch);
    await writeFiles(clone, { "README.md": "origin 側\n" });
    await git(clone, "commit", "--quiet", "-am", "origin で変更");
    await git(clone, "push", "--quiet", "origin", "main");
    await writeFiles(root, { "README.md": "手元側\n" });
    await git(root, "commit", "--quiet", "-am", "手元で変更");
    const before = await git(root, "rev-parse", "main");
    const h = harness();
    h.gh.head = head;
    h.gh.state = "MERGED";
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    expect(result.code).toBe(2);
    expect(await git(root, "rev-parse", "main")).toBe(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(comments(h.orca).at(-1)).toContain("後始末で止まった：PR #7");
    const record = await readPushRecord(testRunner, root, "T12");
    expect(record?.watch).toMatchObject({
      status: "cleanup-stopped",
      reason: "conflict",
    });
  });
});

describe("待ち受け：後始末の守り", () => {
  it("タスクのブランチの先頭が PR の先頭と違うと、worktree を消さずに止め、記録とカードに理由が残る", async () => {
    const { root, wt, origin } = await setup();
    await mergeOnGithub(origin, wt.branch);
    // origin の PR の参照は取れるが、手元の先頭を含まない（手元にしかないコミットがある）
    await git(root, "push", "--quiet", "origin", "main:refs/pull/7/head");
    const h = harness();
    h.gh.state = "MERGED"; // gh.head は "abc"（push した先頭とは違う）
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    expect(result.code).toBe(2);
    expect(existsSync(wt.path)).toBe(true);
    expect(h.orca.callsOf("worktree", "rm")).toEqual([]);
    expect(
      (await readPushRecord(testRunner, root, "T12"))?.watch,
    ).toMatchObject({ status: "cleanup-stopped", reason: "head" });
    expect(comments(h.orca).at(-1)).toContain("後始末で止まった：PR #7");
  });

  it("タスクの worktree に未コミットの変更があると、消さずに止める", async () => {
    const { root, wt, origin, head } = await setup();
    await mergeOnGithub(origin, wt.branch);
    await writeFiles(wt.path, { "src/a.ts": "手で直した\n" });
    const h = harness();
    h.gh.state = "MERGED";
    h.gh.head = head;
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    expect(result.code).toBe(2);
    expect(existsSync(path.join(wt.path, "src/a.ts"))).toBe(true);
    expect(
      (await readPushRecord(testRunner, root, "T12"))?.watch,
    ).toMatchObject({ status: "cleanup-stopped", reason: "worktree" });
  });

  it("main のロックが取れない間は止めずに次の回にやり直し、外れたら後始末をする", async () => {
    const { root, wt, origin, head } = await setup();
    await mergeOnGithub(origin, wt.branch);
    const held = await tryMainLock(context(root, harness().runner), root);
    expect(held.kind).toBe("acquired");
    const h = harness();
    h.gh.state = "MERGED";
    h.gh.head = head;
    const c = clock(async (n) => {
      // 待ち受けは止まらず、記録にも止まった印はつかない
      expect(
        (await readPushRecord(testRunner, root, "T12"))?.watch,
      ).toBeUndefined();
      if (n === 2 && held.kind === "acquired") await held.release();
    });
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: c.sleep,
      intervalMs: 1,
    });
    expect(c.sleeps.length).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ code: 0, data: { merged: true } });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("待ち受けのロックが取られていれば、cleanupMergedPr は何もせず待ち受け中と返す", async () => {
    const { root, wt, origin, head } = await setup();
    await mergeOnGithub(origin, wt.branch);
    const dir = path.join(root, ".git", "orca-flow", "push");
    const lock = await acquireLock(path.join(dir, "T12.lock"), {
      waitMs: 0,
      maxAttempts: 1,
      failed: (f, d) => `${f}${d}`,
    });
    expect(lock.kind).toBe("acquired");
    const h = harness();
    const out = await cleanupMergedPr(
      context(root, h.runner),
      root,
      await requireConfig(root),
      { id: "T12", branch: wt.branch, path: wt.path },
      {
        number: 7,
        url: "u",
        isDraft: false,
        state: "merged",
        headSha: head,
        ci: "passed",
      },
      { holdingWatchLock: false },
    );
    expect(out.kind).toBe("watching");
    expect(existsSync(wt.path)).toBe(true);
    if (lock.kind === "acquired") await lock.release();
  });
});

describe("待ち受け：閉じられた PR・重複・gh", () => {
  it("PR が閉じられたら、後始末をせず終わり、「PR が閉じられた」のカードにする", async () => {
    const { root, wt } = await setup();
    const h = harness();
    h.gh.state = "CLOSED";
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    expect(result).toMatchObject({ code: 0, data: { closed: true } });
    expect(h.orca.callsOf("worktree", "rm")).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
    const card = comments(h.orca).at(-1)!;
    expect(card.startsWith("統合待ち")).toBe(false);
    expect(card.startsWith("PR が閉じられた：PR #7")).toBe(true);
    expect(card).toContain("#7");
    const record = await readPushRecord(testRunner, root, "T12");
    expect((record?.watch as { status: string }).status).toBe("closed");
  });

  it("同じタスクの待ち受けは2つ起きない（2つ目はロックで起きずに終わる）", async () => {
    const { root } = await setup();
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runPushWatch(context(root, h.runner), "T12", {
      sleep: async () => {
        await gate;
      },
      intervalMs: 1,
      maxPolls: 2,
    });
    // 1つ目がロックを取るまで待つ
    for (let i = 0; i < 200 && h.gh.views === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(h.gh.views).toBeGreaterThan(0);
    const viewsBefore = h.gh.views;
    const second = await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    expect(second.data).toMatchObject({
      watching: false,
      alreadyRunning: true,
    });
    expect(h.gh.views).toBe(viewsBefore);
    release();
    expect((await first).code).toBe(0);
    // 終わればロックは外れ、また起こせる
    const third = await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
      maxPolls: 1,
    });
    expect(third.data).not.toMatchObject({ alreadyRunning: true });
  });

  it("gh がなければ終了コード2で、トークンらしい値を出さない。記録とカードに印が残る", async () => {
    const { root } = await setup();
    const h = harness();
    h.gh.missing = true;
    const err: string[] = [];
    const ctx = context(root, h.runner, [], err);
    ctx.env = { GH_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123" };
    const error = await runPushWatch(ctx, "T12", { sleep: clock().sleep }).then(
      () => null,
      (e: Error & { code?: number }) => e,
    );
    expect(error?.code).toBe(2);
    expect(error?.message).not.toContain("ghp_");
    expect(err.join("")).not.toContain("ghp_");
    const record = await readPushRecord(testRunner, root, "T12");
    expect(record?.watch).toMatchObject({ status: "watch-stopped" });
    expect(JSON.stringify(record)).not.toContain("ghp_");
    expect(comments(h.orca).at(-1)).toMatch(/^待ち受けが止まった：PR #7（/);
  });

  it("gh の失敗の出力にトークンがあっても、投げるエラー・記録・カードに出ない（環境変数の値も伏せる）", async () => {
    const { root } = await setup();
    const h = harness();
    const secret = "plain-secret-value-12345";
    h.gh.failStderr = `denied token=${secret} ghp_abcdefghijklmnopqrstuvwxyz0123`;
    const ctx = context(root, h.runner);
    ctx.env = { GH_TOKEN: secret };
    const result = await runPushWatch(ctx, "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    expect(result.code).toBe(1);
    const all = JSON.stringify([
      await readPushRecord(testRunner, root, "T12"),
      comments(h.orca),
    ]);
    expect(all).not.toContain(secret);
    expect(all).not.toContain("ghp_");
    expect(comments(h.orca).at(-1)).toMatch(/^待ち受けが止まった：PR #7（/);
  });

  it("見回りの途中で gh が使えなくなると、終了コード2で止まり、記録とカードに印が残る", async () => {
    const { root } = await setup();
    const h = harness();
    const c = clock((n) => {
      if (n === 1) h.gh.missing = true;
    });
    await expect(
      runPushWatch(context(root, h.runner), "T12", {
        sleep: c.sleep,
        intervalMs: 1,
      }),
    ).rejects.toMatchObject({ code: 2 });
    expect(
      (await readPushRecord(testRunner, root, "T12"))?.watch,
    ).toMatchObject({ status: "watch-stopped" });
    expect(comments(h.orca).at(-1)).toContain("待ち受けが止まった：PR #7");
    expect(comments(h.orca).at(-1)?.startsWith("統合待ち")).toBe(false);
  });

  it("タスクが見つからないときも、記録に印を残して終了コード1", async () => {
    const { root, wt } = await setup();
    await git(root, "worktree", "remove", "--force", wt.path);
    const h = harness();
    await expect(
      runPushWatch(context(root, h.runner), "T12", { sleep: clock().sleep }),
    ).rejects.toMatchObject({ code: 1 });
    expect(
      (await readPushRecord(testRunner, root, "T12"))?.watch,
    ).toMatchObject({ status: "watch-stopped" });
  });

  it("PR を閉じてすぐ push し直して記録の番号が変わったら、新しい PR を見る", async () => {
    const { root, wt } = await setup();
    const h = harness();
    const c = clock(async (n) => {
      if (n === 1)
        await writePushRecord(testRunner, root, "T12", {
          id: "T12",
          pr: { number: 8, url: "https://github.com/o/r/pull/8" },
        });
    });
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: c.sleep,
      intervalMs: 1,
      maxPolls: 3,
    });
    expect(result.code).toBe(0);
    expect(comments(h.orca)).toEqual(["CI 待ち：PR #7", "CI 待ち：PR #8"]);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("古い PR の closed を見た瞬間に記録が新しい番号に変わっていたら、終わらずに新しい PR を見る", async () => {
    const { root, wt } = await setup();
    const h = harness();
    h.gh.stateByNumber = { 7: "CLOSED", 8: "OPEN" };
    h.gh.onView = async (n) => {
      if (n === 7)
        await writePushRecord(testRunner, root, "T12", {
          id: "T12",
          pr: { number: 8, url: "https://github.com/o/r/pull/8" },
        });
    };
    const result = await runPushWatch(context(root, h.runner), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
      maxPolls: 3,
    });
    expect(result.data).not.toMatchObject({ closed: true });
    expect(comments(h.orca).some((c) => c.startsWith("統合待ち"))).toBe(false);
    expect(comments(h.orca).at(-1)).toBe("CI 待ち：PR #8");
    expect(existsSync(wt.path)).toBe(true);
  });

  it("記録がなければ終了コード1", async () => {
    const root = await makeRepo({});
    const h = harness();
    await expect(
      runPushWatch(context(root, h.runner), "T99"),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("gh の読み取りが続けて失敗すると、止めて記録に残す。トークンは伏せる", async () => {
    const { root } = await setup();
    const h = harness();
    const failing: Runner = async (cmd, args, opts) =>
      cmd === "gh" && args[0] === "pr"
        ? {
            code: 1,
            stdout: "",
            stderr: "boom ghp_abcdefghijklmnopqrstuvwxyz0123",
            timedOut: false,
          }
        : h.runner(cmd, args, opts);
    const err: string[] = [];
    const result = await runPushWatch(context(root, failing, [], err), "T12", {
      sleep: clock().sleep,
      intervalMs: 1,
    });
    expect(result.code).toBe(1);
    const record = await readPushRecord(testRunner, root, "T12");
    expect(record?.watch).toMatchObject({ status: "gh-error" });
    expect(JSON.stringify(record)).not.toContain("ghp_");
    expect(err.join("")).not.toContain("ghp_");
    expect(comments(h.orca).at(-1)).toMatch(/^待ち受けが止まった：PR #7（/);
    expect(comments(h.orca).join("")).not.toContain("ghp_");
  });
});

describe("様子の表示と起動", () => {
  it("--show は記録から今の様子と、待ち受けが動いているかを出す", async () => {
    const { root } = await setup();
    const h = harness();
    h.gh.ci = "failed";
    const out: string[] = [];
    // 待ち受けが動いている間
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sleeping = false;
    const running = runPushWatch(context(root, h.runner), "T12", {
      sleep: async () => {
        sleeping = true;
        await gate;
      },
      intervalMs: 1,
      maxPolls: 2,
    });
    // 偽物の sleep に入った合図（記録とカードを書き終えたあと）を待つ
    for (let i = 0; i < 500 && !sleeping; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(sleeping).toBe(true);
    const during = await showPushWatch(context(root, h.runner, out), "T12");
    expect(during.data).toMatchObject({
      status: "ci-failed",
      watching: true,
      pr: { number: 7 },
    });
    expect(out.join("\n")).toContain("CI が落ちた");
    release();
    await running;
    const after = await showPushWatch(context(root, h.runner), "T12");
    expect(after.data).toMatchObject({ watching: false });
  });

  it("--show は記録がなければ終了コード1", async () => {
    const root = await makeRepo({});
    await expect(
      showPushWatch(context(root, harness().runner), "T12"),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("launchPushWatch は main-check と同じ形で、切り離した子に push 〈ID〉 --watch を流させる", async () => {
    const { root } = await setup();
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "git") return testRunner(cmd, args, opts);
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await launchPushWatch(context(root, runner), "T12");
    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args[1]).toContain('"push", "T12", "--watch"');
    expect(args[1]).toContain("detached: true");
    expect(args).toContain(root);
    expect(args.some((a) => a.endsWith("main.ts"))).toBe(true);
  });

  it("起動役が失敗したら、起こし直し方つきで FlowError(1)", async () => {
    const { root } = await setup();
    const runner: Runner = async (cmd, args, opts) =>
      cmd === "git"
        ? testRunner(cmd, args, opts)
        : { code: 1, stdout: "", stderr: "だめ", timedOut: false };
    await expect(
      launchPushWatch(context(root, runner), "T12"),
    ).rejects.toMatchObject({ code: 1 });
  });
});
