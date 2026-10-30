import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATES_DIR } from "../../src/commands/init.ts";
import {
  MAX_BULLET_CHARS,
  MAX_CODE_LINES,
  MAX_SUMMARY_LINES,
  MAX_TABLE_CELL_CHARS,
  SPLIT_TASK_ITEMS,
  readabilityWarnings,
} from "../../src/lib/readability.ts";
import { parseTaskDoc } from "../../src/lib/task-doc.ts";

/** 決まりどおりの設計書。各テストでここから1か所だけ変える */
function doc(
  options: {
    summary?: string[] | null;
    body?: string;
    items?: number;
  } = {},
): string {
  const summary =
    options.summary === undefined
      ? [
          "- 目的：買い物の一覧を見やすくしたい。",
          "- 変わること：買い物の一覧を直す。",
          "- 決めてほしいこと：なし",
          "- 気をつけること：なし",
        ]
      : options.summary;
  const items = Array.from(
    { length: options.items ?? 2 },
    (_, i) => `${i + 1}. 作るもの${i + 1}`,
  );
  return [
    "# タスク T12：買い物の直し",
    "",
    ...(summary === null ? [] : ["## 要点", "", ...summary, ""]),
    "## 作るもの",
    "",
    ...items,
    "",
    "## 守ること",
    "",
    options.body ?? "- 決まりを守る。",
    "",
  ].join("\n");
}

const chars = (n: number, ch = "あ") => ch.repeat(n);

describe("readabilityWarnings", () => {
  it("決まりどおりの設計書には警告を出さない", () => {
    expect(readabilityWarnings(doc())).toEqual([]);
  });

  it("「要点」の節がなければ警告する", () => {
    const warnings = readabilityWarnings(doc({ summary: null }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("要点");
  });

  it("要点の最初の箇条書きが「目的：」で始まらなければ、「目的」を含む警告を1つ出す", () => {
    const warnings = readabilityWarnings(
      doc({
        summary: ["- 変わること：一覧を直す。", "- 気をつけること：なし"],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("目的");
  });

  it("目的の行が2行目以降なら、同じ警告を出す", () => {
    const warnings = readabilityWarnings(
      doc({
        summary: ["- 変わること：一覧を直す。", "- 目的：見やすくする。"],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("目的");
  });

  it("「目的:」（半角のコロン）でも警告しない", () => {
    expect(
      readabilityWarnings(doc({ summary: ["- 目的: 見やすくする。"] })),
    ).toEqual([]);
  });

  it("要点の節がなければ「要点がない」の警告だけを出し、目的の警告は出さない", () => {
    const warnings = readabilityWarnings(doc({ summary: null }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("目的");
  });

  it("「要点（承認の判断に使う）」のように後ろに書き添えがあっても要点の節とみなす", () => {
    const text = doc().replace("## 要点", "## 要点（承認の判断に使う）");
    expect(readabilityWarnings(text)).toEqual([]);
  });

  it("要点の空でない行が10行を超えたら警告する", () => {
    const lines = [
      "- 目的：行を数える。",
      ...Array.from({ length: MAX_SUMMARY_LINES }, (_, i) => `- 行${i + 1}`),
    ];
    const warnings = readabilityWarnings(doc({ summary: lines }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("要点");
    expect(warnings[0]).toContain(String(MAX_SUMMARY_LINES + 1));
  });

  it("要点がちょうど10行で、空行をはさんでいても警告しない", () => {
    const lines = [
      "- 目的：行を数える。",
      "",
      ...Array.from({ length: MAX_SUMMARY_LINES - 1 }, (_, i) => [
        `- 行${i + 1}`,
        "",
      ]).flat(),
    ];
    expect(readabilityWarnings(doc({ summary: lines }))).toEqual([]);
  });

  it("箇条書きの1項目が150文字を超えたら、節の名前と先頭20文字を入れて警告する", () => {
    const body = `- ${"い".repeat(20)}${chars(MAX_BULLET_CHARS - 19)}`;
    const warnings = readabilityWarnings(doc({ body }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("守ること");
    expect(warnings[0]).toContain("い".repeat(20));
    expect(warnings[0]).not.toContain(`${"い".repeat(20)}あ`);
  });

  it("箇条書きがちょうど150文字なら警告しない（絵文字も見た目の1文字と数える）", () => {
    expect(
      readabilityWarnings(doc({ body: `- ${chars(MAX_BULLET_CHARS)}` })),
    ).toEqual([]);
    expect(
      readabilityWarnings(doc({ body: `- ${chars(MAX_BULLET_CHARS, "🍳")}` })),
    ).toEqual([]);
  });

  it("番号つきの項目と字下げした項目も箇条書きとして数える", () => {
    const body = `- 親\n  - ${chars(MAX_BULLET_CHARS + 1)}`;
    expect(readabilityWarnings(doc({ body }))).toHaveLength(1);
    const numbered = doc().replace("1. 作るもの1", `1. ${chars(151)}`);
    const warnings = readabilityWarnings(numbered);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("作るもの");
  });

  it("表のセルが60文字を超えたら警告する", () => {
    const body = `| 名前 | 説明 |\n| --- | --- |\n| a | ${chars(MAX_TABLE_CELL_CHARS + 1)} |`;
    const warnings = readabilityWarnings(doc({ body }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("表");
    expect(warnings[0]).toContain("守ること");
  });

  it("表のセルがちょうど60文字なら、行全体が長くても警告しない", () => {
    const cell = chars(MAX_TABLE_CELL_CHARS);
    const body = `| 名前 | 説明 | 備考 |\n| --- | --- | --- |\n| a | ${cell} | ${cell} |`;
    expect(readabilityWarnings(doc({ body }))).toEqual([]);
  });

  it("コードブロックが5行を超えたら警告する", () => {
    const code = Array.from(
      { length: MAX_CODE_LINES + 1 },
      (_, i) => `echo ${i}`,
    );
    const body = ["```sh", ...code, "```"].join("\n");
    const warnings = readabilityWarnings(doc({ body }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("コードブロック");
    expect(warnings[0]).toContain(String(MAX_CODE_LINES + 1));
  });

  it("コードブロックがちょうど5行なら、中の長い行や見出しも数えずに警告しない", () => {
    const code = [
      "## 見出しではない",
      `- ${chars(MAX_BULLET_CHARS + 1)}`,
      `| ${chars(MAX_TABLE_CELL_CHARS + 1)} |`,
      "a",
      "b",
    ];
    const body = ["```", ...code, "```"].join("\n");
    expect(readabilityWarnings(doc({ body }))).toEqual([]);
  });

  it("「作るもの」の一番上の番号つきの項目が8つ以上なら、タスクを分けることを考えるよう警告する", () => {
    const warnings = readabilityWarnings(doc({ items: SPLIT_TASK_ITEMS }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("作るもの");
    expect(warnings[0]).toContain("タスクを分けることを考える");
  });

  it("「作るもの」が7つで、字下げした番号つきの項目がいくつあっても警告しない", () => {
    const nested = Array.from({ length: 5 }, (_, i) => `   ${i + 1}. 細部`);
    const text = doc({ items: SPLIT_TASK_ITEMS - 1 }).replace(
      "1. 作るもの1",
      ["1. 作るもの1", ...nested].join("\n"),
    );
    expect(readabilityWarnings(text)).toEqual([]);
  });
});

describe("テンプレート", () => {
  it("新しいテンプレートは警告が0件で、要点から始まる", async () => {
    const text = await readFile(
      path.join(TEMPLATES_DIR, "spec-template.md"),
      "utf8",
    );
    expect(readabilityWarnings(text)).toEqual([]);
    const summaryFirst = text
      .split("\n")
      .slice(text.split("\n").indexOf("## 要点") + 1)
      .find((line) => line.trim() !== "");
    expect(summaryFirst).toMatch(/^- 目的：/);
    const headings = text
      .split("\n")
      .filter((line) => /^## /.test(line))
      .map((line) => line.slice(3));
    expect(headings).toEqual([
      "要点",
      "作るもの",
      "完了条件（自動テストで確認する）",
      "書き込んでよい場所",
      "担当の分け方",
      "作業中のほかのタスクとの重なり",
      "main への事前変更",
      "読むもの",
      "依存",
      "守ること",
      "報告の形",
    ]);
  });

  it("新しいテンプレートから、今と同じく書き込んでよい場所と担当を読み取れる", async () => {
    const text = await readFile(
      path.join(TEMPLATES_DIR, "spec-template.md"),
      "utf8",
    );
    const parsed = parseTaskDoc(text);
    expect(parsed.allowed).toEqual(["src/feature-a"]);
    expect(parsed.workers).toEqual([
      {
        name: "担当A：〈名前〉",
        paths: ["src/feature-a/core", "test/feature-a/core"],
      },
    ]);
    expect(parsed.warnings).toEqual([]);
  });
});
