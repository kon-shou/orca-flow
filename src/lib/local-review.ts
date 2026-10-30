import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalReviewConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(HERE, "../../agents");

export const LOCAL_REVIEW_TIMEOUT_MS = 10 * 60_000;

export const REVIEWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aspect", "file", "scenario", "severity"],
        properties: {
          aspect: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
          scenario: { type: "string" },
          proposedFix: { type: "string" },
          severity: {
            type: "string",
            enum: ["must_fix", "should_fix", "check_only"],
          },
        },
      },
    },
  },
} as const;

export const VERIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "severity", "preExisting", "evidence"],
        properties: {
          id: { type: "string" },
          verdict: {
            type: "string",
            enum: ["confirmed", "likely", "wrong"],
          },
          severity: {
            type: "string",
            enum: ["must_fix", "should_fix", "check_only"],
          },
          preExisting: { type: "boolean" },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export const REDO_VERIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results", "newFindings"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "reason"],
        properties: {
          id: { type: "string" },
          status: {
            type: "string",
            enum: ["fixed", "fixed_intentional", "not_fixed"],
          },
          reason: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    newFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "aspect",
          "file",
          "scenario",
          "severity",
          "verdict",
          "preExisting",
          "evidence",
        ],
        properties: {
          aspect: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
          scenario: { type: "string" },
          proposedFix: { type: "string" },
          severity: {
            type: "string",
            enum: ["must_fix", "should_fix", "check_only"],
          },
          verdict: {
            type: "string",
            enum: ["confirmed", "likely", "wrong"],
          },
          preExisting: { type: "boolean" },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export interface RawFinding {
  aspect: string;
  file: string;
  line?: number;
  scenario: string;
  proposedFix?: string;
  severity: "must_fix" | "should_fix" | "check_only";
}

export interface RawVerification {
  id: string;
  verdict: "confirmed" | "likely" | "wrong";
  severity: "must_fix" | "should_fix" | "check_only";
  preExisting: boolean;
  evidence: string;
}

export interface RawRedoResult {
  id: string;
  status: "fixed" | "fixed_intentional" | "not_fixed";
  reason: string;
  evidence?: string;
}

export interface RawVerifiedFinding extends RawFinding {
  verdict: "confirmed" | "likely" | "wrong";
  preExisting: boolean;
  evidence: string;
}

function withoutFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  return end < 0 ? text : text.slice(end + 5);
}

export async function readAgentPrompt(name: string): Promise<string> {
  const file = path.join(AGENTS_DIR, `${name}.md`);
  try {
    return withoutFrontmatter(await readFile(file, "utf8")).trim();
  } catch {
    throw new FlowError(1, `担当の定義を読めません：${file}`);
  }
}

export function buildReviewerPrompt(input: {
  agent: string;
  taskId: string;
  designPath: string;
  baseBranch: string;
  range: string;
  verifyResult: string;
  settled: string;
}): string {
  return `${input.agent}

# 今回の入力

- ID：${input.taskId}
- 設計書：${input.designPath}
- baseBranch：${input.baseBranch}
- 差分の範囲：${input.range}
- verify の結果：${input.verifyResult || "なし"}
- 前の回までの指摘と判断（新しい根拠なしに同じ指摘を繰り返さない）：${input.settled || "なし"}

# 返す形

最後のメッセージを、次の形の JSON だけにしてください。前後に説明を書かないでください。

{"findings":[{"aspect":"正しさ","file":"src/foo.ts","line":12,"scenario":"どんな入力で何が壊れるか","proposedFix":"直し方の案","severity":"must_fix"}]}

severity は must_fix・should_fix・check_only のどれかです。指摘がなければ {"findings":[]} を返してください。`;
}

export function buildVerifierPrompt(input: {
  agent: string;
  taskId: string;
  designPath: string;
  baseBranch: string;
  range: string;
  verifyResult: string;
  findings: readonly (RawFinding & { id?: string })[];
}): string {
  return `${input.agent}

# 今回の入力

- ID：${input.taskId}
- 設計書：${input.designPath}
- baseBranch：${input.baseBranch}
- 差分の範囲：${input.range}
- verify の結果：${input.verifyResult || "なし"}
- レビュー役の指摘：

${JSON.stringify(
  input.findings.map((finding, index) => ({
    ...finding,
    id: finding.id ?? `F${index + 1}`,
  })),
  null,
  2,
)}

# 返す形

最後のメッセージを、次の形の JSON だけにしてください。前後に説明を書かないでください。

{"findings":[{"id":"F1","verdict":"confirmed","severity":"must_fix","preExisting":false,"evidence":"読んだ所・流したテスト・再現の手順"}]}

verdict は confirmed・likely・wrong のどれかです。`;
}

export function buildRedoVerifierPrompt(input: {
  agent: string;
  taskId: string;
  designPath: string;
  baseBranch: string;
  range: string;
  verifyResult: string;
  previous: readonly {
    id: string;
    scenario: string;
    fix?: {
      summary: string;
      intent: string;
      behaviorChange: string;
      tests: string[];
    };
  }[];
}): string {
  return `${input.agent}

# 今回の入力（やり直し）

- ID：${input.taskId}
- 設計書：${input.designPath}
- baseBranch：${input.baseBranch}
- 直した差分の範囲：${input.range}
- verify の結果：${input.verifyResult || "なし"}
- 前の回の直させるものと、修正の意図：${JSON.stringify(input.previous, null, 2)}

# 返す形

最後のメッセージを、次の形の JSON だけにしてください。前後に説明を書かないでください。

{"results":[{"id":"F1","status":"fixed","reason":"直った理由","evidence":"読んだ所・流したテスト"}],"newFindings":[{"aspect":"正しさ","file":"src/foo.ts","scenario":"新しく入った問題","severity":"must_fix","verdict":"confirmed","preExisting":false,"evidence":"読んだ所・流したテスト"}]}

status は fixed・fixed_intentional・not_fixed のどれかです。意図的な挙動変更は fixed_intentional にしてください。`;
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // 下でまとめて失敗にする
      }
    }
  }
  throw new FlowError(1, "ローカルのモデルが JSON を返しませんでした");
}

export function claudeArgs(
  config: LocalReviewConfig,
  prompt: string,
  schema: unknown,
): string[] {
  return [
    "-p",
    "--bare",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    // 設定ファイル（user・project・local）を読ませない。その env が --bare でも効き、
    // 消したキー・宛先・ヘッダを戻して、本物のキーをローカルの端点に送ってしまうため
    "--setting-sources",
    "",
    "--allowedTools",
    "Read,Glob,Grep,Bash",
    "--model",
    config.model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--max-turns",
    "80",
    prompt,
  ];
}

/** 別の提供元への切り替えと、その付属の設定。ローカルの端点に向けるときは必ず消す */
const REMOVED_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BETAS",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

/** 小さいモデルや別名への裏の呼び出しも、設定のモデルに向ける */
const MODEL_ENV = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/** ローカルの端点に渡す環境。本物のキー・トークン・提供元の切り替えを必ず消す */
export function localReviewEnv(
  env: NodeJS.ProcessEnv,
  config: LocalReviewConfig,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of REMOVED_ENV) delete next[name];
  for (const name of MODEL_ENV) next[name] = config.model;
  next.ANTHROPIC_BASE_URL = config.baseUrl;
  next.ANTHROPIC_API_KEY = "local";
  next.ANTHROPIC_AUTH_TOKEN = "local";
  next.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return next;
}

export interface LocalCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** 1回の呼び出し（再試行を含む）の記録 */
export interface LocalCallRecord {
  durationMs: number;
  /** 再試行の回数（1回で通れば0） */
  retries: number;
  /** 成功した試行の usage の合計。取れなければ省く */
  usage?: LocalCallUsage;
}

/** claude -p --output-format json の外側から usage を取る。取れなければ undefined */
export function parseUsage(stdout: string): LocalCallUsage | undefined {
  try {
    const outer: unknown = JSON.parse(stdout);
    if (typeof outer !== "object" || outer === null) return undefined;
    const raw = (outer as Record<string, unknown>).usage;
    if (typeof raw !== "object" || raw === null) return undefined;
    const u = raw as Record<string, unknown>;
    const pick = (key: string) =>
      typeof u[key] === "number" && Number.isFinite(u[key])
        ? (u[key] as number)
        : undefined;
    const usage: LocalCallUsage = {};
    const input = pick("input_tokens");
    const output = pick("output_tokens");
    const read = pick("cache_read_input_tokens");
    const created = pick("cache_creation_input_tokens");
    if (input !== undefined) usage.inputTokens = input;
    if (output !== undefined) usage.outputTokens = output;
    if (read !== undefined) usage.cacheReadTokens = read;
    if (created !== undefined) usage.cacheCreationTokens = created;
    return Object.keys(usage).length > 0 ? usage : undefined;
  } catch {
    return undefined;
  }
}

function openCodeArgs(config: LocalReviewConfig, prompt: string): string[] {
  return ["run", "--pure", "--model", config.model, prompt];
}

async function invoke(
  runner: Runner,
  cwd: string,
  env: NodeJS.ProcessEnv,
  config: LocalReviewConfig,
  prompt: string,
  schema: unknown,
): Promise<{ text: string; usage?: LocalCallUsage }> {
  if (config.runner === "opencode") {
    const result = await runner("opencode", openCodeArgs(config, prompt), {
      cwd,
      env,
      timeoutMs: LOCAL_REVIEW_TIMEOUT_MS,
    });
    if (result.timedOut)
      throw new FlowError(1, "ローカルのレビューが時間内に終わりませんでした");
    if (result.code !== 0)
      throw new FlowError(
        1,
        `ローカルのレビューが失敗しました：${(result.stderr || result.stdout).trim()}`,
      );
    return { text: result.stdout };
  }

  const result = await runner("claude", claudeArgs(config, prompt, schema), {
    cwd,
    env,
    timeoutMs: LOCAL_REVIEW_TIMEOUT_MS,
  });
  if (result.timedOut)
    throw new FlowError(1, "ローカルのレビューが時間内に終わりませんでした");
  if (result.code !== 0)
    throw new FlowError(
      1,
      `ローカルのレビューが失敗しました：${(result.stderr || result.stdout).trim()}`,
    );
  // --output-format json の外側を剥がす。中身が文字列ならさらに JSON を読む
  const usage = parseUsage(result.stdout);
  try {
    const outer: unknown = JSON.parse(result.stdout);
    if (typeof outer === "object" && outer !== null) {
      const record = outer as Record<string, unknown>;
      if (record.structured_output !== undefined)
        return { text: JSON.stringify(record.structured_output), usage };
      if (typeof record.result === "string")
        return { text: record.result, usage };
    }
  } catch {
    // そのまま下の JSON 抽出に任せる
  }
  return { text: result.stdout, usage };
}

export async function runLocalJson<T>(input: {
  runner: Runner;
  cwd: string;
  env: NodeJS.ProcessEnv;
  config: LocalReviewConfig;
  prompt: string;
  schema: unknown;
  validate: (value: unknown) => value is T;
  /** 呼び出しが終わるたびに（成功も失敗も）時間・再試行・usage を受け取る */
  onCall?: (record: LocalCallRecord) => void;
}): Promise<T> {
  const env = localReviewEnv(input.env, input.config);
  const started = Date.now();
  let usage: LocalCallUsage | undefined;
  const finish = (retries: number) =>
    input.onCall?.({
      durationMs: Date.now() - started,
      retries,
      ...(usage ? { usage } : {}),
    });
  const add = (next: LocalCallUsage | undefined) => {
    if (!next) return;
    usage ??= {};
    for (const key of Object.keys(next) as (keyof LocalCallUsage)[])
      usage[key] = (usage[key] ?? 0) + (next[key] ?? 0);
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const called = await invoke(
        input.runner,
        input.cwd,
        env,
        input.config,
        input.prompt,
        input.schema,
      );
      add(called.usage);
      const parsed = parseJsonObject(called.text);
      if (input.validate(parsed)) {
        finish(attempt);
        return parsed;
      }
      lastError = new Error("返ってきた JSON の形が違います");
    } catch (error) {
      lastError = error;
    }
  }
  finish(1);
  throw new FlowError(
    1,
    `ローカルのレビュー結果を読めませんでした：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
