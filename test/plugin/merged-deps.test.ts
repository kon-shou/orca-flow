import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 見出しの行から、同じ階層以上の次の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => heading.test(l));
  expect(at, `${heading} が見つかりません`).toBeGreaterThanOrEqual(0);
  const level = (lines[at] ?? "").match(/^#+/)?.[0].length ?? 2;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && (m[1]?.length ?? 9) <= level;
  });
  return [lines[at], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

/** `n. ` で始まる手順の行から、次の手順の前までを返す。 */
function step(text: string, n: number): string {
  const start = text.indexOf(`\n${n}. `);
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(`\n${n + 1}. `, start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

describe("skills/intake/SKILL.md：依存の見分けは orca-flow merged", () => {
  it("手順10が merged を流し、件名の行と push の記録の両方を書く", async () => {
    const s10 = step(await read("skills/intake/SKILL.md"), 10);
    expect(s10).toContain("orca-flow merged");
    expect(s10).toContain("件名の行");
    expect(s10).toContain("push の記録");
    expect(s10).toContain("マージのコミット");
    // merged の出力の読み方（終了コード）は guards.md の手順10の節にある
    const g10 = section(
      await read("skills/intake/guards.md"),
      /^## 手順10：始める前の守り/,
    );
    const out = g10.split("\n").find((l) => l.includes("終了コード1")) ?? "";
    expect(out).toContain("merged");
    expect(out).toContain("ID ごとに");
  });

  it("今の件名の行の説明が同じ行に残っている", async () => {
    const s10 = step(await read("skills/intake/SKILL.md"), 10);
    const line = s10.split("\n").find((l) => /完全に同じ行/.test(l));
    expect(line).toBeDefined();
    expect(line).toContain("--format=%s");
    expect(line).toContain("integratorName");
    expect(line).toContain("まだ ID がなければ");
  });
});

describe("docs/spec.md：実装9の分を15章から移した", () => {
  it("15章がなく、push/〈ID〉.json の行は6章にある", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).not.toMatch(/^## 15\. /m);
    expect(spec).not.toMatch(/^### 15\.4/m);
    const ch6 = section(spec, /^## 6\. /);
    expect(ch6).toContain("push/〈ID〉.json");
    expect(ch6).toContain("mergeCommit");
    expect(ch6).toContain("mergedAt");
  });

  it("8章の push に、マージのコミットを足す後始末がある（integrate は足さない）", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    const para = ch8
      .split("\n")
      .find((l) => l.includes("mergeCommit") && l.includes("finishMergedTask"));
    expect(para).toBeDefined();
    expect(para).toContain("completeMerge");
    expect(para).toContain("警告");
  });

  it("8章の表に merged の行がある", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    const row = ch8.split("\n").find((l) => l.startsWith("| `merged "));
    expect(row).toBeDefined();
    expect(row).toContain("--ref");
    expect(row).toContain("--json");
  });

  it("10.1 の intake に merged での見分けがある", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    expect(s).toContain("orca-flow merged");
    expect(s).toContain("完全に同じ");
  });

  it("15.6・15.7 から移した文が消え、残すものは残る", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).not.toMatch(/^### 15\.6/m);
    expect(spec).not.toMatch(/マージのコミットを `push\/〈ID〉\.json` に足す/);
    // 残りの『マージの見つけ方と後始末』は merge の分として8章へ移した
    expect(spec).not.toContain("『マージの見つけ方と後始末』");
    expect(section(spec, /^## 8\. /)).toContain(
      "どの道から呼ぶときも同じ引数 `mergeCommit`・`mergedAt`",
    );
    // 15.7 は実装7で10.1 へ移って消えた
    expect(spec).not.toMatch(/^### 15\.7/m);
    expect(spec).not.toContain("intake の『依存の見分け』を直す");
  });
});

describe("docs/pr-flow/tasks.md：指摘8", () => {
  it("実装4の依存に「統合は実装9のあと」、実装9は「並べて作ってよい。統合は実装9が先」", async () => {
    const t = await read("docs/pr-flow/tasks.md");
    const row = t.split("\n").find((l) => /^\| 実装4 /.test(l));
    expect(row).toContain("統合は実装9のあと");
    const s9 = section(t, /^## 実装9/);
    expect(s9).toContain("並べて作ってよい。統合は実装9が先");
    expect(s9).not.toContain("実装4と並べてよい");
  });
});
