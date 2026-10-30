import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLedger,
  mustFix,
  readLedger,
  writeLedger,
  type ReviewFinding,
} from "../../src/lib/review-ledger.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
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
  ...over,
});

async function setup(findings: ReviewFinding[]) {
  const root = await makeRepo();
  const wt = await addTaskWorktree(root, "T31", "ledger");
  const ledger = createLedger({
    taskId: "T31",
    stage: 1,
    baseBranch: "main",
    range: "main...HEAD",
    now: "2026-01-01T00:00:00.000Z",
  });
  ledger.findings = findings;
  await writeLedger(fakeOrca().runner, wt.path, ledger);
  return { root, wt };
}

async function noteFile(
  root: string,
  name: string,
  value: unknown,
): Promise<string> {
  const file = path.join(path.dirname(root), name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

describe("review-ledger", () => {
  it("修正メモを台帳に記録し、同じ指摘の2回目の修正は重なり扱いにしない", async () => {
    const { root, wt } = await setup([finding()]);
    const input = await noteFile(root, "fix.json", {
      findingId: "F1",
      files: ["src/a.ts"],
      hunks: ["src/a.ts:10-20"],
      summary: "守る",
      intent: "落ちないようにする",
      behaviorChange: "none",
      rationale: "指摘どおり",
      tests: ["pnpm test"],
    });
    const first = await runCli(
      ["review-ledger", "record-fix", "--stage", "1", "--input", input],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(first.code).toBe(0);
    const second = await runCli(
      ["review-ledger", "record-fix", "--stage", "1", "--input", input],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(second.code).toBe(0);
  });

  it("別の指摘の修正と重なるときは理由がなければ終了コード1、あれば通る", async () => {
    const { root, wt } = await setup([
      finding(),
      finding({ id: "F2", scenario: "別の落ち方", line: 12 }),
    ]);
    const input = await noteFile(root, "fix.json", {
      findingId: "F1",
      files: ["src/a.ts"],
      hunks: ["src/a.ts:10-20"],
      summary: "守る",
      intent: "落ちないようにする",
      behaviorChange: "none",
      rationale: "指摘どおり",
      tests: [],
    });
    expect(
      (
        await runCli(
          ["review-ledger", "record-fix", "--stage", "1", "--input", input],
          { cwd: wt.path, runner: fakeOrca().runner },
        )
      ).code,
    ).toBe(0);

    const overlap = await noteFile(root, "overlap.json", {
      findingId: "F2",
      files: ["src/a.ts"],
      hunks: ["src/a.ts:15-16"],
      summary: "F2 を直す",
      intent: "F2 を直す",
      behaviorChange: "intentional",
      rationale: "F2 のため",
      tests: [],
    });
    const rejected = await runCli(
      ["review-ledger", "record-fix", "--stage", "1", "--input", overlap],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain("revertJustification");

    const withReason = await noteFile(root, "overlap-reason.json", {
      findingId: "F2",
      files: ["src/a.ts"],
      hunks: ["src/a.ts:15-16"],
      summary: "F2 を直す",
      intent: "F2 を直す",
      behaviorChange: "intentional",
      rationale: "F2 のため",
      tests: [],
      revertJustification: "F2 の挙動を優先するため",
    });
    expect(
      (
        await runCli(
          [
            "review-ledger",
            "record-fix",
            "--stage",
            "1",
            "--input",
            withReason,
          ],
          { cwd: wt.path, runner: fakeOrca().runner },
        )
      ).code,
    ).toBe(0);
  });

  it("check-revert は hunks だけで重なりを確かめられる", async () => {
    const { root, wt } = await setup([
      finding({
        status: "fixed",
        fix: {
          files: ["src/a.ts"],
          hunks: ["src/a.ts:10-20"],
          summary: "守る",
          intent: "落ちないようにする",
          behaviorChange: "none",
          rationale: "指摘どおり",
          tests: [],
        },
      }),
    ]);
    const input = await noteFile(root, "check.json", {
      findingId: "F2",
      hunks: ["src/a.ts:15-16"],
    });
    const result = await runCli(
      [
        "review-ledger",
        "check-revert",
        "--stage",
        "1",
        "--input",
        input,
        "--json",
      ],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ overlaps: ["F1"] });
  });

  it("Opus の must-fix は新しい根拠がなければ記録しない", async () => {
    const { root, wt } = await setup([finding({ status: "fixed" })]);
    const noEvidence = await noteFile(root, "opus.json", {
      findingId: "F1",
      verdict: "must_fix",
      reason: "まだ直っていない",
    });
    const rejected = await runCli(
      ["review-ledger", "record-opus", "--stage", "1", "--input", noEvidence],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain("newEvidence");

    const withEvidence = await noteFile(root, "opus-evidence.json", {
      findingId: "F1",
      verdict: "must_fix",
      reason: "まだ直っていない",
      newEvidence: "src/a.ts:10 で再現した",
    });
    expect(
      (
        await runCli(
          [
            "review-ledger",
            "record-opus",
            "--stage",
            "1",
            "--input",
            withEvidence,
          ],
          { cwd: wt.path, runner: fakeOrca().runner },
        )
      ).code,
    ).toBe(0);
    const ledger = await readLedger(fakeOrca().runner, wt.path, "T31", 1);
    expect(ledger?.findings[0]?.status).toBe("not_fixed");
    expect(mustFix(ledger!.findings[0]!)).toBe(true);
  });

  it("低リスク見逃しは acceptedRisks に残り、must-fix から外れる", async () => {
    const { root, wt } = await setup([finding()]);
    const input = await noteFile(root, "risk.json", {
      findingId: "F1",
      verdict: "low_risk_ignore",
      reason: "表示だけの小さなずれ",
    });
    const result = await runCli(
      ["review-ledger", "record-opus", "--stage", "1", "--input", input],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(result.code).toBe(0);
    const ledger = await readLedger(fakeOrca().runner, wt.path, "T31", 1);
    expect(ledger?.acceptedRisks).toEqual(["F1: 表示だけの小さなずれ"]);
    expect(ledger?.findings[0]?.status).toBe("accepted_risk");
    expect(mustFix(ledger!.findings[0]!)).toBe(false);
  });

  it("Opus が見つけた新しい指摘を台帳に足す", async () => {
    const { root, wt } = await setup([finding()]);
    const input = await noteFile(root, "new-finding.json", {
      aspect: "セキュリティ",
      file: "src/a.ts",
      line: 30,
      scenario: "入力がそのままコマンドに入る",
      severity: "must_fix",
      evidence: "src/a.ts:30 を読んだ",
    });
    const result = await runCli(
      ["review-ledger", "record-finding", "--stage", "1", "--input", input],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(result.code).toBe(0);
    const ledger = await readLedger(fakeOrca().runner, wt.path, "T31", 1);
    expect(ledger?.findings[1]).toMatchObject({
      id: "F2",
      verdict: "confirmed",
      severity: "must_fix",
      status: "open",
    });
  });

  it("人間に回す新しい指摘は must-fix として Sonnet に送らない", async () => {
    const { root, wt } = await setup([finding()]);
    const input = await noteFile(root, "new-human.json", {
      aspect: "セキュリティ",
      file: "src/a.ts",
      scenario: "入力がそのままコマンドに入る",
      severity: "must_fix",
      evidence: "src/a.ts:30 を読んだ",
      humanReview: true,
    });
    expect(
      (
        await runCli(
          ["review-ledger", "record-finding", "--stage", "1", "--input", input],
          { cwd: wt.path, runner: fakeOrca().runner },
        )
      ).code,
    ).toBe(0);
    const ledger = await readLedger(fakeOrca().runner, wt.path, "T31", 1);
    expect(ledger?.findings[1]?.humanReview).toBe(true);
    expect(mustFix(ledger!.findings[1]!)).toBe(false);
  });

  it("人間に回す裁定は must-fix として Sonnet に送らない", async () => {
    const { root, wt } = await setup([finding()]);
    const input = await noteFile(root, "human.json", {
      findingId: "F1",
      verdict: "needs_human",
      reason: "認可の設計に関わる",
    });
    const result = await runCli(
      ["review-ledger", "record-opus", "--stage", "1", "--input", input],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(result.code).toBe(0);
    const ledger = await readLedger(fakeOrca().runner, wt.path, "T31", 1);
    expect(ledger?.findings[0]?.status).toBe("not_fixed");
    expect(mustFix(ledger!.findings[0]!)).toBe(false);
  });

  it("show は台帳をそのまま返し、台帳がなければ終了コード2", async () => {
    const { wt } = await setup([finding()]);
    const shown = await runCli(["review-ledger", "show", "--stage", "1"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({ taskId: "T31" });

    const missing = await runCli(["review-ledger", "show", "--stage", "2"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(missing.code).toBe(2);
  });

  it("修正メモの型が違えば終了コード1", async () => {
    const { root, wt } = await setup([finding()]);
    const input = await noteFile(root, "bad.json", {
      findingId: "F1",
      files: "src/a.ts",
      hunks: [],
      summary: "x",
      intent: "y",
      behaviorChange: "maybe",
      rationale: "z",
      tests: [],
    });
    const result = await runCli(
      ["review-ledger", "record-fix", "--stage", "1", "--input", input],
      { cwd: wt.path, runner: fakeOrca().runner },
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("behaviorChange");
  });

  it("周の記録のある台帳も、ない古い台帳も読め、記録は書き戻しで残る", async () => {
    const { wt } = await setup([finding()]);
    const runner = fakeOrca().runner;
    const old = await readLedger(runner, wt.path, "T31", 1);
    expect(old?.rounds).toBeUndefined();
    expect(old?.findings.filter(mustFix)).toHaveLength(1);
    if (!old) throw new Error("台帳がありません");
    old.rounds = [
      {
        stage: 1,
        cycle: 1,
        mode: "first",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 10,
        calls: [{ kind: "reviewer", durationMs: 10, retries: 0 }],
      },
    ];
    await writeLedger(runner, wt.path, old);
    const again = await readLedger(runner, wt.path, "T31", 1);
    expect(again?.rounds).toHaveLength(1);
    expect(again?.findings.filter(mustFix)).toHaveLength(1);
  });
});
