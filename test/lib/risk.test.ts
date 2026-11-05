import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { classifyRisk, cleanForReason } from "../../src/lib/risk.ts";
import { testRunner } from "../helpers/runner.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const done = (code: number, stdout = "") => ({
  code,
  stdout,
  stderr: "",
  timedOut: false,
});

async function repo(files: Record<string, string>) {
  const root = await makeRepo();
  const wt = await addTaskWorktree(root, "T01", "x", files);
  return wt.path;
}

const ghWith =
  (labels: string[] | "fail"): Runner =>
  async (cmd, args, opts) => {
    if (cmd !== "gh") return testRunner(cmd, args, opts);
    return labels === "fail"
      ? done(1)
      : done(0, JSON.stringify({ labels: labels.map((name) => ({ name })) }));
  };

const config = (paths: string[], labels: string[]) => ({
  baseBranch: "main",
  risk: { paths, labels },
});

describe("classifyRisk", () => {
  it("パスに当たらずラベルにも当たらなければ normal", async () => {
    const cwd = await repo({ "src/a.ts": "a" });
    const r = await classifyRisk({
      runner: ghWith(["bug"]),
      cwd,
      config: config(["db/"], ["security"]),
      pr: 7,
    });
    expect(r.level).toBe("normal");
  });

  it("差分のファイルが risk.paths に当たれば high で、当たったパスを添える", async () => {
    const cwd = await repo({ "db/migrations/1.sql": "x" });
    const r = await classifyRisk({
      runner: ghWith([]),
      cwd,
      config: config(["db/"], []),
      pr: 7,
    });
    expect(r.level).toBe("high");
    expect(r.reason).toContain("db/migrations/1.sql");
  });

  it('日本語のパスや " を含むパスも risk.paths に当たる（引用符つきで返らない）', async () => {
    for (const file of ["db/移行/1.sql", 'db/a"b.sql']) {
      const cwd = await repo({ [file]: "x" });
      const r = await classifyRisk({
        runner: ghWith([]),
        cwd,
        config: config(["db/"], []),
        pr: 7,
      });
      expect(r.level).toBe("high");
      expect(r.reason).toContain("risk.paths");
    }
  });

  it("ラベルは大文字小文字を区別せず、制御文字を除いて短く切る", async () => {
    const cwd = await repo({ "src/a.ts": "a" });
    const r = await classifyRisk({
      runner: ghWith(["SECURITY"]),
      cwd,
      config: config([], ["security"]),
      pr: 7,
    });
    expect(r.level).toBe("high");
    expect(r.reason).toContain("SECURITY");
    expect(cleanForReason("a\u001b[31mb\nc")).toBe("a[31mbc");
    expect(cleanForReason("x".repeat(100)).length).toBe(41);
  });

  it("PR の番号がない・ラベルが読めない・差分が読めないときは high", async () => {
    const cwd = await repo({ "src/a.ts": "a" });
    const base = { cwd, config: config([], []) };
    expect(
      (await classifyRisk({ ...base, runner: ghWith([]), pr: null })).level,
    ).toBe("high");
    expect(
      (await classifyRisk({ ...base, runner: ghWith("fail"), pr: 7 })).level,
    ).toBe("high");
    const noBase = await classifyRisk({
      runner: ghWith([]),
      cwd,
      config: { baseBranch: "no-such-branch", risk: { paths: [], labels: [] } },
      pr: 7,
    });
    expect(noBase.level).toBe("high");
    expect(noBase.reason).toContain("差分");
  });
});
