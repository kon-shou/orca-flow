import type { FlowConfig } from "../config.ts";
import type { Runner } from "./exec.ts";
import { currentBranch } from "./git.ts";
import { GH_TIMEOUT_MS } from "./github.ts";
import { matchesShared } from "./overlap.ts";
import { stackBase } from "./stack.ts";
import { idFromBranch } from "./task-id.ts";

// リスク区分。PR が risk.paths・risk.labels に当たれば high、当たらなければ normal。
// 差分かラベルが読めない・PR の番号がないときは high（安全な側）。理由は決まった文に、当たったパスかラベルを添える。

export type RiskLevel = "high" | "normal";

export interface RiskResult {
  level: RiskLevel;
  reason: string;
}

const LABEL_LIMIT = 40;

/** 制御文字・書式文字を除き、短く切る。理由の文に入れる値に使う */
export function cleanForReason(text: string, limit = LABEL_LIMIT): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

export interface RiskInput {
  runner: Runner;
  /** タスクの worktree（HEAD がタスクのブランチ） */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 設定の全部を渡すと、cwd のタスクが乗せていれば土台（乗せた先の枝）からの差分を見る */
  config: Pick<FlowConfig, "risk" | "baseBranch"> | FlowConfig;
  /** PR の番号。なければ null */
  pr: number | null;
}

async function readLabels(
  input: RiskInput,
  pr: number,
): Promise<string[] | null> {
  const out = await input.runner(
    "gh",
    ["pr", "view", String(pr), "--json", "labels"],
    { cwd: input.cwd, timeoutMs: GH_TIMEOUT_MS },
  );
  if (out.code !== 0 || out.timedOut) return null;
  try {
    const parsed: unknown = JSON.parse(out.stdout);
    const labels =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { labels?: unknown }).labels
        : null;
    if (!Array.isArray(labels)) return null;
    return labels.flatMap((l) =>
      typeof l === "object" &&
      l !== null &&
      typeof (l as { name?: unknown }).name === "string"
        ? [(l as { name: string }).name]
        : [],
    );
  } catch {
    return null;
  }
}

const isFull = (config: RiskInput["config"]): config is FlowConfig =>
  "branchPrefix" in config && "idPrefix" in config;

/** 差分の元。cwd がタスクのブランチで設定の全部があれば土台、なければ baseBranch。土台を決められなければ投げる */
async function diffBase(input: RiskInput): Promise<string> {
  const config = input.config;
  if (!isFull(config)) return config.baseBranch;
  const branch = await currentBranch(input.runner, input.cwd);
  const id = branch
    ? idFromBranch(branch, config.branchPrefix, config.idPrefix)
    : null;
  return id === null
    ? config.baseBranch
    : stackBase(input.runner, input.cwd, config, id);
}

/** 差分のパス。quotepath を切り、\0 区切りで読む（日本語や " を含むパスが引用符つきで返らないように） */
async function changedFiles(input: RiskInput): Promise<string[]> {
  const base = await diffBase(input);
  const out = await input.runner(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${base}...HEAD`,
    ],
    { cwd: input.cwd },
  );
  if (out.code !== 0 || out.timedOut) throw new Error("git diff");
  return out.stdout.split("\0").filter((f) => f !== "");
}

export async function classifyRisk(input: RiskInput): Promise<RiskResult> {
  const high = (reason: string): RiskResult => ({ level: "high", reason });
  if (input.pr === null) return high("PR の番号がないので、高く見る");

  let files: string[];
  try {
    files = await changedFiles(input);
  } catch {
    return high("差分を読めなかったので、高く見る");
  }
  for (const file of files)
    for (const pattern of input.config.risk.paths)
      if (matchesShared(file, pattern))
        return high(`risk.paths に当たるパス：${cleanForReason(file, 120)}`);

  const labels = await readLabels(input, input.pr);
  if (labels === null) return high("ラベルを読めなかったので、高く見る");
  const wanted = input.config.risk.labels.map((l) => l.toLowerCase());
  for (const label of labels)
    if (wanted.includes(label.toLowerCase()))
      return high(`risk.labels に当たるラベル：${cleanForReason(label)}`);

  return { level: "normal", reason: "risk.paths・risk.labels に当たらない" };
}
