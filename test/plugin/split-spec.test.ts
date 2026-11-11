import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 見出しの太字の行から、次の太字の段落・表・見出しの前までを返す。 */
function paragraph(text: string, head: string): string {
  const lines = text.split("\n");
  const at = lines.flatMap((l, i) => (l.startsWith(head) ? [i] : []));
  expect(at, head).toHaveLength(1);
  const rest = lines.slice((at[0] ?? 0) + 1);
  const end = rest.findIndex((l) => /^(\*\*|\||#)/.test(l));
  return [lines[at[0] ?? 0], ...(end < 0 ? rest : rest.slice(0, end))].join(
    "\n",
  );
}

describe("仕様書：大きくなった PR を分ける", () => {
  it("6章の依存の記録の段落に、depends --add が足すことがある", async () => {
    const line = paragraph(
      chapter(await read("docs/spec.md"), 6),
      "**依存の記録**：",
    );
    for (const w of ["depends", "--add", "重ね", "なければ作"]) {
      expect(line).toContain(w);
    }
  });

  it("8章の表と段落に、depends の使い方・足す人・探す向き・壊れたときがある", async () => {
    const ch = chapter(await read("docs/spec.md"), 8);
    expect(ch).toMatch(/^\| `depends 〈ID〉/m);
    const line = paragraph(ch, "**depends（依存の記録を見る・足す）**：");
    for (const w of [
      "--add",
      "--on",
      "統括役の場所の確認",
      "重ね",
      "作業中",
      "--json",
      "終了コード1",
      "進捗表",
    ]) {
      expect(line, w).toContain(w);
    }
  });

  it("10.1 の表に split の行があり、下に段落がある", async () => {
    const spec = await read("docs/spec.md");
    const s = spec.indexOf("\n### 10.1 ");
    const e = spec.indexOf("\n### 10.2 ");
    const sec = spec.slice(s, e);
    const row = sec
      .split("\n")
      .find((l) => l.startsWith("| `/orca-flow:split"));
    expect(row).toBeDefined();
    expect(row).toContain("disable-model-invocation: true");
    expect(row).toContain("統括役のタブ");
    const para = paragraph(sec, "**大きくなった PR を分ける**");
    for (const w of [
      "分ける案",
      "refs/orca-flow/split/",
      "--depends",
      "depends --on",
      "tell",
      "組",
      "コードの行",
      "約400行",
      "spec-page.md",
      "外すだけならコードレビューはやり直さない",
      "つなぎ直し",
    ]) {
      expect(para, w).toContain(w);
    }
    expect(para).not.toContain("約700行");
    expect(sec.indexOf(para)).toBeGreaterThan(
      sec.lastIndexOf("\n| `/orca-flow:"),
    );
  });

  it("10.1 の split の段落に、new が落ちたときの分かれ道と、子の参照の後始末がある", async () => {
    const spec = await read("docs/spec.md");
    const s = spec.indexOf("\n### 10.1 ");
    const e = spec.indexOf("\n### 10.2 ");
    const para = paragraph(spec.slice(s, e), "**大きくなった PR を分ける**");
    for (const w of [
      "new が落ちたとき",
      "続けるか片付ける",
      "orca-flow active",
      "依頼のファイル",
      "同じ子の ID",
      "子の参照を消す",
    ]) {
      expect(para, w).toContain(w);
    }
  });

  it("人に聞く形の対象が7つで split を含む", async () => {
    const spec = await read("docs/spec.md");
    const line = paragraph(spec, "**人に聞く形**のスキルの扱い：");
    expect(line).toContain("`split`");
    expect(line).toContain("の7つは");
    expect(line).not.toContain("の6つは");
  });
});
