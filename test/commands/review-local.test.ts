import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner, RunResult } from "../../src/lib/exec.ts";
import { main } from "../../src/cli.ts";
import { claudeArgs, localReviewEnv } from "../../src/lib/local-review.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const ok = (value: unknown): RunResult => ({
  code: 0,
  stdout: JSON.stringify({ result: JSON.stringify(value) }),
  stderr: "",
  timedOut: false,
});

const ledgerPath = (root: string, id: string, stage: number) =>
  path.join(root, ".git/orca-flow/reviews", id, `stage-${stage}.json`);

async function setup(
  files: Record<string, string> = { "src/a.ts": "export const a = 1;\n" },
) {
  const root = await makeRepo({
    localReview: { runner: "claude", model: "glm-test" },
  });
  const wt = await addTaskWorktree(root, "T30", "review", files);
  return { root, wt };
}

function localRunner(reviewer: unknown, verifier: unknown, redo?: unknown) {
  const calls: string[][] = [];
  const orca = fakeOrca();
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd !== "claude") return orca.runner(cmd, args, opts);
    calls.push([...args]);
    const prompt = args.at(-1) ?? "";
    if (prompt.includes("今回の入力（やり直し）")) return ok(redo);
    if (prompt.includes("レビュー役の指摘")) return ok(verifier);
    return ok(reviewer);
  };
  return { runner, calls };
}

describe("review-local", () => {
  it("差分の一覧を取る git diff --name-only に --no-renames をつける", async () => {
    const { wt } = await setup();
    const inner = localRunner({ findings: [] }, { findings: [] });
    const diffs: string[][] = [];
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "diff" && args.includes("--name-only"))
        diffs.push([...args]);
      return inner.runner(cmd, args, opts);
    };
    await runCli(["review-local", "--stage", "1", "--cycle", "1"], {
      cwd: wt.path,
      runner,
    });
    expect(diffs.length).toBeGreaterThan(0);
    for (const args of diffs) expect(args).toContain("--no-renames");
  });

  it("1周分のレビューと検証をして、must-fix を台帳に残す", async () => {
    const { root, wt } = await setup();
    const { runner, calls } = localRunner(
      {
        findings: [
          {
            aspect: "正しさ",
            file: "src/a.ts",
            line: 1,
            scenario: "a が未定義のときに落ちる",
            severity: "must_fix",
          },
        ],
      },
      {
        findings: [
          {
            id: "F1",
            verdict: "confirmed",
            severity: "must_fix",
            preExisting: false,
            evidence: "src/a.ts:1 を読んだ",
          },
        ],
      },
    );
    const result = await runCli(
      ["review-local", "--stage", "1", "--cycle", "1"],
      { cwd: wt.path, runner },
    );
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("must-fix 1 件");
    expect(calls).toHaveLength(2);
    const ledger = JSON.parse(
      await readFile(ledgerPath(root, "T30", 1), "utf8"),
    );
    expect(ledger.findings[0]).toMatchObject({
      id: "F1",
      verdict: "confirmed",
      severity: "must_fix",
      status: "open",
    });
  });

  it("やり直しでは前の指摘の状態を更新し、新しい指摘を足す", async () => {
    const { root, wt } = await setup();
    const first = localRunner(
      {
        findings: [
          {
            aspect: "正しさ",
            file: "src/a.ts",
            line: 1,
            scenario: "落ちる",
            severity: "must_fix",
          },
        ],
      },
      {
        findings: [
          {
            id: "F1",
            verdict: "confirmed",
            severity: "must_fix",
            preExisting: false,
            evidence: "再現した",
          },
        ],
      },
    );
    expect(
      (
        await runCli(["review-local", "--stage", "1", "--cycle", "1"], {
          cwd: wt.path,
          runner: first.runner,
        })
      ).code,
    ).toBe(0);

    const fix = path.join(path.dirname(root), "fix.json");
    await writeFile(
      fix,
      JSON.stringify({
        findingId: "F1",
        files: ["src/a.ts"],
        hunks: ["src/a.ts:1-1"],
        summary: "a を守る",
        intent: "未定義でも落ちないようにする",
        behaviorChange: "none",
        rationale: "指摘どおり",
        tests: ["pnpm test"],
      }),
    );
    expect(
      (
        await runCli(
          ["review-ledger", "record-fix", "--stage", "1", "--input", fix],
          { cwd: wt.path, runner: fakeOrca().runner },
        )
      ).code,
    ).toBe(0);

    const redo = localRunner(
      { findings: [] },
      { findings: [] },
      {
        results: [
          {
            id: "F1",
            status: "fixed",
            reason: "守る処理が入った",
            evidence: "src/a.ts:1 を読んだ",
          },
        ],
        newFindings: [
          {
            aspect: "読みやすさ",
            file: "src/a.ts",
            scenario: "名前が曖昧",
            severity: "should_fix",
            verdict: "confirmed",
            preExisting: false,
            evidence: "src/a.ts:1 を読んだ",
          },
        ],
      },
    );
    const result = await runCli(
      [
        "review-local",
        "T30",
        "main...HEAD",
        "redo",
        "--stage",
        "1",
        "--cycle",
        "2",
      ],
      { cwd: wt.path, runner: redo.runner },
    );
    expect(result.code).toBe(0);
    const ledger = JSON.parse(
      await readFile(ledgerPath(root, "T30", 1), "utf8"),
    );
    expect(ledger.findings).toHaveLength(2);
    expect(ledger.findings[0]).toMatchObject({ id: "F1", status: "fixed" });
    expect(ledger.findings[1]).toMatchObject({
      id: "F2",
      verdict: "confirmed",
      severity: "should_fix",
    });
  });

  it("3周目のフルレビューは台帳を消さず、前の指摘をレビュー役に渡す", async () => {
    const { root, wt } = await setup();
    const first = localRunner(
      {
        findings: [
          {
            aspect: "正しさ",
            file: "src/a.ts",
            line: 1,
            scenario: "最初の指摘",
            severity: "must_fix",
          },
        ],
      },
      {
        findings: [
          {
            id: "F1",
            verdict: "confirmed",
            severity: "must_fix",
            preExisting: false,
            evidence: "再現した",
          },
        ],
      },
    );
    expect(
      (
        await runCli(["review-local", "--stage", "1", "--cycle", "1"], {
          cwd: wt.path,
          runner: first.runner,
        })
      ).code,
    ).toBe(0);

    const third = localRunner(
      {
        findings: [
          {
            aspect: "設計",
            file: "src/a.ts",
            scenario: "2つ目の指摘",
            severity: "should_fix",
          },
        ],
      },
      {
        findings: [
          {
            id: "F2",
            verdict: "confirmed",
            severity: "should_fix",
            preExisting: false,
            evidence: "読んだ",
          },
        ],
      },
    );
    expect(
      (
        await runCli(["review-local", "--stage", "1", "--cycle", "3"], {
          cwd: wt.path,
          runner: third.runner,
        })
      ).code,
    ).toBe(0);
    expect(third.calls[0]?.at(-1)).toContain('"id": "F1"');
    const ledger = JSON.parse(
      await readFile(ledgerPath(root, "T30", 1), "utf8"),
    );
    expect(ledger.findings.map((item: { id: string }) => item.id)).toEqual([
      "F1",
      "F2",
    ]);
  });

  it("2段目は1段目の指摘を背景に渡し、台帳は段ごとに分ける", async () => {
    const { root, wt } = await setup();
    const first = localRunner(
      {
        findings: [
          {
            aspect: "正しさ",
            file: "src/a.ts",
            line: 1,
            scenario: "1段目の指摘",
            severity: "must_fix",
          },
        ],
      },
      {
        findings: [
          {
            id: "F1",
            verdict: "confirmed",
            severity: "must_fix",
            preExisting: false,
            evidence: "再現した",
          },
        ],
      },
    );
    expect(
      (
        await runCli(["review-local", "--stage", "1", "--cycle", "1"], {
          cwd: wt.path,
          runner: first.runner,
        })
      ).code,
    ).toBe(0);

    const second = localRunner(
      {
        findings: [
          {
            aspect: "設計",
            file: "src/a.ts",
            scenario: "2段目の指摘",
            severity: "should_fix",
          },
        ],
      },
      {
        findings: [
          {
            id: "F1",
            verdict: "confirmed",
            severity: "should_fix",
            preExisting: false,
            evidence: "読んだ",
          },
        ],
      },
    );
    const result = await runCli(
      ["review-local", "--stage", "2", "--cycle", "1"],
      { cwd: wt.path, runner: second.runner },
    );
    expect(result.code).toBe(0);
    expect(second.calls[0]?.at(-1)).toContain("1段目の指摘");
    const stage1 = JSON.parse(
      await readFile(ledgerPath(root, "T30", 1), "utf8"),
    );
    const stage2 = JSON.parse(
      await readFile(ledgerPath(root, "T30", 2), "utf8"),
    );
    expect(stage1.findings).toHaveLength(1);
    expect(stage2.findings).toHaveLength(1);
    expect(stage2.findings[0].scenario).toBe("2段目の指摘");
  });

  it("差分がなければモデルを呼ばず、空の台帳を残す", async () => {
    const { root, wt } = await setup({});
    const { runner, calls } = localRunner({ findings: [] }, { findings: [] });
    const result = await runCli(
      ["review-local", "--stage", "1", "--cycle", "1"],
      { cwd: wt.path, runner },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("差分なし");
    expect(calls).toHaveLength(0);
    const ledger = JSON.parse(
      await readFile(ledgerPath(root, "T30", 1), "utf8"),
    );
    expect(ledger.findings).toEqual([]);
  });

  it("壊れた JSON は2回まで試してから終了コード1", async () => {
    const { wt } = await setup();
    let calls = 0;
    const { runner } = localRunner({ findings: [] }, { findings: [] });
    const broken: Runner = async (cmd, args, opts) => {
      if (cmd !== "claude") return runner(cmd, args, opts);
      calls += 1;
      return {
        code: 0,
        stdout: "これは JSON ではない",
        stderr: "",
        timedOut: false,
      };
    };
    const result = await runCli(
      ["review-local", "--stage", "1", "--cycle", "1"],
      { cwd: wt.path, runner: broken },
    );
    expect(result.code).toBe(1);
    expect(calls).toBe(2);
    expect(result.err).toContain("JSON");
  });

  it("2段目は1段目の台帳がなければ終了コード2", async () => {
    const { wt } = await setup();
    const { runner, calls } = localRunner({ findings: [] }, { findings: [] });
    const result = await runCli(
      ["review-local", "--stage", "2", "--cycle", "1"],
      { cwd: wt.path, runner },
    );
    expect(result.code).toBe(2);
    expect(result.err).toContain("段1のレビュー台帳");
    expect(calls).toHaveLength(0);
  });

  it("claude の引数は dontAsk と --no-session-persistence で、plan を使わない", () => {
    const args = claudeArgs(
      { baseUrl: "http://x", model: "glm-test" } as never,
      "P",
      { type: "object" },
    );
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain("--no-session-persistence");
    // 設定ファイルの env が、消したキーや宛先を戻さないよう、設定を読ませない
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("plan");
    expect(args.at(-1)).toBe("P");
  });

  it("親の環境の本物のキー・OAuth・提供元の切り替えを、claude に渡さない", async () => {
    const { wt } = await setup();
    const envs: NodeJS.ProcessEnv[] = [];
    const base = localRunner({ findings: [] }, { findings: [] });
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "claude") envs.push(opts?.env ?? {});
      return base.runner(cmd, args, opts);
    };
    const code = await main(["review-local", "--stage", "1", "--cycle", "1"], {
      cwd: wt.path,
      runner,
      stdout: () => {},
      stderr: () => {},
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-real",
        ANTHROPIC_AUTH_TOKEN: "real-token",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-real",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_MODEL: "claude-opus",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku",
      },
    });
    expect(code).toBe(0);
    expect(envs).toHaveLength(1);
    const env = envs[0] ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe("local");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("local");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBe("glm-test");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-test");
    expect(JSON.stringify(env)).not.toContain("sk-ant-real");
  });

  it("localReviewEnv は元の環境を書き換えない", () => {
    const parent = { CLAUDE_CODE_OAUTH_TOKEN: "x" } as NodeJS.ProcessEnv;
    localReviewEnv(parent, { baseUrl: "http://x", model: "m" } as never);
    expect(parent.CLAUDE_CODE_OAUTH_TOKEN).toBe("x");
  });

  it("1周ごとに周の記録を台帳に足し、usage をトークンとして残す", async () => {
    const { root, wt } = await setup();
    const base = localRunner({ findings: [] }, { findings: [] });
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd !== "claude") return base.runner(cmd, args, opts);
      return {
        code: 0,
        stdout: JSON.stringify({
          result: JSON.stringify({ findings: [] }),
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_input_tokens: 5,
          },
        }),
        stderr: "",
        timedOut: false,
      };
    };
    for (const cycle of ["1", "2"]) {
      const result = await runCli(
        ["review-local", "--stage", "1", "--cycle", cycle],
        { cwd: wt.path, runner },
      );
      expect(result.code).toBe(0);
    }
    const ledger = JSON.parse(
      await readFile(ledgerPath(root, "T30", 1), "utf8"),
    );
    // 1周ごとに1つ足す（2周目は台帳を読み直して足す）
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.rounds[1]).toMatchObject({
      stage: 1,
      cycle: 2,
      mode: "first",
    });
    expect(ledger.rounds[0].calls).toHaveLength(1);
    expect(ledger.rounds[0].calls[0]).toMatchObject({
      kind: "reviewer",
      retries: 0,
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 5 },
    });
    expect(typeof ledger.rounds[0].durationMs).toBe("number");
    expect(typeof ledger.rounds[0].startedAt).toBe("string");
  });

  it("usage がなくても失敗せず、トークンは空", async () => {
    const { root, wt } = await setup();
    const { runner } = localRunner({ findings: [] }, { findings: [] });
    const result = await runCli(
      ["review-local", "--stage", "1", "--cycle", "1"],
      { cwd: wt.path, runner },
    );
    expect(result.code).toBe(0);
    const ledger = JSON.parse(
      await readFile(ledgerPath(root, "T30", 1), "utf8"),
    );
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.rounds[0].calls[0].usage).toBeUndefined();
  });

  it("周の記録のない古い台帳も読め、must-fix の数が変わらない", async () => {
    const { root, wt } = await setup();
    const old = {
      taskId: "T30",
      stage: 1,
      baseBranch: "main",
      range: "main...HEAD",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      findings: [
        {
          id: "F1",
          aspect: "正しさ",
          file: "src/a.ts",
          line: 1,
          scenario: "落ちる",
          severity: "must_fix",
          verdict: "confirmed",
          evidence: "再現した",
          preExisting: false,
          status: "open",
        },
      ],
      acceptedRisks: [],
      notes: [],
    };
    await mkdir(path.dirname(ledgerPath(root, "T30", 1)), { recursive: true });
    await writeFile(ledgerPath(root, "T30", 1), JSON.stringify(old));
    const { runner } = localRunner({ findings: [] }, { findings: [] });
    const result = await runCli(
      ["review-local", "--stage", "1", "--cycle", "2", "--json"],
      { cwd: wt.path, runner },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).counts.mustFix).toBe(1);
    const ledger = JSON.parse(
      await readFile(ledgerPath(root, "T30", 1), "utf8"),
    );
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.findings).toHaveLength(1);
  });
});
