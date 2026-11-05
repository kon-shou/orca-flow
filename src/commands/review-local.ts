import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { currentBranch, requireRoot } from "../lib/git.ts";
import {
  buildRedoVerifierPrompt,
  buildReviewerPrompt,
  buildVerifierPrompt,
  readAgentPrompt,
  REDO_VERIFIER_SCHEMA,
  REVIEWER_SCHEMA,
  runLocalJson,
  VERIFIER_SCHEMA,
  type LocalCallRecord,
  type RawFinding,
  type RawRedoResult,
  type RawVerifiedFinding,
  type RawVerification,
} from "../lib/local-review.ts";
import {
  createLedger,
  findingFingerprint,
  mustFix,
  readLedger,
  reviewLedgerPath,
  writeLedger,
  type ReviewFinding,
  type ReviewLedger,
  type ReviewRoundCall,
} from "../lib/review-ledger.ts";
import { taskDocPath } from "../lib/tasks.ts";
import { idFromBranch } from "../lib/task-id.ts";
import { FlowError, type Command } from "../types.ts";

const REF = /^[A-Za-z0-9/._-]+$/;
const SEVERITIES = ["must_fix", "should_fix", "check_only"] as const;
const VERDICTS = ["confirmed", "likely", "wrong"] as const;
const REDO_STATUSES = ["fixed", "fixed_intentional", "not_fixed"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isRange(value: string): boolean {
  const split = value.includes("...") ? "..." : "..";
  const parts = value.split(split);
  return (
    parts.length === 2 &&
    parts.every(
      (part) =>
        REF.test(part) &&
        !part.startsWith("-") &&
        !part.includes("..") &&
        part !== "",
    )
  );
}

function isRawFinding(value: unknown): value is RawFinding {
  if (!isObject(value)) return false;
  return (
    typeof value.aspect === "string" &&
    typeof value.file === "string" &&
    (value.line === undefined || typeof value.line === "number") &&
    typeof value.scenario === "string" &&
    (value.proposedFix === undefined ||
      typeof value.proposedFix === "string") &&
    SEVERITIES.includes(value.severity as (typeof SEVERITIES)[number])
  );
}

function isReviewerResult(value: unknown): value is { findings: RawFinding[] } {
  return (
    isObject(value) &&
    Array.isArray(value.findings) &&
    value.findings.every(isRawFinding)
  );
}

function isVerification(value: unknown): value is RawVerification {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    VERDICTS.includes(value.verdict as (typeof VERDICTS)[number]) &&
    SEVERITIES.includes(value.severity as (typeof SEVERITIES)[number]) &&
    typeof value.preExisting === "boolean" &&
    typeof value.evidence === "string"
  );
}

function isVerifierResult(
  value: unknown,
): value is { findings: RawVerification[] } {
  return (
    isObject(value) &&
    Array.isArray(value.findings) &&
    value.findings.every(isVerification)
  );
}

function isRedoResult(value: unknown): value is RawRedoResult {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    REDO_STATUSES.includes(value.status as (typeof REDO_STATUSES)[number]) &&
    typeof value.reason === "string" &&
    (value.evidence === undefined || typeof value.evidence === "string")
  );
}

function isVerifiedFinding(value: unknown): value is RawVerifiedFinding {
  if (!isRawFinding(value) || !isObject(value)) return false;
  return (
    VERDICTS.includes(value.verdict as (typeof VERDICTS)[number]) &&
    typeof value.preExisting === "boolean" &&
    typeof value.evidence === "string"
  );
}

function isRedoVerifierResult(value: unknown): value is {
  results: RawRedoResult[];
  newFindings: RawVerifiedFinding[];
} {
  return (
    isObject(value) &&
    Array.isArray(value.results) &&
    value.results.every(isRedoResult) &&
    Array.isArray(value.newFindings) &&
    value.newFindings.every(isVerifiedFinding)
  );
}

const toFinding = (finding: RawFinding, index: number): ReviewFinding => ({
  id: `F${index + 1}`,
  aspect: finding.aspect,
  file: finding.file,
  line: finding.line,
  scenario: finding.scenario,
  proposedFix: finding.proposedFix,
  severity: finding.severity,
  verdict: "likely",
  evidence: "レビュー役の指摘。検証前",
  preExisting: false,
  status: "open",
});

const toVerifiedFinding = (
  finding: RawVerifiedFinding,
  index: number,
): ReviewFinding => ({
  ...toFinding(finding, index),
  verdict: finding.verdict,
  preExisting: finding.preExisting,
  evidence: finding.evidence,
  status: finding.verdict === "wrong" ? "wontfix" : "open",
});

const verifyFinding = (
  finding: ReviewFinding,
  verification: RawVerification,
): ReviewFinding => ({
  ...finding,
  verdict: verification.verdict,
  severity: verification.severity,
  preExisting: verification.preExisting,
  evidence: verification.evidence,
  status: verification.verdict === "wrong" ? "wontfix" : "open",
});

const reportOf = (finding: ReviewFinding) => ({
  id: finding.id,
  aspect: finding.aspect,
  file: finding.file,
  line: finding.line,
  scenario: finding.scenario,
  proposedFix: finding.proposedFix,
  severity: finding.severity,
  verdict: finding.verdict,
  preExisting: finding.preExisting,
  humanReview: finding.humanReview,
  status: finding.status,
  fix: finding.fix,
  opus: finding.opus,
  fingerprint: findingFingerprint(finding),
});

const stageOf = (value: string | undefined): number => {
  const stage = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(stage) || stage < 1)
    throw new FlowError(1, "--stage は1以上の整数にしてください");
  return stage;
};

const cycleOf = (value: string | undefined): number => {
  const cycle = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(cycle) || cycle < 1)
    throw new FlowError(1, "--cycle は1以上の整数にしてください");
  return cycle;
};

/** ローカルのモデルに、1周分のレビューと検証をさせる */
export const run: Command = async (ctx) => {
  const parsed = parseArgs(ctx.argv, ["stage", "cycle", "verify-result"]);
  if (parsed.positionals.length > 3)
    throw new FlowError(
      1,
      "使い方：orca-flow review-local [ID] [差分の範囲] [first|redo] --stage 〈数〉 --cycle 〈数〉 [--verify-result 〈文〉]",
    );
  const [givenId, givenRange, givenMode] = parsed.positionals;
  const mode = givenMode ?? "first";
  if (mode !== "first" && mode !== "redo")
    throw new FlowError(1, "モードは first か redo にしてください");

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  const branch = await currentBranch(ctx.runner, root);
  const branchId = branch
    ? idFromBranch(branch, config.branchPrefix, config.idPrefix)
    : null;
  const id = givenId ?? branchId;
  if (!id)
    throw new FlowError(
      1,
      "タスクの worktree で review-local を呼んでください",
    );
  if (branchId && givenId && givenId !== branchId)
    throw new FlowError(
      1,
      `ID ${givenId} は今のブランチの ${branchId} と違います`,
    );

  const range = givenRange ?? `${config.baseBranch}...HEAD`;
  if (!isRange(range))
    throw new FlowError(1, `差分の範囲の書き方が違います：${range}`);

  const stage = stageOf(parsed.values.get("stage"));
  const cycle = cycleOf(parsed.values.get("cycle"));
  const verifyResult = parsed.values.get("verify-result") ?? "なし";
  const designPath = taskDocPath(config, id);

  const files = await ctx.runner(
    "git",
    ["diff", "--name-only", "--no-renames", range],
    {
      cwd: root,
    },
  );
  if (files.code !== 0)
    throw new FlowError(
      1,
      `git diff ${range} が失敗しました：${(files.stderr || files.stdout).trim()}`,
    );

  let ledger: ReviewLedger;
  let previousLedger: ReviewLedger | null = null;
  if (mode === "first" && stage > 1) {
    previousLedger = await readLedger(ctx.runner, root, id, stage - 1);
    if (!previousLedger)
      throw new FlowError(
        2,
        `${id} の段${stage - 1}のレビュー台帳がありません。先に前の段を終わらせてください`,
      );
  }

  if (mode === "first" && cycle === 1) {
    ledger = createLedger({
      taskId: id,
      stage,
      baseBranch: config.baseBranch,
      range,
      now: ctx.now().toISOString(),
    });
  } else {
    const loaded = await readLedger(ctx.runner, root, id, stage);
    if (!loaded)
      throw new FlowError(
        2,
        `${id} の段${stage}のレビュー台帳がありません。先に1周目を流してください`,
      );
    ledger = loaded;
  }

  if (files.stdout.trim() === "") {
    ledger.range = range;
    ledger.updatedAt = ctx.now().toISOString();
    await writeLedger(ctx.runner, root, ledger);
    const ledgerPath = await reviewLedgerPath(ctx.runner, root, id, stage);
    const must = ledger.findings.filter(mustFix);
    const data = {
      id,
      stage,
      cycle,
      range,
      noDiff: true,
      mustFix: must.map(reportOf),
      report: ledger.findings.map(reportOf),
      counts: {
        findings: ledger.findings.length,
        mustFix: must.length,
        accepted: ledger.findings.filter(
          (finding) =>
            finding.status === "accepted_risk" || finding.status === "wontfix",
        ).length,
      },
      acceptedRisks: ledger.acceptedRisks,
      ledgerPath,
    };
    if (!ctx.json) ctx.stdout("差分なし");
    return { code: 0, data };
  }

  const roundStartedAt = ctx.now().toISOString();
  const roundStart = Date.now();
  const calls: ReviewRoundCall[] = [];
  const record =
    (kind: string) =>
    (call: LocalCallRecord): void => {
      calls.push({ kind, ...call });
    };

  const reviewerPrompt = await readAgentPrompt("code-reviewer");
  const verifierPrompt = await readAgentPrompt("review-verifier");

  if (mode === "first") {
    const settled = [
      ...(config.localReview.contextLedger && previousLedger
        ? previousLedger.findings.map((finding) => ({
            stage: previousLedger.stage,
            finding,
          }))
        : []),
      ...ledger.findings.map((finding) => ({ stage, finding })),
    ].map(({ stage, finding }) => ({
      stage,
      id: finding.id,
      aspect: finding.aspect,
      file: finding.file,
      line: finding.line,
      scenario: finding.scenario,
      status: finding.status,
      verdict: finding.verdict,
      evidence: finding.evidence,
      preExisting: finding.preExisting,
      humanReview: finding.humanReview,
      fix: finding.fix
        ? {
            summary: finding.fix.summary,
            intent: finding.fix.intent,
            behaviorChange: finding.fix.behaviorChange,
          }
        : undefined,
      opus: finding.opus?.verdict,
    }));
    const reviewed = await runLocalJson({
      runner: ctx.runner,
      cwd: root,
      env: ctx.env,
      config: config.localReview,
      prompt: buildReviewerPrompt({
        agent: reviewerPrompt,
        taskId: id,
        designPath,
        baseBranch: config.baseBranch,
        range,
        verifyResult,
        settled: settled.length > 0 ? JSON.stringify(settled, null, 2) : "",
      }),
      schema: REVIEWER_SCHEMA,
      onCall: record("reviewer"),
      validate: isReviewerResult,
    });
    const firstNewIndex = ledger.findings.length;
    const added = reviewed.findings.map((finding, index) =>
      toFinding(finding, firstNewIndex + index),
    );
    if (added.length > 0) {
      const verified = await runLocalJson({
        runner: ctx.runner,
        cwd: root,
        env: ctx.env,
        config: config.localReview,
        prompt: buildVerifierPrompt({
          agent: verifierPrompt,
          taskId: id,
          designPath,
          baseBranch: config.baseBranch,
          range,
          verifyResult,
          findings: added,
        }),
        schema: VERIFIER_SCHEMA,
        onCall: record("verifier"),
        validate: isVerifierResult,
      });
      const byId = new Map(verified.findings.map((item) => [item.id, item]));
      const verifiedFindings = added.map((finding) => {
        const verification = byId.get(finding.id);
        return verification ? verifyFinding(finding, verification) : finding;
      });
      ledger.findings.push(...verifiedFindings);
    }
  } else {
    const previous = ledger.findings.filter(
      (finding) =>
        finding.verdict === "confirmed" &&
        finding.severity === "must_fix" &&
        !finding.preExisting &&
        finding.humanReview !== true &&
        finding.status !== "accepted_risk" &&
        finding.status !== "wontfix" &&
        finding.opus?.verdict !== "accept" &&
        finding.opus?.verdict !== "accept_intentional" &&
        finding.opus?.verdict !== "low_risk_ignore" &&
        finding.opus?.verdict !== "needs_human",
    );
    if (previous.length > 0) {
      const redone = await runLocalJson({
        runner: ctx.runner,
        cwd: root,
        env: ctx.env,
        config: config.localReview,
        prompt: buildRedoVerifierPrompt({
          agent: verifierPrompt,
          taskId: id,
          designPath,
          baseBranch: config.baseBranch,
          range,
          verifyResult,
          previous: previous.map((finding) => ({
            id: finding.id,
            scenario: finding.scenario,
            fix: finding.fix
              ? {
                  summary: finding.fix.summary,
                  intent: finding.fix.intent,
                  behaviorChange: finding.fix.behaviorChange,
                  tests: finding.fix.tests,
                }
              : undefined,
          })),
        }),
        schema: REDO_VERIFIER_SCHEMA,
        onCall: record("redo-verifier"),
        validate: isRedoVerifierResult,
      });
      const results = new Map(redone.results.map((item) => [item.id, item]));
      ledger.findings = ledger.findings.map((finding) => {
        const result = results.get(finding.id);
        if (!result) return finding;
        return {
          ...finding,
          status:
            result.status === "fixed_intentional"
              ? "fixed_intentional"
              : result.status,
          evidence: result.evidence ?? result.reason,
        };
      });
      let next = ledger.findings.length;
      for (const finding of redone.newFindings) {
        ledger.findings.push(toVerifiedFinding(finding, next++));
      }
    }
  }

  ledger.range = range;
  ledger.updatedAt = ctx.now().toISOString();
  ledger.rounds = [
    ...(ledger.rounds ?? []),
    {
      stage,
      cycle,
      mode,
      startedAt: roundStartedAt,
      durationMs: Date.now() - roundStart,
      calls,
    },
  ];
  await writeLedger(ctx.runner, root, ledger);

  const must = ledger.findings.filter(mustFix);
  const report = ledger.findings.map(reportOf);
  const data = {
    id,
    stage,
    cycle,
    range,
    noDiff: false,
    mustFix: must.map(reportOf),
    report,
    counts: {
      findings: ledger.findings.length,
      mustFix: must.length,
      accepted: ledger.findings.filter(
        (finding) =>
          finding.status === "accepted_risk" || finding.status === "wontfix",
      ).length,
    },
    ledgerPath: await reviewLedgerPath(ctx.runner, root, id, stage),
  };

  if (!ctx.json) {
    ctx.stdout(
      `${id} 段${stage} 周${cycle}：指摘 ${data.counts.findings} 件、must-fix ${data.counts.mustFix} 件`,
    );
    for (const finding of must) {
      ctx.stdout(
        `- ${finding.id} ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`} ${finding.scenario}`,
      );
    }
  }
  return { code: 0, data };
};
