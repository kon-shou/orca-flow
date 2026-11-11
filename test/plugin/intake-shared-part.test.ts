import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const H6 = "手順6：下書きの決まり";

/** 「## 見出し」の行から、次の「## 」の前まで。なければ空文字。 */
function sec(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `## ${heading}`);
  if (at < 0) return "";
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const hasAll = (line: string | undefined, words: string[]) =>
  line !== undefined && words.every((w) => line.includes(w));

/** 前の項目の次の行を返す。なければ undefined。 */
function nextLine(text: string, prefix: string): string | undefined {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(prefix));
  return at < 0 ? undefined : lines[at + 1];
}

const GUARD_1 = "- 共通の部品の横の確かめ：";
const GUARD_2 = "- 共通側の案を黙って捨てない：";
const REVIEW_ITEM = "- 横の見落とし（";

function guardsOk(guards: string): boolean {
  const s = sec(guards, H6);
  const first = nextLine(s, "- how に渡す問い：");
  const second = nextLine(s, GUARD_1);
  return (
    first?.startsWith(GUARD_1) === true &&
    second?.startsWith(GUARD_2) === true &&
    hasAll(first, [
      "ほかの使い所",
      "同じ問題",
      "子のリポジトリ",
      "readFirst",
      "ほかのリポジトリは見ていない",
    ]) &&
    hasAll(second, [
      "局所で直す",
      "共通で直す",
      "非推奨",
      "決めてほしいこと",
      "影響範囲",
      "拡張性",
      "捨てた案",
      "人が選んだ",
      "後続のタスクの候補",
    ])
  );
}

function reviewerOk(text: string): boolean {
  const next = nextLine(text, "- 依存の抜け");
  return (
    next !== undefined &&
    next.trimStart().startsWith(REVIEW_ITEM) &&
    hasAll(next, ["ほかの使い所", "人に聞かずに捨てて"])
  );
}

function specAdrOk(spec: string): boolean {
  const l = spec.split("\n").find((x) => x.startsWith("- 仕様は ADR の形"));
  return hasAll(l, ["共通の部品", "ほかの使い所", "影響範囲", "拡張性"]);
}

function specReviewOk(spec: string): boolean {
  const l = spec.split("\n").find((x) => x.startsWith("3. レビュー："));
  return l !== undefined && l.includes("横の見落とし");
}

/** 部分文字列を含む行を抜いた写し（1行も抜けなければ失敗）。 */
function without(text: string, part: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !l.includes(part));
  expect(kept.length, `抜く行がありません：${part}`).toBeLessThan(lines.length);
  return kept.join("\n");
}

describe("共通の部品の横の確かめ", () => {
  it("guards.md の手順6に2項目がこの順で並ぶ", async () => {
    expect(guardsOk(await read("skills/intake/guards.md"))).toBe(true);
  });

  it("goldfish-reviewer.md の手順3で依存の抜けの次に横の見落としがある", async () => {
    expect(reviewerOk(await read("agents/goldfish-reviewer.md"))).toBe(true);
  });

  it("仕様書の10.1と10.2に足した文がある", async () => {
    const spec = await read("docs/spec.md");
    expect(specAdrOk(spec)).toBe(true);
    expect(specReviewOk(spec)).toBe(true);
  });

  it("行を抜いた写しでは落ちる", async () => {
    const g = await read("skills/intake/guards.md");
    expect(guardsOk(without(g, GUARD_1))).toBe(false);
    expect(guardsOk(without(g, GUARD_2))).toBe(false);
    const r = await read("agents/goldfish-reviewer.md");
    expect(reviewerOk(without(r, REVIEW_ITEM))).toBe(false);
    const spec = await read("docs/spec.md");
    expect(specAdrOk(without(spec, "- 仕様は ADR の形"))).toBe(false);
    expect(specReviewOk(without(spec, "3. レビュー："))).toBe(false);
  });

  it("言葉を変えた写しでも落ちる", async () => {
    const g = await read("skills/intake/guards.md");
    expect(guardsOk(g.replace("非推奨", "そのまま"))).toBe(false);
    expect(guardsOk(g.replace("拡張性", "広さ"))).toBe(false);
    const r = await read("agents/goldfish-reviewer.md");
    expect(reviewerOk(r.replace("人に聞かずに捨てて", "捨てて"))).toBe(false);
  });
});
