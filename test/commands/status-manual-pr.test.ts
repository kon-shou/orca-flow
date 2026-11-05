import { describe, expect, it } from "vitest";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

describe("status responding：手で開いた PR", () => {
  it("push の記録がないときは、Orca を呼ばず終了コード1。文に対象外であることと入り方（push・send）が入る", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    const result = await runCli(["status", "responding"], {
      cwd: wt.path,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("手で開いた PR");
    expect(result.err).toContain("/orca-flow:push T12");
    expect(result.err).toContain("/orca-flow:send T12");
    expect(orca.calls).toEqual([]);
  });
});
