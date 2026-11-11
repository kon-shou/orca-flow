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
const WORKSPACE = "skills/intake/workspace.md";
const SKILL = "skills/intake/SKILL.md";
const SPEC = "docs/spec.md";

function sec(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `## ${heading}`);
  if (at < 0) return "";
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function item(text: string, start: string): string {
  const found = text.split("\n").find((l) => l.startsWith(start));
  expect(found, `「${start}」で始まる行がありません`).toBeDefined();
  return found as string;
}

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

const MUTUAL = ["互いを指す", "new"];

describe("たどった親の確かめ：page-format.md の形の見分け", () => {
  it("印・見出し「何が変わるか」・互いを指すかを確かめ、外れたら止まって人に示す", async () => {
    const s = sec(await read(FORMAT), "形の見分け");
    expectAll(s, [
      "見分けの印",
      "何が変わるか",
      ...MUTUAL,
      "止まり",
      "渡された URL",
      "たどった親の URL",
      "外れた点",
    ]);
  });

  it("URL はページの ID で比べる", async () => {
    const s = sec(await read(FORMAT), "形の見分け");
    expectAll(s, ["ページの ID", "16進", "32文字", "ハイフン"]);
  });

  it("Notion に書く文に orca-flow の語を入れない", async () => {
    const s = sec(await read(FORMAT), "形の見分け");
    const added = s
      .split("\n")
      .filter((l) => l.includes("互いを指す"))
      .join("\n");
    expect(added).not.toContain("orca-flow");
    expect(added).not.toMatch(/notion\.(so|site)/);
  });
});

describe("手順10の確かめ：guards.md", () => {
  it("タスクのページから親をたどる項が、形の見分けの確かめを指す", async () => {
    const g = await read(GUARDS);
    const trace = item(
      g,
      "- 渡された URL がタスクのページなら、つながりの行のリンクから親をたどる",
    );
    expectAll(trace, ["page-format.md", "形の見分け", "確かめ"]);
  });

  it("読み直しで、始める各項目が互いを指すかを確かめ、外れたら new を流さず止まる", async () => {
    const g = await read(GUARDS);
    const re = item(g, "- 読み直すとき、");
    expectAll(re, [
      "始める各項目",
      "互いを指す",
      "どの new も流さず",
      "項目",
      "外れた点",
      "止まる",
    ]);
  });

  it("new が通るたびに：ブランチの行と項目のリポジトリで場所を選び、書いたら読み直して確かめ、外れたら直さず止まる", async () => {
    const g = await read(GUARDS);
    const l = item(g, "- new が通るたびに");
    expectAll(l, [
      "ブランチ〈番号〉 〈slug〉",
      "項目のリポジトリ",
      "状態の行の文だけで選ばない",
      "親を読み直し",
      "開始済み 〈ID〉",
      "ほかの項目の状態の行にその ID がない",
      "自分で直さず",
      "止まる",
      "入った場所",
    ]);
  });

  it("前の形の言葉は、状態の行（前の形では状態の欄）と両方で書く", async () => {
    const g = await read(GUARDS);
    const l = item(g, "- new が通るたびに");
    expect(l).toContain("状態の行（前の形では状態の欄）");
    expect(l).toContain("項目の横");
    expect(g).toContain("状態の行（前の形では状態の欄）");
  });

  it("足した文に orca-flow の語と Notion のドメインがない", async () => {
    const g = await read(GUARDS);
    const l = item(g, "- new が通るたびに");
    expect(l).not.toContain("orca-flow");
    expect(l).not.toMatch(/notion\.(so|site)/);
  });
});

describe("読み直しを指す文：page-format.md と workspace.md", () => {
  it("「状態と ID」が、guards.md の書いたあとの読み直しを指す", async () => {
    const s = sec(await read(FORMAT), "状態と ID");
    expectAll(s, ["guards.md", "読み直"]);
  });

  it("「配る」が、guards.md の書いたあとの読み直しを指す", async () => {
    const l = item(
      sec(await read(WORKSPACE), "手順10の差し替え：配る"),
      "- 配る：",
    );
    expectAll(l, ["書いたあとの読み直し", "new が通るたびに", "guards.md"]);
  });

  it("ワークスペースの道では名前も含めて比べる", async () => {
    const l = item(
      sec(await read(WORKSPACE), "手順10の差し替え：配る"),
      "- 配る：",
    );
    expectAll(l, ["〈名前〉:〈ID〉で比べ", "名前の違う同じ ID"]);
    const g = item(
      sec(await read(GUARDS), "手順10：始める前の守り"),
      "- new が通るたびに",
    );
    expectAll(g, ["〈名前〉:〈ID〉で比べ", "値全体"]);
  });

  it("代わりの道で、親のブランチの項目の行にタスクのページへのリンクを書き足す", async () => {
    const s = sec(await read(FORMAT), "作れないときの代わり");
    expectAll(s, [
      "親のそのブランチの項目の行にリンクとして書き足し",
      "互いを指すことを確かめる",
    ]);
  });
});

describe("仕様書 10.1", () => {
  it("「始め方：」の項に、たどった親と読み直しの指し合いの要約がある", async () => {
    const spec = await read(SPEC);
    const l = item(spec, "- 始め方：「待つもの：ブランチ〈番号〉」の依存は");
    expectAll(l, ["互いを指す", "ページの ID", "どの new も流さず", "止まる"]);
  });

  it("「new が通るたびに」の項に、場所の選び方と読み直しの要約がある", async () => {
    const spec = await read(SPEC);
    const l = item(spec, "- new が通るたびに、すぐ親のページ");
    expectAll(l, [
      "ブランチ〈番号〉 〈slug〉",
      "読み直し",
      "ほかの項目の状態の行にその ID がない",
      "自分で直さず",
    ]);
  });
});

const NOTION_DOMAIN = /notion\.(so|site|com)/i;

function linesWith(text: string, words: string[]): string[] {
  return text.split("\n").filter((l) => words.some((w) => l.includes(w)));
}

describe("URL の取り方と止まったときの案内", () => {
  it("形の見分けに、? と # から後ろを除き、パスの末尾の32文字をページの ID とする行がある", async () => {
    const s = sec(await read(FORMAT), "形の見分け");
    const l = item(s, "- ID を取る前に");
    expectAll(l, [
      "`?`",
      "`#`",
      "から後ろを除く",
      "パスの末尾",
      "末尾",
      "16進",
      "32文字",
      "ページの ID",
    ]);
    const lines = s.split("\n");
    expect(lines.indexOf(l)).toBe(
      lines.findIndex((x) => x.startsWith("- URL はページの ID で比べる")) + 1,
    );
  });

  it("手順10の守りに、止まったときの案内の項がある", async () => {
    const s = sec(await read(GUARDS), "手順10：始める前の守り");
    const l = item(s, "- ID の書き場所で止まったとき");
    expectAll(l, [
      "そのブランチのその項目の状態の行",
      "〈番号〉. 〈タスク名〉",
      "開始済み 〈ID〉",
      "消して",
      "打ち直",
      "二重に始まりうる",
      "書けなかったとき",
      "ほかの項目の状態の行",
      "〈名前〉:〈ID〉",
      "開始済み 〈名前〉:〈ID〉",
      "状態の欄",
      "項目の横",
    ]);
    for (const w of ["new が通るたび", "終了コード", "依頼のファイルには"]) {
      expect(l).not.toContain(w);
    }
  });

  it("1つのリポジトリの道でも、読み直しで ID を値全体で比べる", async () => {
    const s = sec(await read(GUARDS), "手順10：始める前の守り");
    const l = item(s, "- 1つのリポジトリの道でも");
    expectAll(l, ["読み直し", "部分の一致でなく値全体で比べる"]);
  });

  it("SKILL.md の手順8に、親の行へリンクを書き足して読み直す文がある", async () => {
    const t = await read(SKILL);
    const lines = t.split("\n");
    const at = lines.findIndex((x) =>
      x.startsWith("   - 子ページを作れないときは"),
    );
    expect(at).toBeGreaterThan(0);
    const l = lines[at + 1] ?? "";
    expectAll(l, [
      "もらった各タスクのページの URL",
      "そのブランチのその項目の行にリンクとして書き足し",
      "書けなければ人に頼み",
      "親を読み直して互いを指すことを確かめる",
    ]);
  });

  it("足した行に Notion のドメインと orca-flow の語がない（配るの行は語だけ除く）", async () => {
    const format = sec(await read(FORMAT), "形の見分け");
    const alt = sec(await read(FORMAT), "作れないときの代わり");
    const guards = sec(await read(GUARDS), "手順10：始める前の守り");
    const skill = await read(SKILL);
    const idRule = "- URL はページの ID で比べる";
    const afterWrite = "- 書いたあとの読み直しは";
    const added = [
      ...linesWith(format, ["互いを指す", "- ID を取る前に", idRule]),
      ...linesWith(sec(await read(FORMAT), "状態と ID"), [afterWrite]),
      ...linesWith(alt, ["互いを指すことを確かめる"]),
      ...linesWith(guards, [
        "- 渡された URL がタスクのページなら",
        "- 読み直すとき、",
        "- new が通るたびに",
        "- ID の書き場所で止まったとき",
        "- 1つのリポジトリの道でも",
      ]),
      ...linesWith(skill, ["親を読み直して互いを指すことを確かめる"]),
    ];
    item(format, idRule);
    item(sec(await read(FORMAT), "状態と ID"), afterWrite);
    expect(added.length).toBeGreaterThanOrEqual(8);
    for (const l of added) {
      expect(l).not.toContain("orca-flow");
      expect(l).not.toMatch(NOTION_DOMAIN);
    }
    const dist = item(
      sec(await read(WORKSPACE), "手順10の差し替え：配る"),
      "- 配る：",
    );
    expect(dist).not.toMatch(NOTION_DOMAIN);
  });
});
