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
const PREV = "skills/intake/page-format-prev.md";

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

describe("親のページとタスクのページ：page-format.md", () => {
  it("親のページの見出しが、何が変わるか・分け方・ブランチ・並びと図・使い合うもの・質問・細部・出典の順に出て、組の進め方がない", async () => {
    const heads = (await read(FORMAT))
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    const names = [
      "何が変わるか",
      "分け方",
      "ブランチ",
      "並びと図",
      "同時に作るタスクの間で使い合うもの",
      "決めてほしいこと",
      "細部（AI 向け）",
      "出典",
    ];
    expect(heads).not.toContain("組の進め方");
    expect(heads).not.toContain("タスク");
    expect(heads).not.toContain("ステップと番号");
    const at = names.map((n) => heads.indexOf(n));
    for (const [i, n] of names.entries())
      expect(at[i], `見出し「${n}」がありません`).toBeGreaterThanOrEqual(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("親のページの並びに、同じ順の番号つきの行がある", async () => {
    const s = sec(await read(FORMAT), "親のページの並び");
    expectInOrder(s, [
      "見分けの印の行",
      "読み方の行",
      "何が変わるか",
      "分け方",
      "ブランチ",
      "同時に作るタスクの間で使い合うもの",
      "決めてほしいこと",
      "区切りの線",
      "出典",
    ]);
  });

  it("タスクのページの並びが順に書かれ、ID を書かない文がある", async () => {
    const t = await read(FORMAT);
    const s = sec(t, "タスクのページの並び");
    expectInOrder(s, [
      "見分けの印の行",
      "つながりの行",
      "要点",
      "決めてほしいこと",
      "細部（AI 向け）",
      "出典",
    ]);
    expect(s).toContain("タスクのページには、状態も ID も書かない");
    expect(sec(t, "状態と ID")).toContain(
      "タスクのページには、状態も ID も書かない",
    );
  });

  it("つながりの行の書き方と、見出し「お願いすること」「先に入れるもの」を置かない", async () => {
    const t = await read(FORMAT);
    expect(t).toContain(
      "親のページ：〈リンク〉 ／ このページはブランチ〈番号〉",
    );
    expect(t).toContain("このページはブランチ〈番号〉の〈リポジトリ〉");
    expect(t).not.toContain("このページはタスク〈番号〉」にする");
    expect(t).not.toContain("お願いすること");
    expect(t).not.toContain("先に入れるもの");
  });

  it("状態の行は親だけ・番号は通し・ブランチの行と項目の行・入れる順の行", async () => {
    const t = await read(FORMAT);
    expectAll(sec(t, "状態と ID"), [
      "親のブランチの項目の行の「状態：」だけに書く",
      "開始済み 〈ID〉",
      "開始済み 〈名前〉:〈ID〉",
    ]);
    expectAll(sec(t, "並びと図"), [
      "待つものの順に番号を振る",
      "親全体で1から通しで振る",
    ]);
    expectAll(sec(t, "ブランチ"), [
      "太字の行「ブランチ〈番号〉 〈slug〉」",
      "待つもの：… ／ 出す順：…",
      "入れる順：ブランチ〈番号〉のあと",
      "大きさ：… ／ 状態：",
      "リポジトリ",
      "ブランチは見出しにしない",
      "1ブランチの中は1リポジトリ1項目",
    ]);
    const body = t
      .split("\n")
      .filter((l) => !l.startsWith("> ") && !l.includes("前の形"));
    expect(body.join("\n")).not.toContain("ステップ");
    expect(body.join("\n")).not.toContain("組：組A");
    expect(sec(t, "同時に作るタスクの間で使い合うもの")).toContain(
      "「単位」は分け方を決める内部の言葉で、Notion のページには出さない",
    );
    expect(sec(t, "ページの置き方")).toContain("項目が1つでも");
  });

  it("ステップと組の形は前の形の文書に残り、待つものと状態の行と組の読み方がある", async () => {
    const p = sec(await read(PREV), "ステップと組の形");
    expectAll(p, [
      "ステップ〈番号〉（〈何が入ったら〉同時に）",
      "ステップが1つだけなら小見出しはない",
      "入れる順：タスク〈番号〉のあと",
      "組：組A",
      "リポジトリ：",
      "組の2つは同じステップに置かれ",
      "それぞれ自分の（組の外の）依存だけを書く",
      "組の両方とも始めない",
      "組ごとの決定",
      "組A（slug：",
      "同じ slug",
      "組の進め方",
      "書き換えてブランチの形にはしない",
    ]);
  });

  it("2つ以上のブランチに効くものは親に1回だけ置き、タスクのページは指すだけにする", async () => {
    const t = await read(FORMAT);
    const s = sec(t, "親に1回だけ置くもの");
    expectAll(s, [
      "2つ以上のブランチに効くもの（質問・決定・結果）は、親に1回だけ置く",
      "タスクのページは指すだけ",
      "同じブランチの2つ以上の項目に効くもの",
    ]);
    expectAll(sec(t, "決めてほしいこと"), [
      "親のページの質問〈番号〉もこのタスクに効く",
      "親の決めてほしいこと〈番号〉",
      "ページごとに1から振る",
    ]);
    expect(sec(t, "細部（AI 向け）")).toContain("親の細部の〈見出し〉が効く");
  });

  it("形の見分けで、新しい形・ステップと組の形・それより前の形を分け、前の形は読み書き換えない", async () => {
    const s = sec(await read(FORMAT), "形の見分け");
    expectAll(s, [
      "見出し「何が変わるか」",
      "見出し「ブランチ」",
      "「親のページ：」で始まるつながりの行",
      "このページはブランチ〈番号〉",
      "つながりの行のリンクから親をたどり",
      "ステップと組の形",
      "見出し「タスク」",
      "それより前の形も同じ",
      "page-format-prev.md",
      "書き換えない",
      "混ぜて読まない",
    ]);
  });

  it("依存は「待つもの：ブランチ〈番号〉」で書き、親のブランチの全部の項目の状態の行の ID に解いて確かめる", async () => {
    const s = sec(await read(FORMAT), "依存の書き方と解き方");
    expectAll(s, [
      "「待つもの：ブランチ〈番号〉」",
      "親のそのブランチの全部の項目の状態の行の ID に解く",
      "全部が `merged` で入ったときだけ",
      "ID の形の確かめと `merged`",
      "同じリポジトリの ID だけ",
      "`--cross-depends` に渡すと",
    ]);
    expectAll(s, ["印なしで始める", "前を待つ印をつけて始める"]);
    expect(s).not.toContain("入ったとして始める");
  });

  it("依頼のファイルに写すものと、統合の戻しの決まり", async () => {
    const t = await read(FORMAT);
    expectAll(sec(t, "依頼のファイルに写すもの"), [
      "そのタスクのページの URL にする",
      "親の質問と答え",
      "文で写す",
    ]);
    expectAll(sec(t, "統合の戻し"), [
      "つながりの行から親を読む",
      "状態の行にこの ID があるときだけ戻す",
      "直すのはタスクのページ",
      "状態の行は変えない",
      "タスクのページの末尾に足す",
    ]);
  });

  it("作れないときの代わりと、子ページを作れないときの扱いがある", async () => {
    const s = sec(await read(FORMAT), "作れないときの代わり");
    expectAll(s, [
      "見出しと箇条書き",
      "答え：",
      "これからも：",
      "状態：開始済み 〈ID〉",
      "Mermaid の図が作れなければ",
      "子ページを作れないとき",
    ]);
  });

  it("質問のチェックの例が残り、Notion に書く例の行に orca-flow の語がない", async () => {
    const t = await read(FORMAT);
    expectAll(sec(t, "決めてほしいこと"), [
      "吹き出し",
      "チェックボックス",
      "これからも同じにする",
      "答え・補足",
    ]);
    expect(t).not.toMatch(/notion\.(so|com)/);
    const examples = t.split("\n").filter((l) => l.startsWith("> "));
    expect(examples.length).toBeGreaterThan(0);
    for (const l of examples) expect(l).not.toContain("orca-flow");
    expectAll(sec(t, "見分けの印の行"), [
      "要件から自動で作った仕様のページ",
      "orca-flow の intake が作った仕様のページ",
      "印とみなす",
    ]);
  });
});

describe("前の形の読み方：page-format-prev.md", () => {
  it("前の形の見分け（表・細部の見出し・つながりの行・単位の一覧）と ID の読み方が残る", async () => {
    const t = await read(PREV);
    expectAll(sec(t, "古い形のページ"), [
      "「タスクの一覧」の表",
      "「細部（AI 向け）」の見出し",
      "今までどおり項目の横（見出しの横など）の ID を読む",
      "書き換えて新しい形にはしない",
    ]);
    expectAll(t, [
      "### 複数のページと1ページの見分け",
      "つながりの行がない",
      "「単位の一覧」",
    ]);
    expect(sec(t, "タスクの一覧")).toContain("開始済み 〈ID〉");
    expect(sec(t, "ID を書く所")).toContain("状態の欄だけに書く");
    expect(t).toContain("書き換えて新しい形");
  });

  it("新しい形では読まない旨が先頭にある", async () => {
    const t = await read(PREV);
    expect(t.split("\n").slice(0, 4).join("\n")).toContain(
      "`page-format.md` の「形の見分け」で前の形と決まったとき",
    );
  });
});

describe("親とタスクのページ：手順と守り", () => {
  it("guards.md に、解いてから確かめる文と、ID を親の状態の行に書く文がある", async () => {
    const t = await read("skills/intake/guards.md");
    expectAll(t, [
      "親のそのブランチの全部の項目の状態の行の ID に解いてから、今の ID の形の確かめと `merged` にかける",
      "ほかのリポジトリの ID は `--depends` にも `--cross-depends` にも渡さない",
      "親のページのそのブランチのその項目の行の「状態：」にその ID を書く",
      "タスクのページには書かない",
    ]);
  });

  it("guards.md に、依頼のファイルの仕様の URL と、タスクのページから親をたどる文がある", async () => {
    const t = await read("skills/intake/guards.md");
    expectAll(t, [
      "「仕様」の URL は、そのタスクのページの URL にする",
      "親の細部のうちその項目に効く決定と結果",
      "つながりの行のリンクから親をたどる",
      "page-format-prev.md",
    ]);
  });

  it("workspace.md に、解く文と、ID を親の状態の行に書く文がある", async () => {
    const t = await read("skills/intake/workspace.md");
    expectAll(t, [
      "「待つもの：ブランチ〈番号〉」",
      "親のそのブランチの全部の項目の状態の行の `〈名前〉:〈ID〉` に解いてから",
      "親のページのそのブランチのその項目の行の「状態：」に書く",
      "タスクのページには書かない",
    ]);
  });

  it("SKILL.md の手順8に、親を節の下に、タスクのページを親の子に作り、読み直して確かめる文がある", async () => {
    const t = await read("skills/intake/SKILL.md");
    const lines = t.split("\n");
    const at = lines.findIndex((l) => l.startsWith("8. "));
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => /^\d+\. /.test(l));
    const s = lines
      .slice(at, at + 1 + (end < 0 ? rest.length : end))
      .join("\n");
    expectAll(s, [
      "子ページとして親のページを作り",
      "タスクのページを親の子ページとして作る",
      "親を読み直して",
      "タスクのページが親の子になっているか",
    ]);
  });

  it("splitting.md は単位をページに出さず、親のページへ契約を書く", async () => {
    const t = await read("skills/intake/splitting.md");
    expectAll(t, [
      "「単位」は分け方を決める内部の言葉で、Notion のページには出さない",
      "同時に作るタスクの間で使い合うもの",
    ]);
  });
});

describe("親とタスクのページ：統合の戻しと画面の記録", () => {
  it("spec-page.md に、タスクのページの印・親を読む・親の状態の行の ID で確かめる文があり、前の形の見分けも残る", async () => {
    const t = await read("skills/integrate/spec-page.md");
    expectAll(t, [
      "「親のページ：」で始まるつながりの行",
      "つながりの行のリンクから親のページを読む",
      "親の状態の行で確かめる",
      "前の形",
      "今までどおり",
      "項目の横",
      "親は、そのブランチの概要だけを直してよい",
      "項目が1つのブランチだけ",
      "状態の欄は変えない",
    ]);
  });

  it("spec-page-capture.md に、同じ見分けと、タスクのページの末尾へ足す文があり、前の形の見分けも残る", async () => {
    const t = await read("skills/integrate/spec-page-capture.md");
    expectAll(t, [
      "「親のページ：」で始まるつながりの行",
      "つながりの行から親を読み",
      "状態の行に、このタスクの ID",
      "前の形",
      "項目の横",
      "タスクのページ（前の形ではそのページ）の末尾",
    ]);
  });
});

describe("親とタスクのページ：仕様書", () => {
  it("10.1 の仕様のページの形の箇条が、親とタスクのページの形を書き、page-format.md を指す", async () => {
    const t = await read("docs/spec.md");
    const item =
      t.split("\n").find((l) => l.startsWith("- 仕様のページの形：")) ?? "";
    expectAll(item, [
      "親のページとタスクごとのページ",
      "skills/intake/page-format.md",
      "ブランチ",
      "待つもの",
      "出す順：",
      "親の決めてほしいこと〈番号〉",
      "親の項目の行の状態に「開始済み 〈ID〉」",
      "ステップと組の形",
      "page-format-prev.md",
    ]);
    expect(item).not.toContain("ステップごとの小見出し");
    expect(item).not.toContain("組の進め方");
    const pages =
      t
        .split("\n")
        .find((l) => l.startsWith("- 親のページとタスクのページ：")) ?? "";
    expectAll(pages, [
      "タスクが1つでも2枚",
      "2つ以上のタスクに効く質問・決定・結果は親に1回だけ",
      "入れる順：ブランチ〈番号〉のあと",
      "Mermaid",
      "ブランチが2つ以上のときだけ",
      "反映のたびに待つものから作り直す",
      "人は直さない",
    ]);
    expect(pages).not.toContain("ステップごとの小見出し");
    expect(pages).not.toContain("組の進め方");
  });

  it("12章の9番に、親とタスクのページの文がある", async () => {
    const t = await read("docs/spec.md");
    const item =
      t
        .split("\n")
        .find((l) => l.startsWith("9. **Notion の要件から始める**")) ?? "";
    expectAll(item, [
      "親のページ1つと、タスクごとのページ",
      "ブランチ",
      "前の形",
    ]);
    expect(item).not.toContain("ステップに分けて");
  });
});

describe("レビューの直し：決まりのそろえ", () => {
  it("入れる順の値は、待つものでつながっていないブランチの間に書く", async () => {
    const t = await read(FORMAT);
    const line =
      sec(t, "ブランチ")
        .split("\n")
        .find((l) => l.startsWith("- 入れる順があるブランチには")) ?? "";
    expectAll(line, [
      "待つものでつながっていないブランチの間にだけ",
      "待つものでつながる間は「待つもの」で書く",
    ]);
    expect(line).not.toContain("別のステップのタスクだけ");
  });

  it("ブランチは全部の項目が入ったときだけ印なしで始め、入っていなければ前を待つ印をつけて始め、同じブランチの項目は同じ ID と slug でそろえて始める。前の形の組の決まりは前の形の文書に残る", async () => {
    const prev = sec(await read(PREV), "ステップと組の形");
    expectAll(prev, [
      "組の2つは同じステップ",
      "それぞれ自分の（組の外の）依存だけを書く",
      "組の両方とも始めない",
    ]);
    expect(prev).not.toContain("合わせて同じに書く");
    const g = await read("skills/intake/guards.md");
    expectAll(g, [
      "全部の項目が入ったときだけ、そのブランチを入ったとし、待つ項目を印なしで始める",
      "入っていない待つ先があれば、そのブランチを待つ項目に前を待つ印をつけて始める",
      "同じブランチの項目は同じ ID と slug でそろえて始め",
    ]);
    expect(g).not.toContain("合わせて同じに書く");
  });

  it("ブランチの slug の正は親の細部のブランチごとの決定で、タスクのページの1項目にも同じ slug を書く", async () => {
    const t = await read(FORMAT);
    expectAll(sec(t, "細部（AI 向け）"), [
      "ブランチごとの決定",
      "ブランチ1（slug：",
      "同じ slug",
    ]);
    const w = await read("skills/intake/workspace.md");
    expectAll(w, ["ブランチごとの決定", "同じ slug を書く"]);
    expectAll(w, ["依存先の項目の行のリポジトリと食い違う"]);
  });

  it("形の見分けは前の形の単位のページも前の形に数え、spec-page も同じ言葉でそろえる", async () => {
    expectAll(sec(await read(FORMAT), "形の見分け"), [
      "「親のページ：」で始まるつながりの行も、見出し「何が変わるか」もない",
      "「つながり：」の行がある",
    ]);
    for (const f of [
      "skills/integrate/spec-page.md",
      "skills/integrate/spec-page-capture.md",
    ]) {
      expectAll(await read(f), [
        "「親のページ：」で始まるつながりの行も、見出し「何が変わるか」もない",
        "「つながり：」の行がある",
      ]);
    }
  });

  it("統合の戻しは、タスクのページと親のそのブランチの概要（項目が1つのブランチだけ）を直し、ほかは人に渡す", async () => {
    const files = [FORMAT, "skills/integrate/spec-page.md", "docs/spec.md"];
    for (const f of files) {
      const t = await read(f);
      expectAll(t, [
        "そのブランチの概要だけを直してよい",
        "状態の行は変えない",
      ]);
      expect(t, f).toMatch(
        /親の細部・質問・図や、ほかのタスクのページに届く違いは直さず/,
      );
    }
    const sp = await read("skills/integrate/spec-page.md");
    expect(sp).not.toContain("親の細部の該当の決定を直す");
  });

  it("子ページを作れず人に貼ってもらうときは、親の URL を各タスクのページのつながりの行に書き足して読み直す", async () => {
    const t = await read(FORMAT);
    const line =
      sec(t, "作れないときの代わり")
        .split("\n")
        .find((l) => l.includes("子ページを作れないときは")) ?? "";
    expectAll(line, [
      "つながりの行に",
      "書き足し",
      "書けなければ人に頼み",
      "読み直して",
    ]);
    const skill = await read("skills/intake/SKILL.md");
    expectAll(skill, [
      "つながりの行に「親のページ：〈リンク〉」として書き足す",
      "読み直して、つながりの行が親を指している",
    ]);
  });

  it("「新しい形」はブランチの形の親とタスクのページだけを指し、上の所のある前の1ページは別の名前で呼ぶ", async () => {
    const prev = await read(PREV);
    expectAll(prev, [
      "上の所のある1ページ",
      "「新しい形」はブランチの形の親のページとタスクのページだけ",
    ]);
    expect(prev).not.toContain("この文書で「新しい形」と呼ぶのは");
    const g = await read("skills/intake/guards.md");
    expectAll(g, [
      "前の形のうち上の所のある1ページ（親とタスクのページではない）の質問にも、同じに効く",
    ]);
  });

  it("前の形の言葉（状態の欄・入れる順の列・依存の欄）は、状態の行などと両方で書く", async () => {
    const g = await read("skills/intake/guards.md");
    expectAll(g, [
      "状態の行（前の形では状態の欄）",
      "入れる順の列があれば、人に伝える（ブランチの形とステップと組の形では「入れる順：」の行",
      "依存の文字（新しい形では状態の行の ID、前の形では依存の欄）をそのまま人間に示して聞く（ステップと組の形では、親のそのタスクの状態の行の ID を示す）",
    ]);
  });

  it("子に印のあるページが2つ以上のときは、親どうしと前の形の土台と単位の区別がつくように示す", async () => {
    const s = await read("skills/intake/SKILL.md");
    expect(s).toContain(
      "親のページどうし、または前の形の土台と単位のページの区別がつくように並べて示し",
    );
  });
});
