import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import {
  loadFlowConfig,
  requireFlowConfig,
} from "../../src/lib/flow-config.ts";
import { FlowError } from "../../src/types.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const CONFIG = ".orca-flow/config.json";

function counting(): { runner: Runner; calls: () => number } {
  let n = 0;
  return {
    runner: (cmd, args, opts) => {
      n++;
      return testRunner(cmd, args, opts);
    },
    calls: () => n,
  };
}

/** .orca-flow/ を git に入れない形のメインと、写しを持つ worktree */
async function setup(main: object | null, copy: object | null) {
  const root = await makeRepo({}, { ".gitignore": ".orca-flow/\n" });
  const wt = await addTaskWorktree(root, "T1", "a");
  const put = async (dir: string, value: object | null) => {
    const file = path.join(dir, CONFIG);
    await rm(file, { force: true });
    if (value === null) return;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  await put(root, main);
  await put(wt.path, copy);
  return { root, wt: wt.path };
}

describe("loadFlowConfig", () => {
  it("写しが untracked なら、リンクした worktree でメインの設定を読む", async () => {
    const { root, wt } = await setup(
      { untracked: true, verify: ["new"] },
      { untracked: true, verify: ["old"] },
    );
    const loaded = await loadFlowConfig(testRunner, wt);
    expect(loaded.config.verify).toEqual(["new"]);
    expect(loaded.path).toBe(path.join(root, CONFIG));
  });

  it("写しが untracked でないときは写しを読み、Runner を呼ばない", async () => {
    const { wt } = await setup(
      { untracked: true, verify: ["new"] },
      { untracked: false, verify: ["old"] },
    );
    const spy = counting();
    const loaded = await loadFlowConfig(spy.runner, wt);
    expect(loaded.config.verify).toEqual(["old"]);
    expect(spy.calls()).toBe(0);
  });

  it("メインに config.json がなければ写しを読む", async () => {
    const { wt } = await setup(null, { untracked: true, verify: ["old"] });
    const loaded = await loadFlowConfig(testRunner, wt);
    expect(loaded.config.verify).toEqual(["old"]);
    expect(loaded.path).toBe(path.join(wt, CONFIG));
  });

  it("メインの作業ツリーでは自分の config.json を読む", async () => {
    const { root } = await setup(
      { untracked: true, verify: ["new"] },
      { untracked: true, verify: ["old"] },
    );
    const spy = counting();
    const loaded = await loadFlowConfig(spy.runner, root);
    expect(loaded.config.verify).toEqual(["new"]);
    expect(spy.calls()).toBe(0);
  });

  it("メインの config.json が壊れていれば、そのパスを含む文で終了コード1", async () => {
    const { root, wt } = await setup(null, { untracked: true });
    await writeFile(path.join(root, CONFIG), "{ broken");
    const error = await loadFlowConfig(testRunner, wt).catch((e) => e);
    expect(error).toBeInstanceOf(FlowError);
    expect(error.code).toBe(1);
    expect(error.message).toContain(path.join(root, CONFIG));
  });

  it.each([
    ["型が違う", { untracked: true, verify: "x" }],
    ["知らないキーがある", { untracked: true, unknownKey: 1 }],
    ["オブジェクトでない", [1]],
  ])(
    "メインの config.json の中身に誤り（%s）があれば、メインのパスを含む文で終了コード1",
    async (_label, main) => {
      const { root, wt } = await setup(main, { untracked: true });
      const error = await loadFlowConfig(testRunner, wt).catch((e) => e);
      expect(error).toBeInstanceOf(FlowError);
      expect(error.code).toBe(1);
      expect(error.message.startsWith(path.join(root, CONFIG))).toBe(true);
    },
  );

  it("写しがなければ設定なし（コミットする形と同じ）", async () => {
    const { wt } = await setup({ untracked: true }, null);
    const spy = counting();
    expect((await loadFlowConfig(spy.runner, wt)).exists).toBe(false);
    expect(spy.calls()).toBe(0);
  });
});

describe("requireFlowConfig", () => {
  it("設定がなければ終了コード2", async () => {
    const { wt } = await setup(null, null);
    const error = await requireFlowConfig(testRunner, wt).catch((e) => e);
    expect(error).toBeInstanceOf(FlowError);
    expect(error.code).toBe(2);
  });

  it("untracked の worktree ではメインの設定を返す", async () => {
    const { wt } = await setup(
      { untracked: true, baseBranch: "main", verify: ["new"] },
      { untracked: true },
    );
    expect((await requireFlowConfig(testRunner, wt)).verify).toEqual(["new"]);
  });
});
