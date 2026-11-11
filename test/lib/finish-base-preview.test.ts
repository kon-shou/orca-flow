import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeTaskWorktree } from "../../src/lib/finish.ts";
import { createOrca } from "../../src/lib/orca.ts";
import {
  e2eCapturesDir,
  previewBaseRecordPath,
  previewBaseWorktreeDir,
} from "../../src/lib/preview-base.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, tempDir } from "../helpers/repo.ts";

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function setup() {
  const root = await makeRepo({
    idPrefix: "T",
    preview: { up: "make dev", down: "make down" },
  });
  const wt = await addTaskWorktree(root, "T7", "shop");
  const state = await tempDir("orca-flow-state-");
  const env = { XDG_STATE_HOME: state };
  const common = path.join(root, ".git");
  const fake = fakeOrca();
  fake.terminals.push(
    { handle: "term_task", worktreePath: wt.path },
    { handle: "term_base", worktreePath: wt.path },
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
    env,
    stdout: () => {},
    stderr: (t: string) => errs.push(t),
    now: () => new Date(),
  } as CommandContext;

  const dir = previewBaseWorktreeDir(env, common, "T7");
  await mkdir(path.dirname(dir), { recursive: true });
  await git(root, "worktree", "add", "--detach", "--quiet", dir, "main");
  const recordFile = previewBaseRecordPath(common, "T7");
  await mkdir(path.dirname(recordFile), { recursive: true });
  await writeFile(
    recordFile,
    JSON.stringify({
      id: "T7",
      worktree: dir,
      taskWorktree: wt.path,
      terminal: "term_base",
      commit: "abc",
      at: "2026-11-05T00:00:00.000Z",
    }),
  );
  const captures = e2eCapturesDir(common, "T7");
  await mkdir(captures, { recursive: true });
  await writeFile(path.join(captures, "flow-before.webm"), "x");
  return {
    root,
    wt,
    fake,
    downs,
    errs,
    ctx,
    dir,
    recordFile,
    captures,
    setDownCode: (c: number) => (downCode = c),
    orca: createOrca(runner, root),
  };
}

describe("worktree を消す前の前の画面と録画の片づけ", () => {
  it("前の画面を止め（down・ターミナル・作業ツリー・記録）、録画の置き場を消す", async () => {
    const s = await setup();
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.downs.map((d) => d.command)).toEqual(["make down"]);
    expect(s.downs[0]!.cwd).toContain("preview-base");
    expect(s.fake.callsOf("terminal", "close")[0]).toContain("term_base");
    expect(await exists(s.dir)).toBe(false);
    expect(await exists(s.recordFile)).toBe(false);
    expect(await exists(s.captures)).toBe(false);
    const order = s.fake.calls
      .filter(
        (c) =>
          (c[0] === "terminal" && c[1] === "close") ||
          (c[0] === "worktree" && c[1] === "rm"),
      )
      .map((c) => c.slice(0, 2).join(" "));
    expect(order).toEqual(["terminal close", "worktree rm"]);
    expect(s.errs).toEqual([]);
  });

  it("止められなくても worktree は消え、警告だけで、録画の置き場も消える", async () => {
    const s = await setup();
    s.setDownCode(3);
    s.fake.closeFails = true;
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.errs.join("\n")).toContain("警告");
    expect(s.fake.callsOf("worktree", "rm")).toHaveLength(1);
    expect(await exists(s.captures)).toBe(false);
  });

  it("壊れた記録でも worktree は消え、警告が出る", async () => {
    const s = await setup();
    await writeFile(s.recordFile, "{壊れ");
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.errs.join("\n")).toContain("壊れ");
    expect(await exists(s.recordFile)).toBe(false);
  });

  it("記録が置き場の外を指していても、そのフォルダを消さず down も流さず、警告する", async () => {
    const s = await setup();
    const victim = await tempDir("orca-flow-victim-");
    await writeFile(path.join(victim, "keep.txt"), "x");
    const record = JSON.parse(await readFile(s.recordFile, "utf8"));
    await writeFile(
      s.recordFile,
      JSON.stringify({ ...record, worktree: victim }),
    );
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(await exists(path.join(victim, "keep.txt"))).toBe(true);
    expect(await exists(s.root)).toBe(true);
    expect(s.downs).toEqual([]);
    expect(s.errs.join("\n")).toContain("置き場の外");
  });

  it("前の画面も録画もなければ何も流さず、警告も出さない", async () => {
    const s = await setup();
    const { rm } = await import("node:fs/promises");
    await rm(s.recordFile);
    await rm(s.captures, { recursive: true });
    await git(s.root, "worktree", "remove", "--force", s.dir);
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.downs).toEqual([]);
    expect(s.errs).toEqual([]);
    await expect(readFile(s.recordFile, "utf8")).rejects.toThrow();
  });
});
