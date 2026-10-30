import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import type { Runner, RunResult } from "../../src/lib/exec.ts";
import {
  allKeysAreLocal,
  defaultHandler,
  startFakeAnthropic,
  type FakeAnthropic,
  type Handler,
} from "../helpers/fake-anthropic.ts";
import { testRunner } from "../helpers/runner.ts";
import { tempDir } from "../helpers/repo.ts";

const REAL_KEY = "sk-ant-REAL-SECRET-KEY";

interface Claude {
  calls: { args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[];
  /** 返す structured_output。関数なら、プロンプトから読んだファイルの中身を渡す */
  reply: (fileText: string) => unknown;
  exit?: number;
}

function runnerWith(claude: Claude): Runner {
  return async (cmd, args, opts) => {
    if (cmd !== "claude") return testRunner(cmd, args, opts);
    claude.calls.push({
      args: [...args],
      env: opts?.env ?? {},
      cwd: opts?.cwd,
    });
    const prompt = args.at(-1) ?? "";
    const file = /cat ([^\s`]+)/.exec(prompt)?.[1] ?? "";
    const text = await readFile(file, "utf8").catch(() => "");
    const result: RunResult = {
      code: claude.exit ?? 0,
      stdout: JSON.stringify({
        is_error: false,
        structured_output: claude.reply(text.trim()),
      }),
      stderr: "",
      timedOut: false,
    };
    return result;
  };
}

let fake: FakeAnthropic;
beforeEach(async () => {
  fake = await startFakeAnthropic();
});
afterEach(async () => {
  await fake.close();
});

async function check(
  claude: Claude,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const cwd = await tempDir("orca-flow-lc-cwd-");
  const code = await main(
    ["local-check", "--base-url", fake.url, "--model", "glm-test", ...extra],
    {
      cwd,
      runner: runnerWith(claude),
      env,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const echo = (text: string) => ({ content: text });

describe("local-check", () => {
  it("偽の入口が正しく答えれば、3段とも通って終了コード0", async () => {
    const claude: Claude = { calls: [], reply: echo };
    const result = await check(claude);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("① 入口：通った");
    expect(result.out).toContain("② tool use：通った");
    expect(result.out).toContain("③ Claude Code：通った");
    expect(claude.calls).toHaveLength(1);
  });

  it("入口が答えなければ①が落ち、②③は飛ばして終了コード1", async () => {
    fake.setHandler(() => ({
      kind: "http",
      status: 503,
      body: { error: "x" },
    }));
    const claude: Claude = { calls: [], reply: echo };
    const result = await check(claude, ["--json"]);
    expect(result.code).toBe(1);
    const data = JSON.parse(result.out);
    expect(data.stages.map((s: { result: string }) => s.result)).toEqual([
      "failed",
      "skipped",
      "skipped",
    ]);
    expect(data.stages[0].reason).toContain("503");
    expect(claude.calls).toHaveLength(0);
  });

  it("入口につながらなくても①が落ちる", async () => {
    await fake.close();
    const claude: Claude = { calls: [], reply: echo };
    const result = await check(claude, ["--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).stages[0].result).toBe("failed");
    fake = await startFakeAnthropic();
  });

  it("tool_use が返らなければ②が落ちて終了コード1", async () => {
    fake.setHandler(() => ({ kind: "text", text: "天気は晴れです" }));
    const claude: Claude = { calls: [], reply: echo };
    const result = await check(claude, ["--json"]);
    expect(result.code).toBe(1);
    const data = JSON.parse(result.out);
    expect(data.stages.map((s: { result: string }) => s.result)).toEqual([
      "passed",
      "failed",
      "passed",
    ]);
    expect(data.stages[1].reason).toContain("tool_use");
  });

  it("claude が中身の違う JSON を返せば③が落ちて終了コード1", async () => {
    const claude: Claude = { calls: [], reply: () => ({ content: "違う" }) };
    const result = await check(claude, ["--json"]);
    expect(result.code).toBe(1);
    const data = JSON.parse(result.out);
    expect(data.stages[2].result).toBe("failed");
    expect(data.stages[2].reason).toContain("中身と違います");
  });

  it("claude が失敗しても③が落ちる", async () => {
    const claude: Claude = { calls: [], reply: echo, exit: 1 };
    const result = await check(claude, ["--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).stages[2].result).toBe("failed");
  });

  it("--json の data に、段ごとの名前・結果・理由が入る", async () => {
    const claude: Claude = { calls: [], reply: echo };
    const result = await check(claude, ["--json"]);
    const data = JSON.parse(result.out);
    expect(data).toMatchObject({
      ok: true,
      baseUrl: fake.url,
      model: "glm-test",
    });
    expect(data.stages).toHaveLength(3);
    for (const stage of data.stages) {
      expect(typeof stage.name).toBe("string");
      expect(stage.result).toBe("passed");
      expect(typeof stage.reason).toBe("string");
    }
    expect(data.stages.map((s: { name: string }) => s.name)).toEqual([
      "入口",
      "tool use",
      "Claude Code",
    ]);
  });

  it("送信にも claude の環境にも本物のキーが入らない", async () => {
    const claude: Claude = { calls: [], reply: echo };
    const result = await check(claude, [], {
      ANTHROPIC_API_KEY: REAL_KEY,
      ANTHROPIC_AUTH_TOKEN: REAL_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-REAL",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(result.code).toBe(0);
    expect(fake.messages()).toHaveLength(2);
    expect(allKeysAreLocal(fake.requests)).toBe(true);
    expect(fake.messages().every((r) => r.apiKey === "local")).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain(REAL_KEY);
    const env = claude.calls[0]!.env;
    expect(env.ANTHROPIC_API_KEY).toBe("local");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("local");
    expect(env.ANTHROPIC_BASE_URL).toBe(fake.url);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it("claude は review-local と同じ引数で、worktree の外の一時ディレクトリで流れ、使い終わったら消える", async () => {
    const claude: Claude = { calls: [], reply: echo };
    await check(claude);
    const call = claude.calls[0]!;
    expect(call.args).toContain("dontAsk");
    expect(call.args).toContain("--no-session-persistence");
    expect(call.args).not.toContain("plan");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("glm-test");
    const file = /cat ([^\s`]+)/.exec(call.args.at(-1) ?? "")![1]!;
    expect(file.startsWith(call.cwd!)).toBe(true);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("知らない引数や位置引数は終了コード1", async () => {
    const claude: Claude = { calls: [], reply: echo };
    expect((await check(claude, ["--foo"])).code).toBe(1);
    expect((await check(claude, ["extra"])).code).toBe(1);
  });
});

describe("偽の入口", () => {
  it("道具に StructuredOutput があれば Bash を呼んでから structured を返す（SSE）", async () => {
    const handler: Handler = defaultHandler({ bash: "echo hi" });
    const first = handler(
      {
        tools: [{ name: "Bash" }, { name: "StructuredOutput" }],
        messages: [{ role: "user", content: "x" }],
      },
      0,
    );
    expect(first).toMatchObject({
      kind: "tool_use",
      calls: [{ name: "Bash" }],
    });
    const response = await fetch(`${fake.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: message_stop");
    expect(body).toContain('"text":"pong"');
  });
});
