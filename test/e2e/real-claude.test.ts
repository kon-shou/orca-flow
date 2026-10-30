import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import {
  allKeysAreLocal,
  defaultHandler,
  lastToolResultText,
  startFakeAnthropic,
  type AnthropicBody,
  type FakeAnthropic,
} from "../helpers/fake-anthropic.ts";
import { testRunner } from "../helpers/runner.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

/**
 * 本物の claude を、偽の Anthropic 互換の入口に向けて流す。
 * ORCA_FLOW_REAL_CLAUDE=1 のときだけ動く（pnpm test では飛ばされ、claude を起動しない）。
 * 本物の Orca と ローカルのモデルの機械 には触らない。
 */
const ENABLED = process.env.ORCA_FLOW_REAL_CLAUDE === "1";
const MODEL = "glm-e2e";
const LEAK = "sk-ant-e2e-must-not-leak";

const promptOf = (body: AnthropicBody): string => {
  const first = body.messages?.[0]?.content;
  if (typeof first === "string") return first;
  return (first ?? [])
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
};

/** 本物の claude に渡る親の環境。本物らしいキーがあっても漏れないことを確かめる */
const dirtyEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ANTHROPIC_API_KEY: LEAK,
  ANTHROPIC_AUTH_TOKEN: LEAK,
  CLAUDE_CODE_OAUTH_TOKEN: LEAK,
  CLAUDE_CODE_USE_BEDROCK: "1",
});

async function cli(argv: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd,
    runner: testRunner,
    env: dirtyEnv(),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe.skipIf(!ENABLED)("本物の claude（ORCA_FLOW_REAL_CLAUDE=1）", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake.close();
  });

  const expectOnlyLocal = () => {
    expect(fake.messages().length).toBeGreaterThan(0);
    expect(allKeysAreLocal(fake.requests)).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain(LEAK);
    const models = new Set(fake.messages().map((r) => r.body?.model));
    expect([...models]).toEqual([MODEL]);
  };

  it("local-check の③：Bash が動き、構造化出力が返る", async () => {
    fake.requests.length = 0;
    fake.setHandler((body) => {
      const prompt = promptOf(body);
      if (!body.tools?.some((t) => t.name === "StructuredOutput"))
        return defaultHandler()(body, 0);
      const file = /cat ([^\s`]+)/.exec(prompt)?.[1] ?? "";
      return defaultHandler({
        bash: `cat ${file}`,
        // Bash の出力（ファイルの1行）をそのまま返す
        structured: (b: AnthropicBody) => ({
          content: lastToolResultText(b).trim(),
        }),
      })(body, 0);
    });
    const result = await cli(
      ["local-check", "--base-url", fake.url, "--model", MODEL, "--json"],
      process.cwd(),
    );
    const data = JSON.parse(result.out);
    expect(data.stages.map((s: { result: string }) => s.result)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(result.code).toBe(0);
    expectOnlyLocal();
  }, 240_000);

  it("review-local：first と redo が通り、台帳に周の記録が残る", async () => {
    fake.requests.length = 0;
    const reviewer = {
      findings: [
        {
          aspect: "正しさ",
          file: "src/a.ts",
          line: 1,
          scenario: "a が未定義のときに落ちる",
          severity: "must_fix",
        },
      ],
    };
    const verifier = {
      findings: [
        {
          id: "F1",
          verdict: "confirmed",
          severity: "must_fix",
          preExisting: false,
          evidence: "src/a.ts:1 を読んだ",
        },
      ],
    };
    const redo = {
      results: [{ id: "F1", status: "fixed", reason: "直った" }],
      newFindings: [],
    };
    fake.setHandler((body) => {
      const prompt = promptOf(body);
      const structured = prompt.includes("今回の入力（やり直し）")
        ? redo
        : prompt.includes("レビュー役の指摘")
          ? verifier
          : reviewer;
      return defaultHandler({ bash: "git log --oneline -1", structured })(
        body,
        0,
      );
    });

    const root = await makeRepo({
      localReview: { runner: "claude", model: MODEL, baseUrl: fake.url },
    });
    // 差分の中の project の設定に env があっても、キー・宛先・ヘッダが戻らないこと
    const wt = await addTaskWorktree(root, "T30", "review", {
      "src/a.ts": "export const a = 1;\n",
      ".claude/settings.json": JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: LEAK,
          ANTHROPIC_AUTH_TOKEN: LEAK,
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          ANTHROPIC_CUSTOM_HEADERS: `x-leak: ${LEAK}`,
        },
      }),
    });

    const first = await cli(
      ["review-local", "--stage", "1", "--cycle", "1"],
      wt.path,
    );
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toContain("must-fix 1 件");

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
        await cli(
          ["review-ledger", "record-fix", "--stage", "1", "--input", fix],
          wt.path,
        )
      ).code,
    ).toBe(0);

    const second = await cli(
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
      wt.path,
    );
    expect(second.err).toBe("");
    expect(second.code).toBe(0);

    const ledger = JSON.parse(
      await readFile(
        path.join(root, ".git/orca-flow/reviews/T30/stage-1.json"),
        "utf8",
      ),
    );
    expect(ledger.findings[0]).toMatchObject({ id: "F1", status: "fixed" });
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.rounds.map((r: { mode: string }) => r.mode)).toEqual([
      "first",
      "redo",
    ]);
    expectOnlyLocal();
    // Bash が dontAsk のもとで動いた（tool_result が返っている）
    const sawBashResult = fake
      .messages()
      .some((r) =>
        r.body?.messages?.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some(
              (b) => b.type === "tool_result" && b.is_error !== true,
            ),
        ),
      );
    expect(sawBashResult).toBe(true);
  }, 480_000);
});
