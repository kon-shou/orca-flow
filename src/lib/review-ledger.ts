import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Runner } from "./exec.ts";
import { gitCommonDir } from "./git.ts";
import { requireIdShape } from "./task-id.ts";
import { FlowError } from "../types.ts";

export type FindingVerdict = "confirmed" | "likely" | "wrong";
export type FindingSeverity = "must_fix" | "should_fix" | "check_only";
export type FindingStatus =
  | "open"
  | "fixed"
  | "fixed_intentional"
  | "not_fixed"
  | "accepted_risk"
  | "wontfix";
export type BehaviorChange = "none" | "intentional" | "unknown";
export type OpusVerdict =
  | "accept"
  | "accept_intentional"
  | "low_risk_ignore"
  | "must_fix"
  | "needs_human";

export interface ReviewFix {
  commit?: string;
  files: string[];
  hunks: string[];
  summary: string;
  intent: string;
  behaviorChange: BehaviorChange;
  rationale: string;
  alternativesRejected?: string;
  tests: string[];
  residualRisk?: string;
  compatibility?: string;
  revertJustification?: string;
}

export interface OpusDecision {
  verdict: OpusVerdict;
  reason: string;
  newEvidence?: string;
  revertJustification?: string;
  at: string;
}

export interface ReviewFinding {
  id: string;
  aspect: string;
  file: string;
  line?: number;
  scenario: string;
  proposedFix?: string;
  severity: FindingSeverity;
  verdict: FindingVerdict;
  evidence: string;
  preExisting: boolean;
  humanReview?: boolean;
  status: FindingStatus;
  fix?: ReviewFix;
  opus?: OpusDecision;
}

/** review-local の1周の1回の呼び出し。トークンは取れなければ省く */
export interface ReviewRoundCall {
  /** reviewer・verifier・redo-verifier */
  kind: string;
  durationMs: number;
  /** 再試行の回数（1回で通れば0） */
  retries: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

/** review-local の1周の計測。ledger.rounds に周ごとに1つずつ足す */
export interface ReviewRound {
  stage: number;
  cycle: number;
  mode: "first" | "redo";
  startedAt: string;
  durationMs: number;
  calls: ReviewRoundCall[];
}

export interface ReviewLedger {
  taskId: string;
  stage: number;
  baseBranch: string;
  range: string;
  createdAt: string;
  updatedAt: string;
  findings: ReviewFinding[];
  acceptedRisks: string[];
  notes: string[];
  /** 周ごとの計測。前からある台帳にはない */
  rounds?: ReviewRound[];
}

export interface FixNoteInput {
  findingId: string;
  commit?: string;
  files: string[];
  hunks: string[];
  summary: string;
  intent: string;
  behaviorChange: BehaviorChange;
  rationale: string;
  alternativesRejected?: string;
  tests: string[];
  residualRisk?: string;
  compatibility?: string;
  revertJustification?: string;
}

export interface OpusNoteInput {
  findingId: string;
  verdict: OpusVerdict;
  reason: string;
  newEvidence?: string;
  revertJustification?: string;
}

export interface FindingNoteInput {
  aspect: string;
  file: string;
  line?: number;
  scenario: string;
  proposedFix?: string;
  severity: FindingSeverity;
  evidence: string;
  preExisting?: boolean;
  humanReview?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export async function reviewLedgerDir(
  runner: Runner,
  cwd: string,
): Promise<string> {
  return path.join(await gitCommonDir(runner, cwd), "orca-flow", "reviews");
}

export async function reviewLedgerPath(
  runner: Runner,
  cwd: string,
  id: string,
  stage: number,
): Promise<string> {
  requireIdShape(id);
  return path.join(
    await reviewLedgerDir(runner, cwd),
    id,
    `stage-${stage}.json`,
  );
}

export function createLedger(input: {
  taskId: string;
  stage: number;
  baseBranch: string;
  range: string;
  now: string;
}): ReviewLedger {
  return {
    taskId: input.taskId,
    stage: input.stage,
    baseBranch: input.baseBranch,
    range: input.range,
    createdAt: input.now,
    updatedAt: input.now,
    findings: [],
    acceptedRisks: [],
    notes: [],
  };
}

export async function readLedger(
  runner: Runner,
  cwd: string,
  id: string,
  stage: number,
): Promise<ReviewLedger | null> {
  const file = await reviewLedgerPath(runner, cwd, id, stage);
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isLedger(raw)) return null;
    // 計測は付け足しの情報。壊れていても指摘は読めるようにする
    if (raw.rounds !== undefined && !Array.isArray(raw.rounds))
      delete raw.rounds;
    return raw;
  } catch {
    return null;
  }
}

export async function writeLedger(
  runner: Runner,
  cwd: string,
  ledger: ReviewLedger,
): Promise<void> {
  const file = await reviewLedgerPath(runner, cwd, ledger.taskId, ledger.stage);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(temp, file);
}

export function findingFingerprint(finding: ReviewFinding): string {
  const normalize = (text: string) =>
    text.toLowerCase().replace(/\s+/g, " ").trim();
  return [
    normalize(finding.file),
    finding.line ?? "",
    normalize(finding.aspect),
    normalize(finding.scenario),
  ].join("|");
}

export function mustFix(finding: ReviewFinding): boolean {
  return (
    finding.verdict === "confirmed" &&
    finding.severity === "must_fix" &&
    !finding.preExisting &&
    finding.humanReview !== true &&
    finding.status !== "fixed" &&
    finding.status !== "fixed_intentional" &&
    finding.status !== "accepted_risk" &&
    finding.status !== "wontfix" &&
    finding.opus?.verdict !== "accept" &&
    finding.opus?.verdict !== "accept_intentional" &&
    finding.opus?.verdict !== "low_risk_ignore" &&
    finding.opus?.verdict !== "needs_human"
  );
}

export function recordFix(
  ledger: ReviewLedger,
  input: FixNoteInput,
  now: string,
): ReviewFinding {
  const finding = ledger.findings.find((item) => item.id === input.findingId);
  if (!finding)
    throw new FlowError(1, `台帳に指摘 ${input.findingId} がありません`);
  if (input.files.length === 0 || input.hunks.length === 0)
    throw new FlowError(1, "修正の files と hunks は1つ以上にしてください");
  if (input.files.some((file) => file.trim() === ""))
    throw new FlowError(1, "修正の files に空のファイル名は書けません");
  if (input.hunks.some((hunk) => parseHunk(hunk) === null))
    throw new FlowError(
      1,
      "修正の hunks は src/foo.ts:12 か src/foo.ts:12-20 の形にしてください",
    );
  if (input.summary.trim() === "" || input.intent.trim() === "")
    throw new FlowError(1, "修正の summary と intent は空にできません");
  finding.fix = {
    commit: input.commit,
    files: input.files,
    hunks: input.hunks,
    summary: input.summary,
    intent: input.intent,
    behaviorChange: input.behaviorChange,
    rationale: input.rationale,
    alternativesRejected: input.alternativesRejected,
    tests: input.tests,
    residualRisk: input.residualRisk,
    compatibility: input.compatibility,
    revertJustification: input.revertJustification,
  };
  finding.status =
    input.behaviorChange === "intentional" ? "fixed_intentional" : "fixed";
  ledger.updatedAt = now;
  return finding;
}

export function recordFinding(
  ledger: ReviewLedger,
  input: FindingNoteInput,
  now: string,
): ReviewFinding {
  if (
    input.aspect.trim() === "" ||
    input.file.trim() === "" ||
    input.scenario.trim() === "" ||
    input.evidence.trim() === ""
  )
    throw new FlowError(
      1,
      "新しい指摘の aspect・file・scenario・evidence は空にできません",
    );
  const next =
    ledger.findings.reduce((max, finding) => {
      const number = Number(finding.id.replace(/^F/, ""));
      return Number.isInteger(number) ? Math.max(max, number) : max;
    }, 0) + 1;
  const finding: ReviewFinding = {
    id: `F${next}`,
    aspect: input.aspect,
    file: input.file,
    line: input.line,
    scenario: input.scenario,
    proposedFix: input.proposedFix,
    severity: input.severity,
    verdict: "confirmed",
    evidence: input.evidence,
    preExisting: input.preExisting ?? false,
    humanReview: input.humanReview,
    status: input.humanReview ? "not_fixed" : "open",
  };
  ledger.findings.push(finding);
  ledger.updatedAt = now;
  return finding;
}

export function recordOpus(
  ledger: ReviewLedger,
  input: OpusNoteInput,
  now: string,
): ReviewFinding {
  const finding = ledger.findings.find((item) => item.id === input.findingId);
  if (!finding)
    throw new FlowError(1, `台帳に指摘 ${input.findingId} がありません`);
  if (input.reason.trim() === "")
    throw new FlowError(1, "Opus の裁定の reason は空にできません");
  finding.opus = {
    verdict: input.verdict,
    reason: input.reason,
    newEvidence: input.newEvidence,
    revertJustification: input.revertJustification,
    at: now,
  };
  if (input.verdict === "accept")
    finding.status = finding.fix ? "fixed" : "accepted_risk";
  else if (input.verdict === "accept_intentional")
    finding.status = finding.fix ? "fixed_intentional" : "accepted_risk";
  else if (input.verdict === "low_risk_ignore")
    finding.status = "accepted_risk";
  if (finding.status === "accepted_risk") {
    const risk = `${finding.id}: ${input.reason}`;
    if (!ledger.acceptedRisks.includes(risk)) ledger.acceptedRisks.push(risk);
  } else if (input.verdict === "must_fix" || input.verdict === "needs_human")
    finding.status = "not_fixed";
  ledger.updatedAt = now;
  return finding;
}

/** `src/foo.ts:12-20` のような hunk をファイルと行範囲に分ける */
function parseHunk(
  hunk: string,
): { file: string; start: number; end: number } | null {
  const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(hunk.trim());
  if (!match) return null;
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  return { file: match[1]!, start, end };
}

/** 新しい hunk が、以前の修正 hunk と重なる指摘の ID を返す */
export function overlappingFixIds(
  ledger: ReviewLedger,
  hunks: readonly string[],
  exceptId?: string,
): string[] {
  const next = hunks.map(parseHunk).filter((hunk) => hunk !== null);
  const ids = new Set<string>();
  for (const finding of ledger.findings) {
    if (finding.id === exceptId) continue;
    if (!finding.fix || finding.status === "open") continue;
    for (const oldText of finding.fix.hunks) {
      const old = parseHunk(oldText);
      if (!old) continue;
      if (
        next.some(
          (item) =>
            item.file === old.file &&
            item.start <= old.end &&
            old.start <= item.end,
        )
      )
        ids.add(finding.id);
    }
  }
  return [...ids];
}

export interface RevertCheckInput {
  findingId?: string;
  hunks: readonly string[];
  revertJustification?: string;
}

export function checkRevertRisk(
  ledger: ReviewLedger,
  input: RevertCheckInput,
): string[] {
  if (input.hunks.some((hunk) => parseHunk(hunk) === null))
    throw new FlowError(
      1,
      "hunks は src/foo.ts:12 か src/foo.ts:12-20 の形にしてください",
    );
  if (input.revertJustification?.trim()) return [];
  return overlappingFixIds(ledger, input.hunks, input.findingId);
}

function isLedger(value: unknown): value is ReviewLedger {
  if (!isObject(value)) return false;
  if (
    typeof value.taskId !== "string" ||
    typeof value.stage !== "number" ||
    typeof value.baseBranch !== "string" ||
    typeof value.range !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.findings) ||
    !isStringArray(value.acceptedRisks) ||
    !isStringArray(value.notes)
  )
    return false;
  return value.findings.every(isFinding);
}

const VERDICTS: readonly FindingVerdict[] = ["confirmed", "likely", "wrong"];
const SEVERITIES: readonly FindingSeverity[] = [
  "must_fix",
  "should_fix",
  "check_only",
];
const STATUSES: readonly FindingStatus[] = [
  "open",
  "fixed",
  "fixed_intentional",
  "not_fixed",
  "accepted_risk",
  "wontfix",
];
const BEHAVIORS: readonly BehaviorChange[] = ["none", "intentional", "unknown"];

function isFinding(value: unknown): value is ReviewFinding {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.aspect === "string" &&
    typeof value.file === "string" &&
    (value.line === undefined || typeof value.line === "number") &&
    typeof value.scenario === "string" &&
    (value.proposedFix === undefined ||
      typeof value.proposedFix === "string") &&
    SEVERITIES.includes(value.severity as FindingSeverity) &&
    VERDICTS.includes(value.verdict as FindingVerdict) &&
    typeof value.evidence === "string" &&
    typeof value.preExisting === "boolean" &&
    (value.humanReview === undefined ||
      typeof value.humanReview === "boolean") &&
    STATUSES.includes(value.status as FindingStatus) &&
    (value.fix === undefined || isFix(value.fix)) &&
    (value.opus === undefined || isOpus(value.opus))
  );
}

function isFix(value: unknown): value is ReviewFix {
  if (!isObject(value)) return false;
  return (
    (value.commit === undefined || typeof value.commit === "string") &&
    isStringArray(value.files) &&
    isStringArray(value.hunks) &&
    typeof value.summary === "string" &&
    typeof value.intent === "string" &&
    BEHAVIORS.includes(value.behaviorChange as BehaviorChange) &&
    typeof value.rationale === "string" &&
    (value.alternativesRejected === undefined ||
      typeof value.alternativesRejected === "string") &&
    isStringArray(value.tests) &&
    (value.residualRisk === undefined ||
      typeof value.residualRisk === "string") &&
    (value.compatibility === undefined ||
      typeof value.compatibility === "string") &&
    (value.revertJustification === undefined ||
      typeof value.revertJustification === "string")
  );
}

function isOpus(value: unknown): value is OpusDecision {
  if (!isObject(value)) return false;
  return (
    [
      "accept",
      "accept_intentional",
      "low_risk_ignore",
      "must_fix",
      "needs_human",
    ].includes(value.verdict as string) &&
    typeof value.reason === "string" &&
    (value.newEvidence === undefined ||
      typeof value.newEvidence === "string") &&
    (value.revertJustification === undefined ||
      typeof value.revertJustification === "string") &&
    typeof value.at === "string"
  );
}
