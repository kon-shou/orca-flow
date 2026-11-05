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
import { withOutboxLock, writeLastWrite } from "../../src/lib/outbox.ts";
import {
  CARD_RESET,
  cleanupHolderLabel,
  cleanupMergedPr,
  releaseApprovedDraft,
  showPushWatch,
  type ReleaseOutcome,
} from "../../src/lib/pr-finish.ts";
import type { GhContext, PrInfo } from "../../src/lib/github.ts";
import type { CommandContext } from "../../src/types.ts";
import { readMergeOrder } from "../../src/lib/merge-order.ts";
import {
  addItem,
  readItems,
  updateState,
  type OutboxItem,
} from "../../src/lib/outbox.ts";
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
  /** gh pr ready を失敗させる */
  readyFails: boolean;
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
    readyFails: false,
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
      if (args[0] === "pr" && args[1] === "list") {
        return ok(
          JSON.stringify([
            {
              number: 7,
              url: "https://github.com/o/r/pull/7",
              isDraft: gh.isDraft,
              state: "OPEN",
              headRefOid: gh.head,
              statusCheckRollup: rollup(gh.ci),
              isCrossRepository: false,
            },
          ]),
        );
      }
      if (args[0] === "pr" && args[1] === "ready") {
        if (gh.readyFails)
          return { code: 1, stdout: "", stderr: "boom", timedOut: false };
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

/**
 * 人が send で承認した「承認済み・CI 待ち」の pr-ready の案を置く（送る前の確認で承認した先頭は、タスクの今の先頭）。
 * head を渡すと、承認した先頭をそれに変える
 */
async function approveReady(
  root: string,
  wt: { path: string; branch: string },
  options: { head?: string; pr?: number | null } = {},
): Promise<OutboxItem> {
  const common = path.join(root, ".git");
  const current = await git(wt.path, "rev-parse", "HEAD");
  const { item } = await addItem(
    common,
    {
      taskId: "T12",
      kind: "pr-ready",
      body: "",
      head: current,
      target: {
        remote: "origin",
        branch: wt.branch,
        base: "main",
        pr: options.pr === undefined ? 7 : options.pr,
      },
      afterCi: true,
    },
    {},
    new Date("2026-11-03T00:00:00Z"),
  );
  return updateState(
    common,
    item,
    "ci-wait",
    new Date("2026-11-03T00:00:00Z"),
    {
      approvedHead: options.head ?? current,
      approvedFingerprint: item.fingerprint,
    },
  );
}

const readyItem = async (root: string) =>
  (await readItems(path.join(root, ".git"), "T12")).find(
    (i) => i.kind === "pr-ready",
  );

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

const comments = (orca: ReturnType<typeof fakeOrca>) =>
  orca
    .callsOf("worktree", "set")
    .map((c) => c[c.indexOf("--comment") + 1] ?? "");

const noSleep = { now: () => Date.now(), sleep: async () => {} };

/** 見張りが CI の通った PR で呼ぶ形（下書きを外す） */
async function release(
  root: string,
  wt: { path: string; branch: string },
  h: ReturnType<typeof harness>,
  options: {
    err?: string[];
    headSha?: string | null;
    number?: number;
    ci?: "passed" | "pending" | "failed";
  } = {},
): Promise<ReleaseOutcome> {
  h.gh.ci = options.ci ?? "passed";
  const g: GhContext = { runner: h.runner, cwd: root, env: {} };
  return releaseApprovedDraft(
    context(root, h.runner, [], options.err ?? []),
    root,
    await requireConfig(root),
    { id: "T12", branch: wt.branch, path: wt.path },
    g,
    {
      number: options.number ?? 7,
      headSha: options.headSha === undefined ? h.gh.head : options.headSha,
    },
    noSleep,
  );
}

const mergedPr = (head: string): PrInfo => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  isDraft: false,
  state: "merged",
  headSha: head,
  ci: "passed",
});

/** マージ済みの PR の後始末（見張りと同じ。古い待ち受けのロックは持たない） */
async function cleanup(
  root: string,
  wt: { path: string; branch: string },
  h: ReturnType<typeof harness>,
  pr: PrInfo,
  err: string[] = [],
) {
  return cleanupMergedPr(
    context(root, h.runner, [], err),
    root,
    await requireConfig(root),
    { id: "T12", branch: wt.branch, path: wt.path },
    pr,
    { holdingWatchLock: false },
  );
}

const finished = (out: Awaited<ReturnType<typeof cleanup>>) => {
  if (out.kind !== "finished") throw new Error(`finished でなく ${out.kind}`);
  return out.result;
};

describe("下書きの解除（releaseApprovedDraft）", () => {
  it("承認済み・CI 待ちの案を送って下書きを外し、案は「送った」になる", async () => {
    const { root, wt, head } = await setup({ prReady: "after-ci" });
    const approved = await approveReady(root, wt);
    const h = harness();
    h.gh.head = head;
    const out = await release(root, wt, h);
    expect(out).toEqual({ kind: "sent", itemId: approved.id });
    expect(h.gh.ready).toEqual([["pr", "ready", "7"]]);
    expect((await readyItem(root))?.state).toBe("sent");
  });

  it("承認済み・CI 待ちの案がなければ外さず、積み方の案内を返す", async () => {
    const { root, wt } = await setup({ prReady: "after-ci" });
    const h = harness();
    const out = await release(root, wt, h);
    expect(out.kind).toBe("no-item");
    expect(h.gh.ready).toEqual([]);
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain("承認済み・CI 待ちの pr-ready の案がありません");
    expect(reason).toContain(
      "orca-flow outbox add T12 pr-ready --after-ci で積み、/orca-flow:send で承認すると外します",
    );
  });

  it("承認した先頭と今の先頭が違えば送らず、案を積んだ状態に戻し、カードを「送る前の確認待ち」にする", async () => {
    const { root, wt, head } = await setup({ prReady: "after-ci" });
    const approved = await approveReady(root, wt, { head: "1".repeat(40) });
    const h = harness();
    h.gh.head = head;
    const out = await release(root, wt, h);
    expect(out).toMatchObject({ kind: "returned", itemId: approved.id });
    expect((out as { reason: string }).reason).toContain(
      "先頭が承認したときと違います",
    );
    expect(h.gh.ready).toEqual([]);
    const item = await readyItem(root);
    expect(item).toMatchObject({
      state: "queued",
      approvedHead: null,
      approvedFingerprint: null,
    });
    const card = h.orca.callsOf("worktree", "set").at(-1)!;
    expect(card[card.indexOf("--comment") + 1]).toBe(
      `送る前の確認待ち：${approved.id}`,
    );
    expect(card).toContain("--unread");
  });

  it("手元の先頭が承認のあとで進んでいても、時間帯の外でも、先頭の違いが先に見つかって戻す", async () => {
    const { root, wt } = await setup({
      prReady: "after-ci",
      outbound: { window: { days: [], from: "09:00", to: "09:00" } },
    });
    await approveReady(root, wt);
    await writeFiles(wt.path, { "src/b.ts": "b\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "進める");
    const h = harness();
    const out = await release(root, wt, h);
    expect(out.kind).toBe("returned");
    expect((await readyItem(root))?.state).toBe("queued");
  });

  it("GitHub 上の PR の先頭が承認した先頭と違えば（手元は同じでも）外さず、案を積んだ状態に戻し、カードを「送る前の確認待ち」にする", async () => {
    const { root, wt } = await setup({ prReady: "after-ci" });
    const approved = await approveReady(root, wt);
    const h = harness();
    h.gh.head = "f".repeat(40);
    const out = await release(root, wt, h);
    expect(out).toMatchObject({ kind: "returned", itemId: approved.id });
    expect((out as { reason: string }).reason).toContain(
      "GitHub 上の PR の先頭",
    );
    expect(h.gh.ready).toEqual([]);
    expect(await readyItem(root)).toMatchObject({
      state: "queued",
      approvedHead: null,
      approvedFingerprint: null,
    });
    const card = h.orca.callsOf("worktree", "set").at(-1)!;
    expect(card[card.indexOf("--comment") + 1]).toBe(
      `送る前の確認待ち：${approved.id}`,
    );
  });

  it("渡された先頭は承認と同じでも、送る直前の GitHub の今の先頭が違えば外さず、送る前の確認に戻す", async () => {
    const { root, wt, head } = await setup({ prReady: "after-ci" });
    const approved = await approveReady(root, wt);
    const h = harness();
    h.gh.head = "e".repeat(40); // 回から背景までのあいだに GitHub の先頭が変わった
    const out = await release(root, wt, h, { headSha: head });
    expect(out).toMatchObject({ kind: "returned", itemId: approved.id });
    expect(h.gh.ready).toEqual([]);
    expect((await readyItem(root))?.state).toBe("queued");
    expect(h.orca.callsOf("worktree", "set")).not.toEqual([]);
  });

  it("送る直前に CI がまだ・落ちていれば外さず、案は承認済み・CI 待ちのまま残す", async () => {
    for (const ci of ["pending", "failed"] as const) {
      const { root, wt, head } = await setup({ prReady: "after-ci" });
      await approveReady(root, wt);
      const h = harness();
      h.gh.head = head;
      const out = await release(root, wt, h, { ci });
      expect(out.kind).toBe("ci-not-passed");
      // 送る直前に見た CI の値を返す（背景が止めた印に書く）
      expect(out).toMatchObject({ ci });
      expect(h.gh.ready).toEqual([]);
      expect((await readyItem(root))?.state).toBe("ci-wait");
    }
  });

  it("gh pr ready が落ちるときは外さず、下書きのまま。案は「送った」にならない", async () => {
    const { root, wt, head } = await setup({ prReady: "after-ci" });
    await approveReady(root, wt);
    const h = harness();
    h.gh.head = head;
    h.gh.readyFails = true;
    const out = await release(root, wt, h);
    expect(out.kind).toBe("failed");
    expect(h.gh.ready).toEqual([]);
    expect(h.gh.isDraft).toBe(true);
    expect((await readyItem(root))?.state).not.toBe("sent");
  });

  it("送る時間帯の外なら送らず、案は承認済み・CI 待ちのまま残す", async () => {
    const { root, wt, head } = await setup({
      prReady: "after-ci",
      outbound: { window: { days: [], from: "09:00", to: "09:00" } },
    });
    await approveReady(root, wt);
    const h = harness();
    h.gh.head = head;
    const out = await release(root, wt, h);
    expect(out.kind).toBe("outside-window");
    expect(h.gh.ready).toEqual([]);
    expect((await readyItem(root))?.state).toBe("ci-wait");
    expect(h.orca.callsOf("worktree", "set")).toEqual([]);
  });

  it("間隔を待つ間に時間帯の終わりを越えたら、入口と同じく outside-window を返し、案は変えない", async () => {
    const { root, wt, head } = await setup({
      prReady: "after-ci",
      outbound: {
        window: { days: [0, 1, 2, 3, 4, 5, 6], from: "09:00", to: "20:00" },
        interval: { seconds: 60, perBatch: 5 },
      },
    });
    await approveReady(root, wt);
    const common = path.join(root, ".git");
    // 入口は 19:59:59（時間帯の中）。前の書き込みは今で、間隔 60 秒を待つあいだに 20:00 を越える
    let t = new Date(2026, 10, 3, 19, 59, 59).getTime();
    await writeLastWrite(common, t);
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
    const h = harness();
    h.gh.head = head;
    h.gh.ci = "passed";
    const ctx = {
      ...context(root, h.runner),
      now: () => new Date(2026, 10, 3, 19, 59, 59),
    };
    const g: GhContext = { runner: h.runner, cwd: root, env: {} };
    const out = await releaseApprovedDraft(
      ctx,
      root,
      await requireConfig(root),
      { id: "T12", branch: wt.branch, path: wt.path },
      g,
      { number: 7, headSha: head },
      clock,
    );
    expect(out.kind).toBe("outside-window");
    expect(h.gh.ready).toEqual([]);
    expect((await readyItem(root))?.state).toBe("ci-wait");
    expect(h.orca.callsOf("worktree", "set")).toEqual([]);
  });

  it("許可リストにない pr-ready は送らない", async () => {
    const { root, wt, head } = await setup({
      prReady: "after-ci",
      outbound: { allow: ["push", "pr-create"] },
    });
    await approveReady(root, wt);
    const h = harness();
    h.gh.head = head;
    const out = await release(root, wt, h);
    expect(out.kind).toBe("refused");
    expect(h.gh.ready).toEqual([]);
    expect((await readyItem(root))?.state).toBe("ci-wait");
  });

  it("取り下げた案は外さない。外した案は「送った」になり、2回は外さない", async () => {
    const { root, wt, head } = await setup({ prReady: "after-ci" });
    const approved = await approveReady(root, wt);
    const common = path.join(root, ".git");
    await updateState(common, approved, "withdrawn", new Date());
    const h = harness();
    h.gh.head = head;
    expect((await release(root, wt, h)).kind).toBe("no-item");
    expect(h.gh.ready).toEqual([]);

    const again = await approveReady(root, wt);
    expect((await release(root, wt, h)).kind).toBe("sent");
    expect(h.gh.ready).toEqual([["pr", "ready", "7"]]);
    const item = (await readItems(common, "T12")).find(
      (i) => i.id === again.id,
    );
    expect(item?.state).toBe("sent");
    // GitHub 側で下書きに戻っても、同じ案では2回は外さない
    expect((await release(root, wt, h)).kind).toBe("no-item");
    expect(h.gh.ready).toHaveLength(1);
  });

  it("案の PR の番号が見ている PR と違えば外さない", async () => {
    const { root, wt, head } = await setup({ prReady: "after-ci" });
    await approveReady(root, wt, { pr: 8 });
    const h = harness();
    h.gh.head = head;
    const out = await release(root, wt, h);
    expect(out.kind).toBe("refused");
    expect((out as { reason: string }).reason).toContain("#8");
    expect(h.gh.ready).toEqual([]);
  });

  it("送りのロックを別の send が持っていれば busy を返し、案は承認済み・CI 待ちのまま残す", async () => {
    const { root, wt, head } = await setup({ prReady: "after-ci" });
    await approveReady(root, wt);
    const common = path.join(root, ".git");
    // 別の send がロックを持っている間は送らず busy
    const h = harness();
    h.gh.head = head;
    const out = await withOutboxLock(common, () => release(root, wt, h));
    expect(out.kind).toBe("busy");
    expect(h.gh.ready).toEqual([]);
    expect((await readyItem(root))?.state).toBe("ci-wait");
  });
});

describe("マージ済みの PR の後始末（cleanupMergedPr）", () => {
  it("マージを見つけると後始末をして、カードを統合済みにし、worktree を消す", async () => {
    const { root, wt, origin, head } = await setup();
    const h = harness();
    await mergeOnGithub(origin, wt.branch);
    const result = finished(await cleanup(root, wt, h, mergedPr(head)));
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
    await mergeOnGithub(origin, wt.branch);
    await cleanup(root, wt, h, mergedPr(head));
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
    const err: string[] = [];
    const result = finished(await cleanup(root, wt, h, mergedPr(head), err));
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
    const result = finished(await cleanup(root, wt, h, mergedPr(head)));
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

  it("タスクのブランチの先頭が PR の先頭と違うと、worktree を消さずに止め、記録とカードに理由が残る", async () => {
    const { root, wt, origin } = await setup();
    await mergeOnGithub(origin, wt.branch);
    // origin の PR の参照は取れるが、手元の先頭を含まない（手元にしかないコミットがある）
    await git(root, "push", "--quiet", "origin", "main:refs/pull/7/head");
    const h = harness();
    // PR の先頭は "abc"（push した先頭とは違う）
    const result = finished(await cleanup(root, wt, h, mergedPr("abc")));
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
    const result = finished(await cleanup(root, wt, h, mergedPr(head)));
    expect(result.code).toBe(2);
    expect(existsSync(path.join(wt.path, "src/a.ts"))).toBe(true);
    expect(
      (await readPushRecord(testRunner, root, "T12"))?.watch,
    ).toMatchObject({ status: "cleanup-stopped", reason: "worktree" });
  });

  it("main のロックが取れない間は止めず busy を返し、外れたら後始末をする", async () => {
    const { root, wt, origin, head } = await setup();
    await mergeOnGithub(origin, wt.branch);
    const held = await tryMainLock(context(root, harness().runner), root);
    expect(held.kind).toBe("acquired");
    const h = harness();
    const first = await cleanup(root, wt, h, mergedPr(head));
    expect(first.kind).toBe("busy");
    // 記録にも止まった印はつかない
    expect(
      (await readPushRecord(testRunner, root, "T12"))?.watch,
    ).toBeUndefined();
    if (held.kind === "acquired") await held.release();
    const second = finished(await cleanup(root, wt, h, mergedPr(head)));
    expect(second).toMatchObject({ code: 0, data: { merged: true } });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("古いタスクごとの待ち受けのロックが取られていれば、何もせず待ち受け中と返す", async () => {
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
    const out = await cleanup(root, wt, h, mergedPr(head));
    expect(out.kind).toBe("watching");
    expect(existsSync(wt.path)).toBe(true);
    if (lock.kind === "acquired") await lock.release();
  });

  it("ロックの種類 merge で後始末でき、持ち主の言い方は「マージのコマンドが後始末をしています」", async () => {
    expect(cleanupHolderLabel("merge")).toBe(
      "マージのコマンドが後始末をしています",
    );
    const { root, wt, origin, head } = await setup();
    await mergeOnGithub(origin, wt.branch);
    // merge が持っている間は、見張りの後始末は待ち受け中（持ち主は merge）と返して何もしない
    const dir = path.join(root, ".git", "orca-flow", "push");
    const lock = await acquireLock(path.join(dir, "T12.lock"), {
      kind: "merge",
      waitMs: 0,
      maxAttempts: 1,
      failed: (f, d) => `${f}${d}`,
    });
    expect(lock.kind).toBe("acquired");
    const h = harness();
    const blocked = await cleanup(root, wt, h, mergedPr(head));
    expect(blocked).toMatchObject({ kind: "watching", holderKind: "merge" });
    expect(existsSync(wt.path)).toBe(true);
    if (lock.kind === "acquired") await lock.release();
    // merge 自身が lockKind: merge で後始末を通せる
    const out = await cleanupMergedPr(
      context(root, h.runner, [], []),
      root,
      await requireConfig(root),
      { id: "T12", branch: wt.branch, path: wt.path },
      mergedPr(head),
      { holdingWatchLock: false, lockKind: "merge" },
    );
    expect(out).toMatchObject({
      kind: "finished",
      result: { code: 0, data: { merged: true } },
    });
  });

  it("後始末は mergeCommit・mergedAt を渡し、push の記録に残る", async () => {
    const { root, wt, origin, head } = await setup();
    await mergeOnGithub(origin, wt.branch);
    const h = harness();
    const first = finished(
      await cleanup(root, wt, h, {
        ...mergedPr(head),
        mergeCommit: "c".repeat(40),
        mergedAt: "2026-11-02T10:00:00Z",
      }),
    );
    expect(first.code).toBe(0);
    const record = await readPushRecord(testRunner, root, "T12");
    expect(record).toMatchObject({
      mergeCommit: "c".repeat(40),
      mergedAt: "2026-11-02T10:00:00Z",
    });
  });
});

describe("push の記録の watch キー（WatchState・STATUS_LABEL）と --show", () => {
  it("書いた様子を --show が読む。CARD_RESET は send が置く印の名前", async () => {
    const { root } = await setup();
    await writePushRecord(testRunner, root, "T12", {
      id: "T12",
      watch: {
        status: "ci-failed",
        detail: null,
        reason: CARD_RESET,
        ci: "failed",
        draft: true,
        updatedAt: "2026-11-03T00:00:00Z",
      },
    });
    const out: string[] = [];
    const shown = await showPushWatch(
      context(root, harness().runner, out),
      "T12",
    );
    expect(shown.data).toMatchObject({
      status: "ci-failed",
      pr: { number: 7 },
    });
    expect(out.join("\n")).toContain("CI が落ちた");
  });

  it("--show は見張りがまだ見ていなければ、そう出す", async () => {
    const { root } = await setup();
    const shown = await showPushWatch(context(root, harness().runner), "T12");
    expect(shown.data).toMatchObject({
      status: null,
      label: "まだ見ていません",
    });
  });

  it("--show は記録がなければ終了コード1", async () => {
    const root = await makeRepo({});
    await expect(
      showPushWatch(context(root, harness().runner), "T12"),
    ).rejects.toMatchObject({ code: 1 });
  });
});
