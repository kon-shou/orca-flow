import { describe, expect, it } from "vitest";
import { ORCA_FLOW_MAIN } from "../../src/lib/background.ts";
import {
  findWatchAutomation,
  installWatchAutomation,
  removeWatchAutomation,
  watchCron,
  watchPrecheck,
} from "../../src/lib/watch-automation.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";

const ROOT = "/work/repo";
const OPTS = { root: ROOT, intervalMinutes: 5 };

describe("watch-automation", () => {
  it("ない・ある・分からないを分ける", async () => {
    const orca = fakeOrca();
    expect(await findWatchAutomation(orca.runner, ROOT)).toEqual({
      state: "missing",
    });
    await installWatchAutomation(orca.runner, OPTS);
    expect((await findWatchAutomation(orca.runner, ROOT)).state).toBe("found");
    orca.automationsListFails = true;
    expect((await findWatchAutomation(orca.runner, ROOT)).state).toBe(
      "unknown",
    );
    orca.automationsListFails = false;
    orca.unavailable = true;
    expect((await findWatchAutomation(orca.runner, ROOT)).state).toBe(
      "unknown",
    );
  });

  it("install は precheck と5分おきの cron を渡し、--workspace・--reuse-session を渡さない", async () => {
    const orca = fakeOrca();
    const r = await installWatchAutomation(orca.runner, OPTS);
    expect(r.action).toBe("created");
    const call = orca.callsOf("automations", "create")[0]!;
    expect(call).toContain("--precheck");
    expect(call[call.indexOf("--trigger") + 1]).toBe("*/5 * * * *");
    expect(call).not.toContain("--workspace");
    expect(call).not.toContain("--reuse-session");
    expect(call[call.indexOf("--repo") + 1]).toBe(`path:${ROOT}`);
    expect(call[call.indexOf("--precheck") + 1]).toBe(watchPrecheck(ROOT));
  });

  it("precheck は PATH の orca-flow に頼らず、node と main.ts の絶対パスと --root で呼ぶ", () => {
    const text = watchPrecheck(ROOT, "linux");
    expect(text).toContain(`'${process.execPath}'`);
    expect(text).toContain(`'${ORCA_FLOW_MAIN}'`);
    expect(text).toContain(`'pr-watch' '--root' '${ROOT}'`);
    expect(text).not.toMatch(/(^|\s)'?orca-flow'?\s/);
    expect(text).not.toContain("--workspace");
  });

  it("2回目の install は2つ目を作らず、今の中身に直す", async () => {
    const orca = fakeOrca();
    await installWatchAutomation(orca.runner, OPTS);
    orca.automations[0]!.precheck = "古い precheck";
    const r = await installWatchAutomation(orca.runner, {
      root: ROOT,
      intervalMinutes: 10,
    });
    expect(r.action).toBe("updated");
    expect(orca.automations).toHaveLength(1);
    expect(orca.callsOf("automations", "create")).toHaveLength(1);
    expect(orca.automations[0]!.trigger).toBe("*/10 * * * *");
    expect(orca.automations[0]!.precheck).toBe(watchPrecheck(ROOT));
    const edit = orca.callsOf("automations", "edit")[0]!;
    expect(edit[edit.indexOf("--precheck") + 1]).toBe(watchPrecheck(ROOT));
  });

  it("一覧が automations の形でも items の形でも読める", async () => {
    for (const key of ["automations", "items"]) {
      const orca = fakeOrca();
      await installWatchAutomation(orca.runner, OPTS);
      const inner = orca.runner;
      const runner: typeof inner = async (cmd, args, opts) => {
        const r = await inner(cmd, args, opts);
        if (args[0] !== "automations" || args[1] !== "list") return r;
        const result = JSON.parse(r.stdout).result;
        return {
          ...r,
          stdout: JSON.stringify({ result: { [key]: result.automations } }),
        };
      };
      expect((await findWatchAutomation(runner, ROOT)).state, key).toBe(
        "found",
      );
    }
  });

  it("分からないときの install は作らずに失敗する", async () => {
    const orca = fakeOrca();
    orca.automationsListFails = true;
    await expect(installWatchAutomation(orca.runner, OPTS)).rejects.toThrow(
      /確かめられません/,
    );
    expect(orca.callsOf("automations", "create")).toHaveLength(0);
  });

  it("remove は消す。なければ何もしない", async () => {
    const orca = fakeOrca();
    expect(await removeWatchAutomation(orca.runner, ROOT)).toEqual({
      id: null,
    });
    await installWatchAutomation(orca.runner, OPTS);
    const r = await removeWatchAutomation(orca.runner, ROOT);
    expect(r.id).not.toBeNull();
    expect(orca.automations).toHaveLength(0);
  });

  it("別のリポジトリの automation は見つけない", async () => {
    const orca = fakeOrca();
    await installWatchAutomation(orca.runner, {
      root: "/work/other",
      intervalMinutes: 5,
    });
    expect((await findWatchAutomation(orca.runner, ROOT)).state).toBe(
      "missing",
    );
  });

  it("cron は間隔に合わせる", () => {
    expect(watchCron(5)).toBe("*/5 * * * *");
    expect(watchCron(120)).toBe("0 */2 * * *");
    expect(watchCron(2000)).toBe("0 0 * * *");
  });
});
