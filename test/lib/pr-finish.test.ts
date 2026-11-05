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
  CARD_RESET,
  cleanupHolderLabel,
  cleanupMergedPr,
  showPushWatch,
} from "../../src/lib/pr-finish.ts";
import type { PrInfo } from "../../src/lib/github.ts";
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
