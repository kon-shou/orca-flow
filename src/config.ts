import { readFile } from "node:fs/promises";
import path from "node:path";
import { FlowError } from "./types.ts";

export const CONFIG_PATH = ".orca-flow/config.json";

export interface ProgressConfig {
  /** 進捗表の Markdown ファイル（リポジトリのトップからの相対パス） */
  file: string;
  /** 表の見出しの文字。列の位置は見出しから探す */
  columns: {
    id: string;
    title: string;
    depends: string;
    state: string;
    branch: string;
  };
  /** 進捗表に書く状態の言葉 */
  stateLabels: { designing: string; working: string; integrated: string };
}

export interface LeadConfig {
  /** orca の --agent */
  agent: string;
  /** orca の --model */
  model: string;
  /** orca の --effort */
  effort: string;
}

export interface PathVerify {
  /** 差分がこの場所にあるときだけ commands を足す */
  paths: string[];
  commands: string[];
}

/** コードレビュー（review スキル）の強さ。full＝いつもどおり、light＝軽く、off＝止める */
export type CodeReviewMode = "full" | "light" | "off";

const CODE_REVIEW_MODES: readonly CodeReviewMode[] = ["full", "light", "off"];

/** レビューを Claude の担当で回すか、ローカルのモデルで回すか */
export type ReviewBackend = "claude" | "local";

const REVIEW_BACKENDS: readonly ReviewBackend[] = ["claude", "local"];

/** 統合でテストをいつ確かめるか。after-merge＝先にマージして main をあとで確かめる、before-merge＝マージの前に記録を確かめて待つ */
export type IntegrateVerify = "after-merge" | "before-merge";

const INTEGRATE_VERIFY_MODES: readonly IntegrateVerify[] = [
  "after-merge",
  "before-merge",
];

/** タスクの終わり方。integrate＝統括役が main に統合する、pr＝PR を出して GitHub で終える */
export type TaskEnd = "integrate" | "pr";

const TASK_END_MODES: readonly TaskEnd[] = ["integrate", "pr"];

/** GitHub に書く送りの案の種類。返信などの種類は、使う実装の事前変更で足す */
export const OUTBOUND_KINDS = [
  "push",
  "pr-create",
  "pr-ready",
  "reply",
  "rerequest",
] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

/** 送る時間帯（その機械の時刻）。days は 0＝日曜〜6＝土曜、from・to は HH:MM */
export interface OutboundWindow {
  days: number[];
  from: string;
  to: string;
}

/** 書き込みの間（秒）と、1回の send で送る件数の上限 */
export interface OutboundInterval {
  seconds: number;
  perBatch: number;
}

/** GitHub の見張り（pr-watch）の間隔（分）と、残りの回数がこれを切ったら問い合わせを飛ばすしきい値と、同時に起こす新しい会話の上限 */
export interface PrWatchConfig {
  intervalMinutes: number;
  minRemaining: number;
  maxLaunches: number;
}

/** 作業のリスク区分：当たる PR の指摘は、合議の2票目をとらずに人に回す */
export interface RiskConfig {
  /** 差分のファイルがこれに当たる PR（パスの頭か glob） */
  paths: string[];
  /** このラベルがついた PR */
  labels: string[];
}

/** GitHub に書く送りの案の許可リスト・時間帯・間隔（6章 outbound） */
export interface OutboundConfig {
  allow: OutboundKind[];
  window: OutboundWindow;
  interval: OutboundInterval;
}

/** ローカルのモデルを動かす入口 */
export type LocalReviewRunner = "claude" | "opencode";

const LOCAL_REVIEW_RUNNERS: readonly LocalReviewRunner[] = [
  "claude",
  "opencode",
];

/** ローカルが使えないときの扱い。claude-once は Claude のレビューを1回だけ流す */
export type LocalReviewFallback = "claude-once" | "human";

const LOCAL_REVIEW_FALLBACKS: readonly LocalReviewFallback[] = [
  "claude-once",
  "human",
];

export interface LocalReviewConfig {
  /** OpenAI/Anthropic 互換の入口 */
  baseUrl: string;
  /** ローカルのモデル名 */
  model: string;
  /** ローカルを動かす入口 */
  runner: LocalReviewRunner;
  /** 1段目・2段目のレビュー回数の上限 */
  stageLimits: [number, number];
  /** フルレビューを行う周（1始まり） */
  fullReviewAt: number[];
  /** must-fix がなくなったら早く止める */
  stopOnNoMustFix: boolean;
  /** 同じ指摘が続いたときに止める回数 */
  repeatLimit: number;
  /** 1段あたりの時間の上限（分） */
  maxMinutes: number;
  /** 1回の修正で変えてよい行数の上限 */
  maxFixLines: number;
  /** Opus の裁定検証を行う回数の上限 */
  opusChecks: number;
  /** ローカルが使えないときの扱い */
  fallback: LocalReviewFallback;
  /** 修正の背景を台帳に残す */
  contextLedger: boolean;
  /** Opus の must-fix に新しい根拠を要求する */
  requireNewEvidence: boolean;
  /** 前の修正を打ち消す変更に理由を要求する */
  revertGuard: boolean;
  /** Opus 単独で見逃さず、人間に回す分類 */
  humanReviewCategories: string[];
}

export interface FlowConfig {
  baseBranch: string;
  idPrefix: string;
  branchPrefix: string;
  tasksDir: string;
  reportsDir: string;
  progress: ProgressConfig | null;
  readFirst: string[];
  verify: string[];
  pathVerify: PathVerify[];
  /** 差分がすべてこの中なら、統合でテスト（とテストの記録）を飛ばす */
  verifySkipPaths: string[];
  /** 共有のファイル。ファイル名だけのもの（"/" を含まないもの）は、どの階層のそのファイルにも当たる */
  sharedPaths: string[];
  appendOnlyFiles: string[];
  /** 決定の記録のファイル（appendOnlyFiles に入っていること）。null なら使わない */
  decisionsFile: string | null;
  maxActiveTasks: number;
  maxWorkersPerTask: number;
  lead: LeadConfig;
  workerAgent: string;
  reviewerAgent: string;
  codeReview: CodeReviewMode;
  reviewBackend: ReviewBackend;
  localReview: LocalReviewConfig;
  integrateVerify: IntegrateVerify;
  /** 設計の overlap で、作業中のほかのタスクとの重なりだけが問題のとき、マージの順に自動で足す */
  autoOrderOnOverlap: boolean;
  taskEnd: TaskEnd;
  outbound: OutboundConfig;
  prWatch: PrWatchConfig;
  risk: RiskConfig;
  integratorName: string;
}

export const DEFAULT_SHARED_PATHS: readonly string[] = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "uv.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "composer.json",
  "composer.lock",
  "CLAUDE.md",
  ".claude/",
  ".orca-flow/",
  "orca.yaml",
  ".gitattributes",
  ".worktreeinclude",
];

export const DEFAULT_PROGRESS: Omit<ProgressConfig, "file"> = {
  columns: {
    id: "ID",
    title: "タスク",
    depends: "依存",
    state: "状態",
    branch: "ブランチ",
  },
  stateLabels: {
    designing: "設計中",
    working: "作業中",
    integrated: "統合済み",
  },
};

export const DEFAULT_CONFIG: FlowConfig = {
  baseBranch: "main",
  idPrefix: "T",
  branchPrefix: "task/",
  tasksDir: "docs/tasks",
  reportsDir: "docs/tasks/reports",
  progress: null,
  readFirst: ["CLAUDE.md"],
  verify: [],
  pathVerify: [],
  verifySkipPaths: [],
  sharedPaths: [...DEFAULT_SHARED_PATHS],
  appendOnlyFiles: [],
  decisionsFile: null,
  maxActiveTasks: 3,
  maxWorkersPerTask: 3,
  lead: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
  workerAgent: "orca-flow:task-worker",
  reviewerAgent: "orca-flow:task-reviewer",
  codeReview: "full",
  reviewBackend: "claude",
  localReview: {
    baseUrl: "http://localhost:8080",
    model: "glm-5.3-flash",
    runner: "claude",
    stageLimits: [5, 3],
    fullReviewAt: [1, 3, 5],
    stopOnNoMustFix: true,
    repeatLimit: 2,
    maxMinutes: 120,
    maxFixLines: 300,
    opusChecks: 2,
    fallback: "claude-once",
    contextLedger: true,
    requireNewEvidence: true,
    revertGuard: true,
    humanReviewCategories: ["security", "auth", "data-loss", "migration"],
  },
  integrateVerify: "after-merge",
  autoOrderOnOverlap: true,
  taskEnd: "integrate",
  outbound: {
    allow: ["push", "pr-create", "pr-ready"],
    window: { days: [1, 2, 3, 4, 5], from: "09:00", to: "20:00" },
    interval: { seconds: 1, perBatch: 5 },
  },
  prWatch: { intervalMinutes: 5, minRemaining: 1000, maxLaunches: 3 },
  risk: { paths: [], labels: [] },

  integratorName: "統括役",
};

export interface LoadedConfig {
  config: FlowConfig;
  /** .orca-flow/config.json があったか */
  exists: boolean;
  /** config.json の絶対パス */
  path: string;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";
const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;
const isPositiveIntArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every(isPositiveInt);

/** ID の頭の文字の形（正規表現の中身）。ID の形（src/lib/task-id.ts）もこれから組む */
export const ID_PREFIX_PATTERN = "[A-Za-z][A-Za-z_-]*";

/** ID の頭の文字：英字で始まり、英字・「-」・「_」だけ（数字と「.」は ID の数と区切りが読めなくなる） */
const ID_PREFIX = new RegExp(`^${ID_PREFIX_PATTERN}$`);

/** ブランチの名前（の頭）に使える形。パスの外に出る文字と git の ref に使えない形をはじく */
function isSafeRefPart(value: string, whole: boolean): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (/^[-/.]/.test(value)) return false;
  if (/\.\.|\/\/|\/\./.test(value)) return false;
  if (value.split("/").some((part) => part.endsWith(".lock"))) return false;
  if (whole && /[/.]$/.test(value)) return false;
  return true;
}

/** 使わなくなったトップのキー。書いてあっても誤りにせず読み飛ばす */
const RETIRED_KEYS: ReadonlySet<string> = new Set(["prReady"]);

/** 書いていないキーは既定値で埋める。知らないキーと型の違いは FlowError(1) にまとめて投げる */
export function parseConfig(raw: unknown): FlowConfig {
  if (!isObject(raw))
    throw new FlowError(
      1,
      `${CONFIG_PATH} は JSON のオブジェクトにしてください`,
    );
  const problems: string[] = [];
  const config: FlowConfig = structuredClone(DEFAULT_CONFIG);
  const known = new Set(Object.keys(DEFAULT_CONFIG));

  for (const [key, value] of Object.entries(raw)) {
    // 使わなくなったキー（PR は下書きでなく出す）。前の設定に残っていても、どの値でも読み飛ばす
    if (RETIRED_KEYS.has(key)) continue;
    if (!known.has(key)) {
      problems.push(`知らないキー ${key}`);
      continue;
    }
    switch (key) {
      case "idPrefix":
        if (typeof value !== "string" || value === "")
          problems.push(`${key} は空でない文字列にしてください`);
        else if (!ID_PREFIX.test(value))
          problems.push(
            `${key} は英字で始まり、英字・「-」・「_」だけにしてください（数字と「.」は使えません。今の値：${JSON.stringify(value)}）`,
          );
        else config[key] = value;
        break;
      case "baseBranch":
      case "branchPrefix":
        if (typeof value !== "string" || value === "")
          problems.push(`${key} は空でない文字列にしてください`);
        else if (!isSafeRefPart(value, key === "baseBranch"))
          problems.push(
            `${key} は英数字・「.」・「_」・「-」・「/」だけで、「-」「/」「.」で始まらず、「..」「//」「/.」を含まず、各部分が「.lock」で終わらない形にしてください${key === "baseBranch" ? "（「/」と「.」でも終わらない）" : ""}（今の値：${JSON.stringify(value)}）`,
          );
        else config[key] = value;
        break;
      case "tasksDir":
      case "reportsDir":
      case "workerAgent":
      case "reviewerAgent":
      case "integratorName":
        if (typeof value === "string" && value !== "") config[key] = value;
        else problems.push(`${key} は空でない文字列にしてください`);
        break;
      case "readFirst":
      case "verify":
      case "sharedPaths":
        if (isStringArray(value)) config[key] = value;
        else problems.push(`${key} は文字列の配列にしてください`);
        break;
      case "appendOnlyFiles":
        if (!isStringArray(value))
          problems.push(`${key} は文字列の配列にしてください`);
        // 空の文字列・「.」・グロブだけの値はすべてのファイルに当たり、見直しの指紋から全部のファイルが外れてしまう
        else if (value.some((item) => /^[\s./*?]*$/.test(item)))
          problems.push(
            `${key} に空の文字列・「.」・グロブだけの値は書けません（すべてのファイルに当たり、見直しとテストの記録の確かめが何でも通るため）`,
          );
        else config[key] = value;
        break;
      case "verifySkipPaths":
        if (!isStringArray(value))
          problems.push(`${key} は文字列の配列にしてください`);
        // 空の文字列はすべてのファイルに当たり、どの統合でもテストを飛ばしてしまう
        else if (value.some((item) => item.trim() === ""))
          problems.push(
            `${key} に空の文字列は書けません（すべてのファイルに当たり、テストが飛ばされるため）`,
          );
        else config[key] = value;
        break;
      case "codeReview":
        if (CODE_REVIEW_MODES.includes(value as CodeReviewMode))
          config.codeReview = value as CodeReviewMode;
        else
          problems.push(
            'codeReview は "full"・"light"・"off" のどれかにしてください',
          );
        break;
      case "reviewBackend":
        if (REVIEW_BACKENDS.includes(value as ReviewBackend))
          config.reviewBackend = value as ReviewBackend;
        else
          problems.push(
            'reviewBackend は "claude"・"local" のどちらかにしてください',
          );
        break;
      case "integrateVerify":
        if (INTEGRATE_VERIFY_MODES.includes(value as IntegrateVerify))
          config.integrateVerify = value as IntegrateVerify;
        else
          problems.push(
            'integrateVerify は "after-merge"・"before-merge" のどちらかにしてください',
          );
        break;
      case "autoOrderOnOverlap":
        if (typeof value === "boolean") config.autoOrderOnOverlap = value;
        else problems.push(`${key} は true か false にしてください`);
        break;
      case "taskEnd":
        if (TASK_END_MODES.includes(value as TaskEnd))
          config.taskEnd = value as TaskEnd;
        else
          problems.push(
            'taskEnd は "integrate"・"pr" のどちらかにしてください',
          );
        break;
      case "prWatch":
        if (isObject(value)) config.prWatch = parsePrWatch(value, problems);
        else problems.push("prWatch はオブジェクトにしてください");
        break;
      case "risk":
        if (isObject(value)) config.risk = parseRisk(value, problems);
        else problems.push("risk はオブジェクトにしてください");
        break;
      case "outbound":
        if (isObject(value)) config.outbound = parseOutbound(value, problems);
        else problems.push("outbound はオブジェクトにしてください");
        break;
      case "localReview":
        if (isObject(value))
          config.localReview = parseLocalReview(value, problems);
        else problems.push("localReview はオブジェクトにしてください");
        break;
      case "maxActiveTasks":
      case "maxWorkersPerTask":
        if (typeof value === "number" && Number.isInteger(value) && value >= 1)
          config[key] = value;
        else problems.push(`${key} は1以上の整数にしてください`);
        break;
      case "pathVerify":
        if (
          Array.isArray(value) &&
          value.every(
            (item) =>
              isObject(item) &&
              isStringArray(item.paths) &&
              isStringArray(item.commands),
          )
        ) {
          config.pathVerify = value.map((item) => ({
            paths: (item as Raw).paths as string[],
            commands: (item as Raw).commands as string[],
          }));
        } else {
          problems.push(
            "pathVerify は { paths: string[], commands: string[] } の配列にしてください",
          );
        }
        break;
      case "lead":
        if (isObject(value)) {
          for (const [leadKey, leadValue] of Object.entries(value)) {
            if (
              leadKey === "agent" ||
              leadKey === "model" ||
              leadKey === "effort"
            ) {
              if (typeof leadValue === "string" && leadValue !== "")
                config.lead[leadKey] = leadValue;
              else
                problems.push(`lead.${leadKey} は空でない文字列にしてください`);
            } else {
              problems.push(`知らないキー lead.${leadKey}`);
            }
          }
        } else {
          problems.push("lead はオブジェクトにしてください");
        }
        break;
      case "decisionsFile":
        if (value === null) config.decisionsFile = null;
        else if (typeof value === "string" && value !== "")
          config.decisionsFile = value;
        else
          problems.push("decisionsFile は null か空でない文字列にしてください");
        break;
      case "progress":
        if (value === null) {
          config.progress = null;
        } else if (
          isObject(value) &&
          typeof value.file === "string" &&
          value.file !== ""
        ) {
          config.progress = parseProgress(value, problems);
        } else {
          problems.push(
            "progress は null か、file を持つオブジェクトにしてください",
          );
        }
        break;
    }
  }

  // 書く順によらず照らすため、全部のキーを読んだあとで確かめる
  if (
    config.decisionsFile !== null &&
    !config.appendOnlyFiles.includes(config.decisionsFile)
  )
    problems.push(
      `decisionsFile は appendOnlyFiles に入れてください（${config.decisionsFile}）`,
    );

  if (problems.length > 0) {
    throw new FlowError(
      1,
      `${CONFIG_PATH} に直すところがあります：\n- ${problems.join("\n- ")}`,
    );
  }
  return config;
}

const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function parsePrWatch(value: Raw, problems: string[]): PrWatchConfig {
  const prWatch = structuredClone(DEFAULT_CONFIG.prWatch);
  for (const [key, inner] of Object.entries(value)) {
    switch (key) {
      case "intervalMinutes":
        if (isPositiveInt(inner)) prWatch.intervalMinutes = inner;
        else
          problems.push("prWatch.intervalMinutes は1以上の整数にしてください");
        break;
      case "maxLaunches":
        if (isPositiveInt(inner)) prWatch.maxLaunches = inner;
        else problems.push("prWatch.maxLaunches は1以上の整数にしてください");
        break;
      case "minRemaining":
        if (typeof inner === "number" && Number.isInteger(inner) && inner >= 0)
          prWatch.minRemaining = inner;
        else problems.push("prWatch.minRemaining は0以上の整数にしてください");
        break;
      default:
        problems.push(`知らないキー prWatch.${key}`);
    }
  }
  return prWatch;
}

function parseRisk(value: Raw, problems: string[]): RiskConfig {
  const risk = structuredClone(DEFAULT_CONFIG.risk);
  for (const [key, inner] of Object.entries(value)) {
    switch (key) {
      case "paths":
      case "labels":
        // 空の文字列は全部のパス・ラベルに当たるので誤りにする
        if (isStringArray(inner) && inner.every((item) => item.trim() !== ""))
          risk[key] = inner;
        else problems.push(`risk.${key} は空でない文字列の配列にしてください`);
        break;
      default:
        problems.push(`知らないキー risk.${key}`);
    }
  }
  return risk;
}

function parseOutbound(value: Raw, problems: string[]): OutboundConfig {
  const outbound = structuredClone(DEFAULT_CONFIG.outbound);
  for (const [key, inner] of Object.entries(value)) {
    switch (key) {
      case "allow":
        if (
          isStringArray(inner) &&
          inner.every((kind) =>
            (OUTBOUND_KINDS as readonly string[]).includes(kind),
          )
        )
          outbound.allow = inner as OutboundKind[];
        else
          problems.push(
            `outbound.allow は ${OUTBOUND_KINDS.map((k) => `"${k}"`).join("・")} の中から選んだ配列にしてください`,
          );
        break;
      case "window":
        if (isObject(inner)) outbound.window = parseWindow(inner, problems);
        else problems.push("outbound.window はオブジェクトにしてください");
        break;
      case "interval":
        if (isObject(inner)) outbound.interval = parseInterval(inner, problems);
        else problems.push("outbound.interval はオブジェクトにしてください");
        break;
      default:
        problems.push(`知らないキー outbound.${key}`);
    }
  }
  return outbound;
}

function parseWindow(value: Raw, problems: string[]): OutboundWindow {
  const window = structuredClone(DEFAULT_CONFIG.outbound.window);
  for (const [key, inner] of Object.entries(value)) {
    switch (key) {
      case "days":
        if (
          Array.isArray(inner) &&
          inner.every(
            (day) =>
              typeof day === "number" &&
              Number.isInteger(day) &&
              day >= 0 &&
              day <= 6,
          )
        )
          window.days = inner as number[];
        else
          problems.push(
            "outbound.window.days は 0（日曜）〜6（土曜）の整数の配列にしてください",
          );
        break;
      case "from":
      case "to":
        if (typeof inner === "string" && TIME_OF_DAY.test(inner))
          window[key] = inner;
        else
          problems.push(
            `outbound.window.${key} は HH:MM（00:00〜23:59）にしてください`,
          );
        break;
      default:
        problems.push(`知らないキー outbound.window.${key}`);
    }
  }
  return window;
}

function parseInterval(value: Raw, problems: string[]): OutboundInterval {
  const interval = structuredClone(DEFAULT_CONFIG.outbound.interval);
  for (const [key, inner] of Object.entries(value)) {
    switch (key) {
      case "seconds":
        if (typeof inner === "number" && Number.isFinite(inner) && inner > 0)
          interval.seconds = inner;
        else
          problems.push(
            "outbound.interval.seconds は0より大きい数にしてください",
          );
        break;
      case "perBatch":
        if (isPositiveInt(inner)) interval.perBatch = inner;
        else
          problems.push(
            "outbound.interval.perBatch は1以上の整数にしてください",
          );
        break;
      default:
        problems.push(`知らないキー outbound.interval.${key}`);
    }
  }
  return interval;
}

function parseLocalReview(value: Raw, problems: string[]): LocalReviewConfig {
  const local = structuredClone(DEFAULT_CONFIG.localReview);
  const known = new Set(Object.keys(local));

  for (const [key, inner] of Object.entries(value)) {
    if (!known.has(key)) {
      problems.push(`知らないキー localReview.${key}`);
      continue;
    }
    switch (key) {
      case "baseUrl":
      case "model":
        if (isNonEmptyString(inner)) local[key] = inner;
        else problems.push(`localReview.${key} は空でない文字列にしてください`);
        break;
      case "runner":
        if (LOCAL_REVIEW_RUNNERS.includes(inner as LocalReviewRunner))
          local.runner = inner as LocalReviewRunner;
        else
          problems.push(
            'localReview.runner は "claude"・"opencode" のどちらかにしてください',
          );
        break;
      case "fallback":
        if (LOCAL_REVIEW_FALLBACKS.includes(inner as LocalReviewFallback))
          local.fallback = inner as LocalReviewFallback;
        else
          problems.push(
            'localReview.fallback は "claude-once"・"human" のどちらかにしてください',
          );
        break;
      case "stageLimits":
        if (
          Array.isArray(inner) &&
          inner.length === 2 &&
          inner.every(isPositiveInt)
        )
          local.stageLimits = [inner[0] as number, inner[1] as number];
        else
          problems.push(
            "localReview.stageLimits は1以上の整数を2つ並べてください",
          );
        break;
      case "fullReviewAt":
        if (isPositiveIntArray(inner)) local.fullReviewAt = inner;
        else
          problems.push(
            "localReview.fullReviewAt は1以上の整数の配列にしてください",
          );
        break;
      case "humanReviewCategories":
        if (isStringArray(inner) && inner.every(isNonEmptyString))
          local.humanReviewCategories = inner;
        else
          problems.push(
            "localReview.humanReviewCategories は空でない文字列の配列にしてください",
          );
        break;
      case "stopOnNoMustFix":
      case "contextLedger":
      case "requireNewEvidence":
      case "revertGuard":
        if (typeof inner === "boolean") local[key] = inner;
        else
          problems.push(`localReview.${key} は true か false にしてください`);
        break;
      case "repeatLimit":
      case "maxMinutes":
      case "maxFixLines":
      case "opusChecks":
        if (isPositiveInt(inner)) local[key] = inner;
        else problems.push(`localReview.${key} は1以上の整数にしてください`);
        break;
    }
  }
  return local;
}

function parseProgress(value: Raw, problems: string[]): ProgressConfig {
  const progress: ProgressConfig = {
    file: value.file as string,
    ...structuredClone(DEFAULT_PROGRESS),
  };
  for (const [key, inner] of Object.entries(value)) {
    if (key === "file") continue;
    if (key !== "columns" && key !== "stateLabels") {
      problems.push(`知らないキー progress.${key}`);
      continue;
    }
    if (!isObject(inner)) {
      problems.push(`progress.${key} はオブジェクトにしてください`);
      continue;
    }
    const target = progress[key] as Record<string, string>;
    for (const [innerKey, innerValue] of Object.entries(inner)) {
      if (!(innerKey in target))
        problems.push(`知らないキー progress.${key}.${innerKey}`);
      else if (typeof innerValue !== "string" || innerValue === "")
        problems.push(
          `progress.${key}.${innerKey} は空でない文字列にしてください`,
        );
      else target[innerKey] = innerValue;
    }
  }
  return progress;
}

/** root（git のトップ）の .orca-flow/config.json を読む。なければ既定値と exists: false を返す */
export async function loadConfig(root: string): Promise<LoadedConfig> {
  const file = path.join(root, CONFIG_PATH);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        config: structuredClone(DEFAULT_CONFIG),
        exists: false,
        path: file,
      };
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FlowError(1, `${CONFIG_PATH} が JSON として読めません`);
  }
  return { config: parseConfig(raw), exists: true, path: file };
}

/** init と context 以外のサブコマンドが使う。設定がなければ FlowError(2) */
export async function requireConfig(root: string): Promise<FlowConfig> {
  const loaded = await loadConfig(root);
  if (!loaded.exists) {
    throw new FlowError(
      2,
      "このリポジトリには orca-flow の設定がありません。メインのチェックアウトのタブで /orca-flow:init を流してください",
    );
  }
  return loaded.config;
}
