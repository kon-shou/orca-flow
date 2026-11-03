import { existsSync } from "node:fs";
import { chmod, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireConfig } from "../../src/config.ts";
import {
  finishMergedTask,
  pushRecordFile,
  readPushRecord,
  writePushRecord,
} from "../../src/lib/finish.ts";
import { readPr } from "../../src/lib/github.ts";
import type { PrInfo } from "../../src/lib/github.ts";
import { cleanupMergedPr } from "../../src/lib/push-watch.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

async function setup() {
  const root = await makeRepo({ integrateVerify: "before-merge" });
  const wt = await addTaskWorktree(root, "T12", "shop", { "src/a.ts": "a\n" });
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
  // GitHub でマージされた状態
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
  const mergeCommit = await git(clone, "rev-parse", "HEAD");
  return { root, wt, head, mergeCommit };
}

const context = (
  root: string,
  runner: CommandContext["runner"],
  err: string[] = [],
): CommandContext => ({
  argv: [],
  cwd: root,
  json: false,
  runner,
  env: {},
  stdout: () => {},
  stderr: (t) => err.push(t),
  now: () => new Date("2026-11-03T00:00:00Z"),
});

const prOf = (head: string, extra: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  url: "u",
  isDraft: false,
  state: "merged",
  headSha: head,
  ci: "passed",
  ...extra,
});

const cleanup = async (
  s: Awaited<ReturnType<typeof setup>>,
  pr: PrInfo,
  err: string[] = [],
) =>
  cleanupMergedPr(
    context(s.root, fakeOrca().runner, err),
    s.root,
    await requireConfig(s.root),
    { id: "T12", branch: s.wt.branch, path: s.wt.path },
    pr,
    { holdingWatchLock: false },
  );

describe("後始末：マージのコミットを push の記録に足す", () => {
  it("PR のマージのコミットと時刻が足され、今のキーが残る", async () => {
    const s = await setup();
    const before = await readPushRecord(testRunner, s.root, "T12");
    const out = await cleanup(
      s,
      prOf(s.head, {
        mergeCommit: s.mergeCommit,
        mergedAt: "2026-11-02T10:00:00Z",
      }),
    );
    expect(out.kind).toBe("finished");
    const after = await readPushRecord(testRunner, s.root, "T12");
    expect(after?.mergeCommit).toBe(s.mergeCommit);
    expect(after?.mergedAt).toBe("2026-11-02T10:00:00Z");
    expect(after).toMatchObject({
      id: "T12",
      branch: before?.branch,
      pushedHead: before?.pushedHead,
      pr: before?.pr,
    });
    expect(after?.watch).toBeDefined();
  });

  it("時刻が渡らなければ書いた時刻を入れる", async () => {
    const s = await setup();
    await cleanup(s, prOf(s.head, { mergeCommit: s.mergeCommit }));
    const after = await readPushRecord(testRunner, s.root, "T12");
    expect(after?.mergedAt).toBe("2026-11-03T00:00:00.000Z");
  });

  it("2回走らせても、記録の中身は1回目と同じ", async () => {
    const s = await setup();
    const pr = prOf(s.head, {
      mergeCommit: s.mergeCommit,
      mergedAt: "2026-11-02T10:00:00Z",
    });
    await cleanup(s, pr);
    const first = await readFile(
      await pushRecordFile(testRunner, s.root, "T12"),
      "utf8",
    );
    await cleanup(s, pr);
    const second = await readFile(
      await pushRecordFile(testRunner, s.root, "T12"),
      "utf8",
    );
    const a = JSON.parse(first);
    const b = JSON.parse(second);
    expect(b.mergeCommit).toBe(a.mergeCommit);
    expect(b.mergedAt).toBe(a.mergedAt);
    expect({ ...b, watch: undefined }).toEqual({ ...a, watch: undefined });
  });

  it("同じ mergeCommit がすでにあれば、mergedAt も書き換えない", async () => {
    const s = await setup();
    const pr = prOf(s.head, { mergeCommit: s.mergeCommit });
    await cleanup(s, pr);
    const first = await readPushRecord(testRunner, s.root, "T12");
    expect(first?.mergedAt).toBe("2026-11-03T00:00:00.000Z");
    const later = {
      ...context(s.root, fakeOrca().runner),
      now: () => new Date("2026-11-05T00:00:00Z"),
    };
    await cleanupMergedPr(
      later,
      s.root,
      await requireConfig(s.root),
      { id: "T12", branch: s.wt.branch, path: s.wt.path },
      pr,
      { holdingWatchLock: false },
    );
    const second = await readPushRecord(testRunner, s.root, "T12");
    expect(second?.mergeCommit).toBe(s.mergeCommit);
    expect(second?.mergedAt).toBe(first?.mergedAt);
  });

  it("マージのコミットが取れないときは、止まらず、記録に足さない", async () => {
    const s = await setup();
    const err: string[] = [];
    const out = await cleanup(s, prOf(s.head), err);
    expect(out).toMatchObject({ kind: "finished", result: { code: 0 } });
    const after = await readPushRecord(testRunner, s.root, "T12");
    expect(after).not.toHaveProperty("mergeCommit");
    expect(after).not.toHaveProperty("mergedAt");
    expect(err).toEqual([]);
  });

  it("記録がなければ作らない", async () => {
    const s = await setup();
    const file = await pushRecordFile(testRunner, s.root, "T12");
    await rm(file);
    const err: string[] = [];
    const out = await finishMergedTask(
      context(s.root, fakeOrca().runner, err),
      await requireConfig(s.root),
      s.root,
      { id: "T12", branch: s.wt.branch, path: s.wt.path },
      { prHead: s.head, prNumber: 7, mergeCommit: s.mergeCommit },
    );
    expect(out.kind).toBe("done");
    expect(existsSync(file)).toBe(false);
    expect(err).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "記録に書けないときは、警告を1行出して後始末は続ける",
    async () => {
      const s = await setup();
      const file = await pushRecordFile(testRunner, s.root, "T12");
      const dir = path.dirname(file);
      // 記録を書き換えられないように、記録の場所を読み取り専用にする
      await chmod(dir, 0o555);
      const err: string[] = [];
      try {
        const out = await finishMergedTask(
          context(s.root, fakeOrca().runner, err),
          await requireConfig(s.root),
          s.root,
          { id: "T12", branch: s.wt.branch, path: s.wt.path },
          { prHead: s.head, prNumber: 7, mergeCommit: s.mergeCommit },
        );
        expect(out.kind).toBe("done");
      } finally {
        await chmod(dir, 0o755);
      }
      expect(
        err.filter((l) => l.includes("警告") && l.includes("マージのコミット")),
      ).toHaveLength(1);
    },
  );
});

describe("gh の PR の読み取り", () => {
  it("mergeCommit と mergedAt を読む。なければ項目を持たない", async () => {
    const view = (extra: Record<string, unknown>) => async (cmd: string) => ({
      code: 0,
      stdout: JSON.stringify({
        number: 7,
        url: "u",
        state: "MERGED",
        ...extra,
      }),
      stderr: "",
      timedOut: false,
      cmd,
    });
    const g = (extra: Record<string, unknown>) => ({
      runner: view(extra),
      cwd: ".",
    });
    const full = await readPr(
      g({ mergeCommit: { oid: "abc123" }, mergedAt: "2026-11-02T10:00:00Z" }),
      7,
    );
    expect(full.mergeCommit).toBe("abc123");
    expect(full.mergedAt).toBe("2026-11-02T10:00:00Z");
    const none = await readPr(g({ mergeCommit: null, mergedAt: null }), 7);
    expect(none.mergeCommit).toBeUndefined();
    expect(none.mergedAt).toBeUndefined();
  });

  it("PR_FIELDS に mergeCommit と mergedAt を頼む", async () => {
    const asked: string[][] = [];
    const runner = async (_c: string, args: readonly string[]) => {
      asked.push([...args]);
      return {
        code: 0,
        stdout: JSON.stringify({ number: 7, state: "OPEN" }),
        stderr: "",
        timedOut: false,
      };
    };
    await readPr({ runner, cwd: "." }, 7);
    const fields = asked[0]![asked[0]!.indexOf("--json") + 1]!;
    expect(fields).toContain("mergeCommit");
    expect(fields).toContain("mergedAt");
  });
});

describe("integrate の道", () => {
  it("integrate で統合したタスクの push の記録に mergeCommit を足さない", async () => {
    const root = await makeRepo(
      {
        integrateVerify: "before-merge",
        progress: { file: "docs/progress.md" },
        verify: ["test -f src/shop/a.ts"],
        maxActiveTasks: 2,
      },
      {
        "docs/progress.md": PROGRESS.replace(
          "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
          "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 作業中 | task/T12-shop | |\n",
        ),
      },
    );
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
    });
    await writeFiles(wt.path, {
      "src/shop/a.ts": "export const a = 1;\n",
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
    const orca = fakeOrca();
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: orca.runner })).code,
    ).toBe(0);
    const head = await git(wt.path, "rev-parse", "HEAD");
    await writePushRecord(testRunner, root, "T12", {
      id: "T12",
      branch: wt.branch,
      base: "main",
      pushedHead: head,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: null,
    });
    const r = await runCli(["integrate", "T12", "--keep-worktree"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(r.code).toBe(0);
    const after = await readPushRecord(testRunner, root, "T12");
    expect(after?.pushedHead).toBe(head);
    expect(after).not.toHaveProperty("mergeCommit");
  });
});
