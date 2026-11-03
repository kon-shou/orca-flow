import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { tryMainLock, type MainLockKind } from "../../src/lib/finish.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { currentBootAt, parseLockKind } from "../../src/lib/lock.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

// main のロックを approve と new も取る（8章 push「main のロック」）。取れなければ何も変えずに終了コード2

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "50";
  process.env[VERIFY_INTERVAL_ENV] = "10";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

const progressWith = (row: string) =>
  PROGRESS.replace(
    "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
    `| T01 | 雛形   | —    | 統合済み | main         |      |\n${row}\n`,
  );

async function setup() {
  const root = await makeRepo(
    { progress: { file: "docs/progress.md" } },
    {
      "docs/progress.md": progressWith(
        "| T12 | 買い物 | — | 設計中 | task/T12-shop | |",
      ),
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
  });
  return { root, wt };
}

const ctxOf = (root: string): CommandContext => ({
  argv: [],
  cwd: root,
  json: false,
  runner: fakeOrca().runner,
  env: {},
  stdout: () => {},
  stderr: () => {},
  now: () => new Date("2026-11-03T00:00:00Z"),
});

const lockFile = (root: string) =>
  path.join(root, ".git", "orca-flow", "main.lock");

async function hold(root: string, kind: MainLockKind | null) {
  if (kind) {
    const lock = await tryMainLock(ctxOf(root), root, kind);
    expect(lock.kind).toBe("acquired");
    return async () => {
      if (lock.kind === "acquired") await lock.release();
    };
  }
  // 種類のない古い形：自分の番号だけを書く
  await writeFiles(path.dirname(lockFile(root)), {
    "main.lock": `${process.pid} ${currentBootAt()}\n`,
  });
  const { rm } = await import("node:fs/promises");
  return () => rm(lockFile(root), { force: true });
}

const NAMES: [MainLockKind | null, string][] = [
  ["integrate", "integrate"],
  ["finish", "push の道の後始末"],
  ["approve", "approve"],
  ["new", "new"],
  [null, "別の処理"],
];

describe("approve は main のロックを取る", () => {
  it.each(NAMES)(
    "持ち主が %s のとき、終了コード2で何も変えず、相手とロックのパスを出す",
    async (kind, name) => {
      const { root, wt } = await setup();
      const release = await hold(root, kind);
      const before = await git(root, "rev-parse", "main");
      const taskBefore = await git(wt.path, "rev-parse", "HEAD");
      const progressBefore = await readFile(
        path.join(root, "docs/progress.md"),
        "utf8",
      );
      const orca = fakeOrca();
      const out = await runCli(["approve", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(out.code).toBe(2);
      expect(out.err).toContain(`${name}が main を書き換えています`);
      expect(out.err).toContain(`ロック：${lockFile(root)}`);
      expect(await git(root, "rev-parse", "main")).toBe(before);
      expect(await git(wt.path, "rev-parse", "HEAD")).toBe(taskBefore);
      expect(await readFile(path.join(root, "docs/progress.md"), "utf8")).toBe(
        progressBefore,
      );
      expect(orca.callsOf("worktree", "set")).toEqual([]);
      expect(orca.callsOf("terminal", "send")).toEqual([]);
      await release();
    },
  );

  it("ロックが外れていれば通り、終わったらロックは残らない", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      title: "claude",
      agentIdentity: "claude",
    });
    const out = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(out.code).toBe(0);
    expect(existsSync(lockFile(root))).toBe(false);
  });
});

describe("new は main のロックを取る", () => {
  const args = ["new", "--title", "かご", "--slug", "cart"];

  it.each(NAMES)(
    "持ち主が %s のとき、終了コード2で進捗表・ブランチ・worktree を変えず、相手とロックのパスを出す",
    async (kind, name) => {
      const { root } = await setup();
      const release = await hold(root, kind);
      const before = await git(root, "rev-parse", "main");
      const branches = await git(root, "branch", "--list");
      const worktrees = await git(root, "worktree", "list");
      const orca = fakeOrca();
      const out = await runCli(args, { cwd: root, runner: orca.runner });
      expect(out.code).toBe(2);
      expect(out.err).toContain(`${name}が main を書き換えています`);
      expect(out.err).toContain(`ロック：${lockFile(root)}`);
      expect(await git(root, "rev-parse", "main")).toBe(before);
      expect(await git(root, "branch", "--list")).toBe(branches);
      expect(await git(root, "worktree", "list")).toBe(worktrees);
      expect(await git(root, "status", "--porcelain")).toBe("");
      expect(orca.callsOf("worktree", "create")).toEqual([]);
      await release();
    },
  );

  it("ロックが外れていれば通り、終わったらロックは残らない", async () => {
    const { root } = await setup();
    const orca = fakeOrca();
    const out = await runCli(args, { cwd: root, runner: orca.runner });
    expect(out.err).not.toContain("main を書き換えています");
    expect(out.code).toBe(0);
    expect(existsSync(lockFile(root))).toBe(false);
  });
});

/** main を書き換える git（commit・merge）が呼ばれた瞬間のロックの3つめの語を集める Runner */
function watchLockKinds(inner: Runner, root: string) {
  const kinds: (string | null)[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "git" && (args[0] === "commit" || args[0] === "merge")) {
      try {
        const text = await readFile(lockFile(root), "utf8");
        kinds.push(parseLockKind(text));
      } catch {
        kinds.push(null);
      }
    }
    return inner(cmd, args, opts);
  };
  return { runner, kinds };
}

describe("各コマンドはロックに自分の種類を書く", () => {
  it("approve は approve と書く", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      title: "claude",
      agentIdentity: "claude",
    });
    const watch = watchLockKinds(orca.runner, root);
    const out = await runCli(["approve", "T12"], {
      cwd: root,
      runner: watch.runner,
    });
    expect(out.code).toBe(0);
    expect(watch.kinds.length).toBeGreaterThan(0);
    expect(new Set(watch.kinds)).toEqual(new Set(["approve"]));
  });

  it("new は new と書く", async () => {
    const { root } = await setup();
    const watch = watchLockKinds(fakeOrca().runner, root);
    const out = await runCli(["new", "--title", "かご", "--slug", "cart"], {
      cwd: root,
      runner: watch.runner,
    });
    expect(out.code).toBe(0);
    expect(watch.kinds.length).toBeGreaterThan(0);
    expect(new Set(watch.kinds)).toEqual(new Set(["new"]));
  });
});
