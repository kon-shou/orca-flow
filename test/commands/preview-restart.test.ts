import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { ORCA_FLOW_MAIN } from "../../src/lib/background.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

function recorder() {
  const base = fakeOrca();
  const launches: (readonly string[])[] = [];
  const others: string[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === process.execPath && args[0] === "-e") {
      launches.push(args);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (cmd !== "git" && cmd !== "orca")
      others.push(`${cmd} ${args.join(" ")}`);
    return base.runner(cmd, args, opts);
  };
  return { runner, launches, others, orca: base };
}

async function setup(preview: Record<string, unknown> | null, record: boolean) {
  const root = await makeRepo({ idPrefix: "T", preview });
  const wt = await addTaskWorktree(root, "T7", "shop");
  const dir = path.join(root, ".git", "orca-flow", "preview");
  if (record) {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "T7.json"),
      JSON.stringify({
        id: "T7",
        worktree: wt.path,
        terminal: "term_1",
        at: "2026-01-01T00:00:00.000Z",
      }),
    );
  }
  return root;
}

describe("preview --restart", () => {
  it("記録があれば、背景の子を1回起こしてすぐ戻る", async () => {
    const root = await setup({ up: "make dev" }, true);
    const { runner, launches } = recorder();
    const result = await runCli(["preview", "T7", "--restart"], {
      cwd: root,
      runner,
    });
    expect(result.code).toBe(0);
    expect(launches).toHaveLength(1);
    expect(launches[0]![1]).toContain('"preview", "T7", "--restart-now"');
    expect(launches[0]!.slice(2, 4)).toEqual([
      process.execPath,
      ORCA_FLOW_MAIN,
    ]);
  });

  it("前景では止めも立てもせず、答えにログの場所と restarted がある", async () => {
    const root = await setup({ up: "make dev", down: "make down" }, true);
    const { runner, launches, others, orca } = recorder();
    const result = await runCli(["preview", "T7", "--restart", "--json"], {
      cwd: root,
      runner,
    });
    expect(result.code).toBe(0);
    expect(launches).toHaveLength(1);
    expect(others).toEqual([]);
    for (const action of ["close", "create", "send"])
      expect(orca.callsOf("terminal", action)).toEqual([]);
    const data = JSON.parse(result.out);
    expect(data).toMatchObject({ id: "T7", restarted: true });
    expect(data.log).toBe(
      path.join(root, ".git", "orca-flow", "preview-restart", "T7.log"),
    );
  });

  it("文の答えにも立て直しのログの場所が出る", async () => {
    const root = await setup({ up: "make dev" }, true);
    const { runner } = recorder();
    const result = await runCli(["preview", "T7", "--restart"], {
      cwd: root,
      runner,
    });
    expect(result.out).toContain(
      path.join(root, ".git", "orca-flow", "preview-restart", "T7.log"),
    );
  });

  it("設定が null なら、何もせず終了コード0", async () => {
    const root = await setup(null, true);
    const { runner, launches } = recorder();
    const result = await runCli(["preview", "T7", "--restart"], {
      cwd: root,
      runner,
    });
    expect(result.code).toBe(0);
    expect(launches).toEqual([]);
  });

  it("記録がなければ、何もせず終了コード0", async () => {
    const root = await setup({ up: "make dev" }, false);
    const { runner, launches } = recorder();
    const result = await runCli(["preview", "T7", "--restart", "--json"], {
      cwd: root,
      runner,
    });
    expect(result.code).toBe(0);
    expect(launches).toEqual([]);
    expect(JSON.parse(result.out)).toMatchObject({ restarted: false });
  });
});
