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

/** 「- 」か「1. 」で始まる箇条とその下のインデントされた行を、キーワードで探す。 */
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

describe("スキルが人に示す new の1行は --auto を頭に置く形", () => {
  it("init・to-lint・run に --auto のない古い形が残らない", async () => {
    for (const f of [
      "skills/init/SKILL.md",
      "skills/to-lint/SKILL.md",
      "skills/run/SKILL.md",
    ]) {
      expect(await read(f), f).not.toContain(OLD_LINE);
    }
  });

  it("init の手順7に新しい形・頭に置く・to-lint・lint.md がある", async () => {
    const b = bullet(await read("skills/init/SKILL.md"), "人間に、置いたもの");
    expect(b).toMatch(/^7\. /);
    for (const w of [
      NEW_LINE,
      "頭に置く",
      "/orca-flow:to-lint",
      ".orca-flow/lint.md",
    ]) {
      expect(b, w).toContain(w);
    }
  });

  it("init の手順1・3に lint.md を置く指示がない", async () => {
    const text = await read("skills/init/SKILL.md");
    for (const n of ["1", "3"]) {
      const lines = text.split("\n");
      const start = lines.findIndex((l) => l.startsWith(`${n}. `));
      expect(start).toBeGreaterThanOrEqual(0);
      let end = lines.findIndex((l, i) => i > start && /^\d+\. /.test(l));
      if (end < 0) end = lines.length;
      expect(lines.slice(start, end).join("\n"), `手順${n}`).not.toContain(
        "lint.md",
      );
    }
  });

  it("to-lint の「テストにする」の行に新しい形と頭に置くがある", async () => {
    const b = bullet(await read("skills/to-lint/SKILL.md"), "「テストにする」");
    expect(b).toContain(NEW_LINE);
    expect(b).toContain("頭に置く");
  });

  it("run の後続のタスクの1行に新しい形と頭に置くがある", async () => {
    const b = bullet(await read("skills/run/SKILL.md"), "直しの指示が来たら");
    expect(b).toContain(NEW_LINE);
    expect(b).toContain("頭に置く");
  });
});
