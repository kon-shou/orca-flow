import { describe, expect, it } from "vitest";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { makeRepo } from "../helpers/repo.ts";

const WORDING = "ID の形が正しくありません";

describe("CLI の入口：形の外れた ID", () => {
  it("push ../x1 は終了コード1で、今と同じ文", async () => {
    const root = await makeRepo();
    const orca = fakeOrca();
    const result = await runCli(["push", "../x1"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain(`${WORDING}：../x1`);
    expect(orca.calls).toEqual([]);
  });

  it.each([
    ["on", "../x1"],
    ["off", "T1/x"],
    ["log", ".T1"],
    ["on", "12"],
  ])("auto %s %s は終了コード1で、今と同じ文", async (sub, id) => {
    const root = await makeRepo();
    const orca = fakeOrca();
    const argv = sub === "log" ? ["auto", sub, id, "x"] : ["auto", sub, id];
    const result = await runCli(argv, { cwd: root, runner: orca.runner });
    expect(result.code).toBe(1);
    expect(result.err).toContain(`${WORDING}：${id}`);
    expect(orca.calls).toEqual([]);
  });
});
