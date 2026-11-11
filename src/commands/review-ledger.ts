import { requireFlowConfig } from "../lib/flow-config.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "../lib/args.ts";
import { currentBranch, requireRoot } from "../lib/git.ts";
import {
  checkRevertRisk,
  readLedger,
  recordFinding,
  recordFix,
  recordOpus,
  writeLedger,
  type BehaviorChange,
  type FindingNoteInput,
  type FixNoteInput,
  type OpusNoteInput,
  type OpusVerdict,
} from "../lib/review-ledger.ts";
import { idFromBranch } from "../lib/task-id.ts";
import { FlowError, type Command } from "../types.ts";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new FlowError(
      1,
      `台帳の入力 JSON を読めません（${file}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseFixNote(raw: unknown): FixNoteInput {
  if (!isObject(raw))
    throw new FlowError(1, "修正メモは JSON のオブジェクトにしてください");
  const behavior = raw.behaviorChange;
  if (
    behavior !== "none" &&
    behavior !== "intentional" &&
    behavior !== "unknown"
  )
    throw new FlowError(
      1,
      'behaviorChange は "none"・"intentional"・"unknown" のどれかにしてください',
    );
  if (
    typeof raw.findingId !== "string" ||
    typeof raw.summary !== "string" ||
    typeof raw.intent !== "string" ||
    typeof raw.rationale !== "string" ||
    !isStringArray(raw.files) ||
    !isStringArray(raw.hunks) ||
    !isStringArray(raw.tests)
  )
    throw new FlowError(
      1,
      "修正メモには findingId・summary・intent・rationale・files・hunks・tests が必要です",
    );
  return {
    findingId: raw.findingId,
    commit: typeof raw.commit === "string" ? raw.commit : undefined,
    files: raw.files,
    hunks: raw.hunks,
    summary: raw.summary,
    intent: raw.intent,
    behaviorChange: behavior as BehaviorChange,
    rationale: raw.rationale,
    alternativesRejected:
      typeof raw.alternativesRejected === "string"
        ? raw.alternativesRejected
        : undefined,
    tests: raw.tests,
    residualRisk:
      typeof raw.residualRisk === "string" ? raw.residualRisk : undefined,
    compatibility:
      typeof raw.compatibility === "string" ? raw.compatibility : undefined,
    revertJustification:
      typeof raw.revertJustification === "string"
        ? raw.revertJustification
        : undefined,
  };
}

const OPUS_VERDICTS: readonly OpusVerdict[] = [
  "accept",
  "accept_intentional",
  "low_risk_ignore",
  "must_fix",
  "needs_human",
];

const SEVERITIES: readonly FindingNoteInput["severity"][] = [
  "must_fix",
  "should_fix",
  "check_only",
];

function parseFindingNote(raw: unknown): FindingNoteInput {
  if (!isObject(raw))
    throw new FlowError(1, "新しい指摘は JSON のオブジェクトにしてください");
  if (
    typeof raw.aspect !== "string" ||
    typeof raw.file !== "string" ||
    typeof raw.scenario !== "string" ||
    typeof raw.evidence !== "string" ||
    !SEVERITIES.includes(raw.severity as FindingNoteInput["severity"])
  )
    throw new FlowError(
      1,
      "新しい指摘には aspect・file・scenario・evidence・severity が必要です",
    );
  if (
    raw.line !== undefined &&
    (typeof raw.line !== "number" || !Number.isInteger(raw.line))
  )
    throw new FlowError(1, "新しい指摘の line は整数にしてください");
  if (raw.preExisting !== undefined && typeof raw.preExisting !== "boolean")
    throw new FlowError(
      1,
      "新しい指摘の preExisting は true か false にしてください",
    );
  if (raw.humanReview !== undefined && typeof raw.humanReview !== "boolean")
    throw new FlowError(
      1,
      "新しい指摘の humanReview は true か false にしてください",
    );
  return {
    aspect: raw.aspect,
    file: raw.file,
    line: typeof raw.line === "number" ? raw.line : undefined,
    scenario: raw.scenario,
    proposedFix:
      typeof raw.proposedFix === "string" ? raw.proposedFix : undefined,
    severity: raw.severity as FindingNoteInput["severity"],
    evidence: raw.evidence,
    preExisting:
      typeof raw.preExisting === "boolean" ? raw.preExisting : undefined,
    humanReview:
      typeof raw.humanReview === "boolean" ? raw.humanReview : undefined,
  };
}

function parseRevertNote(raw: unknown): {
  findingId?: string;
  hunks: string[];
  revertJustification?: string;
} {
  if (!isObject(raw) || !isStringArray(raw.hunks))
    throw new FlowError(1, "check-revert には hunks の配列が必要です");
  return {
    findingId: typeof raw.findingId === "string" ? raw.findingId : undefined,
    hunks: raw.hunks,
    revertJustification:
      typeof raw.revertJustification === "string"
        ? raw.revertJustification
        : undefined,
  };
}

function parseOpusNote(raw: unknown): OpusNoteInput {
  if (!isObject(raw))
    throw new FlowError(1, "Opus の裁定は JSON のオブジェクトにしてください");
  if (
    typeof raw.findingId !== "string" ||
    typeof raw.reason !== "string" ||
    !OPUS_VERDICTS.includes(raw.verdict as OpusVerdict)
  )
    throw new FlowError(
      1,
      "Opus の裁定には findingId・verdict・reason が必要です",
    );
  return {
    findingId: raw.findingId,
    verdict: raw.verdict as OpusVerdict,
    reason: raw.reason,
    newEvidence:
      typeof raw.newEvidence === "string" ? raw.newEvidence : undefined,
    revertJustification:
      typeof raw.revertJustification === "string"
        ? raw.revertJustification
        : undefined,
  };
}

const stageOf = (raw: string | undefined): number => {
  const stage = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(stage) || stage < 1)
    throw new FlowError(1, "--stage は1以上の整数にしてください");
  return stage;
};

/** タスクの worktree で、レビューの台帳を読み書きする */
export const run: Command = async (ctx) => {
  const parsed = parseArgs(ctx.argv, ["stage", "input"]);
  const [action] = parsed.positionals;
  if (
    action !== "show" &&
    action !== "record-fix" &&
    action !== "record-finding" &&
    action !== "record-opus" &&
    action !== "check-revert"
  )
    throw new FlowError(
      1,
      "使い方：orca-flow review-ledger <show|record-fix|record-finding|record-opus|check-revert> --stage 〈数〉 [--input 〈JSON〉]",
    );
  if (parsed.positionals.length > 1)
    throw new FlowError(1, "review-ledger の引数が多すぎます");

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  const branch = await currentBranch(ctx.runner, root);
  const id = branch
    ? idFromBranch(branch, config.branchPrefix, config.idPrefix)
    : null;
  if (!id)
    throw new FlowError(
      1,
      "タスクの worktree で review-ledger を呼んでください",
    );

  const stage = stageOf(parsed.values.get("stage"));
  const ledger = await readLedger(ctx.runner, root, id, stage);
  if (!ledger)
    throw new FlowError(
      2,
      `${id} の段${stage}のレビュー台帳がありません。先に orca-flow review-local を流してください`,
    );

  if (action === "show") {
    if (!ctx.json) ctx.stdout(JSON.stringify(ledger, null, 2));
    return { code: 0, data: ledger };
  }

  const input = parsed.values.get("input");
  if (!input)
    throw new FlowError(1, `${action} には --input 〈JSON のパス〉が必要です`);
  const raw = await readJson(path.resolve(ctx.cwd, input));

  if (action === "record-finding") {
    const note = parseFindingNote(raw);
    const finding = recordFinding(ledger, note, ctx.now().toISOString());
    await writeLedger(ctx.runner, root, ledger);
    if (!ctx.json) ctx.stdout(`新しい指摘 ${finding.id} を台帳に記録しました`);
    return { code: 0, data: finding };
  }

  if (action === "record-fix") {
    const note = parseFixNote(raw);
    if (config.localReview.revertGuard) {
      const overlaps = checkRevertRisk(ledger, note);
      if (overlaps.length > 0)
        throw new FlowError(
          1,
          `前の修正と重なる修正です（${overlaps.join(", ")}）。revertJustification を書いてください`,
        );
    }
    const finding = recordFix(ledger, note, ctx.now().toISOString());
    await writeLedger(ctx.runner, root, ledger);
    if (!ctx.json)
      ctx.stdout(
        `${finding.id} の修正メモを台帳に記録しました（${finding.status}）`,
      );
    return { code: 0, data: finding };
  }

  if (action === "record-opus") {
    const note = parseOpusNote(raw);
    if (
      config.localReview.requireNewEvidence &&
      note.verdict === "must_fix" &&
      !note.newEvidence?.trim()
    )
      throw new FlowError(
        1,
        `Opus の must-fix には newEvidence が必要です：${note.findingId}`,
      );
    const finding = recordOpus(ledger, note, ctx.now().toISOString());
    await writeLedger(ctx.runner, root, ledger);
    if (!ctx.json)
      ctx.stdout(`${finding.id} の Opus 裁定を記録しました（${note.verdict}）`);
    return { code: 0, data: finding };
  }

  const note = parseRevertNote(raw);
  const overlaps = checkRevertRisk(ledger, note);
  if (!ctx.json)
    ctx.stdout(
      overlaps.length === 0
        ? "前の修正と重なりません"
        : `前の修正と重なります：${overlaps.join(", ")}`,
    );
  return { code: overlaps.length === 0 ? 0 : 1, data: { overlaps } };
};
