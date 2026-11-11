import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTaskWorktree } from "../../src/lib/finish.ts";
import { createOrca } from "../../src/lib/orca.ts";
import { previewDeps, withPreviewLock } from "../../src/lib/preview.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

async function setup(preview: Record<string, unknown> | null) {
  const root = await makeRepo({ idPrefix: "T", preview });
  const wt = await addTaskWorktree(root, "T7", "shop");
  const fake = fakeOrca();
  fake.terminals.push(
    { handle: "term_preview", worktreePath: wt.path },
    { handle: "term_other", worktreePath: wt.path },
  );
  const downs: { command: string; cwd: string | undefined }[] = [];
  let downCode = 0;
  const runner: typeof fake.runner = async (cmd, args, opts) => {
    if (cmd === "sh" && args[0] === "-c") {
      downs.push({ command: args[1]!, cwd: opts?.cwd });
      return { code: downCode, stdout: "", stderr: "", timedOut: false };
    }
    return fake.runner(cmd, args, opts);
  };
  const errs: string[] = [];
  const ctx = {
    argv: [],
    cwd: root,
    json: false,
    runner,
    env: {},
    stdout: () => {},
    stderr: (t: string) => errs.push(t),
    now: () => new Date(),
  } as CommandContext;
  const record = path.join(root, ".git", "orca-flow", "preview", "T7.json");
  const writeRecord = async () => {
    await mkdir(path.dirname(record), { recursive: true });
    await writeFile(
      record,
      JSON.stringify({
        id: "T7",
        worktree: wt.path,
        terminal: "term_preview",
        at: "2026-11-05T00:00:00.000Z",
      }),
    );
  };
  return {
    root,
    wt,
    fake,
    downs,
    errs,
    ctx,
    record,
    writeRecord,
    setDownCode: (c: number) => (downCode = c),
    orca: createOrca(runner, root),
  };
}

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

describe("worktree を消す前の preview の停止", () => {
  it("記録があれば、worktree を消す前に down を流し、記録のターミナルだけを閉じて記録を消す", async () => {
    const s = await setup({ up: "make dev", down: "make down" });
    await s.writeRecord();
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.downs).toEqual([{ command: "make down", cwd: s.wt.path }]);
    const order = s.fake.calls
      .filter(
        (c) =>
          (c[0] === "terminal" && c[1] === "close") ||
          (c[0] === "worktree" && c[1] === "rm"),
      )
      .map((c) => c.slice(0, 2).join(" "));
    expect(order).toEqual(["terminal close", "worktree rm"]);
    expect(s.fake.callsOf("terminal", "close")[0]).toContain("term_preview");
    await expect(readFile(s.record, "utf8")).rejects.toThrow();
  });

  it("記録がなければ何も流さない", async () => {
    const s = await setup({ up: "make dev", down: "make down" });
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.downs).toEqual([]);
    expect(s.fake.callsOf("terminal", "close")).toEqual([]);
  });

  it("止めるのに失敗しても worktree は消え、警告だけが出る", async () => {
    const s = await setup({ up: "make dev", down: "make down" });
    await s.writeRecord();
    s.setDownCode(3);
    s.fake.closeFails = true;
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    const text = s.errs.join("\n");
    expect(text).toContain("警告");
    expect(text).toContain("止める");
    expect(s.fake.callsOf("worktree", "rm")).toHaveLength(1);
  });

  it("設定の preview が null でも、記録があればターミナルを閉じて記録を消す（down は流さない）", async () => {
    const s = await setup(null);
    await s.writeRecord();
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.downs).toEqual([]);
    expect(s.fake.callsOf("terminal", "close")[0]).toContain("term_preview");
    await expect(readFile(s.record, "utf8")).rejects.toThrow();
  });

  it("記録が壊れていても worktree は消え、記録のパスを添えた警告が出る", async () => {
    const s = await setup({ up: "make dev", down: "make down" });
    await mkdir(path.dirname(s.record), { recursive: true });
    await writeFile(s.record, "{");
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    const text = s.errs.join("\n");
    expect(text).toContain("警告");
    expect(text).toContain(s.record);
    expect(s.downs).toEqual([]);
    expect(s.fake.callsOf("worktree", "rm")).toHaveLength(1);
  });

  it("ロックが取れなくても worktree は消え、警告が出る", async () => {
    const s = await setup({ up: "make dev", down: "make down" });
    await s.writeRecord();
    previewDeps.lockWaitMs = 100;
    const common = path.join(s.root, ".git");
    const removed = await withPreviewLock(common, "T7", () =>
      removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path),
    );
    expect(removed).toBe(true);
    expect(s.errs.join("\n")).toContain("警告");
    expect(s.downs).toEqual([]);
    expect(s.fake.callsOf("worktree", "rm")).toHaveLength(1);
  });

  it("設定が読めないときは、止めるコマンドを流さず警告し、ターミナルを閉じて記録を消す", async () => {
    const s = await setup({ up: "make dev", down: "make down" });
    await s.writeRecord();
    await rm(path.join(s.root, ".orca-flow", "config.json"), { force: true });
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.downs).toEqual([]);
    expect(s.errs.join("\n")).toContain("止めるコマンドを流していません");
    expect(s.fake.callsOf("terminal", "close")[0]).toContain("term_preview");
    await expect(readFile(s.record, "utf8")).rejects.toThrow();
  });
});
