import { describe, expect, it } from "vitest";
import {
  addedLinesOf,
  idLikeLines,
  readDecisionDraft,
  startsWithBase,
} from "../../src/lib/decisions.ts";

const doc = (section: string) =>
  `# タスク\n\n## 目的\n\nテスト。\n\n${section}\n## 報告の形\n\n報告。\n`;

describe("readDecisionDraft", () => {
  it("節がなければ missing", () => {
    expect(readDecisionDraft(doc(""))).toBe("missing");
  });

  it("「なし」だけなら none（飾りや句点があっても）", () => {
    for (const body of ["なし", "- なし", "なし。", "\n- なし\n", "**なし**"])
      expect(readDecisionDraft(doc(`## 決定の記録の文案\n\n${body}\n`))).toBe(
        "none",
      );
  });

  it("中身があれば present", () => {
    expect(
      readDecisionDraft(
        doc("## 決定の記録の文案\n\n- 見出し：形を決めた\n- 決めたこと：A\n"),
      ),
    ).toBe("present");
  });

  it("「なし」の字を含む行があっても、ほかに中身があれば present", () => {
    expect(
      readDecisionDraft(
        doc("## 決定の記録の文案\n\n- 見出し：x\n- 捨てた案と理由：なし\n"),
      ),
    ).toBe("present");
  });

  it("無し・特になし・ない・かっこの書き添え・コメント行つきも none", () => {
    for (const body of [
      "- 無し",
      "- 特になし",
      "ない",
      "- なし（決めることがない）",
      "- なし\n<!-- 書くことがあれば足す -->",
      "<!-- メモ -->\n- なし",
    ])
      expect(readDecisionDraft(doc(`## 決定の記録の文案\n\n${body}\n`))).toBe(
        "none",
      );
  });

  it("中身が空の節は節がないのと同じ（missing）", () => {
    expect(readDecisionDraft(doc("## 決定の記録の文案\n\n"))).toBe("missing");
  });

  it("コードブロックの中の見出しは節にしない", () => {
    expect(
      readDecisionDraft("## 作るもの\n\n```\n## 決定の記録の文案\n- x\n```\n"),
    ).toBe("missing");
  });
});

describe("addedLinesOf / idLikeLines", () => {
  const diff = [
    "diff --git a/d.md b/d.md",
    "--- a/d.md",
    "+++ b/d.md",
    "@@ -1 +1,3 @@",
    " 古い T1 の行",
    "+## 2026-01-01 形",
    "+- T12 で決めた",
    "-消した T9",
  ].join("\n");

  it("足した行だけを返す（+++ の行と文脈の行は除く）", () => {
    expect(addedLinesOf(diff)).toEqual(["## 2026-01-01 形", "- T12 で決めた"]);
  });

  it("idPrefix と数字の形の行を返す", () => {
    expect(idLikeLines(addedLinesOf(diff), "T")).toEqual(["- T12 で決めた"]);
    expect(idLikeLines(["ITEM12 と T-1 と Tx"], "T")).toEqual([]);
  });
});

describe("startsWithBase", () => {
  it("先頭が同じなら true、行が消えたら false", () => {
    expect(startsWithBase("a\nb\n", "a\nb\nc\n")).toBe(true);
    expect(startsWithBase("a\nb\n", "a\nc\n")).toBe(false);
    expect(startsWithBase("a\nb\n", "")).toBe(false);
  });
});
