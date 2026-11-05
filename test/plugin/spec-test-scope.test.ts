import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

const EXTRA = [
  "助けのファイル",
  "import",
  "拡張子を除いた",
  "文を足すだけでも",
  "含まない",
];

describe("spec のスキル：仕様書のテストを範囲に入れる決まり", () => {
  it("手順4に、必要な言葉を全部含む箇条が1つあり、このリポジトリだけの名前がない", async () => {
    const skill = await read("skills/spec/SKILL.md");
    const start = skill.indexOf("\n4. ");
    const end = skill.indexOf("\n5. ", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step4 = skill.slice(start, end);
    const bullets = step4
      .split("\n")
      .filter((line) => line.startsWith("   - "));
    const words = [
      "readFirst が正とする仕様の文書",
      "git grep",
      "ファイル名",
      "書き込んでよい場所",
      "担当の書き込む場所",
      "迷ったら入れる",
    ];
    const hits = bullets.filter((b) => words.every((w) => b.includes(w)));
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toContain("test/plugin");
    expect(hits[0]).not.toContain("docs/spec.md");
    for (const w of EXTRA) expect(hits[0]).toContain(w);
    expect(hits[0]).toContain("当たらなければ何も足さない");
  });
});

describe("仕様書 10.1：仕様書のテストを範囲に入れる決まり", () => {
  it("10.1 の表のあと、10.2 の見出しの前に、同じ言葉を含む段落がある", async () => {
    const spec = await read("docs/spec.md");
    const s = spec.indexOf("\n### 10.1 ");
    const e = spec.indexOf("\n### 10.2 ");
    expect(s).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(s);
    const section = spec.slice(s, e);
    const lastTableRow = section.lastIndexOf("\n|");
    expect(lastTableRow).toBeGreaterThan(-1);
    const after = section.slice(lastTableRow + 1);
    const paragraphs = after.split(/\n\n+/);
    const hits = paragraphs.filter(
      (p) =>
        !p.startsWith("|") &&
        p.includes("readFirst が正とする仕様の文書") &&
        p.includes("git grep") &&
        p.includes("迷ったら入れる"),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^\*\*[^*]+\*\*：/);
    for (const w of EXTRA) expect(hits[0]).toContain(w);
    expect(hits[0]).toContain("当たらなければ何も足さない");
    expect(hits[0]).not.toContain("ふつうは当たらず、何も足さない");
  });
});
