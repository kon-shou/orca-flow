import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 見出しの行から、同じ深さ以下の次の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `${heading} が見つかりません`).toBeGreaterThanOrEqual(0);
  const depth = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i] ?? "");
    if (m && (m[1]?.length ?? 99) <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("spec.md：画面の記録とスナップショット", () => {
  it("9.1 の報告の節の説明に「画面の記録」の箇条がある（後回しにしたものより前）", async () => {
    // 9.1 はテンプレートのコードブロックに「#」の行があるので、9.2 の見出しまでで切る
    const all = (await read("docs/spec.md")).split("\n");
    const from = all.findIndex((l) => /^### 9\.1 /.test(l));
    const to = all.findIndex((l) => /^### 9\.2 /.test(l));
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const s91 = all.slice(from, to);
    const idx = s91.findIndex((l) => l.startsWith("- 「画面の記録」"));
    const later = s91.findIndex((l) => l.startsWith("- 「後回しにしたもの」"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(later);
    const bullet = s91[idx] ?? "";
    for (const w of [
      "「画面の記録」の節",
      "録れなかった理由",
      "「録らない」",
      "Notion の URL",
      "リポジトリに置かない",
    ]) {
      expect(bullet).toContain(w);
    }
    expect(s91[later] ?? "").not.toContain("画面の記録");
  });

  it("10.1 の表の下に「画面の記録とスナップショット」の段落がある", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1 /);
    const lines = s.split("\n");
    const para = lines.find((l) =>
      l.startsWith("**画面の記録とスナップショット**"),
    );
    expect(para).toBeDefined();
    const lastRow = Math.max(
      ...lines.map((l, i) => (l.startsWith("|") ? i : -1)),
    );
    expect(lines.indexOf(para ?? "")).toBeGreaterThan(lastRow);
    for (const w of [
      "e2e のスナップショット",
      "e2e の仕組みがない",
      "デグレ",
      "「画面の記録」の節",
      "録らない",
      "screen-capture.md",
      "GIF",
      "captures/",
      "spec-page-capture.md",
      "実装後の画面",
      "コミットし",
      "書き込んでよい場所",
      "intake の1行と GIF の両方",
    ]) {
      expect(para, w).toContain(w);
    }
  });

  it("13章に GIF の書き出し先と Notion のファイルの上げ方の行がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 13\. /);
    const row = s
      .split("\n")
      .find((l) =>
        l.startsWith(
          "| 拡張の GIF の書き出し先と、Notion の MCP のファイルの上げ方",
        ),
      );
    expect(row).toBeDefined();
    const cells = (row ?? "").split("|").map((c) => c.trim());
    expect(cells[2]).toContain(
      "書き出し先が見つからなければ、報告に書いて進む",
    );
    expect(cells[2]).toContain("上げられなければ、記録の場所を人に渡す");
  });

  it("手元のパスと Notion の URL を書いていない", async () => {
    const spec = await read("docs/spec.md");
    const para = spec
      .split("\n")
      .filter((l) => l.includes("画面の記録") || l.includes("拡張の GIF"))
      .join("\n");
    expect(para).not.toMatch(/https?:\/\//);
    expect(para).not.toMatch(/\/Users\//);
    expect(para).not.toMatch(/notion\.so/);
  });

  it("10.1 の表の行に画面の記録の話が入っていない", async () => {
    const lines = section(await read("docs/spec.md"), /^### 10\.1 /).split(
      "\n",
    );
    const rows = lines.filter((l) => l.startsWith("|"));
    expect(rows.length).toBeGreaterThan(0);
    for (const w of ["screen-capture", "spec-page-capture", "画面の記録"]) {
      expect(rows.join("\n")).not.toContain(w);
    }
    const para = lines.find((l) =>
      l.startsWith("**画面の記録とスナップショット**"),
    );
    expect(para).toBeDefined();
    expect(para?.startsWith("|")).toBe(false);
  });
});
