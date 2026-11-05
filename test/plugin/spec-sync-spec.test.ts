import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function spec(): Promise<string> {
  return readFile(path.join(ROOT, "docs/spec.md"), "utf8");
}

/** 見出しに当たる行の次から、同じ深さ以下の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  // 9.1 はテンプレートのコードブロックの中に「#」の行があるので、次の「### 」までを返す。
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^### \d+\.\d+ /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 先頭が prefix の行から、次の「**」で始まる段落の前まで（箇条書きを含む）。 */
function paragraph(text: string, prefix: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(prefix));
  expect(start, `段落が見つかりません：${prefix}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start);
  const end = rest.findIndex((l, i) => i > 0 && l.startsWith("**"));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("仕様のページへの追従：docs/spec.md 9.1", () => {
  it("報告の節の説明に「仕様のページとの違い」の書き方がある", async () => {
    const s = section(await spec(), /^### 9\.1 /);
    expect(s).toContain("「仕様のページとの違い」");
    expect(s).toContain("intake");
    expect(s).toContain("何が");
    expect(s).toContain("どう変わったか");
    expect(s).toContain("なぜ");
    expect(s).toContain("なし");
    expect(s).toContain("Notion の URL");
  });
});

describe("仕様のページへの追従：docs/spec.md 10.1", () => {
  it("10.1 に「仕様のページへの追従」の段落があり、作るもの1〜4を書いている", async () => {
    const s = section(await spec(), /^### 10\.1 /);
    const p = paragraph(s, "**仕様のページへの追従**");
    expect(p).toContain("intake");
    const item = (head: string): string => {
      const line = p.split("\n").find((l) => l.startsWith(head));
      expect(line, `箇条が見つかりません：${head}`).toBeDefined();
      return line as string;
    };
    // 設計のスキル
    const specItem = item("- spec：");
    expect(specItem).toContain("報告の形");
    expect(specItem).toContain("仕様のページとの違い");
    // 実行のスキル
    const runItem = item("- run：");
    expect(runItem).toContain("項目の全文");
    expect(runItem).toContain("設計の段で人が直した");
    // 統合のスキル
    const integrateItem = item("- integrate：");
    expect(integrateItem).toContain("orca-flow/requests/");
    expect(integrateItem).toContain("仕様のページに戻す");
    expect(integrateItem).toContain("auto log");
    expect(integrateItem).toContain("決定の記録に足さない");
    // 戻し方
    const pageItem = item("- `spec-page.md`：");
    expect(pageItem).toContain("ToolSearch");
    expect(pageItem).toContain("見分けの印");
    expect(pageItem).toContain("要件から自動で作った仕様のページ");
    expect(pageItem).toContain("前の印");
    expect(pageItem).toContain("orca-flow の語を入れない");
    expect(pageItem).toContain("実装で変わったこと");
    expect(pageItem).toContain("手順5の残り");
    expect(p).toContain("CLI は変えない");
  });

  it("段落は 10.1 の表の下にあり、Notion の URL を書いていない", async () => {
    const text = await spec();
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("**仕様のページへの追従**"));
    const lastRow = lines.reduce(
      (acc, l, i) => (l.startsWith("| `/orca-flow:") ? i : acc),
      -1,
    );
    expect(at).toBeGreaterThan(lastRow);
    expect(paragraph(text, "**仕様のページへの追従**")).not.toMatch(/https?:/);
  });
});
