import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLocalDecisions,
  decisionsIgnored,
  readLocalEntries,
} from "../../src/lib/local-decisions.ts";
import { makeRepo, tempDir } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const REPORT = `# 報告

結果：完了

## 決定の記録の項

### 2026-11-10 形を決めた

- 決めたこと：A
- 理由：B

#### 細目

- C

### 2026-11-11 もう一つ

- 決めたこと：D

## 次の節

### 2026-11-12 節の外

- 入らない
`;

describe("readLocalEntries", () => {
  it("節の項を「## 日付 見出し」にそろえ、項の中の見出しは同じ幅だけ浅くする", () => {
    const entries = readLocalEntries(REPORT);
    expect(entries.map((e) => e.heading)).toEqual([
      "## 2026-11-10 形を決めた",
      "## 2026-11-11 もう一つ",
    ]);
    expect(entries[0]!.text).toBe(
      "## 2026-11-10 形を決めた\n\n- 決めたこと：A\n- 理由：B\n\n### 細目\n\n- C",
    );
    expect(entries[1]!.text).not.toContain("節の外");
  });

  it("項の見出しが「##」でも読め、節の見出しの階層は問わない", () => {
    const text =
      "# 報告\n\n## 決定の記録の項\n\n## 2026-11-10 A\n\n本文\n\n## 2026-11-11 B\n\n本文2\n\n## 別の節\n";
    expect(readLocalEntries(text).map((e) => e.heading)).toEqual([
      "## 2026-11-10 A",
      "## 2026-11-11 B",
    ]);
    const deep = "#### 決定の記録の項\n\n##### 2026-11-10 A\n\nx\n";
    expect(readLocalEntries(deep)[0]!.text).toBe("## 2026-11-10 A\n\nx");
  });

  it("節がない・日付つきの項がないときは空、コードの囲みの中の見出しは見ない", () => {
    expect(readLocalEntries("# 報告\n\n本文\n")).toEqual([]);
    expect(readLocalEntries("## 決定の記録の項\n\nなし\n")).toEqual([]);
    expect(
      readLocalEntries("```\n## 決定の記録の項\n### 2026-11-10 A\n```\n"),
    ).toEqual([]);
  });
});

describe("appendLocalDecisions", () => {
  it("ファイルがなければ作り、あれば前に空行を1行置いて末尾に足す", async () => {
    const dir = await tempDir();
    const added = await appendLocalDecisions(dir, "docs/d.md", REPORT, "");
    expect(added).toHaveLength(2);
    const text = await readFile(path.join(dir, "docs/d.md"), "utf8");
    expect(text.startsWith("## 2026-11-10 形を決めた")).toBe(true);
    expect(text).toContain("- C\n\n## 2026-11-11 もう一つ\n");
    await writeFile(path.join(dir, "docs/e.md"), "# 記録\n");
    await appendLocalDecisions(dir, "docs/e.md", REPORT, "");
    expect(await readFile(path.join(dir, "docs/e.md"), "utf8")).toMatch(
      /^# 記録\n\n## 2026-11-10 /,
    );
  });

  it("同じ見出しがすでにあれば足さない", async () => {
    const dir = await tempDir();
    await appendLocalDecisions(dir, "d.md", REPORT, "");
    const before = await readFile(path.join(dir, "d.md"), "utf8");
    expect(await appendLocalDecisions(dir, "d.md", REPORT, "")).toEqual([]);
    expect(await readFile(path.join(dir, "d.md"), "utf8")).toBe(before);
    const one = REPORT.replace(
      "## 決定の記録の項",
      "## 決定の記録の項\n\n### 2026-11-20 新しい\n\n- E\n",
    );
    expect(await appendLocalDecisions(dir, "d.md", one, "")).toEqual([
      "## 2026-11-20 新しい",
    ]);
  });

  it("報告がない・節がないときは何もしない", async () => {
    const dir = await tempDir();
    expect(await appendLocalDecisions(dir, "d.md", null, "")).toEqual([]);
    expect(await appendLocalDecisions(dir, "d.md", "# 報告\n", "")).toEqual([]);
  });
});

describe("decisionsIgnored", () => {
  it("info/exclude の行に当たれば真、decisionsFile がなければ偽", async () => {
    const root = await makeRepo();
    const config = { decisionsFile: "docs/d.md" };
    expect(await decisionsIgnored(testRunner, root, config)).toBe(false);
    await writeFile(path.join(root, ".git", "info", "exclude"), "/docs/d.md\n");
    expect(await decisionsIgnored(testRunner, root, config)).toBe(true);
    expect(
      await decisionsIgnored(testRunner, root, { decisionsFile: null }),
    ).toBe(false);
  });
});
