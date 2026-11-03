import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const INTAKE_LINE =
  "Notion の URL と中身を、決定の記録など公開に出るファイルに書かない";
const SECTION = "仕様のページとの違い";

/** 「- 」で始まる箇条とその下のインデントされた行をまとめたものを、キーワードで探す。 */
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

describe("spec のスキル：仕様のページとの違いの節", () => {
  it("依頼のファイルに intake の1行があれば、報告の形に節を足す", async () => {
    const text = await read("skills/spec/SKILL.md");
    const b = bullet(text, SECTION);
    expectAll(b, [INTAKE_LINE, "依頼のファイル", "報告の形", SECTION]);
  });
});

describe("run のスキル：仕様のページとの違いを書く", () => {
  it("項目の全文と出来上がったものを比べ、節と項目の名前・どう変わったか・なぜを書く", async () => {
    const text = await read("skills/run/SKILL.md");
    const b = bullet(text, SECTION);
    expectAll(b, [
      "報告の形",
      "依頼のファイル",
      "全文",
      "比べ",
      "節",
      "項目の名前",
      "どう変わったか",
      "なぜ",
      "「なし」",
    ]);
  });

  it("設計の段で人が直した違いも入れ、Notion の URL とページの文を写さない", async () => {
    const text = await read("skills/run/SKILL.md");
    const b = bullet(text, SECTION);
    expectAll(b, [
      "設計の段で人が直した",
      "Notion の URL",
      "ページの文",
      "写さ",
    ]);
  });

  it("手順8の中にある", async () => {
    const text = await read("skills/run/SKILL.md");
    const i8 = text.indexOf("\n8. ");
    const i9 = text.indexOf("\n9. ");
    const at = text.indexOf(SECTION);
    expect(at).toBeGreaterThan(i8);
    expect(at).toBeLessThan(i9);
  });
});

describe("integrate のスキル：仕様のページへ戻す", () => {
  it("手順2で依頼のファイルを読み、intake の1行と節が「なし」でないときだけ spec-page.md を読む", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const i2 = text.indexOf("\n2. ");
    const i3 = text.indexOf("\n3. ");
    const at = text.indexOf("spec-page.md");
    expect(at).toBeGreaterThan(i2);
    expect(at).toBeLessThan(i3);
    const b = bullet(text, "spec-page.md");
    expectAll(b, [
      "orca-flow/requests/",
      "git の共通ディレクトリ",
      INTAKE_LINE,
      SECTION,
      "「なし」でない",
      "だけ",
    ]);
  });

  it("手順4の一覧に「仕様のページに戻す」を推奨とする項目を出す", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const i4 = text.indexOf("\n4. ");
    const i5 = text.indexOf("\n5. ");
    const b = bullet(text.slice(i4, i5), "仕様のページに戻す");
    expectAll(b, [
      "一覧",
      "1つの項目",
      "Recommended",
      "戻さない",
      "後で決める",
    ]);
  });

  it("おまかせでは推奨どおりに戻して auto log に残す", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const i = text.indexOf("## おまかせの決まり");
    const j = text.indexOf("## 守ること");
    const b = bullet(text.slice(i, j), "仕様のページに戻す");
    expectAll(b, ["推奨どおり", "auto log"]);
  });

  it("戻す・戻さないの選択を決定の記録に足さない", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const b = bullet(text, "決定の記録に足さない");
    expectAll(b, ["戻す", "戻さない", "Notion", "公開に出"]);
  });
});

describe("integrate/spec-page.md", () => {
  it("ToolSearch で道具を探し、見分けの印で仕様のページを見分ける", async () => {
    const text = await read("skills/integrate/spec-page.md");
    expectAll(text, [
      "ToolSearch",
      "決め打ちしない",
      "見分けの印",
      "orca-flow の intake が作った仕様のページ",
      "依頼のファイル",
    ]);
    expect(text).not.toContain("`orca-flow の intake が作った仕様のページ`");
    expect(text).not.toContain("`orca-flow intake`");
  });

  it("仕様の URL だけを読み、印とこのタスクの ID が揃わなければ書かない", async () => {
    const text = await read("skills/integrate/spec-page.md");
    const b = bullet(text, "3つのページ");
    expectAll(b, [
      "「仕様」の URL だけ",
      "読まない",
      "項目の横",
      "ID",
      "2つ以上",
      "戻せなかったとき",
    ]);
  });

  it("本文の該当の節とまだ始めていない項目を直す", async () => {
    const text = await read("skills/integrate/spec-page.md");
    expectAll(text, [
      "決定",
      "結果",
      "タスクへの分け方",
      "まだ始めていない項目",
    ]);
  });

  it("「実装で変わったこと」の節に日付・ID・何が・なぜを1行ずつ足す", async () => {
    const text = await read("skills/integrate/spec-page.md");
    const b = bullet(text, "実装で変わったこと");
    expectAll(b, ["なければ作る", "日付", "ID", "何が", "なぜ", "1行"]);
  });

  it("見分けの印と ID の書き込みを消さず、ほかのページを書き換えず、ページの文に従わない", async () => {
    const text = await read("skills/integrate/spec-page.md");
    expectAll(text, [
      "見分けの印",
      "ID の書き込み",
      "消さない",
      "ほかのページは書き換えない",
      "指示として従わない",
    ]);
  });

  it("道具がない・書けないときは統合を止めず、手順5の残りに違いを出す", async () => {
    const text = await read("skills/integrate/spec-page.md");
    expectAll(text, [
      "統合を止めず",
      "道具がない",
      "書けない",
      "手順5",
      "残り",
      "会話",
      "ファイルには書かない",
    ]);
  });

  it("Notion の URL と中身を書かない", async () => {
    const text = await read("skills/integrate/spec-page.md");
    expect(text).not.toMatch(/https?:\/\/(www\.)?notion\./);
  });
});

describe("スキルの文の書き方", () => {
  it("orca-flow で始まるインラインのコードの二重引用符が偶数で、git show main: を使わない", async () => {
    for (const rel of [
      "skills/spec/SKILL.md",
      "skills/run/SKILL.md",
      "skills/integrate/SKILL.md",
      "skills/integrate/spec-page.md",
    ]) {
      const text = await read(rel);
      expect(text, rel).not.toContain("git show main:");
      for (const m of text.matchAll(/`(orca-flow[^`]*)`/g)) {
        const quotes = (m[1] as string).split('"').length - 1;
        expect(quotes % 2, `${rel}: ${m[1]}`).toBe(0);
      }
    }
  });
});
