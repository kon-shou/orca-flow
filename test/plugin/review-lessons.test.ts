import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 「- 」か「1. 」で始まる箇条とその下のインデントされた行を、キーワードで探す。 */
function bullet(text: string, keyword: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) => /^\s*(- |\d+\. )/.test(l) && l.includes(keyword),
  );
  expect(
    start,
    `「${keyword}」を含む箇条が見つかりません`,
  ).toBeGreaterThanOrEqual(0);
  const out = [lines[start] as string];
  const indent = (lines[start] as string).search(/\S/);
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === "" || l.search(/\S/) > indent) out.push(l);
    else break;
  }
  return out.join("\n");
}

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

function step(text: string, n: number): string {
  const i = text.indexOf(`\n${n}. `);
  const j = text.indexOf(`\n${n + 1}. `);
  expect(i, `手順${n}`).toBeGreaterThanOrEqual(0);
  return text.slice(i, j < 0 ? undefined : j);
}

describe("spec のスキル：教訓を読む", () => {
  it("手順1で orca-flow lessons を読み、設計と割り振りで避ける", async () => {
    const s1 = step(await read("skills/spec/SKILL.md"), 1);
    expectAll(s1, ["orca-flow lessons", "設計", "割り振り", "避ける"]);
  });
});

describe("run のスキル：教訓を読む", () => {
  it("手順1で orca-flow lessons を読み、担当に --path の絶対パスを渡す", async () => {
    const text = await read("skills/run/SKILL.md");
    expectAll(step(text, 1), ["orca-flow lessons", "避ける"]);
    expectAll(step(text, 1), ["orca-flow lessons --path", "絶対パス"]);
    expectAll(step(text, 4), ["教訓の絶対パス"]);
  });
});

describe("run のスキル：直しのあとに教訓を聞く", () => {
  it("直しの指示の箇条で、案をタブで聞く・ID とパスを書かない・似た項はまとめ直す", async () => {
    const b = bullet(await read("skills/run/SKILL.md"), "直しの指示が来たら");
    expectAll(b, [
      "タブ",
      "案",
      "ID",
      "手元のパス",
      "書かない",
      "似た項",
      "まとめ直",
      "orca-flow lessons add",
      "足した教訓：",
    ]);
  });

  it("聞くのは手順6のあと・手順8の前で、orca-flow status question にする", async () => {
    const b = bullet(await read("skills/run/SKILL.md"), "直しの指示が来たら");
    const ask = bullet(b, "教訓を聞く");
    expect(ask).toMatch(/手順6[^。\n]*あと[^。\n]*手順8[^。\n]*前/);
    expect(ask).toContain("orca-flow status question");
  });

  it("教訓の案は mktemp -d の一時ディレクトリに Write ツールで書き、消す", async () => {
    const b = bullet(await read("skills/run/SKILL.md"), "直しの指示が来たら");
    const add = bullet(b, "「足す」「直して足す」なら");
    expectAll(add, ["mktemp -d", "Write ツール", "一時ディレクトリを消す"]);
  });

  it("テストか lint にできる誤りなら後続のタスクを聞き、/orca-flow:new の1行を後回しにしたものに書く", async () => {
    const b = bullet(await read("skills/run/SKILL.md"), "直しの指示が来たら");
    expectAll(b, [
      "テストか lint",
      "後続のタスク",
      "/orca-flow:new",
      "1行",
      "後回しにしたもの",
    ]);
  });
});

describe("review のスキル：教訓をレビュー役と検証役に渡す", () => {
  it("教訓の絶対パスをレビュー役と検証役の渡すものに入れる", async () => {
    const text = await read("skills/review/SKILL.md");
    expectAll(text, ["orca-flow lessons --path", "教訓の絶対パス"]);
    const reviewer = bullet(text, "渡すもの：観点の名前と上の表のその行");
    expect(reviewer).toContain("教訓の絶対パス");
    const verifier = bullet(text, "渡すもの：渡す指摘");
    expect(verifier).toContain("教訓の絶対パス");
    expect(bullet(text, "教訓の絶対パス：")).toContain("「教訓：〈見出し〉」");
    expect(bullet(text, "検証役に渡す：run が本文に")).toContain(
      "教訓の絶対パス（`orca-flow lessons --path` の出力）",
    );
  });
});

describe("仕様書：教訓", () => {
  it("6章の終わりに置き場・項の形・200行の目安がある", async () => {
    const text = await read("docs/spec.md");
    const i = text.indexOf("**教訓のファイル**");
    const j = text.indexOf("\n## 7. ");
    expect(i).toBeGreaterThan(text.indexOf("\n## 6. "));
    expect(i).toBeLessThan(j);
    expectAll(text.slice(i, j), [
      "〈git の共通ディレクトリ〉/orca-flow/lessons.md",
      "見出し",
      "決まり",
      "理由",
      "見分け方",
      "観点",
      "200行",
    ]);
  });

  it("8章に lessons の3つの形と動きがある", async () => {
    const text = await read("docs/spec.md");
    const i = text.indexOf("\n## 8. ");
    const j = text.indexOf("\n## 9. ");
    expectAll(text.slice(i, j), [
      "`lessons [--path]`",
      "`lessons add 〈ファイル〉`",
      "`lessons remove 〈番号〉`",
      "教訓はありません",
      "200行",
      "警告",
    ]);
  });

  it("10.1 に spec・run・review の読み方と聞き方がある", async () => {
    const text = await read("docs/spec.md");
    const i = text.indexOf("\n### 10.1 ");
    const j = text.indexOf("\n### 10.2 ");
    expectAll(text.slice(i, j), [
      "orca-flow lessons --path",
      "orca-flow status question",
      "足した教訓：",
      "/orca-flow:new",
      "後回しにしたもの",
    ]);
  });

  it("10.2 の担当・レビュー役・検証役の定義が教訓を読み「教訓：〈見出し〉」をつける", async () => {
    const text = await read("docs/spec.md");
    const i = text.indexOf("\n### 10.2 ");
    const j = text.indexOf("\n### 10.3 ");
    const sec = text.slice(i, j);
    for (const key of [
      "**agents/task-worker.md**",
      "**agents/code-reviewer.md**",
      "**agents/review-verifier.md**",
    ]) {
      const start = sec.indexOf(key);
      expect(start, key).toBeGreaterThanOrEqual(0);
      const end = sec.indexOf("\n**agents/", start + 1);
      expectAll(sec.slice(start, end < 0 ? undefined : end), [
        "orca-flow lessons --path",
        "教訓：〈見出し〉",
      ]);
    }
  });
});
