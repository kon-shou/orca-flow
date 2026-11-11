import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireConfig } from "../../src/config.ts";
import { finishMergedTask } from "../../src/lib/finish.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";

const DRAFT =
  "\n## 決定の記録の文案\n\n- 見出し：形を決めた\n- 捨てた案と理由：なし\n- 決めたこと：A\n";
const SECTION =
  "\n## 決定の記録の項\n\n### 2026-11-10 形を決めた\n\n- 決めたこと：A\n";

async function setup(options: {
  ignored: boolean;
  doc: string;
  report: string;
  code?: boolean;
  initial?: string;
  tracked?: boolean;
  verify?: string;
  branchEntry?: string;
}) {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      appendOnlyFiles: ["docs/decisions.md"],
      decisionsFile: "docs/decisions.md",
      verify: [options.verify ?? "true"],
    },
    options.tracked
      ? { "docs/decisions.md": options.initial ?? "# 記録\n" }
      : {},
  );
  if (options.ignored)
    await appendFile(
      path.join(root, ".git", "info", "exclude"),
      "/docs/decisions.md\n",
    );
  if (options.initial !== undefined && !options.tracked)
    await writeFiles(root, { "docs/decisions.md": options.initial });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md":
      specDoc("T12", { allowed: ["src/shop/"] }) + options.doc,
  });
  await writeFiles(wt.path, {
    ...(options.branchEntry !== undefined
      ? { "docs/decisions.md": options.branchEntry }
      : {}),
    ...(options.code === false
      ? {}
      : { "src/shop/a.ts": "export const a = 1;\n" }),
    "docs/tasks/reports/T12.md": `# 報告\n${options.report}`,
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  return { root, wt };
}

const integrate = (root: string, ...extra: string[]) =>
  runCli(["integrate", "T12", "--verify-here", ...extra], {
    cwd: root,
    runner: fakeOrca().runner,
  });
const decisions = (root: string) =>
  readFile(path.join(root, "docs", "decisions.md"), "utf8");

describe("integrate：無視された決定の記録", () => {
  it("報告の節の項をメインの記録の末尾に足し、コミットしない（ファイルがなくても作る）", async () => {
    const { root } = await setup({
      ignored: true,
      doc: DRAFT,
      report: SECTION,
    });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(await decisions(root)).toBe(
      "## 2026-11-10 形を決めた\n\n- 決めたこと：A\n",
    );
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await git(root, "ls-files", "docs/decisions.md")).toBe("");
  });

  it("あるファイルには前に空行を1行置いて足し、同じ見出しがあれば足さない", async () => {
    const { root } = await setup({
      ignored: true,
      doc: DRAFT,
      report: SECTION,
      initial: "# 決定の記録\n",
    });
    await integrate(root);
    expect(await decisions(root)).toBe(
      "# 決定の記録\n\n## 2026-11-10 形を決めた\n\n- 決めたこと：A\n",
    );
    const again = await setup({
      ignored: true,
      doc: DRAFT,
      report: SECTION,
      initial: "## 2026-11-10 形を決めた\n\n- 前の項\n",
    });
    await integrate(again.root);
    expect(await decisions(again.root)).toBe(
      "## 2026-11-10 形を決めた\n\n- 前の項\n",
    );
  });

  it("差分のない統合でも足す", async () => {
    const { root } = await setup({
      ignored: true,
      doc: DRAFT,
      report: SECTION,
      code: false,
    });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(await decisions(root)).toContain("## 2026-11-10 形を決めた");
  });

  it("文案があって報告に節がなければ、マージせず終了コード1（--skip-decision なら通す）", async () => {
    const { root } = await setup({ ignored: true, doc: DRAFT, report: "" });
    const headBefore = await git(root, "rev-parse", "HEAD");
    const result = await integrate(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("決定の記録の項");
    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
    const skipped = await integrate(root, "--skip-decision");
    expect(skipped.code).toBe(0);
    expect(skipped.err).toContain("--skip-decision で通しました");
  });

  it("文案が「なし」なら節がなくても通る", async () => {
    const { root } = await setup({
      ignored: true,
      doc: "\n## 決定の記録の文案\n\nなし\n",
      report: "",
    });
    expect((await integrate(root)).code).toBe(0);
  });

  it("無視されていなければ、今までどおり差分の記録を見て、報告の節は写さない", async () => {
    const { root } = await setup({
      ignored: false,
      doc: DRAFT,
      report: SECTION,
    });
    const headBefore = await git(root, "rev-parse", "HEAD");
    const result = await integrate(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("差分に docs/decisions.md がありません");
    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
  });

  it("無視されていなければ、差分の項を通し、報告の節があっても記録に2重に入らない", async () => {
    const entry = "# 記録\n\n## 2026-11-10 形を決めた\n\n- 決めたこと：A\n";
    const { root } = await setup({
      ignored: false,
      doc: DRAFT,
      report: SECTION,
      tracked: true,
      initial: "# 記録\n",
      branchEntry: entry,
    });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await decisions(root)).toBe(entry);
  });

  it("追跡中の記録は、exclude の行があっても差分の記録を求め、メインの記録に書き足さない", async () => {
    const { root } = await setup({
      ignored: true,
      doc: DRAFT,
      report: SECTION,
      tracked: true,
      initial: "# 記録\n",
    });
    const headBefore = await git(root, "rev-parse", "HEAD");
    const result = await integrate(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("差分に docs/decisions.md がありません");
    expect(await decisions(root)).toBe("# 記録\n");
    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
  });

  it("verify が落ちて統合が止まったとき、メインの記録に項を足さない", async () => {
    const { root } = await setup({
      ignored: true,
      doc: DRAFT,
      report: SECTION,
      verify: "false",
    });
    const result = await integrate(root);
    expect(result.code).toBe(1);
    expect(existsSync(path.join(root, "docs", "decisions.md"))).toBe(false);
  });
});

describe("PR の後始末：無視された決定の記録", () => {
  it("報告の節の項をメインの記録に足し、2回目は足さない", async () => {
    const { root, wt } = await setup({
      ignored: true,
      doc: DRAFT,
      report: SECTION,
    });
    const origin = path.join(await tempDir("orca-flow-origin-"), "origin.git");
    await git(
      path.dirname(origin),
      "init",
      "--quiet",
      "--bare",
      "-b",
      "main",
      origin,
    );
    await git(root, "remote", "add", "origin", origin);
    await git(root, "push", "--quiet", "origin", "main");
    const ctx = {
      argv: [],
      cwd: root,
      json: false,
      runner: fakeOrca().runner,
      env: {},
      stdout: () => {},
      stderr: () => {},
      now: () => new Date("2026-11-10T00:00:00Z"),
    };
    const config = await requireConfig(root);
    const task = { id: "T12", branch: wt.branch, path: wt.path };
    const result = await finishMergedTask(ctx, config, root, task, {
      keepWorktree: true,
    });
    expect(result.kind).toBe("done");
    const text = await decisions(root);
    expect(text).toBe("## 2026-11-10 形を決めた\n\n- 決めたこと：A\n");
    await finishMergedTask(ctx, config, root, task, { keepWorktree: true });
    expect(await decisions(root)).toBe(text);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });
});
