import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import {
  ORCA_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
} from "../../src/commands/context.ts";
import type { RunResult } from "../../src/lib/exec.ts";
import { currentBootAt } from "../../src/lib/lock.ts";
import {
  capture,
  fakeOrcaRunner,
  git,
  makeRepo,
  ok,
  tempDir,
  writeFiles,
} from "../init/helpers.ts";

const CONFIG = { ".orca-flow/config.json": "{}\n" };

/** 設定つきのリポジトリと、task/T12-x とほかの worktree */
function setup() {
  const root = makeRepo(CONFIG);
  const parent = tempDir("orca-flow-p3-wt-");
  const task = path.join(parent, "T12");
  const other = path.join(parent, "other");
  const done = path.join(parent, "T10");
  git(root, "worktree", "add", "-q", "-b", "task/T12-x", task);
  git(root, "worktree", "add", "-q", "-b", "feature/y", other);
  // 統合済み（--no-ff でマージ済み）のタスクは作業中に数えない
  git(root, "worktree", "add", "-q", "-b", "task/T10-old", done);
  writeFiles(done, { "docs/tasks/T10.md": "# T10\n" });
  git(done, "add", "-A");
  git(done, "commit", "-q", "-m", "T10: 設計書を書く");
  git(
    root,
    "merge",
    "-q",
    "--no-ff",
    "task/T10-old",
    "-m",
    "統括役: T10 をマージする",
  );
  return { root, task, other, done };
}

/** WSL の中の形（platform が linux で WSL_DISTRO_NAME がある）にして、fn のあと必ず元に戻す */
async function inWsl<T>(fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
  const had = Object.hasOwn(process.env, "WSL_DISTRO_NAME");
  const prev = process.env.WSL_DISTRO_NAME;
  Object.defineProperty(process, "platform", { ...desc, value: "linux" });
  process.env.WSL_DISTRO_NAME = "Ubuntu";
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
    if (had) process.env.WSL_DISTRO_NAME = prev;
    else delete process.env.WSL_DISTRO_NAME;
  }
}

/** Linux のパスを今のディストリビューションの UNC の形にする */
const toUnc = (p: string) =>
  `\\\\wsl.localhost\\Ubuntu${p.replaceAll("/", "\\")}`;

const never = () => new Promise<RunResult>(() => {});

async function context(cwd: string, runner: ReturnType<typeof fakeOrcaRunner>) {
  const io = capture();
  const code = await main(["context"], { ...io, cwd, runner: runner.runner });
  return { code, io };
}

describe("context", () => {
  it("git の外では何も出さず0", async () => {
    const r = fakeOrcaRunner(() => ok({}));
    const { code, io } = await context(tempDir(), r);
    expect(code).toBe(0);
    expect(io.text()).toBe("");
  });

  it("config がなければ何も出さず0", async () => {
    const r = fakeOrcaRunner(() => ok({}));
    const { code, io } = await context(makeRepo(), r);
    expect(code).toBe(0);
    expect(io.text()).toBe("");
    expect(r.calls.filter((c) => c.cmd === "orca")).toEqual([]);
  });

  it("タスクでない worktree では何も出さない", async () => {
    const { other } = setup();
    const r = fakeOrcaRunner(() => ok({}));
    const { code, io } = await context(other, r);
    expect(code).toBe(0);
    expect(io.text()).toBe("");
  });

  it("メインのチェックアウトでは統括役の文と作業中のタスク", async () => {
    const { root, task } = setup();
    const r = fakeOrcaRunner(() =>
      ok({
        worktrees: [
          { path: root, comment: "", workspaceStatus: "in-progress" },
          { path: task, comment: "設計書のレビュー待ち" },
        ],
      }),
    );
    const { code, io } = await context(root, r);
    expect(code).toBe(0);
    const text = io.text();
    expect(text).toContain("あなたは統括役");
    expect(text).toContain("/orca-flow:new");
    expect(text).toContain("package.json");
    expect(text).toContain("T12（設計書のレビュー待ち）");
    expect(text).not.toContain("T10");
    const orca = r.calls.filter((c) => c.cmd === "orca");
    expect(orca).toHaveLength(1);
    expect(orca[0]?.opts?.timeoutMs).toBe(1000);
  });

  it("ほかのタスクが取り込んだ main のコミットを先頭に持つ新しいタスクは、統合済みに数えず作業中に出す", async () => {
    const { root, task } = setup();
    const parent = tempDir("orca-flow-p996-wt-");
    const t11 = path.join(parent, "T11");
    const t13 = path.join(parent, "T13");
    git(root, "worktree", "add", "-q", "-b", "task/T11-a", t11);
    writeFiles(t11, { "a.txt": "a\n" });
    git(t11, "add", "-A");
    git(t11, "commit", "-q", "-m", "T11: a");
    // main が進み、T11 がそれを merge で取り込む（取り込んだ main のコミットが、マージの2つ目の親になる）
    writeFiles(root, { "m.txt": "m\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main を進める");
    git(t11, "merge", "-q", "main", "-m", "T11: main を取り込む");
    git(
      root,
      "merge",
      "-q",
      "--no-ff",
      "task/T11-a",
      "-m",
      "統括役: T11 をマージする",
    );
    // コミットのない新しいタスクは、取り込まれた main のコミットを先頭に持つ
    git(root, "worktree", "add", "-q", "-b", "task/T13-new", t13, "main~1");
    const r = fakeOrcaRunner(() =>
      ok({
        worktrees: [
          { path: root, comment: "", workspaceStatus: "in-progress" },
          { path: task, comment: "" },
          { path: t13, comment: "設計書を書いている" },
        ],
      }),
    );
    const { io } = await context(root, r);
    const text = io.text();
    expect(text).toContain("T13（設計書を書いている）");
    expect(text).toContain("T12");
    expect(text).not.toContain("T11（");
  });

  // Windows の一時ディレクトリはドライブつきの形で、WSL の中の Linux の形を作れないので飛ばす。
  it.skipIf(process.platform === "win32")(
    "WSL の中で、UNC の形のカードがタスクに結びつく",
    async () => {
      const { root, task } = setup();
      const r = fakeOrcaRunner(() =>
        ok({
          worktrees: [
            { path: toUnc(root), comment: "", workspaceStatus: "in-progress" },
            { path: toUnc(task), comment: "設計書のレビュー待ち" },
          ],
        }),
      );
      const { io } = await inWsl(() => context(root, r));
      expect(io.text()).toContain("T12（設計書のレビュー待ち）");
    },
  );

  it("乗せた先が作業中の乗せたタスクがあり、待ち受けが動いていなければ /orca-flow:auto を勧める", async () => {
    const { root, task } = setup();
    const back = path.join(path.dirname(task), "T13");
    git(
      root,
      "worktree",
      "add",
      "-q",
      "-b",
      "task/T13-back",
      back,
      "task/T12-x",
    );
    const r = fakeOrcaRunner(() => ok({ worktrees: [] }));
    const before = (await context(root, r)).io.text();
    expect(before).not.toContain("/orca-flow:auto");

    const stackDir = path.join(root, ".git", "orca-flow", "stack");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(
      path.join(stackDir, "T13.json"),
      JSON.stringify({
        id: "T13",
        on: "T12",
        branch: "task/T12-x",
        at: "2026-01-01T00:00:00.000Z",
      }),
    );
    const text = (await context(root, r)).io.text();
    expect(text).toContain("乗せたタスク（T13）");
    expect(text).toContain("/orca-flow:auto");

    const autoDir = path.join(root, ".git", "orca-flow", "auto");
    mkdirSync(autoDir, { recursive: true });
    writeFileSync(
      path.join(autoDir, "wait.lock"),
      `${process.pid} ${currentBootAt()}\n`,
    );
    expect((await context(root, r)).io.text()).not.toContain("/orca-flow:auto");
  });

  it("task/T12-x のブランチではタスク長の文と設計書のパス", async () => {
    const { task } = setup();
    const r = fakeOrcaRunner((args) => {
      expect(args).toEqual(["worktree", "current", "--json"]);
      return ok({
        worktree: {
          isMainWorktree: false,
          branch: "refs/heads/task/T12-x",
          workspaceStatus: "in-progress",
          comment: "設計中",
        },
      });
    });
    const { code, io } = await context(task, r);
    expect(code).toBe(0);
    const text = io.text();
    expect(text).toContain("あなたは T12 のタスク長");
    expect(text).toContain("設計書：docs/tasks/T12.md");
    expect(text).toContain("今の状態：設計中");
    expect(text).toContain("承認されるまでコードを書かない");
    expect(r.calls.filter((c) => c.cmd === "orca")).toHaveLength(1);
  });

  it("サブフォルダから呼んでも tasksDir の設定を使う", async () => {
    const { task } = setup();
    writeFiles(task, {
      ".orca-flow/config.json": JSON.stringify({ tasksDir: "plans" }),
      "src/a.txt": "",
    });
    const r = fakeOrcaRunner(() => ok({ worktree: { comment: "" } }));
    const { io } = await context(path.join(task, "src"), r);
    expect(io.text()).toContain("設計書：plans/T12.md");
  });

  /** Orca が止まったままの偽物。呼ばれた時刻を残す */
  const hungOrca = () => {
    const at: number[] = [];
    const r = fakeOrcaRunner(() => {
      at.push(Date.now());
      return never();
    });
    return { r, at };
  };

  it("Orca が応えなくても、1秒の打ち切りで git で分かった役の文と「取れませんでした」を出して0（タスク長）", async () => {
    const { task } = setup();
    const { r, at } = hungOrca();
    const start = Date.now();
    const { code, io } = await context(task, r);
    const end = Date.now();
    expect(code).toBe(0);
    expect(io.text()).toContain("あなたは T12 のタスク長");
    expect(io.text()).toContain("設計書：docs/tasks/T12.md");
    expect(io.text()).toContain("今の状態：Orca から取れませんでした");
    // Orca には1回だけ、1秒の打ち切りで聞き、打ち切ったらすぐ終わる
    expect(at).toHaveLength(1);
    expect(r.calls.find((c) => c.cmd === "orca")?.opts?.timeoutMs).toBe(
      ORCA_TIMEOUT_MS,
    );
    expect(end - at[0]!).toBeGreaterThanOrEqual(ORCA_TIMEOUT_MS - 50);
    expect(end - at[0]!).toBeLessThan(TOTAL_TIMEOUT_MS - 1000);
    expect(end - start).toBeLessThan(TOTAL_TIMEOUT_MS);
  });

  it("Orca が応えなくても、1秒の打ち切りで git で分かった役の文と「取れませんでした」を出して0（統括役）", async () => {
    const { root } = setup();
    const { r, at } = hungOrca();
    const start = Date.now();
    const { code, io } = await context(root, r);
    const end = Date.now();
    expect(code).toBe(0);
    expect(io.text()).toContain("あなたは統括役");
    expect(io.text()).toContain("T12（状態は Orca から取れませんでした）");
    expect(at).toHaveLength(1);
    expect(end - at[0]!).toBeLessThan(TOTAL_TIMEOUT_MS - 1000);
    expect(end - start).toBeLessThan(TOTAL_TIMEOUT_MS);
  });

  it("全体の締め切りは、フックの5秒より短い", () => {
    expect(ORCA_TIMEOUT_MS).toBe(1000);
    expect(TOTAL_TIMEOUT_MS).toBeLessThan(5000);
    expect(TOTAL_TIMEOUT_MS).toBeGreaterThan(ORCA_TIMEOUT_MS);
  });

  it("壊れた config でも0で終わり、標準出力には何も出さない", async () => {
    const root = makeRepo({ ".orca-flow/config.json": "{ broken" });
    const r = fakeOrcaRunner(() => ok({}));
    const { code, io } = await context(root, r);
    expect(code).toBe(0);
    expect(io.text()).toBe("");
  });

  it("bin/orca-flow context は git の外で0、何も出さない", () => {
    const bin = path.resolve(import.meta.dirname, "../../bin/orca-flow");
    const result = spawnSync(bin, ["context"], {
      cwd: tempDir(),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
