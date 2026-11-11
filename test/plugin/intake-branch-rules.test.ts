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
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

/** 見出し行から、次の同じ高さ以上の見出しの前まで */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === heading);
  expect(at, `見出しがありません：${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+) /.exec(l);
    return m !== null && (m[1] as string).length <= level;
  });
  return lines.slice(at, at + 1 + (end < 0 ? rest.length : end)).join("\n");
}

/** 番号つきの基準の1つ（次の番号の行の前まで） */
function criterion(text: string, n: number): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${n}. `));
  expect(at, `基準${n}がありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || l.startsWith("## "));
  return lines.slice(at, at + 1 + (end < 0 ? rest.length : end)).join("\n");
}

const SPLIT = "skills/intake/splitting.md";
const GUARDS = "skills/intake/guards.md";
const FORMAT = "skills/intake/page-format.md";

describe("splitting.md：ブランチの単位", () => {
  it("QA の単位で、独立していることは分ける理由にしないと書く", async () => {
    const s = section(await read(SPLIT), "## ブランチの単位");
    expectAll(s, [
      "QA の単位",
      "互いに独立していても同じブランチに入れる",
      "独立していることは、ブランチを分ける理由にしない",
    ]);
  });

  it("分けてよい4つの場合だけを書く", async () => {
    const s = section(await read(SPLIT), "## ブランチの単位");
    expectAll(s, [
      "分けてよいのは、次の4つの場合だけ",
      "マージの順の待ち",
      "時期をずらす",
      "目安を超える",
      "整理",
    ]);
  });

  it("4つの場合の箇条はちょうど4つで、頭の名前が決まっている", async () => {
    const s = section(await read(SPLIT), "## ブランチの単位").split("\n");
    const at = s.findIndex((l) =>
      l.startsWith("- ブランチを分けてよいのは、次の4つの場合だけ"),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    const items: string[] = [];
    for (const l of s.slice(at + 1)) {
      if (/^ {2}- /.test(l)) items.push(l);
      else if (!/^ {2,}\S/.test(l)) break;
    }
    expect(items.map((l) => /^ {2}- ([^：]+)：/.exec(l)?.[1])).toEqual([
      "マージの順の待ち",
      "時期をずらす",
      "目安を超える",
      "整理",
    ]);
  });

  it("入口が「ブランチの単位」の4つの場合を先に指し、分けたあとに「独立の単位」で依存を消す", async () => {
    const skill = await read("skills/intake/SKILL.md");
    const guards = await read(GUARDS);
    for (const t of [skill, guards]) {
      expect(t).toContain("「ブランチの単位」の4つの場合で分けるかを決め");
      expect(t).toContain("分けたら「独立の単位」で依存を消す");
      expect(t).not.toContain("先に独立に作れる単位を決める");
    }
    expect(await read(SPLIT)).toContain(
      "「ブランチの単位」の4つの場合で分けると決めたら、そのあと単位を決め",
    );
    const spec = await read("docs/spec.md");
    const line =
      spec.split("\n").find((l) => l.startsWith("- 独立に作れる単位：")) ?? "";
    expectAll(line, [
      "独立は分ける理由にしない",
      "「ブランチの単位」の4つの場合",
    ]);
  });

  it("仕様書の始め方の箇条に、出すときの手順の写しがある", async () => {
    const spec = await read("docs/spec.md");
    const line =
      spec.split("\n").find((l) => l.includes("入れる順・そのブランチの")) ??
      "";
    expect(line).toContain(
      "そのブランチの「出すときの手順：」（あれば）は文で写す",
    );
  });

  it("基準6が、別のブランチにするのは消せないマージの順があるときだけと書く", async () => {
    const c = criterion(await read(SPLIT), 6);
    expectAll(c, [
      "3つに分ける",
      "消せないマージの順があるとき",
      "1つの差分（1つのブランチ）の中で足す→移す→消す",
    ]);
  });

  it("目安を超える項目は、残っていれば指摘して分けた案を求める", async () => {
    const c = criterion(await read(SPLIT), 3);
    expectAll(c, ["元の要件", "どの項目に分けたか", "分けた案を求める"]);
    expect(await read("agents/goldfish-reviewer.md")).toContain(
      "分けた案を求める",
    );
    expect(await read("docs/spec.md")).toContain(
      "元の要件をどの項目に分けたかの分けた案を求める",
    );
  });

  it("順番を3種類に分け、ブランチの待ちで守るのは消せないマージの順だけと書く", async () => {
    const s = section(await read(SPLIT), "## ブランチの単位");
    expectAll(s, [
      "マージの順",
      "本番に出す順",
      "人の手順",
      "ブランチの待ちで守るのは、消せないマージの順だけ",
      "出すときの手順",
    ]);
  });

  it("順はまずコードの書き方で消すと書き、フラグと足す移す消すに結ぶ", async () => {
    const s = section(await read(SPLIT), "## ブランチの単位");
    expectAll(s, [
      "順はまずコードの書き方で消す",
      "古いものと新しいものが並んでも動く",
      "基準5",
      "基準6",
    ]);
  });
});

describe("splitting.md：基準", () => {
  it("基準1が、分けてよいのを「ブランチの単位」の節の場合だけにしている。番号は1〜8のまま", async () => {
    const t = await read(SPLIT);
    const nums = t
      .split("\n")
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => Number(l.split(".")[0]));
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const one = criterion(t, 1);
    expectAll(one, [
      "分けてよいのは、次の「ブランチの単位」の節の4つの場合だけ",
      "理由が書けなければ分けない",
    ]);
    expect(one).not.toContain("次の2〜6に当たるときだけ分け");
  });

  it("基準2と基準6の頭の文は今のまま、どの場合に当たるかを添える", async () => {
    const t = await read(SPLIT);
    const two = criterion(t, 2);
    expect(two).toContain(
      "2. 種類：振る舞いを変えない整理（リファクタ）は、先の別の項目にする。",
    );
    expect(two).toContain("「ブランチの単位」の整理の場合に当たる");
    const six = criterion(t, 6);
    expect(six).toContain(
      "6. 互換を壊す変更は、「新しいものを足す→呼び手を移す→古いものを消す」の3つに分ける。",
    );
    expect(six).toContain("「ブランチの単位」のマージの順の待ち");
  });

  it("基準3に「分けない理由」の道がなく、残してよいのは移すだけと自動で作るファイルだけ", async () => {
    const c = criterion(await read(SPLIT), 3);
    expect(c).not.toContain("分けない理由");
    expect(c).not.toContain("超えても分けない");
    expectAll(c, [
      "超えたら必ず分ける",
      "残してよいのは、ファイルを移すだけの変更（移すだけ）と、自動で作るファイルだけ",
    ]);
  });

  it("基準3に、QA の筋書きで切ることと、下地のブランチの決まりがある", async () => {
    const c = criterion(await read(SPLIT), 3);
    expectAll(c, [
      "QA の筋書き",
      "2つ以上の筋書きが使う部分は、下地のブランチに置く",
      "複数のリポジトリを含んでよい",
      "使うアプリと同じブランチにまとめる",
    ]);
  });

  it("レビュー役が、分けた案があるかを見る", async () => {
    const c = criterion(await read(SPLIT), 3);
    expectAll(c, ["レビュー役", "分けた案があるかを見る"]);
  });

  it("「分けない理由」の語が splitting.md に残らない", async () => {
    expect(await read(SPLIT)).not.toContain("分けない理由");
  });

  it("「独立の単位」の頭に、独立は分ける理由にしないと書く", async () => {
    const s = section(await read(SPLIT), "## 独立の単位");
    const head = s.split("\n").slice(0, 4).join("\n");
    expectAll(head, [
      "独立していることは、ブランチを分ける理由にしない",
      "4つの場合で分けたあとに",
      "依存を消すための考え方",
    ]);
  });

  it("共通を含むブランチの出す順の文と、E2E の出す順の文は今のまま残る", async () => {
    const f = await read(FORMAT);
    expect(f).toContain(
      "「共通の PR をマージ → 共通の版を出す（人が行う）→ 見張りがアプリのタスク長を起こして正式な版に上げる → アプリの PR をマージ」",
    );
    expect(f).toContain(
      "「アプリの PR をマージ → E2E の PR をマージ」のように E2E の PR のマージを最後に書く",
    );
    const w = await read("skills/intake/workspace.md");
    expect(w).toContain("「アプリの PR をマージ → E2E の PR をマージ」と書く");
  });
});

describe("guards.md：手順6", () => {
  async function step6() {
    return section(await read(GUARDS), "## 手順6：下書きの決まり");
  }

  it("「壊れる」の確かめの範囲がある", async () => {
    const s = await step6();
    const line =
      s.split("\n").find((l) => l.startsWith("- 「壊れる」の確かめ")) ?? "";
    expectAll(line, [
      "CI・開発環境・本番",
      "どの操作で",
      "ファイルと行",
      "呼ばれる経路と入力まで確かめて",
    ]);
  });

  it("確かめられないときは「壊れうる（確かめていない）」と書き、それだけで分けずに人に聞く", async () => {
    const s = await step6();
    const line =
      s.split("\n").find((l) => l.startsWith("- 「壊れる」の確かめ")) ?? "";
    expectAll(line, [
      "「壊れうる（確かめていない）」",
      "それだけを理由に分けず",
      "AskUserQuestion",
    ]);
  });

  it("分ける前の問いの6つと、答えの探し方・聞き方・書き足しの勧めがある", async () => {
    const s = await step6();
    const at = s.split("\n").findIndex((l) => l.startsWith("- 分ける前の問い"));
    expect(at).toBeGreaterThanOrEqual(0);
    const block = s
      .split("\n")
      .slice(at, at + 8)
      .join("\n");
    expectAll(block, [
      "データの形の変更（スキーマ）",
      "初めのデータや設定の値の投入",
      "サービスを止めて出せるか",
      "CI は、ほかのリポジトリのどの枝を読むか",
      "同じブランチ名にすると",
      "機能を閉じておく仕組み",
      "先に読む文書",
      "推し量らず AskUserQuestion で人に聞く",
      "先に読む文書に書き足すと、次から聞かずに済む",
      "書き足すのは人に任せる",
    ]);
  });

  it("人に示す一言が分けた案を示し、分けない理由と分けた案の両方を示す文がない", async () => {
    const line =
      (await step6()).split("\n").find((l) => l.startsWith("- 人に示す一言")) ??
      "";
    expectAll(line, ["分けた案", "どこで切るか", "残した理由"]);
    expect(line).not.toContain("分けない理由");
    expect(line).not.toContain("分けたときの案");
  });

  it("一言を添える条件は、分けて目安に収めたときも含み、どちらもなければ添えない", async () => {
    const line =
      (await step6()).split("\n").find((l) => l.startsWith("- 人に示す一言")) ??
      "";
    expectAll(line, [
      "超える見込みだった元の要件がある（分けて目安の中に収めたときも含む）",
      "目安を超えたまま残した項目",
      "どちらもなければ、一言は添えない",
    ]);
    expect(line).not.toContain("超える項目がなければ");
    for (const f of ["SKILL.md", "local.md"]) {
      const t = await read(`skills/intake/${f}`);
      expect(t, f).toContain("分けて収めたときも含む");
      expect(t, f).not.toContain("目安を超える項目があれば");
    }
    expect(await read("docs/spec.md")).toContain(
      "目安を超える見込みだった元の要件があるとき（分けて収めたときも含む）",
    );
  });
});

describe("SKILL.md と local.md：分ける前の問い", () => {
  it("SKILL.md の「当たる所」の行に分ける前の問いがある", async () => {
    const t = await read("skills/intake/SKILL.md");
    const line =
      t.split("\n").find((l) => l.startsWith("- このスキルで当たる所：")) ?? "";
    expect(line).toContain("分ける前の問い");
  });

  it("local.md の「当たる所」の行に分ける前の問いがある", async () => {
    const t = await read("skills/intake/local.md");
    const line =
      t.split("\n").find((l) => l.includes("この道で当たる所は")) ?? "";
    expect(line).toContain("分ける前の問い");
  });
});

describe("出すときの手順", () => {
  it("page-format.md の「ブランチ」の節に決まりがあり、どのブランチにも置け、手順がなければ置かない", async () => {
    const s = section(await read(FORMAT), "## ブランチ");
    const line =
      s.split("\n").find((l) => l.startsWith("  - 出すときの手順：")) ?? "";
    expect(line).not.toBe("");
    expectAll(line, [
      "どのブランチにも置ける",
      "共通のないブランチでも",
      "本番に出す順と人が行う手順",
      "番号つき",
      "（人が行う）",
      "手順がなければ行ごと置かない",
      "同じことを両方に書かない",
    ]);
  });

  it("例のブランチの1つに入っている", async () => {
    const s = section(await read(FORMAT), "## ブランチ");
    const ex = s.split("\n").filter((l) => l.startsWith(">"));
    const at = ex.findIndex((l) => l.includes("出すときの手順："));
    expect(at).toBeGreaterThan(0);
    expect(ex.slice(at + 1, at + 4).some((l) => /^> 1\. /.test(l))).toBe(true);
    expect(ex.filter((l) => l.includes("出すときの手順："))).toHaveLength(1);
  });

  it("「順なし」はPR のマージの順がないことと書き、古い「順が要るならブランチを分け」が残らない", async () => {
    for (const f of [FORMAT, "skills/intake/workspace.md", "docs/spec.md"]) {
      const t = await read(f);
      expect(t, f).not.toContain("順が要るならブランチを分け");
    }
    expect(await read(FORMAT)).toContain(
      "「順なし」と書く（PR のマージの順がない、という意味。",
    );
    expect(await read(FORMAT)).toContain(
      "消せないマージの順が要るときだけブランチを分け",
    );
    const w = await read("skills/intake/workspace.md");
    expectAll(w, [
      "消せないマージの順が要るときだけブランチを分け",
      "共通のないブランチでも、ブランチの「出すときの手順：」に書ける",
    ]);
  });

  it("「出す順：」の行は残る", async () => {
    const f = await read(FORMAT);
    expect(f).toContain("  - 出す順：ブランチのリポジトリが2つ以上のときだけ");
  });

  it("依頼のファイルへの写しに、そのブランチの出すときの手順がある", async () => {
    const g = await read(GUARDS);
    const lines = g.split("\n");
    const copy =
      lines.find((l) => l.startsWith("- 依頼のファイルへの写し")) ?? "";
    expect(copy).toContain("「出すときの手順：」があれば");
    const all = lines.find((l) => l.startsWith("- 依頼のファイルには")) ?? "";
    expect(all).toContain("「出すときの手順：」");
    expect(await read(FORMAT)).toContain(
      "そのブランチの「出すときの手順：」（あれば）は、文で写す",
    );
  });
});

describe("goldfish-reviewer.md と仕様書", () => {
  it("手順3で「文書に照らした前提の誤り」の後ろに3つの観点がある。「横の見落とし」の次の行は文書に照らした前提の誤り", async () => {
    const lines = (await read("agents/goldfish-reviewer.md")).split("\n");
    const at = lines.findIndex((l) => l.includes("- 横の見落とし"));
    expect(lines[at + 1]).toContain("- 文書に照らした前提の誤り");
    expect(lines[at + 2]).toContain("- 独立を理由にした分け方");
    expect(lines[at + 3]).toContain("- 目安を超えたまま残した項目");
    expect(lines[at + 4]).toContain("- 確かめていない「壊れる」");
  });

  it("仕様書の10.1の3つの箇条に要約がある", async () => {
    const spec = await read("docs/spec.md");
    const adr =
      spec.split("\n").find((l) => l.startsWith("- 仕様は ADR の形")) ?? "";
    expectAll(adr, [
      "ブランチは QA の単位",
      "独立していることは分ける理由にしない",
      "4つだけ",
      "本番に出す順・人の手順",
      "必ず分け",
      "移すだけの変更と自動で作るファイルだけ",
      "QA の筋書きで切り",
      "壊れうる（確かめていない）",
      "書き足すよう勧める",
    ]);
    expect(adr).not.toContain("分けないなら理由");
    const pages =
      spec
        .split("\n")
        .find((l) => l.startsWith("- 親のページとタスクのページ：")) ?? "";
    expectAll(pages, [
      "「出す順：」の行（PR のマージの順）",
      "「出すときの手順：」の行",
    ]);
    const form =
      spec.split("\n").find((l) => l.startsWith("- 仕様のページの形：")) ?? "";
    expectAll(form, [
      "「順なし」（PR のマージの順がない）",
      "消せないマージの順が要るときだけ",
      "共通のないブランチでも「出すときの手順：」に書く",
    ]);
  });

  it("仕様書の10.2のレビューの行に、3つの観点がある", async () => {
    const spec = await read("docs/spec.md");
    const l = spec.split("\n").find((x) => x.startsWith("3. レビュー：")) ?? "";
    expectAll(l, [
      "横の見落とし",
      "独立を理由にした分け方",
      "目安を超えたまま残した項目",
      "確かめていない「壊れる」",
    ]);
  });
});

describe("分ける前の問いの聞く条件と「壊れる」の確かめ方", () => {
  const Q_HEAD = "- 分ける前の問い";
  const BROKEN = "- 「壊れる」の確かめ";
  const ONE_LINER = "- 人に示す一言（";
  const ADR = "- 仕様は ADR の形";
  // 6つの問いの順に、「聞くとき：」の後ろに要る言葉
  const CONDS = [
    ["データの形"],
    ["初めのデータか設定の値"],
    ["データの形", "受け渡しの形"],
    ["2つ以上のリポジトリ"],
    ["2つ以上のリポジトリ"],
    ["分ける見込み"],
  ];

  const step6Lines = (guards: string) => {
    const lines = guards.split("\n");
    const at = lines.findIndex((l) => l === "## 手順6：下書きの決まり");
    if (at < 0) return [];
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    return end < 0 ? rest : rest.slice(0, end);
  };

  function questionsOk(guards: string): boolean {
    const lines = step6Lines(guards);
    const at = lines.findIndex((l) => l.startsWith(Q_HEAD));
    if (at < 0) return false;
    const head = lines[at] ?? "";
    if (
      !head.includes("探さず聞かない") ||
      !head.includes("決めきれないときは当たるとして扱う")
    )
      return false;
    return CONDS.every((words, i) => {
      const l = lines[at + 1 + i] ?? "";
      if (!l.startsWith("  - ")) return false;
      const cond = l.split("聞くとき：")[1];
      return cond !== undefined && words.every((w) => cond.includes(w));
    });
  }

  function brokenOk(guards: string): boolean {
    const l = step6Lines(guards).find((x) => x.startsWith(BROKEN));
    return (
      l !== undefined &&
      [
        "CI・開発環境・本番",
        "呼ばれる経路と入力まで確かめて",
        "「壊れうる（確かめていない）」",
        "コード・設定・CI の定義を読み",
        "コマンドを流さない",
        "`.env`",
        "秘密の値を写さない",
      ].every((w) => l.includes(w))
    );
  }

  function askLineOk(line: string | undefined): boolean {
    return (
      line !== undefined &&
      line.includes("分ける前の問い") &&
      line.includes("聞く条件")
    );
  }

  function oneLinerOk(guards: string): boolean {
    const l = step6Lines(guards).find((x) => x.startsWith(ONE_LINER));
    const m = l === undefined ? null : /^- 人に示す一言（([^）]*)）：/.exec(l);
    const label = m?.[1] ?? "";
    return (
      label.includes("超える見込みだった要件") &&
      label.includes("超えたまま残した項目")
    );
  }

  function specOk(spec: string): boolean {
    const l = spec.split("\n").find((x) => x.startsWith(ADR));
    return (
      l !== undefined &&
      [
        "聞く条件",
        "コマンドを流さず",
        "秘密の値を写さない",
        "消せないマージの順があるときだけ",
        "か、例外で",
      ].every((w) => l.includes(w)) &&
      !l.includes("と、例外で")
    );
  }

  const skillLine = (t: string) =>
    t.split("\n").find((l) => l.startsWith("- このスキルで当たる所："));
  const localLine = (t: string) =>
    t.split("\n").find((l) => l.includes("この道で当たる所は"));

  /** 部分文字列を含む行を抜いた写し（1行も抜けなければ失敗）。 */
  function without(text: string, part: string): string {
    const lines = text.split("\n");
    const kept = lines.filter((l) => !l.includes(part));
    expect(kept.length, `抜く行がありません：${part}`).toBeLessThan(
      lines.length,
    );
    return kept.join("\n");
  }

  it("6つの問いが聞くときの条件を持ち、頭の行が聞かない場合と決めきれない場合を書く", async () => {
    expect(questionsOk(await read(GUARDS))).toBe(true);
  });

  it("「壊れる」はファイルを読んで確かめ、コマンドを流さず秘密を写さない", async () => {
    expect(brokenOk(await read(GUARDS))).toBe(true);
  });

  it("SKILL.md と local.md の当たる所が、聞く条件に当たったときと書く", async () => {
    expect(askLineOk(skillLine(await read("skills/intake/SKILL.md")))).toBe(
      true,
    );
    expect(askLineOk(localLine(await read("skills/intake/local.md")))).toBe(
      true,
    );
  });

  it("一言の見出しの括弧が、超える見込みだった要件と残した項目の両方を言う", async () => {
    expect(oneLinerOk(await read(GUARDS))).toBe(true);
  });

  it("仕様書の箇条に聞く条件・確かめ方・別のブランチにする条件・一言のつなぎがある", async () => {
    expect(specOk(await read("docs/spec.md"))).toBe(true);
  });

  it("足した行を抜いた写しや言葉を変えた写しでは落ちる", async () => {
    const g = await read(GUARDS);
    expect(questionsOk(without(g, Q_HEAD))).toBe(false);
    for (const l of g.split("\n").filter((x) => x.includes("聞くとき："))) {
      expect(questionsOk(without(g, l))).toBe(false);
    }
    expect(questionsOk(g.replace("探さず聞かない", "聞く"))).toBe(false);
    expect(questionsOk(g.replace("受け渡しの形", "受け渡し"))).toBe(false);
    expect(brokenOk(without(g, BROKEN))).toBe(false);
    expect(brokenOk(g.replace("秘密の値を写さない", "写す"))).toBe(false);
    expect(oneLinerOk(without(g, ONE_LINER))).toBe(false);
    expect(
      oneLinerOk(g.replace("超えたまま残した項目）", "超える項目）")),
    ).toBe(false);
    const sk = await read("skills/intake/SKILL.md");
    expect(askLineOk(skillLine(without(sk, "- このスキルで当たる所：")))).toBe(
      false,
    );
    expect(askLineOk(skillLine(sk.replace("聞く条件", "条件")))).toBe(false);
    const lo = await read("skills/intake/local.md");
    expect(askLineOk(localLine(without(lo, "この道で当たる所は")))).toBe(false);
    const spec = await read("docs/spec.md");
    expect(specOk(without(spec, ADR))).toBe(false);
    expect(specOk(spec.replace("か、例外で", "と、例外で"))).toBe(false);
    expect(
      specOk(spec.replace("消せないマージの順があるときだけ", "いつも")),
    ).toBe(false);
  });
});
