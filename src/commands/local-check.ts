import { loadFlowConfig } from "../lib/flow-config.ts";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type LocalReviewConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { repoRoot } from "../lib/exec.ts";
import {
  claudeArgs,
  localReviewEnv,
  parseJsonObject,
} from "../lib/local-review.ts";
import { FlowError, type Command } from "../types.ts";

/** ①②の1回の送信を待つ上限 */
export const HTTP_TIMEOUT_MS = 60_000;
/** ③の claude を待つ上限 */
export const CLAUDE_TIMEOUT_MS = 5 * 60_000;

export type StageResult = "passed" | "failed" | "skipped";

export interface StageReport {
  name: string;
  result: StageResult;
  /** 落ちた・飛ばした理由。通ったときは短い確認の文 */
  reason: string;
  durationMs: number;
}

const STAGE_NAMES = ["入口", "tool use", "Claude Code"] as const;
const LABEL: Record<StageResult, string> = {
  passed: "通った",
  failed: "落ちた",
  skipped: "飛ばした",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** /v1/messages に1回送る。キーは local だけを付ける */
async function postMessages(
  baseUrl: string,
  body: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "local",
      authorization: "Bearer local",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

const contentOf = (json: unknown): Record<string, unknown>[] =>
  isObject(json) && Array.isArray(json.content)
    ? json.content.filter(isObject)
    : [];

const describeError = (error: unknown): string =>
  error instanceof Error
    ? error.name === "TimeoutError"
      ? `${HTTP_TIMEOUT_MS / 1000}秒以内に答えませんでした`
      : `つながりません（${error.cause instanceof Error ? error.cause.message : error.message}）`
    : String(error);

async function checkEndpoint(config: LocalReviewConfig): Promise<string> {
  const { status, json, text } = await postMessages(config.baseUrl, {
    model: config.model,
    max_tokens: 64,
    messages: [{ role: "user", content: "ping と一言だけ返してください。" }],
  });
  if (status !== 200)
    throw new Error(`HTTP ${status}：${text.slice(0, 200).trim()}`);
  const block = contentOf(json).find(
    (b) => b.type === "text" && typeof b.text === "string" && b.text !== "",
  );
  if (!block) throw new Error("文が返りませんでした");
  return "文が返りました";
}

async function checkToolUse(config: LocalReviewConfig): Promise<string> {
  const { status, json, text } = await postMessages(config.baseUrl, {
    model: config.model,
    max_tokens: 256,
    tools: [
      {
        name: "get_weather",
        description: "指定した都市の天気を返す",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: "東京の天気を知りたいです。get_weather を呼んでください。",
      },
    ],
  });
  if (status !== 200)
    throw new Error(`HTTP ${status}：${text.slice(0, 200).trim()}`);
  const call = contentOf(json).find((b) => b.type === "tool_use");
  if (!call) throw new Error("tool_use が返りませんでした");
  return `tool_use（${String(call.name)}）が返りました`;
}

async function checkClaude(
  ctx: Parameters<Command>[0],
  config: LocalReviewConfig,
): Promise<string> {
  // worktree の外の一時ディレクトリに、Bash で読ませるファイルを置く
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "orca-flow-lc-")),
  );
  try {
    const token = `local-check-${randomBytes(6).toString("hex")}`;
    const file = path.join(dir, "probe.txt");
    await writeFile(file, `${token}\n`);
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: { content: { type: "string" } },
    };
    const prompt = `Bash で \`cat ${file}\` を実行し、出力された1行をそのまま content に入れた JSON だけを最後に返してください。前後に説明を書かないでください。\n\n{"content":"（ファイルの1行）"}`;
    const result = await ctx.runner(
      "claude",
      claudeArgs(config, prompt, schema),
      {
        cwd: dir,
        env: localReviewEnv(ctx.env, config),
        timeoutMs: CLAUDE_TIMEOUT_MS,
      },
    );
    if (result.timedOut)
      throw new Error(
        `${CLAUDE_TIMEOUT_MS / 60_000}分以内に終わりませんでした`,
      );
    if (result.code !== 0)
      throw new Error(
        `claude が失敗しました（終了コード ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      );
    let value: unknown;
    try {
      const outer: unknown = JSON.parse(result.stdout);
      if (isObject(outer) && outer.structured_output !== undefined)
        value = outer.structured_output;
      else if (isObject(outer) && typeof outer.result === "string")
        value = parseJsonObject(outer.result);
      else value = parseJsonObject(result.stdout);
    } catch {
      throw new Error("JSON の形で返りませんでした");
    }
    if (!isObject(value) || typeof value.content !== "string")
      throw new Error("返った JSON に content がありません");
    if (!value.content.includes(token))
      throw new Error(
        "返った content が、Bash で読んだファイルの中身と違います",
      );
    return "Bash でファイルを読み、JSON の形で返りました";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 入口・tool use・Claude Code の3段で、ローカルの入口の疎通を確かめる */
export const run: Command = async (ctx) => {
  const parsed = parseArgs(ctx.argv, ["base-url", "model"]);
  if (parsed.positionals.length > 0)
    throw new FlowError(
      1,
      "使い方：orca-flow local-check [--base-url 〈URL〉] [--model 〈名前〉] [--json]",
    );

  let base: LocalReviewConfig = DEFAULT_CONFIG.localReview;
  const root = await repoRoot(ctx.runner, ctx.cwd);
  if (root) base = (await loadFlowConfig(ctx.runner, root)).config.localReview;
  const config: LocalReviewConfig = {
    ...base,
    baseUrl: parsed.values.get("base-url") ?? base.baseUrl,
    model: parsed.values.get("model") ?? base.model,
  };
  try {
    new URL(config.baseUrl);
  } catch {
    throw new FlowError(
      1,
      `--base-url が URL ではありません：${config.baseUrl}`,
    );
  }

  const checks = [
    () => checkEndpoint(config),
    () => checkToolUse(config),
    () => checkClaude(ctx, config),
  ];
  const stages: StageReport[] = [];
  let blocked = false;
  for (const [index, check] of checks.entries()) {
    const name = STAGE_NAMES[index]!;
    if (blocked) {
      stages.push({
        name,
        result: "skipped",
        reason: "①の入口が落ちたため",
        durationMs: 0,
      });
      continue;
    }
    const started = Date.now();
    try {
      const reason = await check();
      stages.push({
        name,
        result: "passed",
        reason,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      stages.push({
        name,
        result: "failed",
        reason:
          index < 2
            ? describeError(error)
            : error instanceof Error
              ? error.message
              : String(error),
        durationMs: Date.now() - started,
      });
      if (index === 0) blocked = true;
    }
  }

  const ok = stages.every((s) => s.result === "passed");
  if (!ctx.json) {
    ctx.stdout(
      `ローカルの入口の確かめ：${config.baseUrl}（モデル ${config.model}）`,
    );
    stages.forEach((s, i) =>
      ctx.stdout(`${"①②③"[i]} ${s.name}：${LABEL[s.result]}　${s.reason}`),
    );
    ctx.stdout(ok ? "3段とも通りました" : "通らない段があります");
  }
  return {
    code: ok ? 0 : 1,
    data: { baseUrl: config.baseUrl, model: config.model, ok, stages },
  };
};
