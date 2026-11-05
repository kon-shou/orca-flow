import { describe, expect, it } from "vitest";
import { run } from "../../src/commands/pr-watch.ts";
import { FlowError } from "../../src/types.ts";
import { addTaskWorktree } from "../helpers/repo.ts";
import { harness } from "../lib/pr-watch/helpers.ts";

describe("pr-watch コマンド", () => {
  it("引数なしは見張りの1回で、gh が失敗してもいつも0以外で終わる", async () => {
    const h = await harness();
    h.gh.failStderr = "boom";
    const result = await run(h.ctx(["--root", h.root]));
    expect(result.code).not.toBe(0);
    expect(h.orca.calls).toEqual([]);
    expect(h.orca.launches).toEqual([]);
  });

  it("--root を渡さなければ呼ばれた場所のリポジトリを見る", async () => {
    const h = await harness();
    h.gh.add({ number: 1, branch: "task/T01-x" });
    const result = await run(h.ctx([]));
    expect(result.code).not.toBe(0);
    expect(h.gh.stage1).toBe(1);
  });

  it("usage は、まだ回がなくても0で終わる", async () => {
    const h = await harness();
    const result = await run(h.ctx(["usage"]));
    expect(result.code).toBe(0);
    expect(h.out.join("\n")).toContain("まだありません");
  });

  it("install は automation を作り、2回目は2つ目を作らず直す。uninstall で消える", async () => {
    const h = await harness({ prWatch: { intervalMinutes: 10 } });
    const first = await run(h.ctx(["install"]));
    expect(first.data).toMatchObject({ action: "created" });
    expect(h.orca.automations).toHaveLength(1);
    expect(h.orca.automations[0]!.trigger).toBe("*/10 * * * *");
    const create = h.orca.callsOf("automations", "create")[0]!;
    expect(create).not.toContain("--workspace");
    expect(create).not.toContain("--reuse-session");
    const second = await run(h.ctx(["install"]));
    expect(second.data).toMatchObject({ action: "updated" });
    expect(h.orca.automations).toHaveLength(1);
    const removed = await run(h.ctx(["uninstall"]));
    expect(removed.code).toBe(0);
    expect(h.orca.automations).toHaveLength(0);
    const none = await run(h.ctx(["uninstall"]));
    expect(none.data).toMatchObject({ id: null });
  });

  it("install の precheck に --root とメインの作業ツリーが入る。タスクの worktree から打っても同じ", async () => {
    const h = await harness();
    const wt = await addTaskWorktree(h.root, "T01", "x");
    await run({ ...h.ctx(["install"]), cwd: wt.path });
    const create = h.orca.callsOf("automations", "create")[0]!;
    const precheck = create[create.indexOf("--precheck") + 1]!;
    expect(precheck).toContain("--root");
    expect(precheck).toContain(h.root);
    expect(precheck).not.toContain(wt.path);
  });

  it("知らない使い方と余分な引数は断る", async () => {
    const h = await harness();
    await expect(run(h.ctx(["nothing"]))).rejects.toBeInstanceOf(FlowError);
    await expect(run(h.ctx(["usage", "x"]))).rejects.toBeInstanceOf(FlowError);
  });
});
