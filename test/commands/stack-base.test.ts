import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireConfig } from "../../src/config.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { classifyRisk } from "../../src/lib/risk.ts";
import { writeStackAt } from "../../src/lib/stack.ts";
import { readRecord } from "../../src/lib/verified.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

/** 前のタスク T01 と、その枝に乗せた後ろのタスク T02 */
async function setup(
  config: Record<string, unknown> = {},
  files: Record<string, string> = {},
) {
  const root = await makeRepo(
    {
      verify: ["true"],
      maxActiveTasks: 5,
      ...config,
    },
    files,
  );
  const front = await addTaskWorktree(root, "T01", "front", {
    "front.txt": "前\n",
  });
  const back = {
    path: path.join(path.dirname(root), "T02-back"),
    branch: "task/T02-back",
  };
  await git(
    root,
    "worktree",
    "add",
    "--quiet",
    "-b",
    back.branch,
    back.path,
    front.branch,
  );
  await writeFiles(back.path, {
    "docs/tasks/T02.md": specDoc("T02", { allowed: ["back.txt"] }),
    "back.txt": "後ろ\n",
  });
  await git(back.path, "add", "-A");
  await git(back.path, "commit", "--quiet", "-m", "T02: 作る");
  await writeStackAt(
    path.join(root, ".git"),
    "T02",
    { id: "T01", branch: front.branch },
    new Date(),
  );
  return { root, front, back };
}

async function commitIn(cwd: string, files: Record<string, string>) {
  await writeFiles(cwd, files);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "--quiet", "-m", `更新 ${Object.keys(files)[0]}`);
  return git(cwd, "rev-parse", "HEAD");
}

const contains = async (cwd: string, commit: string) =>
  (
    await testRunner("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
      cwd,
    })
  ).code === 0;

/** 前のタスクを main に入れる（統合の件名でマージし、worktree を片づける） */
async function landFront(
  root: string,
  front: { path: string; branch: string },
) {
  await git(
    root,
    "merge",
    "--no-ff",
    "--quiet",
    "-m",
    "統括役: T01 をマージする",
    front.branch,
  );
  await git(root, "worktree", "remove", "--force", front.path);
}

describe("乗せたタスクの verify", () => {
  it("乗せた先の枝を取り込み、baseBranch を取り込まない。記録に乗せた先を残す", async () => {
    const { root, front, back } = await setup();
    const frontAhead = await commitIn(front.path, { "front2.txt": "進む\n" });
    const mainAhead = await commitIn(root, { "main.txt": "本線\n" });

    const r = await runCli(["verify"], {
      cwd: back.path,
      runner: fakeOrca().runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${front.branch} を取り込みました`);
    expect(await contains(back.path, frontAhead)).toBe(true);
    expect(await contains(back.path, mainAhead)).toBe(false);

    const record = await readRecord(testRunner, root, "T02");
    expect(record).toMatchObject({
      head: await git(back.path, "rev-parse", "HEAD"),
      base: frontAhead,
      stackedOn: "T01",
    });
  });

  it("乗せた先が入ったあとは baseBranch を取り込み、記録に乗せた先を残さない", async () => {
    const { root, front, back } = await setup();
    await landFront(root, front);
    const mainAhead = await commitIn(root, { "main.txt": "本線\n" });

    const r = await runCli(["verify"], {
      cwd: back.path,
      runner: fakeOrca().runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("main を取り込みました");
    expect(await contains(back.path, mainAhead)).toBe(true);
    const record = await readRecord(testRunner, root, "T02");
    expect(record?.base).toBe(mainAhead);
    expect(record).not.toHaveProperty("stackedOn");
  });

  it("乗せた先が作業中にも baseBranch にもなければ終了コード2で、記録を残さない", async () => {
    const { root, front, back } = await setup();
    await git(root, "worktree", "remove", "--force", front.path);
    await git(root, "branch", "-D", front.branch);
    const r = await runCli(["verify"], {
      cwd: back.path,
      runner: fakeOrca().runner,
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--unstack");
    expect(await readRecord(testRunner, root, "T02")).toBeNull();
  });

  it("乗せている間の記録は、乗せた先が入ったあとの verify に引き継がない", async () => {
    const { root, front, back } = await setup(
      { appendOnlyFiles: ["docs/notes.md"] },
      { "docs/notes.md": "- 一\n" },
    );
    const first = await runCli(["verify"], {
      cwd: back.path,
      runner: fakeOrca().runner,
    });
    expect(first.code).toBe(0);
    expect(await readRecord(testRunner, root, "T02")).toMatchObject({
      stackedOn: "T01",
    });

    await landFront(root, front);
    await commitIn(back.path, { "docs/notes.md": "- 一\n- 二\n" });
    const second = await runCli(["verify"], {
      cwd: back.path,
      runner: fakeOrca().runner,
    });
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("確認を引き継ぎました");
    const record = await readRecord(testRunner, root, "T02");
    expect(record).not.toHaveProperty("carried");
    expect(record).not.toHaveProperty("stackedOn");
  });

  it("決定の記録の確かめは土台と比べる（main だけが進んでも止まらない）", async () => {
    const decisions = "# 決定の記録\n\n## 前の項\n\n- 前\n";
    const root = await makeRepo(
      {
        verify: ["true"],
        maxActiveTasks: 5,
        decisionsFile: "docs/d.md",
        appendOnlyFiles: ["docs/d.md"],
      },
      { "docs/d.md": decisions },
    );
    const front = await addTaskWorktree(root, "T01", "front", {
      "docs/d.md": `${decisions}\n## 前のタスクの項\n\n- 前のタスク\n`,
    });
    const backPath = path.join(path.dirname(root), "T02-back");
    await git(
      root,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "task/T02-back",
      backPath,
      front.branch,
    );
    await writeStackAt(
      path.join(root, ".git"),
      "T02",
      { id: "T01", branch: front.branch },
      new Date(),
    );
    await commitIn(root, {
      "docs/d.md": `${decisions}\n## main の項\n\n- 本線\n`,
    });
    const r = await runCli(["verify"], {
      cwd: backPath,
      runner: fakeOrca().runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("乗せたタスクの approve", () => {
  function withLead(back: { path: string }) {
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_lead",
      worktreePath: back.path,
      title: "claude",
      agentIdentity: "claude",
    });
    return orca;
  }

  it("乗せた先の枝を取り込み、baseBranch を取り込まない", async () => {
    const { root, front, back } = await setup();
    const frontAhead = await commitIn(front.path, { "front2.txt": "進む\n" });
    const mainAhead = await commitIn(root, { "main.txt": "本線\n" });
    const r = await runCli(["approve", "T02"], {
      cwd: root,
      runner: withLead(back).runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(await contains(back.path, frontAhead)).toBe(true);
    expect(await contains(back.path, mainAhead)).toBe(false);
  });

  it("乗せた先が入ったあとは baseBranch を取り込む", async () => {
    const { root, front, back } = await setup();
    await landFront(root, front);
    const mainAhead = await commitIn(root, { "main.txt": "本線\n" });
    const r = await runCli(["approve", "T02"], {
      cwd: root,
      runner: withLead(back).runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(await contains(back.path, mainAhead)).toBe(true);
  });

  // 進捗表があると承認のコミットが main に入り、ふだんはそれをもう一度取り込む
  const withProgress = () =>
    setup(
      { progress: { file: "docs/progress.md" } },
      {
        "docs/progress.md": PROGRESS.replace(
          "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
          "| T01 | 前     | —    | 作業中   | task/T01-front |      |\n| T02 | 後ろ   | T01  | 設計中   | task/T02-back  |      |\n",
        ),
      },
    );

  it("進捗表があっても、乗せている間は承認のコミットのあとに baseBranch を取り込まない", async () => {
    const { root, front, back } = await withProgress();
    const frontAhead = await commitIn(front.path, { "front2.txt": "進む\n" });
    const mainAhead = await commitIn(root, { "main.txt": "本線\n" });
    const r = await runCli(["approve", "T02"], {
      cwd: root,
      runner: withLead(back).runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const approval = await git(root, "rev-parse", "HEAD");
    expect(approval).not.toBe(mainAhead);
    expect(await contains(back.path, frontAhead)).toBe(true);
    expect(await contains(back.path, mainAhead)).toBe(false);
    expect(await contains(back.path, approval)).toBe(false);
  });

  it("進捗表があり、乗せた先が入ったあとは承認のコミットまで取り込む", async () => {
    const { root, front, back } = await withProgress();
    await landFront(root, front);
    const mainAhead = await commitIn(root, { "main.txt": "本線\n" });
    const r = await runCli(["approve", "T02"], {
      cwd: root,
      runner: withLead(back).runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const approval = await git(root, "rev-parse", "HEAD");
    expect(approval).not.toBe(mainAhead);
    expect(await contains(back.path, mainAhead)).toBe(true);
    expect(await contains(back.path, approval)).toBe(true);
  });
});

describe("乗せたタスクの差分の範囲", () => {
  it("rebase-review：乗せた先の枝を取り込んでも、自分の変更が同じなら同じ指紋になる", async () => {
    const { front, back } = await setup();
    const before = await git(back.path, "rev-parse", "HEAD");
    await commitIn(front.path, { "front2.txt": "進む\n" });
    await git(back.path, "merge", "--quiet", "--no-edit", front.branch);

    const r = await runCli(["rebase-review", before], {
      cwd: back.path,
      runner: fakeOrca().runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("取り込みの前と同じ");
  });

  it("risk：差分は土台からで、乗せた先の変更を数えない", async () => {
    const { root, back } = await setup({
      risk: { paths: ["front.txt"], labels: [] },
    });
    const gh: Runner = async (cmd, args, opts) =>
      cmd === "gh"
        ? {
            code: 0,
            stdout: JSON.stringify({ labels: [] }),
            stderr: "",
            timedOut: false,
          }
        : testRunner(cmd, args, opts);
    const config = await requireConfig(root);
    const result = await classifyRisk({
      runner: gh,
      cwd: back.path,
      config,
      pr: 3,
    });
    expect(result.level).toBe("normal");
  });

  it("risk：乗せていなければ今までどおり baseBranch からの差分", async () => {
    const { root, front } = await setup({
      risk: { paths: ["front.txt"], labels: [] },
    });
    const config = await requireConfig(root);
    const result = await classifyRisk({
      runner: testRunner,
      cwd: front.path,
      config,
      pr: 3,
    });
    expect(result).toEqual({
      level: "high",
      reason: "risk.paths に当たるパス：front.txt",
    });
  });

  it("review-local：既定の範囲は土台からの差分", async () => {
    const { root, front, back } = await setup({
      localReview: { runner: "claude", model: "glm-test" },
    });
    const orca = fakeOrca();
    const runner: Runner = async (cmd, args, opts) =>
      cmd === "claude"
        ? {
            code: 0,
            stdout: JSON.stringify({
              result: JSON.stringify({ findings: [] }),
            }),
            stderr: "",
            timedOut: false,
          }
        : orca.runner(cmd, args, opts);
    const r = await runCli(["review-local", "--stage", "1", "--cycle", "1"], {
      cwd: back.path,
      runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const ledger = JSON.parse(
      await readFile(
        path.join(root, ".git/orca-flow/reviews/T02/stage-1.json"),
        "utf8",
      ),
    );
    expect(ledger.range).toBe(`${front.branch}...HEAD`);
  });

  it("review-local：役への依頼と台帳の土台は乗せた先の枝", async () => {
    const { root, front, back } = await setup({
      localReview: { runner: "claude", model: "glm-test" },
    });
    const orca = fakeOrca();
    const prompts: string[] = [];
    const reply = (value: unknown) => ({
      code: 0,
      stdout: JSON.stringify({ result: JSON.stringify(value) }),
      stderr: "",
      timedOut: false,
    });
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd !== "claude") return orca.runner(cmd, args, opts);
      const prompt = args.at(-1) ?? "";
      prompts.push(prompt);
      if (prompt.includes("今回の入力（やり直し）"))
        return reply({
          results: [
            { id: "F1", status: "fixed", reason: "直った", evidence: "読んだ" },
          ],
          newFindings: [],
        });
      if (prompt.includes("レビュー役の指摘"))
        return reply({
          findings: [
            {
              id: "F1",
              verdict: "confirmed",
              severity: "must_fix",
              preExisting: false,
              evidence: "再現した",
            },
          ],
        });
      return reply({
        findings: [
          {
            aspect: "正しさ",
            file: "back.txt",
            line: 1,
            scenario: "落ちる",
            severity: "must_fix",
          },
        ],
      });
    };
    const first = await runCli(
      ["review-local", "--stage", "1", "--cycle", "1"],
      { cwd: back.path, runner },
    );
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const redo = await runCli(
      [
        "review-local",
        "T02",
        `${front.branch}...HEAD`,
        "redo",
        "--stage",
        "1",
        "--cycle",
        "2",
      ],
      { cwd: back.path, runner },
    );
    expect(redo.err).toBe("");
    expect(redo.code).toBe(0);

    expect(prompts).toHaveLength(3);
    for (const prompt of prompts)
      expect(prompt).toContain(`- baseBranch：${front.branch}\n`);
    const ledger = JSON.parse(
      await readFile(
        path.join(root, ".git/orca-flow/reviews/T02/stage-1.json"),
        "utf8",
      ),
    );
    expect(ledger.baseBranch).toBe(front.branch);
  });
});
