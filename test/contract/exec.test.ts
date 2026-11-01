import { describe, expect, it } from "vitest";
import { planWindowsSpawn, realRunner } from "../../src/lib/exec.ts";

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

describe("planWindowsSpawn（Windows の起動の組み立て。macOS から確かめる）", () => {
  const BIN = "C:\\Tools\\bin";
  const lookup = (files: string[]) => ({
    path: `C:\\Windows;${BIN}`,
    pathExt: ".COM;.EXE;.BAT;.CMD",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    exists: (file: string) => files.includes(file),
  });

  it("区切りか拡張子のあるコマンドは、そのまま起動する", () => {
    for (const cmd of ["C:\\x\\orca", "orca.exe", "./orca"]) {
      expect(planWindowsSpawn(cmd, ["a"], lookup([]))).toEqual({
        ok: true,
        file: cmd,
        args: ["a"],
        verbatim: false,
      });
    }
  });

  it("PATH に見つからなければ、そのまま起動する（起動の失敗は127になる）", () => {
    expect(planWindowsSpawn("orca", ["a"], lookup([]))).toEqual({
      ok: true,
      file: "orca",
      args: ["a"],
      verbatim: false,
    });
  });

  it("PATHEXT の順で探し、.exe ならその場所を直に起動する", () => {
    const exe = `${BIN}\\git.exe`;
    expect(
      planWindowsSpawn("git", ["status"], lookup([exe, `${BIN}\\git.cmd`])),
    ).toEqual({ ok: true, file: exe, args: ["status"], verbatim: false });
  });

  it(".cmd なら cmd.exe の /d /s /c に、引用して特別な文字を2重に逃がした1行で渡す", () => {
    const plan = planWindowsSpawn(
      "orca",
      ["terminal", "send", "--text", 'a&b|c "x" 100%'],
      lookup([`${BIN}\\orca.cmd`]),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(plan.verbatim).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const line = plan.args[3] as string;
    expect(line.startsWith('"')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
    // 引数の & | % は、どれも ^ で2重に逃がされ、素のままでは残らない
    expect(line).toContain("a^^^&b^^^|c");
    expect(line).toContain("100^^^%");
    expect(line).not.toMatch(/[^^]&/);
    expect(line).not.toMatch(/[^^]\|/);
  });

  it("ComSpec がなければ cmd.exe を使う", () => {
    const plan = planWindowsSpawn("orca", [], {
      ...lookup([`${BIN}\\orca.bat`]),
      comSpec: undefined,
    });
    expect(plan.ok && plan.file).toBe("cmd.exe");
  });

  it("改行を含む引数は、.cmd の1行に入れられないので起動しない", () => {
    const plan = planWindowsSpawn(
      "orca",
      ["terminal", "send", "--text", "1行目\n2行目"],
      lookup([`${BIN}\\orca.cmd`]),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("改行");
  });
});
