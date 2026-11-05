import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const spec = () => readFile(path.join(ROOT, "docs/spec.md"), "utf8");

const lineWith = (text: string, start: string) =>
  text.split("\n").find((l) => l.startsWith(start)) ?? "";

describe("ほかの追記だけのファイルの並びの戻し（仕様のテスト）", () => {
  it("7章の2に、ほかの追記だけのファイルの並びの戻しと警告だけで止めないことがある", async () => {
    const line = lineWith(await spec(), "2. **追記だけのファイルは union");
    expect(line).toContain("決定の記録でない追記だけのファイル");
    expect(line).toContain("止めずに警告だけ出す");
  });

  it("8章の verify の行に、ほかの追記だけのファイルの並びの戻しと警告だけで止めないことがある", async () => {
    const line = lineWith(await spec(), "| `verify`  ");
    expect(line).toContain("決定の記録でない追記だけのファイルの並びの戻し");
    expect(line).toContain("止めずに警告だけ出す");
  });

  it("8章 integrate の『決定の記録』に項があり、件名と二つの警告の文がある", async () => {
    const line = lineWith(
      await spec(),
      "- ほかの追記だけのファイルの並びの戻し",
    );
    expect(line).toContain("取り込みで変わった〈パス〉の行の並びを戻す");
    expect(line).toContain(
      "警告：〈パス〉 の行の並びを戻せませんでした（〈理由〉）",
    );
    expect(line).toContain(
      "警告：〈baseBranch〉 の 〈パス〉 が、タスクのブランチの 〈パス〉 の先頭と同じではありません",
    );
    expect(line).toContain("止めない");
    expect(line).toContain("終了コードと verify の記録を変えない");
  });

  it("『マージの順』の前のタスクの取り込みの行に、ほかの追記だけのファイルを戻すことがある", async () => {
    const line = lineWith(await spec(), "     - 取り込みの直後、decisionsFile");
    expect(line).toContain("ほかの追記だけのファイルも");
    expect(line).toContain("並びの戻し");
  });
});
