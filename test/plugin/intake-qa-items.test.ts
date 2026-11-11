import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const FORMAT = "skills/intake/page-format.md";
const GUARDS = "skills/intake/guards.md";

function sec(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `## ${heading}`);
  if (at < 0) return "";
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

function expectInOrder(text: string, words: string[]) {
  let from = 0;
  for (const w of words) {
    const at = text.indexOf(w, from);
    expect(at, `「${w}」が順に見つかりません`).toBeGreaterThanOrEqual(0);
    from = at + w.length;
  }
}

/** 10.1 の段落『Notion の要件から始める』の行 */
async function specParagraphLines(): Promise<string[]> {
  const lines = (await read("docs/spec.md")).split("\n");
  const ten = lines.findIndex((l) => l.startsWith("### 10.1"));
  expect(ten).toBeGreaterThanOrEqual(0);
  const from = lines.findIndex(
    (l, i) => i > ten && l.startsWith("**Notion の要件から始める**"),
  );
  expect(from).toBeGreaterThanOrEqual(0);
  const to = lines.findIndex((l, i) => i > from && l.startsWith("**"));
  return lines.slice(from, to < 0 ? undefined : to);
}

describe("タスクのページの QA 項目：page-format.md", () => {
  it("タスクのページの並びで、決めてほしいこと・QA 項目・区切りの線が順に出る", async () => {
    const s = sec(await read(FORMAT), "タスクのページの並び");
    expectInOrder(s, ["決めてほしいこと", "QA 項目", "区切りの線"]);
  });

  it("見出し「QA 項目」がちょうど1つあり、決めてほしいことと細部の見出しの間にある", async () => {
    const lines = (await read(FORMAT)).split("\n");
    const qa = lines.filter((l) => l === "## QA 項目");
    expect(qa).toHaveLength(1);
    const ask = lines.indexOf("## 決めてほしいこと");
    const at = lines.indexOf("## QA 項目");
    const detail = lines.indexOf("## 細部（AI 向け）");
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(detail).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(ask);
    expect(at).toBeLessThan(detail);
  });

  it("QA 項目の節に、形・必須を先・数の目安・答えに数えない・書き換えないの文がある", async () => {
    const s = sec(await read(FORMAT), "QA 項目");
    expectAll(s, [
      "必須",
      "できれば",
      "→",
      "必須を先",
      "数の目安を置かない",
      "質問の答えに数えない",
      "書き換えない",
    ]);
  });

  it("QA 項目の節に、目で見る項目の印の形と、印のない形も読める文がある", async () => {
    const s = sec(await read(FORMAT), "QA 項目");
    const lines = s.split("\n").filter((l) => l.includes("（目で見る）"));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expectAll(lines.join("\n"), [
      "必須（目で見る）：",
      "できれば（目で見る）：",
      "印のない",
    ]);
  });

  it("QA 項目の節（例を含む）に orca-flow の語がない", async () => {
    const s = sec(await read(FORMAT), "QA 項目");
    expect(s).toContain("例：");
    expect(s.toLowerCase()).not.toContain("orca-flow");
  });

  it("ブランチの節に、QA の筋書きを項目が2つ以上のブランチだけに置く文がある", async () => {
    const s = sec(await read(FORMAT), "ブランチ");
    expectAll(s, ["QA の筋書き：", "項目が2つ以上のブランチだけ"]);
    expect(s.toLowerCase()).not.toContain("orca-flow");
  });

  it("作れないときの代わりに、QA 項目の代わりの文がある", async () => {
    const s = sec(await read(FORMAT), "作れないときの代わり");
    const line = s.split("\n").find((l) => l.includes("QA 項目")) ?? "";
    expectAll(line, ["箇条書き", "答えに数えない"]);
  });
});

describe("QA 項目の守り：guards.md", () => {
  it("手順6に、変更の場所ごとの洗い出し・6つの観点・重要度・ネット検索しないの文がある", async () => {
    const s = sec(await read(GUARDS), "手順6：下書きの決まり");
    expectAll(s, [
      "変更の場所ごと",
      "変わらない動きは並べない",
      "  - 機能：",
      "  - データ：",
      "  - つながり：",
      "  - 環境：",
      "  - 運用：",
      "  - 時間：",
      "境界値",
      "権限とロール",
      "起きやすさと影響",
      "intake のときにネット検索しない",
      "QA やテストの決まり",
    ]);
  });

  it("手順6に、見た目の項目に「（目で見る）」の印を付ける文がある", async () => {
    const s = sec(await read(GUARDS), "手順6：下書きの決まり");
    const line = s.split("\n").find((l) => l.includes("（目で見る）")) ?? "";
    expectAll(line, ["必須（目で見る）：", "できれば（目で見る）："]);
  });

  it("手順10に、書き換えない・見直しの候補・答えに数えない・足さない・写しの文がある", async () => {
    const s = sec(await read(GUARDS), "手順10：始める前の守り");
    const qa = s
      .split("\n")
      .filter((l) => l.includes("QA"))
      .join("\n");
    expectAll(qa, [
      "反映で書き換えない",
      "反映の元にもしない",
      "細部を QA 項目に合わせて直さず",
      "見直しの候補",
      "答えに数えない",
      "今あるページに足さない",
      "依頼のファイル",
      "E2E",
    ]);
  });

  it("手順10の前からある反映と質問の読み方の行はそのまま残る", async () => {
    const s = sec(await read(GUARDS), "手順10：始める前の守り");
    expect(s).toContain(
      "- 反映：読み直したあと、上の所と細部が食い違う所、答えの出た質問が細部の決定や項目に入っていない所を、上の所と答えに合わせて細部で直す。",
    );
    expect(s).toContain(
      "- 「これからも」のチェック（代わりの形では「これからも：」の行）は、選択肢のチェックの数に数えない",
    );
  });
});

describe("QA 項目を完了条件の候補にする：spec の SKILL.md", () => {
  it("手順4に、QA 項目を完了条件の候補にする文がある", async () => {
    const lines = (await read("skills/spec/SKILL.md")).split("\n");
    const from = lines.findIndex((l) => l.startsWith("4. "));
    const to = lines.findIndex((l, i) => i > from && l.startsWith("5. "));
    expect(from).toBeGreaterThanOrEqual(0);
    const step = lines.slice(from, to < 0 ? undefined : to).join("\n");
    const line = step.split("\n").find((l) => l.includes("QA 項目")) ?? "";
    expectAll(line, ["依頼のファイル", "自動", "完了条件の候補"]);
  });
});

describe("QA 項目：docs/spec.md の10.1", () => {
  it("親のページとタスクのページの行に、QA 項目と QA の筋書きがある", async () => {
    const lines = await specParagraphLines();
    const pages =
      lines.find((l) => l.startsWith("- 親のページとタスクのページ：")) ?? "";
    expectAll(pages, [
      "そのタスクだけに効く決めてほしいこと・QA 項目・細部",
      "「QA の筋書き：」",
    ]);
  });

  it("段落に「- QA 項目：」で始まる行がちょうど1つある", async () => {
    const lines = await specParagraphLines();
    const qa = lines.filter((l) => l.startsWith("- QA 項目："));
    expect(qa).toHaveLength(1);
    expectAll(qa[0] ?? "", [
      "必須",
      "できれば",
      "変更の場所ごと",
      "ネット検索しない",
      "書き換えず",
      "見直しの候補",
      "答えに数えない",
      "完了条件の候補",
    ]);
  });
});
