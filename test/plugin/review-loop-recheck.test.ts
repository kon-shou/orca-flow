import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」が見つかりません`).toContain(w);
}

/** 見出し（行の頭が heading）から次の同じ階層以上の見出しの前まで。 */
function section(text: string, heading: RegExp, level: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `${heading} が見つかりません`).toBeGreaterThanOrEqual(0);
  const stop = new RegExp(`^#{1,${level}} `);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => stop.test(l));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

/** 手順 n の行と、その下のインデントされた行。 */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  const out = [lines[start] as string];
  for (const l of lines.slice(start + 1)) {
    if (/^\s+\S/.test(l) || l.trim() === "") out.push(l);
    else break;
  }
  return out.join("\n");
}

const lineWith = (text: string, word: string): string => {
  const line = text.split("\n").find((l) => l.includes(word));
  expect(line, `「${word}」を含む行が見つかりません`).toBeDefined();
  return line ?? "";
};

const OLD_MIX = "やり直しで新しく出た直したほうがよいは混ぜない";

describe("検証役のやり直しの読み方", () => {
  it("検証役の定義の手順7は、直した差分を 直す前のコミット..直し終わりの先頭 で読み、HEAD までは読まない", async () => {
    const step = lineWith(
      await read("agents/review-verifier.md"),
      "7. やり直しの形では",
    );
    expect(step).toContain("〈直す前のコミット〉..〈直し終わりの先頭〉");
    expect(step).not.toContain("〈直す前のコミット〉..HEAD");
  });

  it("検証役の定義の手順7は、直しで変えたものの使われる所を探して読み、壊れたものを新しい問題として返す", async () => {
    const step = lineWith(
      await read("agents/review-verifier.md"),
      "7. やり直しの形では",
    );
    expectAll(step, [
      "使われる所",
      "呼び出し元",
      "探して読み",
      "新しい問題として返す",
    ]);
  });

  it("review のスキルの手順7も、渡した範囲だけを読ませ、使われる所を探して読ませる", async () => {
    const step = stepBlock(await read("skills/review/SKILL.md"), 7);
    expectAll(step, [
      "〈直す前のコミット〉..〈直し終わりの先頭〉",
      "使われる所",
      "呼び出し元",
      "探して読み",
      "新しい問題として返す",
    ]);
  });

  it("仕様10.2の検証役は、範囲を 直し終わりの先頭 までにし、使われる所を読む", async () => {
    const spec = await read("docs/spec.md");
    const start = spec.indexOf("**agents/review-verifier.md**");
    const end = spec.indexOf("**agents/stage-verifier.md**");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const verifier = spec.slice(start, end);
    expect(verifier).toContain("〈直す前のコミット〉..〈直し終わりの先頭〉");
    expect(verifier).not.toContain("〈直す前のコミット〉..HEAD");
    expect(verifier).toContain("使われる所");
  });
});

describe("1回目のやり直しの直したほうがよいを混ぜる", () => {
  it("run の混ぜるものは、1回目のやり直しで出た分を2回目に混ぜ、2回目で出た分を報告に回す", async () => {
    const run = await read("skills/run/SKILL.md");
    const mix = lineWith(run, "- 混ぜるもの：");
    expectAll(mix, [
      "1回目のやり直しで新しく出た直したほうがよい",
      "2回目の直しに混ぜて直させる",
      "「混ぜた」の印",
      "2回の枠",
      "2回目のやり直しで新しく出た直したほうがよいは混ぜず、報告に回す",
    ]);
    expect(run).not.toContain(OLD_MIX);
  });

  it("仕様9章の混ぜるものも同じ", async () => {
    const spec = await read("docs/spec.md");
    const mix = lineWith(spec, "- 混ぜるもの：");
    expectAll(mix, [
      "1回目のやり直しで新しく出た直したほうがよい",
      "2回目の直しに混ぜる",
      "2回目のやり直しで新しく出た直したほうがよいは混ぜず、報告に回す",
    ]);
    expect(spec).not.toContain(OLD_MIX);
  });
});

describe("2回目のやり直しで新しく出た必ず直す", () => {
  it("run は直さず「統合の前に人が決めるもの」に入れて聞き、残った理由を「直しのあとに見つけた」にする", async () => {
    const step6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = lineWith(step6, "2回目のやり直しの review で新しく出た");
    expectAll(line, [
      "「必ず直す」",
      "直さない",
      "「統合の前に人が決めるもの」に入れて人に聞く",
      "「直しのあとに見つけた」",
    ]);
  });

  it("run と仕様の「直しのあとに見つけた」の意味に、必ず直すが入っている", async () => {
    const run = await read("skills/run/SKILL.md");
    const meaning = lineWith(run, "直しのあとに見つけた＝");
    expect(meaning).toContain("必ず直す");
    const spec = await read("docs/spec.md");
    const reason = lineWith(spec, "「直しのあとに見つけた」は、");
    expect(reason).toContain("確かの必ず直す");
  });

  it("仕様9章の統合の前に人が決めるものの箇条に、3回目の直しに入らず聞く文がある", async () => {
    const spec = await read("docs/spec.md");
    const line = lineWith(spec, "- 統合の前に人が決めるもの");
    expectAll(line, [
      "2回目のやり直しで新しく出た確かの必ず直すは、3回目の直しに入らず、直さずに聞く",
      "「直しのあとに見つけた」",
    ]);
  });
});

describe("最後の review のあとの確かめ", () => {
  it("run は、最後の review のあとの直しごとにやり直しの形を流し、2回の枠に数えず、出たものを直さない", async () => {
    const step6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = lineWith(step6, "最後の review のあとの確かめ（");
    expectAll(line, [
      "設計書・報告・decisionsFile の外",
      "やり直しの形を流す",
      "前の回の直させるものは「なし」",
      "2回の枠に数えない",
      "出たものは直さない",
      "「統合の前に人が決めるもの」に入れて聞き",
      "〈直す前のコミット〉..〈直し終わりの先頭〉",
      "直しごとに範囲を分けて流す",
      "その直しの分にもう一度流す",
    ]);
    expect(line).not.toContain("1回だけ流す");
  });

  it("run の手順10は、報告を直してコミットし直す前に、最後の review のあとの確かめを流す", async () => {
    const step10 = stepBlock(await read("skills/run/SKILL.md"), 10);
    expectAll(step10, [
      "報告を直してコミットし直す前に",
      "最後の review のあとの確かめ",
    ]);
  });

  it("仕様10.1にも同じ文がある", async () => {
    const spec = await read("docs/spec.md");
    const sec = section(spec, /^### 10\.1 /, 3);
    const line = lineWith(sec, "- 最後の review のあとの確かめ：");
    expectAll(line, [
      "やり直しの形の review を流す",
      "2回の枠に数えず",
      "出たものは直さない",
      "〈直す前のコミット〉..〈直し終わりの先頭〉",
      "直しごとに範囲を分ける",
      "その直しの分にもう一度流し",
    ]);
    expect(lineWith(spec, "- 決定の記録の項（run の手順7")).toContain(
      "どの codeReview の設定でも流す",
    );
    expect(lineWith(spec, "- 順にないタスクの競合の手直し（")).toContain(
      "`full` と `strict` で流れる",
    );
  });

  it("run の決定の記録の項は、秘密と個人のパスの確かめを decisionsFile の差分に絞って流してからコミットする", async () => {
    const step7 = stepBlock(await read("skills/run/SKILL.md"), 7);
    const line = lineWith(step7, "コミットの前に、`git add");
    expectAll(line, [
      "秘密と個人のパスの確かめ",
      "decisionsFile の差分に絞って流す",
      "git add -- 〈decisionsFile〉",
      "git diff --no-color --cached -- 〈decisionsFile〉",
      "追跡外",
      "当たりが出たら",
      "し直し、もう一度流して",
    ]);
    expect(line.indexOf("git add --")).toBeLessThan(
      line.indexOf("git diff --no-color --cached"),
    );
    const spec = await read("docs/spec.md");
    const specLine = lineWith(spec, "- 決定の記録の項（run の手順7");
    expectAll(specLine, [
      "decisionsFile の差分",
      "git add -- 〈decisionsFile〉",
      "git diff --no-color --cached",
      "どの codeReview の設定でも流す",
    ]);
  });
});

describe("順にないタスクの競合の手直し", () => {
  it("run は、最初の review のあとに競合を手で直したら rebase-review と見直しの形を流す", async () => {
    const run = await read("skills/run/SKILL.md");
    const sec = section(run, /^## 順にないタスクの競合の手直し/, 2);
    expectAll(sec, [
      "鎖にいない",
      "最初の review が済んだあと",
      "orca-flow rebase-review 〈覚えた HEAD〉",
      "/orca-flow:review $0 〈baseBranch〉...HEAD 見直し",
      "orca-flow rebase-review --done",
    ]);
  });

  it("run の知らせの節に、「競合を直し」の知らせの扱いがある", async () => {
    const run = await read("skills/run/SKILL.md");
    const sec = section(run, /^## 統括役から知らせが来たら/, 2);
    const line = lineWith(
      sec,
      "をして競合を直し、orca-flow verify を流してから",
    );
    expectAll(line, [
      "orca-flow rebase-review",
      "順にないタスクの競合の手直し",
      "orca-flow verify",
      "integrate-wait",
    ]);
  });

  it("review の見直しの形が、順にないタスクからも呼ばれると書いている", async () => {
    const review = await read("skills/review/SKILL.md");
    const sec = section(review, /^## 見直しの形/, 2);
    expectAll(sec, ["マージの順にないタスク", "順にないタスクの競合の手直し"]);
  });

  it("仕様10.1のマージの順にも同じことが書かれている", async () => {
    const spec = await read("docs/spec.md");
    expect(lineWith(spec, "- run：順にあるタスクは、")).toContain(
      "鎖にいないタスクも",
    );
    expect(lineWith(spec, "- 順にないタスクの競合の手直し（")).toContain(
      "orca-flow rebase-review",
    );
  });
});

describe("厳格モード（strict）", () => {
  it("run に、直しのたびに最初の形の review を流し直し、確かの直したほうがよいまで直す決まりがある", async () => {
    const run = await read("skills/run/SKILL.md");
    const sec = section(run, /^## 厳格モード/, 2);
    expectAll(sec, [
      "次の「直すもの」（確かの必ず直すと確かの直したほうがよい）が出なくなったら終える",
      "`strict`",
      "直しが入るたびに",
      "最初の形の review を全部流し直す",
      "「確か」の「直したほうがよい」",
      "何回目の review で出ても直す",
    ]);
  });

  it("run に、strictReviewRounds の上限と、尽きたときの扱いがある", async () => {
    const run = await read("skills/run/SKILL.md");
    const sec = section(run, /^## 厳格モード/, 2);
    expectAll(sec, [
      "`strictReviewRounds` 回まで",
      "最初の review は数えない",
      "「必ず直す」は直さず「統合の前に人が決めるもの」に入れて聞き",
      "「2回で直らない」で書く",
      "直しの上限で直らない",
    ]);
    expect(run).toContain("strictReviewRounds・reviewBackend");
  });

  it("run と review に、「確定済みの判断」を渡す決まりがある", async () => {
    const run = await read("skills/run/SKILL.md");
    const sec = section(run, /^## 厳格モード/, 2);
    expectAll(sec, [
      "「確定済みの判断」",
      "誤り」で捨てたもの",
      "残した確認だけ",
      "判断事項",
    ]);
    const review = await read("skills/review/SKILL.md");
    const codeReview = section(review, /^## codeReview/, 2);
    expectAll(codeReview, [
      "`strict`",
      "「確定済みの判断」",
      "`strictReviewRounds`",
      "を全部流し直し",
      "確かの「直したほうがよい」まで直す",
      "尽きたときは",
      "確かの必ず直すを run が統合の前に人に聞き",
      "確かの直したほうがよいは直さず報告に書く",
    ]);
    const blast = section(review, /^## 影響範囲/, 2);
    expect(blast).toContain("あれば「確定済みの判断」");
    expect(stepBlock(review, 2)).toContain("確定済みの判断");
    expect(await read("agents/review-verifier.md")).toContain(
      "「確定済みの判断」",
    );
  });

  it("文書だけ・テストだけの見分け方は、strict では当たらない", async () => {
    const review = await read("skills/review/SKILL.md");
    for (const heading of [/^## 文書だけ/, /^## テストだけ/]) {
      const sec = section(review, heading, 2);
      expect(lineWith(sec, "- codeReview が full")).toContain(
        "`strict` は当たらない",
      );
    }
    const run = await read("skills/run/SKILL.md");
    expect(section(run, /^## 厳格モード/, 2)).toContain(
      "文書だけ・テストだけにはならない",
    );
  });

  it("review のスキルの codeReview の節は値を4つとして扱い、strict は full と同じ動きにする", async () => {
    const review = await read("skills/review/SKILL.md");
    const sec = section(review, /^## codeReview/, 2);
    expect(sec).toContain("値は4つ");
    expect(lineWith(sec, "- `strict`")).toContain("`full` と同じ");
  });

  it("仕様6章に strict と strictReviewRounds の行があり、10.1に厳格モードの決まりがある", async () => {
    const spec = await read("docs/spec.md");
    const six = section(spec, /^## 6\. /, 2);
    expect(lineWith(six, "| codeReview")).toContain('`"strict"`');
    const rounds = lineWith(six, "| strictReviewRounds");
    expectAll(rounds, ["`5`", "1以上の整数"]);
    const sec = section(spec, /^### 10\.1 /, 3);
    const para = sec.slice(sec.indexOf("**厳格モード**"));
    expectAll(para, [
      "最初の形の review",
      "全部流し直す",
      "確かの直したほうがよい",
      "`strictReviewRounds` 回まで",
      "「確定済みの判断」",
    ]);
  });
});
