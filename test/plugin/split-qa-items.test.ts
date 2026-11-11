import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const PAGE = "skills/split/spec-page.md";
const SKILL = "skills/split/SKILL.md";

/** 見出しが heading で始まる「## 」の節の本文 */
function sec(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`## ${heading}`));
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

describe("分けた子のタスクのページの QA 項目", () => {
  it("子のページの並びで、決めてほしいこと・QA 項目・区切りの線が順に出る", async () => {
    const s = sec(await read(PAGE), "子のページを作る");
    const line =
      s.split("\n").find((l) => l.startsWith("- 子のタスクのページを、")) ?? "";
    expectInOrder(line, ["決めてほしいこと", "QA 項目", "区切りの線"]);
  });

  it("子の QA 項目は、親の項目のうち移す分を文を変えずに写し、当たらなければ「なし」", async () => {
    const s = sec(await read(PAGE), "子のページを作る");
    const line = s.split("\n").find((l) => l.startsWith("- QA 項目：")) ?? "";
    expectAll(line, ["移す分", "文を変えずに", "迷えば写す", "「なし」"]);
  });

  it("親に QA 項目の節がなければ子にも置かず、AI は新しく書かない", async () => {
    const s = sec(await read(PAGE), "子のページを作る");
    expectAll(s, [
      "親のタスクのページに QA 項目の節がなければ、子にも置かない",
      "AI は子のために新しく書かない",
    ]);
  });

  it("子の QA 項目の決まりの文に orca-flow の語がない", async () => {
    const s = sec(await read(PAGE), "子のページを作る");
    const line = s.split("\n").find((l) => l.startsWith("- QA 項目：")) ?? "";
    expect(line).not.toBe("");
    expect(line.toLowerCase()).not.toContain("orca-flow");
  });
});

describe("分けたときの親のページの QA 項目", () => {
  it("親の QA 項目と「QA の筋書き：」を書き換えず、子のブランチに筋書きを置かない", async () => {
    const s = sec(await read(PAGE), "親のページを直す");
    expectAll(s, [
      "QA 項目と、親のページの「QA の筋書き：」は書き換えない",
      "子のブランチには「QA の筋書き：」を置かない",
    ]);
  });

  it("子のブランチの太字の行は、前のブランチの「QA の筋書き：」の後ろに置く", async () => {
    const s = sec(await read(PAGE), "親のページを直す");
    expectAll(s, [
      "前のブランチのまとまり（「QA の筋書き：」とその項目まで）の後ろに置く",
    ]);
  });

  it("「実装で変わったこと」の行に子に写した QA 項目を添え、既存の行はそのまま残る", async () => {
    const s = sec(await read(PAGE), "親のページを直す");
    expectAll(s, [
      "「実装で変わったこと」の1行に、子のページに写した QA 項目（あれば）を添える",
      "- 親の項目のタスクのページの末尾「実装で変わったこと」（なければ作る）に1行足す：日付（`date +%F`）・親の ID・子の ID に分けたこと・移した中身・なぜ。すでにある行は書き換えない。",
    ]);
  });
});

describe("子の依頼のファイルの QA 項目", () => {
  it("手順8の移す分に、子のページに写した QA 項目が入り、子に効くのはそれだけと分かる", async () => {
    const text = await read(SKILL);
    const line =
      text.split("\n").find((l) => l.startsWith("   - 移す分：")) ?? "";
    expectAll(line, [
      "手順7で子のページに写した QA 項目",
      "子に効く QA 項目はこれだけ",
      "子の完了条件の候補にしない",
    ]);
  });

  it("子のページを作らなかったときは、子に効く QA 項目を限らない", async () => {
    const text = await read(SKILL);
    const line =
      text.split("\n").find((l) => l.startsWith("   - 移す分：")) ?? "";
    expectAll(line, [
      "手順7で子のページを作ったときは、子に効く QA 項目はこれだけ",
      "子のページを作らなかったときは、この限りを書かない",
    ]);
  });
});
