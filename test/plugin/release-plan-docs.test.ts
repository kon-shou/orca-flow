import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readabilityWarnings } from "../../src/lib/readability.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** 仕様書 9.1 のテンプレートの写し（コードブロックの中身） */
function specTemplateCopy(spec: string): string {
  const s91 = spec.slice(spec.indexOf("### 9.1"), spec.indexOf("### 9.2"));
  const open = "```markdown\n";
  const start = s91.indexOf(open);
  expect(start, "9.1 にテンプレートの写しがありません").toBeGreaterThan(-1);
  const end = s91.indexOf("\n```\n", start + open.length);
  return s91.slice(start + open.length, end + 1);
}

function sectionBody(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  expect(start, `見出し「${heading}」がありません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function checkReleaseSection(text: string, where: string): void {
  const headings = text.split("\n").filter((l) => /^## /.test(l));
  const at = headings.indexOf("## 出し方");
  expect(at, `${where}に「## 出し方」がありません`).toBeGreaterThanOrEqual(0);
  expect(headings[at - 1], where).toBe("## 完了条件（自動テストで確認する）");
  expect(headings[at + 1], where).toBe("## 書き込んでよい場所");
  const bullets = sectionBody(text, "## 出し方")
    .split("\n")
    .filter((l) => l.startsWith("- "));
  expect(bullets, where).toHaveLength(3);
  expect(bullets[0], where).toMatch(/^- 止めずに出せるか：/);
  expect(bullets[1], where).toMatch(/^- 戻せるか：/);
  expect(bullets[2], where).toMatch(/^- 出す順：/);
  expect(bullets[2], where).toContain("マイグレーション");
  expect(bullets[2], where).toContain("リポジトリをまたぐ");
  expect(bullets[2], where).toContain("人が行う手順");
  expect(bullets.join("\n"), where).toContain("当たらない（");
}

describe("設計書の「出し方」の節", () => {
  it("テンプレートに、完了条件の次・書き込んでよい場所の前にあり、3つの箇条がある", async () => {
    checkReleaseSection(
      await read("templates/spec-template.md"),
      "テンプレート",
    );
  });

  it("仕様書 9.1 の写しにも同じ節があり、写しはテンプレートと同じ", async () => {
    const copy = specTemplateCopy(await read("docs/spec.md"));
    checkReleaseSection(copy, "9.1 の写し");
    expect(copy).toBe(await read("templates/spec-template.md"));
  });

  it("テンプレートは読みやすさの確認で警告を出さない", async () => {
    expect(
      readabilityWarnings(await read("templates/spec-template.md")),
    ).toEqual([]);
  });
});

describe("仕様書 9.1 の設計書の決まり", () => {
  it("出し方の1項目がある", async () => {
    const spec = await read("docs/spec.md");
    const s91 = spec.slice(spec.indexOf("### 9.1"), spec.indexOf("### 9.2"));
    const rules = s91.slice(
      s91.indexOf("**設計書の決まり**"),
      s91.indexOf("**決定の記録の文案**"),
    );
    const hits = rules
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes("「出し方」"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("「出すときの手順」");
    expect(hits[0]).toContain("先に読む文書");
    expect(hits[0]).toContain("「決めてほしいこと」");
    expect(hits[0]).toContain("止めて出す・戻せない・出す順を人が守る");
  });
});

describe("spec のスキルの手順4", () => {
  it("出し方の項目が1つだけあり、出すときの手順・先に読む文書・決めてほしいことの言葉がある", async () => {
    const body = await read("skills/spec/SKILL.md");
    const lines = body.split("\n");
    const start = lines.findIndex((l) => l.startsWith("4. "));
    const end = lines.findIndex((l, i) => i > start && l.startsWith("5. "));
    const step4 = lines.slice(start, end);
    const hits = step4.filter((l) => /^ {3}- 出し方：/.test(l));
    expect(hits).toHaveLength(1);
    const item = hits[0] ?? "";
    expect(item).toContain("「出すときの手順」");
    expect(item).toContain("写さない");
    expect(item).toContain("先に読む文書");
    expect(item).toContain("「決めてほしいこと」");
    expect(item).toContain("「完了条件」の次");
  });
});
