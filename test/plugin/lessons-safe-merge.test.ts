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

const REMOVE = "lessons remove 〈番号〉 --heading 〈見出し〉";

describe("run のスキル：教訓のまとめ直しは足してから見出しを確かめて消す", () => {
  it("add が remove より前に出て、断られたら消さない・読み直して番号を取る", async () => {
    const text = bullet(
      await read("skills/run/SKILL.md"),
      "直しの指示が来たら",
    );
    expectAll(text, [
      REMOVE,
      "add が断られたら消さない",
      "読み直して",
      "今の番号",
      "1項ずつ",
      "1回だけやり直",
      "人に伝える",
    ]);
    // まとめ直す順の箇条の中で、add が remove より前に出る（ほかの箇条の add で通らないように絞る）
    const order = bullet(text, "まとめ直す順：");
    expect(order.indexOf("orca-flow lessons add")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(REMOVE)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("orca-flow lessons add")).toBeLessThan(
      order.indexOf(REMOVE),
    );
    expectAll(order, ["終了コード0を確かめてから", "add が断られたら消さない"]);
  });

  it("足す箇条が、手順8へ進む前にまとめ直す順で元の項を消すよう指す", async () => {
    const text = bullet(
      await read("skills/run/SKILL.md"),
      "直しの指示が来たら",
    );
    const add = bullet(text, "「足す」「直して足す」なら");
    expect(add).toContain(
      "まとめ直しなら下の「まとめ直す順」で元の項を消してから手順8へ進む",
    );
  });

  it("lint にできる誤りは /orca-flow:to-lint、動かして分かる誤りは /orca-flow:new", async () => {
    const b = bullet(await read("skills/run/SKILL.md"), "直しの指示が来たら");
    expectAll(b, [
      "/orca-flow:to-lint 〈教訓の見出しか誤りの説明〉",
      "/orca-flow:new [--auto] 〈やりたいこと〉",
    ]);
  });
});

describe("仕様書：教訓の削除の確かめ", () => {
  it("8章に --heading と違うときの動きがある", async () => {
    const text = await read("docs/spec.md");
    const sec = text.slice(text.indexOf("\n## 8. "), text.indexOf("\n## 9. "));
    expectAll(sec, ["--heading", "完全に一致", "ファイルを変えず", "今の番号"]);
  });

  it("10.1 にまとめ直しの順と /orca-flow:to-lint がある", async () => {
    const text = await read("docs/spec.md");
    const sec = text.slice(
      text.indexOf("\n### 10.1 "),
      text.indexOf("\n### 10.2 "),
    );
    expectAll(sec, ["/orca-flow:to-lint", "/orca-flow:new", "--heading"]);
    // 教訓の読み方と聞き方の段落に絞り、まとめ直しの順を確かめる（push の「足してから」で通らないように）
    const start = sec.indexOf("**教訓の読み方と聞き方**");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = sec.indexOf("\n\n", start);
    const para = sec.slice(start, end === -1 ? undefined : end);
    const add = para.indexOf("lessons add");
    const remove = para.indexOf(REMOVE);
    expect(add).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(add).toBeLessThan(remove);
    expectAll(para, [
      "終了コード0を確かめてから",
      "読み直して今の番号を取り",
      "add が断られたら消さない",
      "/orca-flow:to-lint",
    ]);
  });
});
