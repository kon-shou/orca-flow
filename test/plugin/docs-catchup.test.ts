import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const NEW_LINE = "/orca-flow:new [--auto] 〈やりたいこと〉";
const OLD_LINE = "`/orca-flow:new 〈やりたいこと〉`";
const AUTO_PHRASE = "おまかせにするときだけ頭に `--auto` をつける";

/** キーワードを含む箇条（「- 」か「1. 」）とその下のインデントされた行。 */
function bullet(text: string, keyword: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) => /^\s*(- |\d+\. )/.test(l) && l.includes(keyword),
  );
  expect(
    start,
    `「${keyword}」を含む箇条が見つかりません`,
  ).toBeGreaterThanOrEqual(0);
  const out = [lines[start] as string];
  const indent = (lines[start] as string).search(/\S/);
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === "" || l.search(/\S/) > indent) out.push(l);
    else break;
  }
  return out.join("\n");
}

/** 「## 」見出しから次の同じ階層の見出しの手前まで。 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  expect(start, `見出し「${heading}」がありません`).toBeGreaterThanOrEqual(0);
  const level = (lines[start] as string).match(/^#+/)?.[0].length ?? 2;
  const end = lines.findIndex(
    (l, i) =>
      i > start && /^#+ /.test(l) && (l.match(/^#+/)?.[0].length ?? 9) <= level,
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const tableRow = (text: string, cmd: string): string =>
  text.split("\n").find((l) => l.startsWith(`| \`/orca-flow:${cmd}`)) ?? "";

describe("スキルの new の1行は角かっこを外し、頭に --auto を置く", () => {
  it("run の「直しの指示が来たら」の箇条", async () => {
    const b = bullet(await read("skills/run/SKILL.md"), "直しの指示が来たら");
    expect(b).toContain("角かっこを外し");
    expect(b).toContain(AUTO_PHRASE);
    expect(b).toContain(NEW_LINE);
  });

  it("to-lint の「テストにする」の箇条", async () => {
    const b = bullet(await read("skills/to-lint/SKILL.md"), "「テストにする」");
    expect(b).toContain("角かっこを外し");
    expect(b).toContain(AUTO_PHRASE);
    expect(b).toContain(NEW_LINE);
  });
});

describe("README と仕様書の new の例", () => {
  it("古い形がなく、使い始め方の2・手順4に新しい形がある", async () => {
    const readme = await read("README.md");
    expect(readme).not.toContain(OLD_LINE);
    const b2 = bullet(readme, "統括役のタブで `/orca-flow:new");
    expect(b2).toContain(`\`${NEW_LINE}\``);
    expect(b2).toContain(AUTO_PHRASE);
    const b4 = bullet(readme, "worktree が増え");
    expect(b4).toContain(`\`${NEW_LINE}\``);
  });

  it("仕様書：古い形がなく、10.1 の new の行と12章「毎回」の1に新しい形がある", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).not.toContain(OLD_LINE);
    expect(tableRow(spec, "new")).toMatch(
      /^\| `\/orca-flow:new \[--auto\] 〈やりたいこと〉`/,
    );
    const b1 = bullet(section(spec, "## 12."), "**始める**");
    expect(b1).toContain(`\`${NEW_LINE}\``);
    expect(b1).toContain(AUTO_PHRASE);
  });

  it("仕様書の流れの図は変えない", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).toContain("/orca-flow:new やりたいこと ─→ orca-flow new");
  });
});

describe("仕様書に to-lint を足す", () => {
  it("5章の木に to-lint と lint.md", async () => {
    const s5 = section(await read("docs/spec.md"), "## 5.");
    expect(s5).toMatch(/skills\/\{[^}]*\bto-lint\b[^}]*\}/);
    const tpl = s5.split("\n").find((l) => l.includes("templates/")) ?? "";
    expect(tpl).toContain("lint.md");
  });

  it("6章の表に .orca-flow/lint.md の行（init は置かない）", async () => {
    const s6 = section(await read("docs/spec.md"), "## 6.");
    const row = s6
      .split("\n")
      .find((l) => l.startsWith("| `.orca-flow/lint.md`"));
    expect(row).toBeDefined();
    expect(row).toContain("to-lint");
    expect(row).toContain("init は置かず");
  });

  it("10.1 の表に to-lint の行", async () => {
    const row = tableRow(await read("docs/spec.md"), "to-lint");
    expect(row).not.toBe("");
    expect(row).toContain("orca-flow new");
    expect(row).toContain("止まる");
  });
});

describe("「戻す」を選んだ判断事項が戻ったかの確かめ", () => {
  it("9.1 の「統合の前に人が決めるもの」の箇条", async () => {
    // 9.1 のテンプレートは中に「## 」の見出しを持つので、9.2 の手前までで切る
    const spec = await read("docs/spec.md");
    const s91 = spec.slice(spec.indexOf("### 9.1"), spec.indexOf("### 9.2"));
    const b = bullet(s91, "統合の前に人が決めるもの");
    expect(b).toContain("戻ったかは");
    expect(b).toContain("run が根拠を開いて確かめ");
    expect(b).toContain("検証役が確かめる");
  });

  it("10.1 の review の行", async () => {
    const row = tableRow(await read("docs/spec.md"), "review");
    expect(row).toContain("戻ったかは");
    expect(row).toContain("run が根拠を開いて確かめ");
    expect(row).toContain("検証役が確かめる");
  });
});
