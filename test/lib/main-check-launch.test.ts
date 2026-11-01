import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { ORCA_FLOW_MAIN, launchMainCheck } from "../../src/lib/main-check.ts";
import { makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

describe("launchMainCheck の起動の形", () => {
  it("node の実行ファイルに src/main.ts を渡し、bin/orca-flow を直接起動しない", async () => {
    const root = await makeRepo();
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "git") return testRunner(cmd, args, opts);
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await launchMainCheck(runner, root);
    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(path.basename(ORCA_FLOW_MAIN)).toBe("main.ts");
    expect(path.basename(path.dirname(ORCA_FLOW_MAIN))).toBe("src");
    expect(args).toContain(process.execPath);
    expect(args).toContain(ORCA_FLOW_MAIN);
    expect(args.some((a) => a.endsWith(path.join("bin", "orca-flow")))).toBe(
      false,
    );
    // 起動役は node で main.ts に main-check run を渡す
    const launcher = args[1]!;
    expect(launcher).toContain('"main-check", "run"');
    expect(launcher).toContain("windowsHide");
  });
});
