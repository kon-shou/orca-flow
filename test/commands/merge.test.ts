import { existsSync } from "node:fs";
import { chmod, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { readDepends, writeDependsAt } from "../../src/lib/depends.ts";
import { readPushRecord, writePushRecord } from "../../src/lib/finish.ts";
import { acquireLock } from "../../src/lib/lock.ts";
import { writeMergeOrder } from "../../src/lib/merge-order.ts";
import { addItem, updateState } from "../../src/lib/outbox.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, tempDir } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const done = (code: number, stdout = "", stderr = "") => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

interface FakePr {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  reviewDecision: string | null;
  mergeStateStatus: string;
  isDraft: boolean;
  unresolved: number;
  /** 解決済みのスレッドの数 */
  resolved: number;
  mergeCommit: string | null;
}

/** gh だけを偽物にする。pr merge が来たら、GitHub のマージのように origin に本物のマージを作る */
async function setup(
  options: {
    allowed?: Record<string, boolean>;
    push?: boolean;
    mergeFails?: boolean;
  } = {},
) {
  const root = await makeRepo({});
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
  await git(root, "remote", "add", "origin", "https://github.com/o/r.git");
  await git(
    root,
    "config",
    `url.${origin}.insteadOf`,
    "https://github.com/o/r.git",
  );
  await git(root, "push", "--quiet", "origin", "main");
  const wt = await addTaskWorktree(root, "T12", "shop", { "src/a.ts": "a\n" });
  await git(wt.path, "push", "--quiet", "origin", wt.branch);
  const head = await git(wt.path, "rev-parse", "HEAD");
  const common = path.join(root, ".git");
  await writePushRecord(testRunner, root, "T12", {
    id: "T12",
    branch: wt.branch,
    base: "main",
    // 記録の先頭は承認した先頭としては使われない
    pushedHead: "9".repeat(40),
    pushedAt: "2026-11-04T00:00:00Z",
    pr: { number: 7, url: "https://github.com/o/r/pull/7" },
  });
  if (options.push !== false) {
    const { item } = await addItem(
      common,
      {
        taskId: "T12",
        kind: "push",
        body: "",
        head,
        target: { remote: "origin", branch: wt.branch, base: "main", pr: null },
      },
      {},
      new Date("2026-11-04T00:00:00Z"),
    );
    await updateState(common, item, "sent", new Date("2026-11-04T00:00:00Z"));
  }

  const pr: FakePr = {
    state: "OPEN",
    head,
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    unresolved: 0,
    resolved: 0,
    mergeCommit: null,
  };
  const merges: string[][] = [];
  const flips: string[] = [];
  const orca = fakeOrca();
  let mergedAt: string | null = null;
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "gh") {
      if (args[0] === "--version" || args[0] === "auth") return done(0, "ok");
      if (args[0] === "repo" && args[1] === "view")
        return done(
          0,
          JSON.stringify({
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: true,
            ...options.allowed,
          }),
        );
      if (args[0] === "api" && args[1] === "graphql") {
        const all = Array.from(
          { length: pr.unresolved + pr.resolved },
          (_, i) => ({ isResolved: i >= pr.unresolved }),
        );
        const query = args.find((a) => a.startsWith("query=")) ?? "";
        if (query.includes("before:")) {
          flips.push(query);
          const cursor = args.find((a) => a.startsWith("c_7=")) ?? "c_7=0";
          const end = Number(cursor.slice(4));
          const start = Math.max(0, end - 100);
          return done(
            0,
            JSON.stringify({
              data: {
                rateLimit: { cost: 1, remaining: 100, resetAt: "" },
                repository: {
                  pr_7: {
                    reviewThreads: {
                      pageInfo: {
                        hasPreviousPage: start > 0,
                        startCursor: String(start),
                      },
                      nodes: all.slice(start, end),
                    },
                  },
                },
              },
            }),
          );
        }
        return done(
          0,
          JSON.stringify({
            data: {
              rateLimit: { cost: 1, remaining: 100, resetAt: "" },
              repository: {
                pr_7: {
                  number: 7,
                  url: "https://github.com/o/r/pull/7",
                  state: pr.state,
                  isDraft: pr.isDraft,
                  updatedAt: "2026-11-04T00:00:00Z",
                  headRefOid: pr.head,
                  headRefName: wt.branch,
                  mergedAt,
                  mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
                  reviewDecision: pr.reviewDecision,
                  mergeStateStatus: pr.mergeStateStatus,
                  commits: { nodes: [] },
                  reviews: { nodes: [] },
                  comments: { nodes: [] },
                  reviewThreads: {
                    totalCount: all.length,
                    pageInfo: {
                      hasPreviousPage: all.length > 30,
                      startCursor: String(Math.max(0, all.length - 30)),
                    },
                    nodes: all.slice(-30).map((t, i) => ({
                      id: `t${i}`,
                      isResolved: t.isResolved,
                      comments: { nodes: [] },
                    })),
                  },
                },
              },
            },
          }),
        );
      }
      if (args[0] === "pr" && args[1] === "merge") {
        merges.push([...args]);
        if (options.mergeFails) return done(1, "", "merge conflict");
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
          `origin/${wt.branch}`,
        );
        await git(clone, "push", "--quiet", "origin", "main");
        pr.state = "MERGED";
        pr.mergeCommit = await git(clone, "rev-parse", "HEAD");
        mergedAt = "2026-11-04T00:10:00Z";
        return done(0);
      }
      if (args[0] === "pr" && args[1] === "view")
        return done(
          0,
          JSON.stringify({
            number: 7,
            url: "https://github.com/o/r/pull/7",
            isDraft: false,
            state: pr.state,
            headRefOid: pr.head,
            statusCheckRollup: [],
            ...(pr.mergeCommit ? { mergeCommit: { oid: pr.mergeCommit } } : {}),
            ...(mergedAt ? { mergedAt } : {}),
          }),
        );
      return done(0);
    }
    return orca.runner(cmd, args, opts);
  };
  const merge = (...argv: string[]) =>
    runCli(["merge", "T12", ...argv], { cwd: root, runner });
  return {
    root,
    origin,
    wt,
    head,
    common,
    pr,
    merges,
    flips,
    orca,
    runner,
    merge,
  };
}

/** origin/main に、統合のマージの件名のコミットを足す（依存先・順の前のタスクが入った印） */
async function landOnOrigin(root: string, id: string) {
  await git(
    root,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    `統括役: ${id} をマージする`,
  );
  await git(root, "push", "--quiet", "origin", "main");
}

/** origin に別の clone から、統合のコミットを push する（手元の origin/main は古いまま） */
async function landFromOtherClone(origin: string, id: string) {
  const clone = path.join(await tempDir("orca-flow-other-"), "c");
  await git(path.dirname(clone), "clone", "--quiet", origin, clone);
  await git(clone, "config", "user.name", "O");
  await git(clone, "config", "user.email", "o@example.com");
  await git(
    clone,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    `統括役: ${id} をマージする`,
  );
  await git(clone, "push", "--quiet", "origin", "main");
}

/** ディレクトリの下のファイルの相対パスと中身（再帰） */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else out[path.relative(dir, f)] = await readFile(f, "utf8");
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out;
}

/** マージのあとに差し替える Runner（マージの呼び出しのあとだけ over が効く） */
const afterMerge =
  (t: { runner: Runner; merges: string[][] }, over: Runner): Runner =>
  async (cmd, args, opts) =>
    t.merges.length > 0 ? over(cmd, args, opts) : t.runner(cmd, args, opts);

describe("orca-flow merge --head（確かめを全部通ったときだけマージする）", () => {
  it("全部通ると --match-head-commit つきで1回だけマージし、後始末をして、記録にマージのコミットが足される", async () => {
    const t = await setup();
    const result = await t.merge("--head", t.head);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(t.merges).toEqual([
      ["pr", "merge", "7", "--merge", "--match-head-commit", t.head],
    ]);
    const record = await readPushRecord(testRunner, t.root, "T12");
    expect(record?.mergeCommit).toBe(t.pr.mergeCommit);
    expect(existsSync(t.wt.path)).toBe(false);
    expect(t.orca.callsOf("worktree", "rm")).toHaveLength(1);
    await git(t.root, "merge-base", "--is-ancestor", "origin/main", "main");
  });

  it("GitHub が許す方式を merge・squash・rebase の順に選ぶ", async () => {
    const t = await setup({
      allowed: { mergeCommitAllowed: false, squashMergeAllowed: false },
    });
    await t.merge("--head", t.head);
    expect(t.merges[0]).toContain("--rebase");
  });

  it("後始末をマージのコマンドのロックで行う（見張りが持っていれば後始末せず、マージしたことを出す）", async () => {
    const t = await setup();
    const dir = path.join(t.root, ".git", "orca-flow", "push");
    const lock = await acquireLock(path.join(dir, "T12.lock"), {
      kind: "watch",
      waitMs: 0,
      maxAttempts: 1,
      failed: (f, d) => `${f}${d}`,
    });
    expect(lock.kind).toBe("acquired");
    const result = await t.merge("--head", t.head);
    expect(t.merges).toHaveLength(1);
    expect(result.out).toContain("見張りが後始末をしています");
    expect(existsSync(t.wt.path)).toBe(true);
    if (lock.kind === "acquired") await lock.release();
  });

  it("依存先が origin/main に入っていなければマージせず、ID と抜け方を出して終了コード2", async () => {
    const t = await setup();
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(t.merges).toEqual([]);
    expect(result.err).toContain("T11");
    expect(result.err).toContain("orca-flow merge T12 --drop-depend T11");
  });

  it("マージの順の前のタスクが入っていなければマージせず、order --remove を出して終了コード2", async () => {
    const t = await setup();
    await writeMergeOrder(testRunner, t.root, {
      chains: [
        [
          { id: "T10", integrated: false, mergeCommit: null },
          { id: "T12", integrated: false, mergeCommit: null },
        ],
      ],
    });
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(t.merges).toEqual([]);
    expect(result.err).toContain("T10");
    expect(result.err).toContain("orca-flow order --remove T10");
  });

  it("入っている依存先・順の前のタスクでは止まらない。--drop-depend で外した依存でも止まらない", async () => {
    const t = await setup();
    await landOnOrigin(t.root, "T11");
    await writeDependsAt(t.common, "T12", ["T11", "T05"], new Date());
    const blocked = await t.merge("--head", t.head);
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain("T05");
    expect(blocked.err).not.toContain("T11 が");
    const dropped = await t.merge("--drop-depend", "T05");
    expect(dropped.code).toBe(0);
    expect(t.merges).toEqual([]);
    expect(await readDepends(testRunner, t.root, "T12")).toEqual(["T11"]);
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(0);
    expect(t.merges).toHaveLength(1);
  });

  it.each([
    ["変更を求めるレビュー", { reviewDecision: "CHANGES_REQUESTED" }],
    ["レビューの判定が空", { reviewDecision: null }],
    ["マージできる状態でない", { mergeStateStatus: "BLOCKED" }],
    ["未解決のスレッド", { unresolved: 2 }],
    ["下書き", { isDraft: true }],
  ] as const)(
    "全員 OK でない（%s）ならマージせず終了コード1",
    async (_, patch) => {
      const t = await setup();
      Object.assign(t.pr, patch);
      const result = await t.merge("--head", t.head);
      expect(result.code).toBe(1);
      expect(t.merges).toEqual([]);
      expect(result.err).toContain("全員 OK ではありません");
    },
  );

  it("--head が PR の今の先頭と違えばマージせず、違う先頭を出して終了コード1", async () => {
    const t = await setup();
    t.pr.head = "c".repeat(40);
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(1);
    expect(t.merges).toEqual([]);
    expect(result.err).toContain("c".repeat(40));
  });

  it("--head が承認した先頭と違えば（PR の今の先頭とは同じでも）マージせず終了コード1。push の記録の先頭は使わない", async () => {
    const t = await setup();
    const other = "d".repeat(40);
    t.pr.head = other;
    const result = await t.merge("--head", other);
    expect(result.code).toBe(1);
    expect(t.merges).toEqual([]);
    expect(result.err).toContain(t.head);
  });

  it("送った push の案がなければ、マージせず /orca-flow:push の案内を出して終了コード2", async () => {
    const t = await setup({ push: false });
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(t.merges).toEqual([]);
    expect(result.err).toContain("/orca-flow:push");
  });

  it("すでにマージ済み・閉じた PR はマージせず終了コード1", async () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      const t = await setup();
      t.pr.state = state;
      const result = await t.merge("--head", t.head);
      expect(result.code).toBe(1);
      expect(t.merges).toEqual([]);
      expect(result.err).toContain(
        state === "MERGED" ? "マージ済み" : "閉じています",
      );
    }
  });

  it("統括役の場所の外（タスクの worktree）では終了コード2で、何も呼ばない", async () => {
    const t = await setup();
    const result = await runCli(["merge", "T12", "--head", t.head], {
      cwd: t.wt.path,
      runner: t.runner,
    });
    expect(result.code).toBe(2);
    expect(t.merges).toEqual([]);
  });

  it("後始末が止まったら、マージしたことと理由を出して終了コード2", async () => {
    const t = await setup();
    const failing: Runner = async (cmd, args, opts) => {
      // マージのあとの取り込みの fetch だけを落とす
      if (cmd === "git" && args[0] === "fetch" && t.merges.length > 0)
        return done(1, "", "network down");
      return t.runner(cmd, args, opts);
    };
    const result = await runCli(["merge", "T12", "--head", t.head], {
      cwd: t.root,
      runner: failing,
    });
    expect(t.merges).toHaveLength(1);
    expect(result.out).toContain("マージしました");
    expect(result.err).toContain("後始末が止まりました");
    expect(result.code).toBe(2);
  });

  it("依存先の統合が手元の main にだけあり origin/main にないときは、マージせず ID と --drop-depend を出して終了コード2（依存は origin/main で見る）", async () => {
    const t = await setup();
    await git(
      t.root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "統括役: T11 をマージする",
    );
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(t.merges).toEqual([]);
    expect(result.err).toContain("T11");
    expect(result.err).toContain("origin/main");
    expect(result.err).toContain("--drop-depend T11");
  });

  it("マージの前に origin を取ってくる。別の clone から入った依存先は、手元の origin/main が古くても通る", async () => {
    const t = await setup();
    await landFromOtherClone(t.origin, "T11");
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const result = await t.merge("--head", t.head);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(t.merges).toHaveLength(1);
  });

  it("スレッドが45件で全部解決済みなら、古いスレッドをめくって数えてマージする", async () => {
    const t = await setup();
    t.pr.resolved = 45;
    const result = await t.merge("--head", t.head);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(t.merges).toHaveLength(1);
    expect(t.flips).toHaveLength(1);
  });

  it("スレッドが45件で、いちばん古い1件だけ未解決なら、終了コード1で止まる", async () => {
    const t = await setup();
    t.pr.unresolved = 1;
    t.pr.resolved = 44;
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(1);
    expect(t.merges).toEqual([]);
    expect(result.err).toContain("未解決のスレッドが1件");
  });

  it("スレッドが331件で全部解決済みなら、数えきれないとして止まり、理由に合計が出る", async () => {
    const t = await setup();
    t.pr.resolved = 331;
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(1);
    expect(t.merges).toEqual([]);
    expect(t.flips).toHaveLength(3);
    expect(result.err).toContain("スレッドが331件あり");
    expect(result.err).toContain("数えきれません");
  });

  it("--head の確かめでは取ってきたことを前提に、--show を打ち直す案内は出さない", async () => {
    const t = await setup();
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const result = await t.merge("--head", t.head);
    expect(result.err).not.toContain("git fetch origin main");
  });

  it("依存先に PR の記録があってマージのコミットがなければ、後始末が済んでいないかもしれないと案内する", async () => {
    const t = await setup();
    await writePushRecord(testRunner, t.root, "T11", {
      id: "T11",
      branch: "task/T11",
      base: "main",
      pushedHead: "8".repeat(40),
      pushedAt: "2026-11-04T00:00:00Z",
      pr: { number: 5, url: "https://github.com/o/r/pull/5" },
    });
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(result.err).toContain("/orca-flow:push T11");
    expect(result.err).toContain("--drop-depend T11");
  });

  it("依存の記録が壊れていればマージを呼ばない", async () => {
    const t = await setup();
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const dir = path.join(t.common, "orca-flow");
    const files = (await snapshot(dir)) as Record<string, string>;
    const rel = Object.keys(files).find((f) => f.includes("depends"))!;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, rel), "{ broken");
    const result = await t.merge("--head", t.head);
    expect(result.code).not.toBe(0);
    expect(t.merges).toEqual([]);
  });

  it("gh pr merge が失敗したら後始末に進まず終了コード1で、worktree は残る", async () => {
    const t = await setup({ mergeFails: true });
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(1);
    expect(t.merges).toHaveLength(1);
    expect(existsSync(t.wt.path)).toBe(true);
    expect(t.orca.callsOf("worktree", "rm")).toEqual([]);
    expect(
      (await readPushRecord(testRunner, t.root, "T12"))?.mergeCommit,
    ).toBeUndefined();
  });

  it("マージのあと Orca が落ちて後始末が止まっても、マージしたことを出し、終了コード2で、data に merged: true がある", async () => {
    const t = await setup();
    const runner = afterMerge(t, async (cmd, args, opts) => {
      if (cmd === "orca") throw new Error("orca down");
      return t.runner(cmd, args, opts);
    });
    const result = await runCli(["merge", "T12", "--head", t.head, "--json"], {
      cwd: t.root,
      runner,
    });
    expect(result.code).toBe(2);
    expect(t.merges).toHaveLength(1);
    expect(result.err).toContain("マージ");
    expect(result.err).toContain("後始末が止まりました");
    expect(JSON.stringify(result)).toContain("merged");
    expect(existsSync(t.wt.path)).toBe(true);
  });

  it("後始末の呼び出し自体が投げても（ロックを書けない）、終了コード2でマージしたことを出す", async () => {
    const t = await setup();
    const dir = path.join(t.common, "orca-flow", "push");
    const inner = t.runner;
    const wrapped: Runner = async (cmd, args, opts) => {
      const r = await inner(cmd, args, opts);
      if (cmd === "gh" && args[0] === "pr" && args[1] === "merge") {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(dir, { recursive: true });
        await chmod(dir, 0o500);
      }
      return r;
    };
    const result = await runCli(["merge", "T12", "--head", t.head], {
      cwd: t.root,
      runner: wrapped,
    });
    await chmod(dir, 0o700);
    expect(t.merges).toHaveLength(1);
    expect(result.code).toBe(2);
    expect(result.err).toContain("マージしました");
    expect(result.err).toContain("後始末が止まりました");
  });

  it("マージのあと PR を読めないなら、終了コード2でマージしたことを出す（マージの呼び出しは1回）", async () => {
    const t = await setup();
    const runner = afterMerge(t, async (cmd, args, opts) =>
      cmd === "gh" && args[0] === "pr" && args[1] === "view"
        ? done(1, "", "boom")
        : t.runner(cmd, args, opts),
    );
    const result = await runCli(["merge", "T12", "--head", t.head], {
      cwd: t.root,
      runner,
    });
    expect(result.code).toBe(2);
    expect(t.merges).toHaveLength(1);
    expect(result.err).toContain("マージしました");
    expect(result.err).toContain("読めませんでした");
    expect(existsSync(t.wt.path)).toBe(true);
  });

  it("マージのあとも GitHub がまだ merged を返さないなら、終了コード2で頼んだことを出す", async () => {
    const t = await setup();
    const runner = afterMerge(t, async (cmd, args, opts) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        const r = await t.runner(cmd, args, opts);
        return done(
          0,
          JSON.stringify({ ...JSON.parse(r.stdout), state: "OPEN" }),
        );
      }
      return t.runner(cmd, args, opts);
    });
    const result = await runCli(["merge", "T12", "--head", t.head], {
      cwd: t.root,
      runner,
    });
    expect(result.code).toBe(2);
    expect(t.merges).toHaveLength(1);
    expect(result.err).toContain("まだマージ済みになっていません");
    expect(existsSync(t.wt.path)).toBe(true);
  });

  it("マージのあと main が別の処理に使われていれば、終了コード2でマージしたことと頼むことを出す", async () => {
    const t = await setup();
    const inner = t.runner;
    let lock: Awaited<ReturnType<typeof acquireLock>> | null = null;
    const wrapped: Runner = async (cmd, args, opts) => {
      const r = await inner(cmd, args, opts);
      if (cmd === "gh" && args[0] === "pr" && args[1] === "merge")
        lock = await acquireLock(
          path.join(t.common, "orca-flow", "main.lock"),
          {
            kind: "integrate",
            waitMs: 0,
            maxAttempts: 1,
            failed: (f, d) => `${f}${d}`,
          },
        );
      return r;
    };
    const result = await runCli(["merge", "T12", "--head", t.head], {
      cwd: t.root,
      runner: wrapped,
    });
    if (lock && (lock as { kind: string }).kind === "acquired")
      await (lock as { release: () => Promise<void> }).release();
    expect(result.code).toBe(2);
    expect(t.merges).toHaveLength(1);
    expect(result.err).toContain("マージしました");
    expect(result.err).toContain("/orca-flow:push");
    expect(existsSync(t.wt.path)).toBe(true);
  });

  it("引数の誤りは終了コード1（モードは1つだけ）", async () => {
    const t = await setup();
    expect((await t.merge()).code).toBe(1);
    expect((await t.merge("--show", "--head", t.head)).code).toBe(1);
    expect((await t.merge("--head", "zzz")).code).toBe(1);
    expect(t.merges).toEqual([]);
  });
});

describe("orca-flow merge --show（読むだけ）", () => {
  it("確かめの結果・PR の今の先頭・承認した先頭・方式を出し、マージも記録もしない。統括役の場所の外でも流せる", async () => {
    const t = await setup();
    const before = await readPushRecord(testRunner, t.root, "T12");
    const result = await runCli(["merge", "T12", "--show"], {
      cwd: t.wt.path,
      runner: t.runner,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`PR の今の先頭：${t.head}`);
    expect(result.out).toContain(`承認した先頭：${t.head}`);
    expect(result.out).toContain("マージの方式：merge");
    expect(result.out).toContain(`orca-flow merge T12 --head ${t.head}`);
    expect(t.merges).toEqual([]);
    expect(await readPushRecord(testRunner, t.root, "T12")).toEqual(before);
  });

  it("外れた確かめは理由つきで出し、通ったとは言わない（終了コードは0）", async () => {
    const t = await setup();
    t.pr.reviewDecision = "CHANGES_REQUESTED";
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const result = await t.merge("--show");
    expect(result.code).toBe(0);
    expect(result.out).toContain("T11");
    expect(result.out).toContain("全員 OK ではありません");
    expect(result.out).not.toContain("通りました");
    expect(t.merges).toEqual([]);
  });
  it("--show は記録を書かず、orca も git fetch も呼ばない。流す前と後で orca-flow の下のファイルが同じ", async () => {
    const t = await setup();
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const dir = path.join(t.common, "orca-flow");
    const before = await snapshot(dir);
    const fetches: string[][] = [];
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "fetch") fetches.push([...args]);
      return t.runner(cmd, args, opts);
    };
    const callsBefore = t.orca.calls.length;
    const result = await runCli(["merge", "T12", "--show"], {
      cwd: t.root,
      runner,
    });
    expect(result.code).toBe(0);
    expect(await snapshot(dir)).toEqual(before);
    expect(t.orca.calls.length).toBe(callsBefore);
    expect(fetches).toEqual([]);
  });

  it("--show で依存が外れたら、origin を取ってきていないことと git fetch のあと打ち直す案内を出す", async () => {
    const t = await setup();
    await writeDependsAt(t.common, "T12", ["T11"], new Date());
    const result = await t.merge("--show");
    expect(result.out).toContain("git fetch origin main");
    expect(result.out).toContain("--show を打ち直");
  });

  it("--show でも PR の今の先頭が承認した先頭と違えば「先頭」の行が外れになり、通ったとは言わない", async () => {
    const t = await setup();
    t.pr.head = "c".repeat(40);
    const result = await t.merge("--show");
    expect(result.out).toContain("先頭：外れ");
    expect(result.out).toContain("承認した先頭");
    expect(result.out).not.toContain("通りました");
  });

  it("--show で先頭が同じなら「先頭：OK」", async () => {
    const t = await setup();
    const result = await t.merge("--show");
    expect(result.out).toContain("先頭：OK");
    expect(result.out).toContain("通りました");
  });
});

describe("orca-flow merge --drop-depend", () => {
  it("記録から外すだけでマージしない。統括役の場所の外では終了コード2", async () => {
    const t = await setup();
    await writeDependsAt(t.common, "T12", ["T11", "T05"], new Date());
    const outside = await runCli(["merge", "T12", "--drop-depend", "T05"], {
      cwd: t.wt.path,
      runner: t.runner,
    });
    expect(outside.code).toBe(2);
    expect(await readDepends(testRunner, t.root, "T12")).toEqual([
      "T11",
      "T05",
    ]);
    const result = await t.merge("--drop-depend", "T05");
    expect(result.code).toBe(0);
    expect(await readDepends(testRunner, t.root, "T12")).toEqual(["T11"]);
    expect(t.merges).toEqual([]);
  });
});
