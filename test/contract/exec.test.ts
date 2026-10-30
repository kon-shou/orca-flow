import { describe, expect, it } from "vitest";
import { realRunner } from "../../src/lib/exec.ts";

describe("realRunner", () => {
  it("標準出力と終了コードを返す", async () => {
    const result = await realRunner("sh", ["-c", "echo hi; exit 3"]);
    expect(result).toMatchObject({ code: 3, stdout: "hi\n", timedOut: false });
  });

  it("見つからないコマンドは127", async () => {
    expect((await realRunner("orca-flow-no-such-command", [])).code).toBe(127);
  });

  it("input を読まずに終わる子に大きな input を渡しても落ちない（EPIPE）", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        realRunner("true", [], { input: "x".repeat(1 << 20) }),
      ),
    );
    expect(results.every((r) => r.code === 0)).toBe(true);
  });

  it("input を渡すと子が読める", async () => {
    expect((await realRunner("cat", [], { input: "abc" })).stdout).toBe("abc");
  });

  it("出力の断片の境目にかかる日本語も壊さない", async () => {
    // 3バイトの文字を64KB を超えて出すと、どこかの断片の境目が文字の途中にかかる
    const text = "あ".repeat(100_000);
    const result = await realRunner(process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(text)}); process.stderr.write(${JSON.stringify(text)})`,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(text);
    expect(result.stderr).toBe(text);
  });

  it("時間を過ぎたら打ち切る", async () => {
    const result = await realRunner("sleep", ["5"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
  });
});
