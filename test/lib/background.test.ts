import path from "node:path";
import { describe, expect, it } from "vitest";
import { launchBackground, ORCA_FLOW_MAIN } from "../../src/lib/background.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { launchMainCheck } from "../../src/lib/main-check.ts";
import { redactSecrets } from "../../src/lib/github.ts";
import { makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

function recorder() {
  const calls: { cmd: string; args: readonly string[]; cwd?: string }[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "git") return testRunner(cmd, args, opts);
    calls.push({ cmd, args, cwd: opts?.cwd });
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { runner, calls };
}

describe("launchBackground", () => {
  it("node で起動役を呼び、渡す引数とログのパスをそのまま子に渡す", async () => {
    const { runner, calls } = recorder();
    await launchBackground(runner, {
      cwd: "/x",
      log: "/x/a.log",
      args: ["push", "T1", "--watch"],
      failure: (r) => `失敗：${r}`,
    });
    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args[1]).toContain("detached: true");
    expect(args[1]).toContain("windowsHide");
    expect(args[1]).toContain('"push", "T1", "--watch"');
    expect(args.slice(2)).toEqual([
      process.execPath,
      ORCA_FLOW_MAIN,
      "/x",
      "/x/a.log",
    ]);
  });

  it("失敗したら failure の文を含む FlowError(1)", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "だめ",
      timedOut: false,
    });
    await expect(
      launchBackground(runner, {
        cwd: "/x",
        log: "/x/a.log",
        args: ["main-check", "run"],
        failure: (r) => `起動できませんでした：${r}`,
      }),
    ).rejects.toMatchObject({
      code: 1,
      message: expect.stringContaining("起動できませんでした：だめ"),
    });
  });

  it("redact を渡すと、失敗の理由は伏せてから failure の文に入る", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "SECRET-VALUE が漏れた",
      timedOut: false,
    });
    const error = await launchBackground(
      runner,
      {
        cwd: "/x",
        log: "/x/a.log",
        args: ["main-check", "run"],
        failure: (r) => `起動できませんでした：${r}`,
      },
      (t) => t.replace("SECRET-VALUE", "〈伏せた〉"),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 1 });
    const text = (error as Error).message;
    expect(text).toContain("起動できませんでした：〈伏せた〉 が漏れた");
    expect(text).not.toContain("SECRET-VALUE");
  });

  it("起動の失敗では、本物の redactSecrets を渡すと秘密の形の文字列が伏せられる", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const runner: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: `認証 ${token} 失敗`,
      timedOut: false,
    });
    const error = await launchBackground(
      runner,
      {
        cwd: "/x",
        log: "/x/a.log",
        args: ["pr-watch", "background"],
        failure: (r) => `背景の仕事を起動できませんでした：${r}`,
      },
      redactSecrets,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 1 });
    const text = (error as Error).message;
    expect(text).toContain("背景の仕事を起動できませんでした");
    expect(text).not.toContain(token);
    expect(text).toContain("〈トークン〉");
  });

  it("見張りの背景の仕事も main の確かめも、同じ起動役の文を通り、引数とログの場所だけが違う", async () => {
    const root = await makeRepo();
    const a = recorder();
    await launchMainCheck(a.runner, root);
    const b = recorder();
    await launchBackground(b.runner, {
      cwd: root,
      log: path.join(root, "pr-watch.log"),
      args: ["pr-watch", "background"],
      failure: (r) => r,
    });
    const ra = a.calls[0]!.args;
    const rb = b.calls[0]!.args;
    expect(ra[1]).toContain('"main-check", "run"');
    expect(rb[1]).toContain('"pr-watch", "background"');
    // 起動役の枠は同じ（引数の並びだけが違う）
    const frame = (s: string) => s.replace(/main, .*\]\, \{/, "main, X], {");
    expect(frame(ra[1]!)).toBe(frame(rb[1]!));
    expect(ra[4]).toBe(root);
    expect(path.basename(ra[5]!)).toBe("run.log");
    expect(path.basename(rb[5]!)).toBe("pr-watch.log");
  });
});
