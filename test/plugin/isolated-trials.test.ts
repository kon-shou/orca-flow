import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** 手順の行（`〈数〉. ` で始まる行）から、次の手順の行の前まで */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}がありません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (l, i) => i > start && new RegExp(`^${n + 1}\\. `).test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** 隔てた一時フォルダで試しを流す決まりの語 */
const RULE_WORDS = [
  "`TMPDIR`",
  "`TMP`",
  "`TEMP`",
  "`mktemp -d` で作ったフォルダ",
  "/tmp",
  "ほかの worktree",
  "ほかの実行のフォルダ",
  "消す範囲が自分で作ったフォルダの中だけかを確かめる",
  "確かめきれなかった",
  "消したり変えたりしない",
  "worktree のまま（`cd` せずに）",
  "3つは向ける",
  "再現と壊したコピーはそのフォルダの中に作る",
];

/** 外した言い回し（`cd` も向けない読みを許す） */
const OLD_PHRASE = "作ったフォルダの中で";

/** 仕様書 10.2 の節（次の `### ` の前まで）の行 */
function section102(spec: string): string[] {
  const lines = spec.split("\n");
  const start = lines.findIndex((l) => l.startsWith("### 10.2 担当の定義"));
  expect(start, "10.2 の節がありません").toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("### "));
  return lines.slice(start, end < 0 ? undefined : end);
}

const DEFINITIONS: [string, string, number][] = [
  ["レビュー役", "agents/code-reviewer.md", 6],
  ["検証役", "agents/review-verifier.md", 3],
  ["段末の裁定検証役", "agents/stage-verifier.md", 8],
];

describe("試しを隔てて流す決まり：担当の定義", () => {
  for (const [name, file, step] of DEFINITIONS) {
    it(`${name}の手順${step}に、決まりの語が全部ある`, async () => {
      const block = stepBlock(await read(file), step);
      for (const w of RULE_WORDS) expect(block, w).toContain(w);
      expect(block, OLD_PHRASE).not.toContain(OLD_PHRASE);
    });
  }

  it("段末の裁定検証役の手順8に、確かめきれなかったと書く欄（reason・evidence）がある", async () => {
    const block = stepBlock(await read("agents/stage-verifier.md"), 8);
    expect(block).toContain("`reason`");
    expect(block).toContain("`evidence`");
  });

  it("段末の裁定検証役の最後の手順は、JSON だけを返す決まりのまま", async () => {
    const text = await read("agents/stage-verifier.md");
    const steps = text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(steps.at(-1), "最後の手順が9ではありません").toMatch(/^9\. /);
    const last = stepBlock(text, 9);
    expect(last).toContain("JSON だけ");
    expect(last).toContain("前後に説明を書かない");
  });
});

describe("試しを隔てて流す決まり：仕様書 10.2", () => {
  it("レビュー役・検証役・段末の裁定検証役の項目に、TMPDIR と消す範囲の確かめがある", async () => {
    const spec = await read("docs/spec.md");
    const lines = section102(spec);
    const paragraphs: [string, RegExp][] = [
      [
        "レビュー役の6",
        /^6\. ファイルは変更しない。作業ツリーを変えるコマンド/,
      ],
      ["検証役の5", /^5\. 再現は worktree の外の一時ディレクトリ/],
      ["段末の裁定検証役", /^\*\*agents\/stage-verifier\.md\*\*/],
    ];
    for (const [name, re] of paragraphs) {
      const line = lines.find((l) => re.test(l));
      expect(line, `${name}の段落がありません`).toBeDefined();
      expect(line, name).toContain("`TMPDIR`");
      expect(line, name).toContain("`TMP`");
      expect(line, name).toContain("`TEMP`");
      expect(line, name).toContain("`mktemp -d`");
      for (const w of [
        "worktree のまま（`cd` せずに）",
        "3つは向ける",
        "再現と壊したコピーはそのフォルダの中に作る",
        "`/tmp`",
        "ほかの実行のフォルダ",
        "触れない",
        "確かめきれなかった",
      ])
        expect(line, `${name}：${w}`).toContain(w);
      expect(line, name).not.toContain(OLD_PHRASE);
      expect(line, name).toContain(
        "消す範囲が自分で作ったフォルダの中だけかを",
      );
    }
  });
});
