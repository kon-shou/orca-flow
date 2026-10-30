import { describe, expect, it } from "vitest";
import { parseConfig, type ProgressConfig } from "../../src/config.ts";
import {
  addRow,
  progressIds,
  ProgressError,
  setCell,
} from "../../src/lib/progress.ts";

const config = (): ProgressConfig =>
  parseConfig({ progress: { file: "docs/progress.md" } }).progress!;

// 見出しの列の順が既定（ID・タスク・依存・状態・ブランチ）と違う表
const TEXT = `# 進捗

前の文。| を含む行。

| ブランチ          | 状態   | ID  | メモ           | タスク   | 依存 |
| ----------------- | ------ | --- | -------------- | -------- | ---- |
| main              | 統合済み | T01 | 雛形           | 雛形     | —    |
| task/T02-a        | 設計中 | \`T02\` | a \\| b       | 買い物   | T01  |
| task/T03-b        | 作業中 | T03 |                | 在庫     | T01  |

うしろの文。

| ID | 別の表 |
| -- | ------ |
| T02 | x |
`;

describe("progress", () => {
  it("対象の行の対象の列だけが変わり、ほかは1文字も変わらない", () => {
    const after = setCell(TEXT, config(), "T02", "state", "作業中");
    const beforeLines = TEXT.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines).toHaveLength(beforeLines.length);
    const changed = afterLines
      .map((line, i) => (line === beforeLines[i] ? -1 : i))
      .filter((i) => i >= 0);
    expect(changed).toEqual([7]);
    expect(afterLines[7]).toBe(
      "| task/T02-a        | 作業中 | `T02` | a \\| b       | 買い物   | T01  |",
    );
  });

  it("行を表の最後に足す", () => {
    const after = addRow(TEXT, config(), {
      id: "T04",
      title: "通知",
      depends: "T02、T03",
      state: "設計中",
      branch: "task/T04-notify",
    });
    const lines = after.split("\n");
    expect(lines[9]).toBe(
      "| task/T04-notify | 設計中 | T04 | | 通知 | T02、T03 |",
    );
    expect(lines.filter((_, i) => i !== 9).join("\n")).toBe(TEXT);
  });

  it("ID の列を読む", () => {
    expect(progressIds(TEXT, config())).toEqual(["T01", "T02", "T03"]);
  });

  it("行や表がなければ ProgressError", () => {
    expect(() => setCell(TEXT, config(), "T99", "state", "x")).toThrow(
      ProgressError,
    );
    expect(() => addRow("表がない\n", config(), { id: "T1" })).toThrow(
      ProgressError,
    );
  });

  it("CRLF の改行を保つ", () => {
    const crlf = TEXT.replace(/\n/g, "\r\n");
    const after = setCell(crlf, config(), "T03", "state", "統合済み");
    expect(after.split("\r\n")).toHaveLength(crlf.split("\r\n").length);
    expect(after).toContain("| task/T03-b        | 統合済み | T03 |");
  });
});
