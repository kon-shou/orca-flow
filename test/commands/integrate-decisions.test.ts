import { describe, expect, it } from "vitest";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

const DRAFT =
  "\n## 決定の記録の文案\n\n- 見出し：形を決めた\n- 捨てた案と理由：なし\n- 決めたこと：A\n";
const NONE = "\n## 決定の記録の文案\n\nなし\n";

async function setup(options: {
  decisionsFile: boolean;
  section: string;
  entry?: string;
  initial?: string;
  fullText?: string;
  union?: boolean;
}) {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      progress: { file: "docs/progress.md" },
      appendOnlyFiles: ["docs/decisions.md"],
      ...(options.decisionsFile ? { decisionsFile: "docs/decisions.md" } : {}),
      verify: ["test -f src/shop/a.ts"],
    },
    {
      "docs/progress.md": PROGRESS.replace(
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 作業中 | task/T12-shop | |\n",
      ),
      "docs/decisions.md": options.initial ?? "# 決定の記録\n",
      ...(options.union
        ? { ".gitattributes": "docs/decisions.md merge=union\n" }
        : {}),
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md":
      specDoc("T12", { allowed: ["src/shop/"] }) + options.section,
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
    ...(options.fullText !== undefined
      ? { "docs/decisions.md": options.fullText }
      : options.entry === undefined
        ? {}
        : { "docs/decisions.md": `# 決定の記録\n\n${options.entry}\n` }),
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  return { root, wt };
}

async function integrate(root: string, ...extra: string[]) {
  return runCli(["integrate", "T12", "--verify-here", ...extra], {
    cwd: root,
    runner: fakeOrca().runner,
  });
}

const merged = async (root: string) =>
  (await git(root, "log", "--format=%s", "-5")).includes("T12 をマージする");

describe("integrate の決定の記録の確かめ", () => {
  it("decisionsFile のない設定では、文案があって項がなくても統合できる", async () => {
    const { root } = await setup({ decisionsFile: false, section: DRAFT });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("決定の記録");
    expect(await merged(root)).toBe(true);
  });

  it("文案が「なし」なら項がなくても統合できる", async () => {
    const { root } = await setup({ decisionsFile: true, section: NONE });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("節がなければ警告を出して統合できる", async () => {
    const { root } = await setup({ decisionsFile: true, section: "" });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(result.err).toContain("決定の記録の文案」の節がない");
  });

  it("文案があって差分に decisionsFile がなければ、終了コード1で止まりマージしない", async () => {
    const { root } = await setup({ decisionsFile: true, section: DRAFT });
    const result = await integrate(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--skip-decision");
    expect(await merged(root)).toBe(false);
  });

  it("--skip-decision をつけると警告つきで統合できる", async () => {
    const { root } = await setup({ decisionsFile: true, section: DRAFT });
    const result = await integrate(root, "--skip-decision");
    expect(result.code).toBe(0);
    expect(result.err).toContain("警告：");
    expect(result.err).toContain("docs/decisions.md");
    expect(await merged(root)).toBe(true);
  });

  it("項があれば警告なしで統合できる", async () => {
    const { root } = await setup({
      decisionsFile: true,
      section: DRAFT,
      entry: "## 2026-01-01 形を決めた\n\n- 決めたこと：A",
    });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("足した行に ID の形があると警告が出て、統合は止まらない", async () => {
    const { root } = await setup({
      decisionsFile: true,
      section: DRAFT,
      entry: "## 2026-01-01 形を決めた\n\n- T12 で決めた",
    });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(result.err).toContain("ID の形");
    expect(await merged(root)).toBe(true);
  });

  it("文案が present でも、「捨てた案と理由：なし」の行だけで none にはならない", async () => {
    const { root } = await setup({ decisionsFile: true, section: DRAFT });
    expect((await integrate(root)).code).toBe(1);
  });
});

describe("integrate の決定の記録は追記だけの確かめ", () => {
  const stop = "の先頭と同じではありません";

  it("main と同じ行を共有する項を足した2つのタスクが union で rebase されて行が消えても、統合が戻してマージする", async () => {
    const { root } = await setup({
      decisionsFile: true,
      section: DRAFT,
      union: true,
      fullText:
        "# 決定の記録\n\n## 2026-01-02 B\n\n- 捨てた案と理由：なし\n- 人が選んだこと：おすすめどおり（承認で決まった）。\n",
    });
    await writeFiles(root, {
      "docs/decisions.md":
        "# 決定の記録\n\n## 2026-01-01 A\n\n- 捨てた案と理由：なし\n- 人が選んだこと：おすすめどおり（承認で決まった）。\n",
    });
    await git(root, "add", "docs/decisions.md");
    await git(root, "commit", "--quiet", "-m", "A の項");
    const result = await integrate(root);
    expect(result.err).not.toContain(stop);
    expect(result.code).toBe(0);
    expect(await merged(root)).toBe(true);
    const text = await git(root, "show", `main:docs/decisions.md`);
    expect(text).toContain("## 2026-01-01 A");
    expect(text).toContain("## 2026-01-02 B");
    expect(text.split("- 人が選んだこと").length - 1).toBe(2);
  });

  it("ブランチがすでにある行を消していたら、--skip-decision でも止まる", async () => {
    const { root } = await setup({
      decisionsFile: true,
      section: DRAFT,
      initial: "# 決定の記録\n\n## 古い\n\n- x\n",
      fullText: "# 決定の記録\n\n## 新しい\n\n- y\n",
    });
    const result = await integrate(root, "--skip-decision");
    expect(result.code).toBe(1);
    expect(result.err).toContain(stop);
    expect(await merged(root)).toBe(false);
  });

  it("ブランチに decisionsFile がなければ止まる", async () => {
    const { root } = await setup({
      decisionsFile: true,
      section: NONE,
      initial: "# 決定の記録\n\n## 古い\n\n- x\n",
    });
    // 確かめの対象にするため、ブランチ側でファイルを消す
    const wtPath = (await git(root, "worktree", "list", "--porcelain"))
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9))
      .find((p) => p.includes("T12"))!;
    await git(wtPath, "rm", "--quiet", "docs/decisions.md");
    await git(wtPath, "commit", "--quiet", "-m", "T12: 消す");
    const result = await integrate(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain(stop);
  });

  it("先頭が同じ（末尾に足しただけ）なら通る", async () => {
    const { root } = await setup({
      decisionsFile: true,
      section: DRAFT,
      initial: "# 決定の記録\n\n## 古い\n\n- x\n",
      fullText: "# 決定の記録\n\n## 古い\n\n- x\n\n## 新しい\n\n- y\n",
    });
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(await merged(root)).toBe(true);
  });
});

describe("項を足さないタスクは、main に項が足されても追記だけの確かめで止まらない", () => {
  const stop = "の先頭と同じではありません";
  const mainEntry =
    "# 決定の記録\n\n## 2026-01-01 A\n\n- 捨てた案と理由：なし\n- 人が選んだこと：おすすめどおり（承認で決まった）。\n";

  async function addToMain(root: string) {
    await writeFiles(root, { "docs/decisions.md": mainEntry });
    await git(root, "add", "docs/decisions.md");
    await git(root, "commit", "--quiet", "-m", "A の項");
  }

  it("文案が「なし」で記録を変えないタスクは、分かれたあとに main で項が足されても通る（merge=union あり）", async () => {
    const { root } = await setup({
      decisionsFile: true,
      section: NONE,
      union: true,
    });
    await addToMain(root);
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain(stop);
    expect(result.err).toBe("");
    expect(await merged(root)).toBe(true);
  });

  it("文案の節がない設計書で記録を変えないタスクも通り、出るのは節がない警告だけ", async () => {
    const { root } = await setup({
      decisionsFile: true,
      section: "",
      union: true,
    });
    await addToMain(root);
    const result = await integrate(root);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain(stop);
    expect(result.err.trim()).toBe(
      "警告：設計書に「決定の記録の文案」の節がないので、docs/decisions.md に項があるかは確かめませんでした",
    );
    expect(result.err).not.toContain("マージしていません");
    expect(await merged(root)).toBe(true);
  });
});
