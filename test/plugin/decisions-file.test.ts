import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 項の見出し：「## 〈日付〉 〈見出し〉」 */
const ENTRY_HEADING = /^## \d{4}-\d{2}-\d{2} \S.*$/;
const SUMMARY_HEADING = "## 決めごとなし";

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, (c) => `\\${c}`);
}

describe("決定の記録（docs/decisions.md）", () => {
  it("タスクの ID の形（設定の idPrefix と数字）がない", async () => {
    const config = JSON.parse(await read(".orca-flow/config.json")) as {
      idPrefix: string;
    };
    const pattern = new RegExp(
      `(?<![A-Za-z0-9])${escapeRegex(config.idPrefix)}[0-9]+[a-z]?(?![A-Za-z0-9])`,
      "g",
    );
    const text = await read("docs/decisions.md");
    const found = [...text.matchAll(pattern)].map((m) => m[0]);
    expect(found).toEqual([]);
  });

  it("冒頭に、追記だけであることと項の形が書いてある", async () => {
    const text = await read("docs/decisions.md");
    const head = text.split("\n## ")[0] ?? "";
    expect(head).toContain("追記だけ");
    for (const w of [
      "決めたこと",
      "理由",
      "捨てた案と理由",
      "人が選んだこと",
    ]) {
      expect(head, w).toContain(w);
    }
  });

  it("項の見出しに日付と見出しがあり、写した過去の項は日付の順に並ぶ", async () => {
    const text = await read("docs/decisions.md");
    const all = text.split("\n").filter((l) => l.startsWith("## "));
    const headings = all.filter((l) => l !== SUMMARY_HEADING);
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h, h).toMatch(ENTRY_HEADING);
    // 日付の順を確かめるのは「決めごとなし」の一覧より前の、写した過去の項だけ。
    // 一覧のうしろの項は統合の順に足すので、日付は前後しうる（追記だけのファイルで
    // 守れない条件を外したのであって、確かめを弱めたのではない）。
    const copied = all
      .slice(0, all.indexOf(SUMMARY_HEADING))
      .map((h) => h.slice(3, 13));
    expect(copied.length).toBeGreaterThan(0);
    expect(copied).toEqual([...copied].sort());
  });

  it("各項に、決めたことと理由がある", async () => {
    const text = await read("docs/decisions.md");
    const sections = text.split("\n## ").slice(1);
    for (const section of sections) {
      const title = section.split("\n")[0] ?? "";
      if (`## ${title}` === SUMMARY_HEADING) continue;
      expect(section, title).toContain("- 決めたこと：");
      expect(section, title).toContain("- 理由：");
    }
  });

  it("決めごとなしの一覧が1つあり、「〈日付〉 〈名前〉：決めごとなし」の形", async () => {
    const text = await read("docs/decisions.md");
    const lines = text.split("\n");
    const i = lines.indexOf(SUMMARY_HEADING);
    expect(i).toBeGreaterThan(0);
    expect(lines.lastIndexOf(SUMMARY_HEADING)).toBe(i);
    // 追記だけのファイルなので、記録を始めたあとの項は一覧のうしろに続く。
    // 一覧は次の項の見出しまで。
    const rest = lines.slice(i + 1);
    const next = rest.findIndex((l) => l.startsWith("## "));
    const items = (next < 0 ? rest : rest.slice(0, next)).filter(
      (l) => l.trim() !== "",
    );
    expect(items.length).toBeGreaterThan(0);
    for (const l of items) {
      expect(l, l).toMatch(/^- \d{4}-\d{2}-\d{2} .+：決めごとなし$/);
    }
  });
});
