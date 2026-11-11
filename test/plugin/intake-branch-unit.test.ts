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
const GUARDS = "skills/intake/guards.md";
const WORKSPACE = "skills/intake/workspace.md";

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

function chapter(text: string, n: number): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`## ${n}. `));
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^## \d+\. /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("page-format.md：ブランチの形", () => {
  it("「ブランチ」の節があり、ブランチの行・待つもの・出す順・項目の行の決まりがある", async () => {
    const t = await read(FORMAT);
    const s = sec(t, "ブランチ");
    expect(s).not.toBe("");
    expectAll(s, [
      "太字の行「ブランチ〈番号〉 〈slug〉」",
      "待つもの：… ／ 出す順：…",
      "「ブランチ〈番号〉」か「なし」",
      "リポジトリが2つ以上のときだけ",
      "1リポジトリのブランチには置かない",
      "〈リポジトリ〉：〈項目名〉（タスクのページへのリンク） ／ 大きさ：… ／ 状態：",
      "1ブランチの中は1リポジトリ1項目",
      "同じリポジトリで同じブランチ名は2つ作れない",
    ]);
  });

  it("ステップの小見出し・組の進め方の節・「組：」の行は、新しい形から消えている", async () => {
    const t = await read(FORMAT);
    const heads = t
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    expect(heads).not.toContain("組の進め方");
    expect(heads).not.toContain("ステップと番号");
    expect(heads).not.toContain("タスク");
    expect(t).not.toContain("### ステップ");
    expect(t).not.toContain("組：組A");
    expect(t).not.toContain("ステップごとの小見出し");
    expect(t).not.toContain("同じステップ");
  });

  it("ブランチは待つものの順に番号を振り、親全体で通しにする", async () => {
    const s = sec(await read(FORMAT), "並びと図");
    expectAll(s, [
      "待つものの順に番号を振る",
      "親全体で1から通しで振る",
      "タスクのページの番号も、この通しの番号と同じにする",
    ]);
  });

  it("Mermaid の図は、ブランチが2つ以上のときだけ置き、反映で作り直し、人は直さない", async () => {
    const s = sec(await read(FORMAT), "並びと図");
    expectAll(s, [
      "Mermaid",
      "ブランチが2つ以上のときだけ",
      "ブランチが1つなら図は置かない",
      "反映のたびに、ブランチの「待つもの」から作り直す",
      "図は人が直さない",
      "矢印は待つもの",
    ]);
    expect(s).toContain("```mermaid");
  });

  it("図の箱の文字は、確かめた slug と設定のリポジトリの名前だけから作る", async () => {
    const s = sec(await read(FORMAT), "並びと図");
    expectAll(s, [
      "`guards.md` の形の確かめを通した slug と、設定のリポジトリの名前だけから作る",
      "人が直せる文字（ブランチの概要や項目名）は図に入れない",
    ]);
    const fence = s.split("\n").filter((l) => l.startsWith("> "));
    for (const l of fence) expect(l).not.toContain("orca-flow");
  });

  it("親の並びは、ブランチの節のあとに決めてほしいことが来て、組の進め方の節がない", async () => {
    const s = sec(await read(FORMAT), "親のページの並び");
    const at = ["何が変わるか", "分け方", "ブランチ", "決めてほしいこと"].map(
      (w) => s.indexOf(w),
    );
    expect(at.every((x) => x >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(s).not.toContain("組の進め方");
  });

  it("形の見分けが、新しい形・ステップと組の形・それより前の形を分ける", async () => {
    const s = sec(await read(FORMAT), "形の見分け");
    expectAll(s, [
      "見出し「ブランチ」と見出し「何が変わるか」",
      "このページはブランチ〈番号〉",
      "このページはブランチ〈番号〉の〈リポジトリ〉",
      "ステップと組の形",
      "見出し「タスク」があり、見出し「ブランチ」がない親",
      "このページはタスク〈番号〉",
      "それより前の形も同じ",
      "混ぜて読まない",
      "page-format-prev.md",
    ]);
  });

  it("依存は、ブランチの全部の項目の状態の行の ID に解いて、全部入ったら始める", async () => {
    const s = sec(await read(FORMAT), "依存の書き方と解き方");
    expectAll(s, [
      "「待つもの：ブランチ〈番号〉」",
      "全部の項目の状態の行の ID に解く",
      "全部が `merged` で入ったときだけ",
      "同じリポジトリの ID だけ",
    ]);
    expectAll(s, ["印なしで始める", "前を待つ印をつけて始める"]);
    expect(s).not.toContain("入ったとして始める");
  });

  it("Notion に書く例に orca-flow の語を入れない", async () => {
    const t = await read(FORMAT);
    const examples = t.split("\n").filter((l) => l.startsWith("> "));
    expect(examples.length).toBeGreaterThan(0);
    for (const l of examples) expect(l).not.toContain("orca-flow");
    expect(t).toContain("Notion に書く文には orca-flow の語を入れない");
  });
});

describe("page-format-prev.md：ステップと組の形", () => {
  it("前の形として読み方があり、書き換えない", async () => {
    const t = await read(PREV);
    const s = sec(t, "ステップと組の形");
    expect(s).not.toBe("");
    expectAll(s, [
      "ステップ〈番号〉（〈何が入ったら〉同時に）",
      "このページはタスク〈番号〉",
      "組：組A",
      "組の進め方",
      "書き換えてブランチの形にはしない",
      "共通を含むブランチと同じ",
    ]);
    expectAll(t, ["ステップと組の形", "今までどおり読み"]);
  });

  it("始め方・状態の書き場所・戻し・ほかのリポジトリの依存・始める前の守りの参照がある", async () => {
    const s = sec(await read(PREV), "ステップと組の形");
    expectAll(s, [
      "親のその番号の状態の行の ID に解いて、今の ID の形の確かめと `merged` にかける",
      "状態の行にまだ ID がなければ、入っていないとして始めない",
      "書き場所は「〈番号〉. 〈タスク名〉」の行で選ぶ",
      "親はそのタスクの概要だけを直してよい（状態の行は変えない）",
      "親の細部・組の進め方・質問は直さず",
      "ほかのタスクのページに届く違いも直さず、人に渡す",
      "`--depends` にも `--cross-depends` にも渡さず",
      "`--cross-depends` に渡すのは同じ組の共通への分だけ",
      "組の外のほかのリポジトリの入った待つ先は渡さない",
      "`guards.md` の手順10",
      "互いを指すかの確かめ",
      "依頼のファイルの「仕様」の URL はそのタスクのページ",
      "読み直しと反映",
      "質問の答えの読み方",
    ]);
    expect(s).not.toContain("別のブランチへのまたぐ依存");
  });
});

describe("guards.md：ブランチの始め方", () => {
  it("ブランチの待つものを全部の項目の ID に解き、全部入ったら印なしで、入っていなければ前を待つ印をつけて始める", async () => {
    const t = sec(await read(GUARDS), "手順10：始める前の守り");
    expectAll(t, [
      "「待つもの：ブランチ〈番号〉」",
      "親のそのブランチの全部の項目の状態の行の ID に解いてから",
      "全部の項目が入ったときだけ、そのブランチを入ったとし、待つ項目を印なしで始める",
      "入っていない待つ先があれば、そのブランチを待つ項目に前を待つ印をつけて始める",
      "1つの項目にでもまだ ID がなければ、入っていないとして始めない",
    ]);
  });

  it("ほかのリポジトリの ID は --depends にも --cross-depends にも渡さない", async () => {
    const t = sec(await read(GUARDS), "手順10：始める前の守り");
    expectAll(t, [
      "同じリポジトリの ID だけ",
      "ほかのリポジトリの ID は `--depends` にも `--cross-depends` にも渡さない",
      "共通にアプリへのまたぐ依存が付いて止まる",
    ]);
  });

  it("ID の書き場所は、ブランチの行と項目のリポジトリで選ぶ", async () => {
    const t = sec(await read(GUARDS), "手順10：始める前の守り");
    expectAll(t, [
      "太字の行「ブランチ〈番号〉 〈slug〉」と項目のリポジトリ",
      "そのブランチのその項目の状態の行に「開始済み 〈ID〉」",
    ]);
  });

  it("ステップと組の形にも、読み替えて同じ守りが効く", async () => {
    const t = await read(GUARDS);
    const l =
      t
        .split("\n")
        .find((x) => x.startsWith("- ブランチの形の親とタスクのページ")) ?? "";
    expect(l).not.toBe("");
    expectAll(l, [
      "ステップと組の形の親とタスクのページ",
      "`page-format-prev.md` の「ステップと組の形」",
      "ブランチ〈番号〉はタスク〈番号〉",
      "見出し「ブランチ」は見出し「タスク」",
      "「このページはタスク〈番号〉」",
      "互いを指すかは番号で比べる",
      "ワークスペースの道ではリポジトリも",
      "「〈番号〉. 〈タスク名〉」の行",
      "弱めない",
    ]);
    const answers = t.split("\n").find((x) => x.startsWith("- 新しい形")) ?? "";
    expectAll(answers, ["ステップと組の形の質問にも、同じに効く"]);
    const ids =
      t.split("\n").find((x) => x.startsWith("- 依存の ID は、`merged`")) ?? "";
    expectAll(ids, ["ステップと組の形では、親のそのタスクの状態の行の ID"]);
    const fmt = sec(await read(FORMAT), "形の見分け");
    expectAll(fmt, [
      "ステップと組の形にも、上の親のたどり方とたどった親の確かめ",
      "ブランチをタスクに、見出し「ブランチ」を見出し「タスク」に読み替えて",
    ]);
  });

  it("始めてよいかの守りを弱めない", async () => {
    const t = sec(await read(GUARDS), "手順10：始める前の守り");
    expectAll(t, [
      "ページに ID が書かれた項目は、始めた項目として飛ばす",
      "idPrefix と数字（と後ろの英字）の形か確かめる",
      "slug は英小文字か数字で始まり",
      "書いたら親を読み直し",
      "このタブで「よい」が来るまで new を流さない",
    ]);
  });
});

describe("workspace.md：共通のないブランチ", () => {
  it("共通のないブランチの始め方（ID の揃え・フラグを付けない・ブランチ名でプレビューを背景で立てる）がある", async () => {
    const t = await read(WORKSPACE);
    const l =
      t.split("\n").find((x) => x.startsWith("- 共通のないブランチ：")) ?? "";
    expect(l).not.toBe("");
    const block = t.slice(t.indexOf(l), t.indexOf("- 単位が2つ以上のとき："));
    expectAll(block, [
      "ID の揃えと続きからの始め方は、共通を含むブランチと同じ",
      "`--allow-branch-push`・`--cross-depends`・`--branches` を付けない",
      "`--id 〈ID〉` と `--slug`",
      "`new` が全部通ったあとに `orca-flow workspace --preview 〈ブランチ名〉 --background` を流す",
    ]);
    expect(block).not.toContain("`workspace --preview` を流さない");
    expect(block).not.toContain("workspace --preview 〈ID〉");
  });

  it("組のプレビューの行は ID でなくブランチ名を渡し、ブランチ名の出どころがある", async () => {
    const t = await read(WORKSPACE);
    const rows = t.split("\n").filter((x) => x.includes("workspace --preview"));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).not.toContain("workspace --preview 〈ID〉");
    const l =
      rows.find((x) =>
        x.includes(
          "リポジトリが2つ以上のブランチの `new` が全部通ったあとに `orca-flow workspace --preview 〈ブランチ名〉 --background` を流す",
        ),
      ) ?? "";
    expect(l).not.toBe("");
    expect(l).toContain("そのブランチで通った `new` の出力のブランチ名");
    expect(l).toContain("ID で渡さない");
    const skip =
      t.split("\n").find((x) => x.startsWith("- ひとまとまりで始める：")) ?? "";
    expect(skip).not.toContain("`--preview` に関わる項は飛ばす");
  });

  it("共通のないブランチの出す順は「順なし」だけで、「→」の書き方を残さない", async () => {
    const f = await read(FORMAT);
    const l = f.split("\n").find((x) => x.includes("出す順：ブランチの")) ?? "";
    const none = l.slice(l.indexOf("共通のないブランチは"));
    expect(none).toContain("共通のないブランチは「順なし」と書く");
    expect(none).toContain("「入れる順：」で表す");
    expect(none).not.toContain("入れる順があれば");
    expect(none).not.toContain("〈リポジトリ〉 → 〈リポジトリ〉");
    const w = await read(WORKSPACE);
    const o = w.split("\n").find((x) => x.startsWith("  - 出す順は")) ?? "";
    expect(o).toContain(
      "「順なし」と書き（PR のマージの順がない、という意味）、全部の項目を同時に始める",
    );
    expect(w).not.toContain("入れる順として人に伝える");
    const spec = await read("docs/spec.md");
    expect(spec).toContain(
      "共通のないブランチの出す順は「順なし」（PR のマージの順がない）と書き",
    );
  });

  it("共通を含むブランチの今の順と守りが残る", async () => {
    const t = await read(WORKSPACE);
    expectAll(t, [
      "共通の項目を `orca-flow workspace 〈名前〉 new` に `--id 〈ID〉 --allow-branch-push` を付けて始める",
      "`--id 〈ID〉 --cross-depends 〈共通〉:〈ID〉 --branches 〈共通〉=〈そのブランチ名〉`",
      "`--bumps` は渡さない",
      "リポジトリが2つ以上のブランチの `new` が全部通ったあとに `orca-flow workspace --preview 〈ブランチ名〉 --background` を流す",
      "共通の PR をマージ → 共通の版を出す（人が行う）",
      "`users` が null",
    ]);
  });

  it("splitting.md の「組む相手」は、同じブランチの項目になっている", async () => {
    const t = await read("skills/intake/splitting.md");
    expect(t).toContain("同じブランチの項目");
    expect(t).not.toContain("組む相手");
  });

  it("手元のチケットの道のファイル名は、項目が2つ以上のブランチでリポジトリを足す", async () => {
    const t = await read("skills/intake/local.md");
    expectAll(t, ["`task-〈番号〉.md`", "`task-〈番号〉-〈リポジトリ〉.md`"]);
  });
});

describe("例と入れる順の書き方", () => {
  it("ブランチの例はワークスペースの道なので、全部の項目と図の箱にリポジトリを添える", async () => {
    const ex = sec(await read(FORMAT), "ブランチ")
      .split("\n")
      .filter((l) => l.startsWith("> - "));
    expect(ex.length).toBeGreaterThan(0);
    for (const l of ex) expect(l).toMatch(/^> - [^：]+：[^ ]/);
    const fig = sec(await read(FORMAT), "並びと図");
    expect(fig).toMatch(/B1\["ブランチ1 notify-base<br>アプリA"\]/);
  });

  it("splitting.md の1項目の入れる順は「ブランチ〈番号〉のあと」", async () => {
    const t = await read("skills/intake/splitting.md");
    expect(t).toContain("入れる順（「ブランチ〈番号〉のあと」");
    expect(t).not.toContain("入れる順（「タスク〈番号〉のあと」");
  });

  it("workspace.md の「ステップと組の形」の参照先が、その節になっている", async () => {
    const t = await read(WORKSPACE);
    expect(t).toContain(
      "ステップと組の形の依存の解き方は `page-format-prev.md` の「ステップと組の形」のとおり",
    );
  });
});

describe("split と integrate の仕様のページの文書", () => {
  it("split は、ステップでなくブランチの番号で子を置く", async () => {
    const t = await read("skills/split/spec-page.md");
    expect(t).not.toContain("ステップ");
    expectAll(t, [
      "親のブランチと同じ待つもの",
      "「ブランチ〈親の番号〉」",
      "子を新しいブランチとして置く番号",
    ]);
  });

  it("integrate は、親を直してよい所を項目が1つのブランチの概要だけにする", async () => {
    const t = await read("skills/integrate/spec-page.md");
    expect(t.replaceAll("ステップと組の形", "")).not.toContain("ステップ");
    expectAll(t, [
      "そのブランチの概要だけを直してよい",
      "項目が1つのとき",
      "状態の行は変えない",
    ]);
  });

  it("integrate は、ステップと組の形のタスクのページを親の状態の行の ID で見つけ、その形の戻しに従う", async () => {
    const t = await read("skills/integrate/spec-page.md");
    const prevForm =
      t
        .split("\n")
        .find((l) => l.startsWith("- 前の形（「親のページ：」で始まる")) ?? "";
    expect(prevForm).not.toBe("");
    expect(prevForm).not.toContain("このページはタスク〈番号〉");
    const stepForm =
      t
        .split("\n")
        .find((l) => l.startsWith("- ステップと組の形のタスクのページ（")) ??
      "";
    expectAll(stepForm, [
      "「親のページ：〈リンク〉 ／ このページはタスク〈番号〉」",
      "つながりの行のリンクから親のページを読む",
      "親の「〈番号〉. 〈タスク名〉」の行の状態の行",
      "このタスクの ID があるときだけ",
      "タスクのページにはない",
    ]);
    const back =
      t
        .split("\n")
        .find((l) => l.startsWith("- ステップと組の形のタスクのページは、")) ??
      "";
    expectAll(back, [
      "`page-format-prev.md` の「ステップと組の形」の戻しに従う",
      "親はそのタスクの概要だけを直してよい（状態の行は変えない）",
      "親の細部・組の進め方・質問は直さず、人に渡す",
      "ほかのタスクのページに届く違いも直さず、人に渡す",
    ]);
    const step1 =
      t.split("\n").find((l) => l.startsWith("1. 本文の該当の節")) ?? "";
    expect(step1).toContain("ただしステップと組の形を除く");
    expect(step1).toContain(
      "ブランチの形は親のそのブランチの概要（項目が1つのブランチだけ）",
    );
    expect(step1).toContain("ステップと組の形は親のそのタスクの概要");
    expect(step1).not.toContain("ステップと組の形は親のそのブランチの概要");
  });
});

describe("docs/spec.md：ブランチの形", () => {
  it("10.1 の仕様のページの形が、ブランチ・出す順・図・前の形の扱いを書き、ステップと組の進め方の決まりがない", async () => {
    const t = await read("docs/spec.md");
    const ten = chapter(t, 10);
    const pages =
      ten
        .split("\n")
        .find((l) => l.startsWith("- 親のページとタスクのページ：")) ?? "";
    expectAll(pages, [
      "「ブランチ〈番号〉 〈slug〉」",
      "「出す順：」の行",
      "Mermaid の図",
      "入れる順：ブランチ〈番号〉のあと",
    ]);
    const form =
      ten.split("\n").find((l) => l.startsWith("- 仕様のページの形：")) ?? "";
    expectAll(form, [
      "共通を含むブランチ",
      "`--allow-branch-push`・`--cross-depends`・`--branches` を付けず",
      "ステップと組の形",
      "書き換えない",
    ]);
    for (const l of [pages, form]) {
      expect(l).not.toContain("ステップごとの小見出し");
      expect(l).not.toContain("組の進め方");
      expect(l).not.toContain("組：組A");
    }
  });

  it("10.1 のまたぐ依存の渡し方は、同じブランチの共通への分だけにそろっている", async () => {
    const ten = chapter(await read("docs/spec.md"), 10);
    const ls = ten.split("\n");
    const cross = ls.find((l) => l.startsWith("- またぐ依存の渡し方：")) ?? "";
    expectAll(cross, [
      "共通を含むブランチのアプリの項目",
      "同じブランチの共通への `--cross-depends",
      "ほかのリポジトリの ID は、`--depends` にも `--cross-depends` にも渡さない",
    ]);
    expect(cross).not.toContain("ほかのリポジトリの依存がある項目の");
    const dep =
      ls.find((l) => l.startsWith("- `new --depends` への渡し方：")) ?? "";
    expect(dep).toContain("`--depends` にも `--cross-depends` にも渡さず");
    expect(dep).not.toContain("子の記録");
    const intake =
      ls.find((l) => l.startsWith("- intake：ワークスペースの道")) ?? "";
    expectAll(intake, [
      "共通を含むブランチのアプリの項目",
      "待つ先のブランチのほかのリポジトリの依存は渡さない",
    ]);
  });

  it("10.1 の親の並びと待つものの解き方が、ブランチの形にそろっている", async () => {
    const ls = chapter(await read("docs/spec.md"), 10).split("\n");
    const pages =
      ls.find((l) => l.startsWith("- 親のページとタスクのページ：")) ?? "";
    expect(pages).toContain("何が変わるか・分け方・ブランチ・");
    expect(pages).not.toContain("分け方・タスク・");
    const start = ls.find((l) => l.startsWith("- 始め方：")) ?? "";
    expectAll(start, [
      "印と見出し「何が変わるか」と見出し「ブランチ」があり",
      "ステップと組の形（見出し「タスク」）の始め方は",
    ]);
    const wait =
      ls.find((l) => l.includes("依存が入ったかは、`orca-flow merged")) ?? "";
    expectAll(wait, [
      "「待つもの：ブランチ〈番号〉」で書かれているので",
      "親のそのブランチの全部の項目の状態の行の ID に解いてから",
    ]);
    expect(wait).not.toContain("「待つもの：タスク〈番号〉」で書かれている");
  });

  it("8章の「共通とアプリのひとまとまり」が残り、「共通を含むブランチ」と1回だけ説明する", async () => {
    const ch8 = chapter(await read("docs/spec.md"), 8);
    expect(ch8).toContain("**共通とアプリのひとまとまり**");
    const n = ch8.split(
      "共通を含むブランチ（仕様のページのブランチのうち",
    ).length;
    expect(n - 1).toBe(1);
  });

  it("2章と12章の流れが、ブランチの言葉になる", async () => {
    const t = await read("docs/spec.md");
    const flow =
      chapter(t, 2)
        .split("\n")
        .find((l) => l.includes("設定 → 親の intake")) ?? "";
    expect(flow).toContain(
      "ブランチ（同じ ID と短い名前で始めるリポジトリのまとまり）ごとに",
    );
    const item =
      chapter(t, 12)
        .split("\n")
        .find((l) => l.startsWith("9. **Notion の要件から始める**")) ?? "";
    expect(item).toContain(
      "ブランチ（同じ ID と短い名前で始めるリポジトリのまとまり）を待つものの順に並べ",
    );
    expect(item).not.toContain("ステップに分けて");
  });
});
