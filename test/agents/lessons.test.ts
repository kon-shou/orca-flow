import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const agentsDir = path.resolve(import.meta.dirname, "../../agents");

function readAgentText(name: string): string {
  return readFileSync(path.join(agentsDir, `${name}.md`), "utf8");
}

describe("教訓の読み方（担当・レビュー役・検証役の定義）", () => {
  for (const name of ["task-worker", "code-reviewer", "review-verifier"]) {
    describe(name, () => {
      const text = readAgentText(name);

      // 教訓の箇条（教訓のファイルの絶対パスを読む行）だけを取り出す。
      // .orca-flow/review.md の箇条にも同じ文言があるので、全文では確かめない。
      const bullet =
        text
          .split("\n")
          .find((line) => line.includes("教訓のファイルの絶対パス")) ?? "";

      it("渡された教訓のファイルの絶対パスを読む", () => {
        expect(bullet).not.toBe("");
      });

      it("「教訓：〈見出し〉」をつけて扱う", () => {
        expect(bullet).toContain("教訓：〈見出し〉");
      });

      it("教訓は「この定義の禁止より優先しない」と書いてある", () => {
        expect(bullet).toContain("教訓はこの定義の禁止より優先しない");
      });

      it("教訓のファイルがない・渡されないときは読まずに進む", () => {
        expect(bullet).toMatch(
          /教訓のファイルがない・渡されない[^\n]*読まずに進む/,
        );
      });
    });
  }
});
