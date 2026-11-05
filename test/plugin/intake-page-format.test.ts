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
const NEW_MARK = "要件から自動で作った仕様のページ";
const OLD_MARK = "orca-flow の intake が作った仕様のページ";

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

describe("仕様のページの形：page-format.md", () => {
  it("見出しが、印・読み方・要点・決めてほしいこと・一覧・細部・出典の順に出る", async () => {
    const t = await read(FORMAT);
    const heads = t
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    const names = [
      "見分けの印の行",
      "読み方の行",
      "要点",
      "決めてほしいこと",
      "タスクの一覧",
      "細部（AI 向け）",
      "出典",
    ];
    const at = names.map((n) => heads.indexOf(n));
    for (const [i, n] of names.entries())
      expect(at[i], `見出し「${n}」がありません`).toBeGreaterThanOrEqual(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("質問の決まり", async () => {
    const q = sec(await read(FORMAT), "決めてほしいこと");
    expectAll(q, [
      "吹き出し",
      "コールアウト",
      "チェックボックス",
      "おすすめ",
      "理由",
      "いつまでに要るか",
      "効く所",
      "答え・補足",
    ]);
  });

  it("表の列・細部の節・折りたたみ・代わり・古い形", async () => {
    const t = await read(FORMAT);
    expectAll(sec(t, "タスクの一覧"), [
      "タスク名",
      "依存",
      "見込みの大きさ",
      "状態",
    ]);
    expectAll(sec(t, "細部（AI 向け）"), [
      "状況",
      "決定",
      "結果",
      "捨てた案",
      "タスクへの分け方",
      "折りたたみ",
    ]);
    expect(sec(t, "作れないときの代わり")).toContain("見出しと箇条書き");
    expect(sec(t, "古い形のページ")).toContain(
      "今までどおり項目の横（見出しの横など）の ID を読む",
    );
    expectAll(sec(t, "古い形のページ"), ["タスクの一覧", "細部（AI 向け）"]);
    expect(sec(t, "作れないときの代わり")).toContain("状態：開始済み 〈ID〉");
  });

  it("ID を書く所と読み方の行", async () => {
    const t = await read(FORMAT);
    expect(sec(t, "タスクの一覧")).toContain("開始済み 〈ID〉");
    expect(sec(t, "ID を書く所")).toContain("状態の欄だけに書く");
    expect(sec(t, "読み方の行")).toContain("届かない");
  });

  it("印の行の決まり", async () => {
    const m = sec(await read(FORMAT), "見分けの印の行");
    expectAll(m, [NEW_MARK, OLD_MARK, "印とみなす", "本文の先頭"]);
  });

  it("Notion の URL がなく、Notion に書く文の例に orca-flow の語がない", async () => {
    for (const f of [
      FORMAT,
      "skills/intake/guards.md",
      "skills/integrate/spec-page.md",
    ]) {
      const t = await read(f);
      expect(t, f).not.toMatch(/notion\.(so|com)/);
    }
    const examples = (await read(FORMAT))
      .split("\n")
      .filter((l) => l.startsWith("> "));
    expect(examples.length).toBeGreaterThan(0);
    for (const l of examples) expect(l).not.toContain("orca-flow");
  });
});

describe("仕様のページの形：guards.md", () => {
  it("手順6は page-format.md を指し、節の5つの言葉が残る", async () => {
    const t = await read("skills/intake/guards.md");
    const s = sec(t, "手順6：下書きの決まり");
    expect(s).toContain("page-format.md");
    const line = s.split("\n").find((l) => l.startsWith("- 節は")) ?? "";
    expectAll(line, ["状況", "決定", "結果", "捨てた案", "タスクへの分け方"]);
    expect(s).toContain("末尾に別に足さない");
  });

  it("手順10に、答えの読み方・反映・古い形・開始済みの決まりがある", async () => {
    const t = await read("skills/intake/guards.md");
    const s = sec(t, "手順10：始める前の守り");
    expectAll(s, [
      "チェックが1つ",
      "チェックがない",
      "2つ以上",
      "反映",
      "細部の直しはありません",
      "「よい」を待つ",
      "古い形",
      "反映を飛ばし",
      "細部を直さず",
      "開始済みの項目にかかる直し",
      "補足を正",
      "page-format.md",
      "新しい形では",
      "「答え：」の行",
      "待たずに進む",
    ]);
    const idLine =
      s.split("\n").find((l) => l.includes("すぐ仕様のページにその ID")) ?? "";
    expectAll(idLine, ["状態の欄", "開始済み"]);
  });
});

describe("仕様のページの形：統合と仕様書", () => {
  it("spec-page.md の戻すに、上の所と古い形の文がある", async () => {
    const t = await read("skills/integrate/spec-page.md");
    const s = sec(t, "戻す");
    expectAll(s, [
      "上の所",
      "古い形",
      "今までどおり本文の節だけ",
      "答え・補足",
      "page-format.md",
      "状態の欄は変えない",
    ]);
    expect(sec(t, "守ること")).toContain("状態の欄");
    expect(sec(t, "仕様のページを見つける")).toContain("状態の欄");
  });

  it("spec-page-capture.md の ID の見分けに状態の欄がある", async () => {
    const t = await read("skills/integrate/spec-page-capture.md");
    expect(sec(t, "仕様のページと道具")).toContain("状態の欄");
  });

  it("docs/spec.md に page-format.md と項がある", async () => {
    const t = await read("docs/spec.md");
    const tree =
      t.split("\n").find((l) => l.startsWith("├── skills/intake/")) ?? "";
    expect(tree).toContain("page-format.md");
    const item =
      t.split("\n").find((l) => l.startsWith("- 仕様のページの形：")) ?? "";
    expect(item).toContain("page-format.md");
    const follow =
      t.split("\n").find((l) => l.startsWith("- `spec-page.md`：")) ?? "";
    expectAll(follow, ["上の所", "古い形", "答え・補足", "状態の欄は変えない"]);
  });
});
