import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { realRunner, type Runner } from "../../src/lib/exec.ts";
import { capture, git, tempDir, writeFiles } from "../init/helpers.ts";

const FILE = "orca-flow-workspace.json";

async function context(cwd: string) {
  const io = capture();
  const calls: string[] = [];
  const runner: Runner = (cmd, args, opts) => {
    calls.push(cmd);
    return realRunner(cmd, args, opts);
  };
  const code = await main(["context"], { ...io, cwd, runner });
  return { code, io, calls };
}

describe("context の親の役", () => {
  it("設定がある git でないフォルダで、親の統括役の文を出して0", async () => {
    const dir = tempDir("orca-flow-ws-");
    // 設定の確かめはしない（中身が誤りでも出す）
    writeFiles(dir, { [FILE]: "{}" });
    const { code, io, calls } = await context(dir);
    expect(code).toBe(0);
    expect(io.text()).toContain("親の統括役");
    expect(io.text()).toContain("orca-flow workspace");
    expect(calls).not.toContain("orca");
  });

  it("git init したフォルダでも出して0", async () => {
    const dir = tempDir("orca-flow-ws-");
    git(dir, "init", "-q", "-b", "main");
    writeFiles(dir, { [FILE]: "{}" });
    const { code, io } = await context(dir);
    expect(code).toBe(0);
    expect(io.text()).toContain("親の統括役");
  });

  it("設定のない git でないフォルダでは何も出さない", async () => {
    const { code, io } = await context(tempDir("orca-flow-ws-"));
    expect(code).toBe(0);
    expect(io.text()).toBe("");
  });

  it("上の階層の設定は探さない", async () => {
    const dir = tempDir("orca-flow-ws-");
    writeFiles(dir, { [FILE]: "{}", "sub/x.txt": "x\n" });
    const { code, io } = await context(`${dir}/sub`);
    expect(code).toBe(0);
    expect(io.text()).toBe("");
  });
});
