import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 手順 n の行と、その下のインデントされた行をまとめる。 */
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

/** ブロックの中の、行の頭が prefix の箇条の行（インデントは問わない）。 */
function bulletLine(block: string, prefix: string): string {
  const line = block.split("\n").find((l) => l.trim().startsWith(prefix));
  expect(line, `${prefix} の箇条が見つかりません`).toBeDefined();
  return line ?? "";
}

const ENTRY_HEADING = "「## 〈日付〉 〈見出し〉」";
const NOT_WRITE = "ID・導入先の名前・手元のパス・秘密";

describe("決定の記録：spec のスキル", () => {
  it("decisionsFile があるときだけ、設計の経緯の次に文案の節を書き、なければ書かない", async () => {
    const s4 = stepBlock(await read("skills/spec/SKILL.md"), 4);
    const line = bulletLine(s4, "- 決定の記録の文案：");
    expect(line).toContain("decisionsFile");
    expect(line).toContain("「設計の経緯（run のときに読む）」の次");
    expect(line).toContain("「決定の記録の文案」の節");
    expect(line).toContain("節を書かない");
    expect(line).toContain("「なし」とだけ書く");
  });

  it("文案は5つの要素の箇条書きで、記録では見出しを日付つきにし、書かないものを挙げる", async () => {
    const s4 = stepBlock(await read("skills/spec/SKILL.md"), 4);
    expect(s4).toContain(
      "見出し・決めたこと・理由・捨てた案と理由・人が選んだことの箇条書き",
    );
    expect(s4).toContain(ENTRY_HEADING);
    expect(s4).toContain(NOT_WRITE);
  });

  it("手順1で decisionsFile を覚える", async () => {
    const s1 = stepBlock(await read("skills/spec/SKILL.md"), 1);
    expect(s1).toContain("decisionsFile");
  });

  it("参照の決まり：設計書を見てと書かず、記録の日付と見出しで指し、設計書・報告のパスと ID を書かない", async () => {
    const s4 = stepBlock(await read("skills/spec/SKILL.md"), 4);
    const line = bulletLine(s4, "- 参照の決まり：");
    expect(line).toContain("「設計書を見て」");
    expect(line).toContain("読むだけで分かる");
    expect(line).toContain("「〈日付〉 〈見出し〉」");
    expect(line).toContain("設計書・報告のパスと ID は書かない");
  });
});

describe("決定の記録：run のスキル", () => {
  it("手順7に、報告の前に項を足してコミットする箇条があり、足さない場合を挙げる", async () => {
    const s7 = stepBlock(await read("skills/run/SKILL.md"), 7);
    const line = bulletLine(s7, "- 決定の記録の項");
    expect(line).toContain("報告を書く前");
    expect(line).toContain("decisionsFile");
    expect(line).toContain("「決定の記録の文案」の節");
    expect(line).toContain("「なし」");
    expect(line).toContain("足さない");
  });

  it("項の形・人が選んだこと・書かないもの・参照の書き方・追記だけがある", async () => {
    const s7 = stepBlock(await read("skills/run/SKILL.md"), 7);
    expect(s7).toContain(ENTRY_HEADING);
    for (const w of [
      "決めたこと",
      "理由",
      "捨てた案と理由",
      "人が選んだこと",
    ]) {
      expect(s7, w).toContain(w);
    }
    expect(s7).toContain("おすすめどおり（承認で決まった）");
    expect(s7).toContain("末尾");
    expect(s7).toContain("書き換えない");
    expect(s7).toContain(
      "ID（idPrefix と数字）・導入先の名前・手元のパス・秘密",
    );
    expect(s7).toContain("「設計書を見て」と書かず");
    expect(s7).toContain("設計書・報告のパスと ID は書かない");
  });

  it("すでにある自分の項は直し、rebase のあとに消えた行がないか確かめる", async () => {
    const s7 = stepBlock(await read("skills/run/SKILL.md"), 7);
    expect(s7).toContain("git diff 〈baseBranch〉...HEAD -- 〈decisionsFile〉");
    expect(s7).toContain("もう一度足さず、その項を直す");
    expect(s7).toContain("まだ統合していない自分の項は書き換えてよい");
    expect(s7).toContain("すでに統合された項");
    expect(s7).toContain("前に空行を1行入れる");
    expect(s7).toContain("〈baseBranch〉 の行を戻し");
  });

  it("rebase のあとは、main の記録がコミットした記録（git show HEAD）の先頭とそのまま同じかで確かめる", async () => {
    const s7 = stepBlock(await read("skills/run/SKILL.md"), 7);
    expect(s7).toContain("git show 〈baseBranch〉:〈decisionsFile〉");
    expect(s7).toContain("先頭とそのまま同じか");
    expect(s7).toContain("自分の項を末尾に足し直");
    expect(s7).not.toContain("消した行がない");
  });

  it("おまかせの承認は auto show の「承認：」で見分け、書き分ける", async () => {
    const s7 = stepBlock(await read("skills/run/SKILL.md"), 7);
    expect(s7).toContain("orca-flow auto show $0");
    expect(s7).toContain("「承認：」で始まる決めたこと");
    expect(s7).toContain("おすすめどおり（おまかせで統括役が決めた）");
    expect(s7).toContain("おすすめどおり（承認で決まった）");
    expect(s7).toContain("今おまかせかどうかでは見分けない");
    expect(s7).toContain("おまかせの記録はありません");
    expect(s7).toContain("git show HEAD:〈decisionsFile〉");
    expect(s7).toContain(
      "がない（`git show` が失敗する）か空のときは確かめない",
    );
  });

  it("項のコミットで HEAD が動くので、手順10の verify のやり直しに含める", async () => {
    const run = await read("skills/run/SKILL.md");
    const s7 = stepBlock(run, 7);
    expect(s7).toMatch(/git add -- 〈decisionsFile〉 && git commit/);
    expect(s7).toContain("HEAD が動く");
    const s10 = stepBlock(run, 10);
    expect(s10).toContain("決定の記録の項をコミットしたとき");
    expect(s10).toContain("項も足さなかったとき");
  });

  it("手順1で decisionsFile と文案を読む", async () => {
    const s1 = stepBlock(await read("skills/run/SKILL.md"), 1);
    expect(s1).toContain("decisionsFile");
    expect(s1).toContain("「決定の記録の文案」");
  });
});

describe("決定の記録：approve のスキル", () => {
  it("人の答えが設計書（文案の人が選んだことも）と違えば、直させてから承認する", async () => {
    const s2 = stepBlock(await read("skills/approve/SKILL.md"), 2);
    const line = bulletLine(s2, "- 人間が承認のとき");
    expect(line).toContain("文案の「人が選んだこと」");
    expect(line).toContain("承認の前に設計書を直させる");
    expect(line).toContain("`orca-flow tell $0");
    expect(line).toContain("違うまま承認しない");
    expect(line).toContain("おすすめどおり（承認で決まった）");
  });
});

describe("決定の記録：おまかせの書き分け", () => {
  /** 「おまかせの決まり」の節の本文。 */
  async function autoRules(rel: string): Promise<string> {
    const text = await read(rel);
    const start = text.indexOf("## おまかせの決まり");
    expect(start, `${rel} に節がありません`).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + 1);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  it("approve：推奨どおりの決めは、終了コード0のあとに「承認：」で始めて残し、手順2の箇条に書き方がある", async () => {
    const sec = await autoRules("skills/approve/SKILL.md");
    const line = bulletLine(sec, "- 決めてほしいことを推奨どおりにした決め");
    expect(line).toContain("「承認：」で始めて");
    expect(line).toContain("終了コード0");
    expect(line).toContain("auto log");
    expect(line).toContain("おすすめどおり（おまかせで統括役が決めた）");
    const s2 = stepBlock(await read("skills/approve/SKILL.md"), 2);
    const bullet = bulletLine(s2, "- 人間が承認のとき");
    expect(bullet).toContain("おすすめどおり（おまかせで統括役が決めた）");
  });

  it("integrate：聞かずに推奨どおりに決めた選択は書き分け、人に聞いたものは人の答えを書く", async () => {
    const sec = await autoRules("skills/integrate/SKILL.md");
    expect(sec).toContain("おすすめどおり（おまかせで統括役が決めた）");
    expect(sec).toContain("人に聞いて決まったものは、人の答えを書く");
  });
});

describe("決定の記録：integrate のスキル", () => {
  it("統合のときに決まった選択を、統括役が main で decisionsFile の末尾に足す", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 統合のときに決まった選択");
    expect(line).toContain("decisionsFile");
    expect(line).toContain("統括役が main で");
    expect(line).toContain("末尾");
    expect(line).toContain("足し直さない");
    expect(s4).toContain(ENTRY_HEADING);
    expect(s4).toContain("書き換えず");
    expect(s4).toContain(NOT_WRITE);
    expect(s4).toContain("「設計書を見て」と書かず");
    expect(s4).toContain("設計書・報告のパスと ID は書かず");
  });

  it("マージのあとに decisionsFile だけをコミットする", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- マージのあとに足してコミットする");
    expect(line).toContain("git add -- 〈decisionsFile〉 && git commit");
    expect(line).toContain("-- 〈decisionsFile〉`");
    expect(line).toContain("〈integratorName〉: $0 の決定の記録");
  });

  it("統括役が足す項は、コミットの前に差分の + の行で ID の形と見出しを確かめる", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- マージのあとに足してコミットする");
    expect(line).toContain("git diff -- 〈decisionsFile〉");
    expect(line).toContain("idPrefix と数字の形");
    expect(line).toContain("「決めたこと」「理由」");
    expect(line).toContain(ENTRY_HEADING);
  });

  it("止めの文で見分ける：項の抜けと、追記だけの確かめ（rebase のあと）", async () => {
    const s3 = stepBlock(await read("skills/integrate/SKILL.md"), 3);
    const missing = bulletLine(
      s3,
      "- 1 で、標準エラーに「設計書に決定の記録の文案がありますが、差分に 〈decisionsFile〉 がありません」",
    );
    expect(missing).toContain("「決定の記録」だけで見分けない");
    expect(missing).toContain("マージしていません");
    expect(missing).toContain("「警告：」で始まらない行");
    const append = bulletLine(
      s3,
      "- 1 で、標準エラーに「〈baseBranch〉 の 〈decisionsFile〉 が、タスクのブランチの 〈decisionsFile〉 の先頭と同じではありません」",
    );
    expect(append).toContain("マージしていません");
    expect(append).toContain("rebase のあと");
    expect(append).toContain("自分の項を末尾に足し直");
    expect(append).toContain("orca-flow tell");
    expect(append).toContain("verify");
    expect(append).toContain("--skip-decision");
    expect(append).toContain("飛ばない");
    expect(append).toContain("merge=union");
  });

  it("抜けで止まったとき（終了コード1・マージしない）の扱いと --skip-decision の使いどころ", async () => {
    const s3 = stepBlock(await read("skills/integrate/SKILL.md"), 3);
    const line = bulletLine(
      s3,
      "- 1 で、標準エラーに「設計書に決定の記録の文案がありますが",
    );
    expect(line).toContain("マージはされていない");
    expect(line).toContain("タスク長に項を足させる");
    expect(line).toContain("人間が頼んだときに");
    expect(line).toContain("--skip-decision");
    expect(line).toContain("警告で通す".replace("で通す", "にして通す"));
    expect(line).toContain("節がない設計書は、警告が出るだけで止まらない");
    const skip = bulletLine(s3, "決定の記録の項の抜けの確かめを飛ばす逃げ道");
    expect(skip).toContain("人間が頼んだときだけ");
  });

  it("手順1で decisionsFile を読む", async () => {
    const s1 = stepBlock(await read("skills/integrate/SKILL.md"), 1);
    expect(s1).toContain("decisionsFile");
  });
});

describe("決定の記録：公開に出る文に ID と手元のパスを書かない", () => {
  it("スキル・仕様書・このテストに、タスクの ID（P と数字）と個人のパスがない", async () => {
    const files = [
      "skills/spec/SKILL.md",
      "skills/run/SKILL.md",
      "skills/approve/SKILL.md",
      "skills/integrate/SKILL.md",
      "docs/spec.md",
      "test/plugin/decisions-record.test.ts",
    ];
    for (const f of files) {
      const text = await read(f);
      expect(text, f).not.toMatch(/\bP\d+\b/);
      expect(text, f).not.toMatch(/\/Users\/|\/home\/[a-z]/);
    }
  });
});

describe("決定の記録：docs/spec.md", () => {
  it("6章の表に decisionsFile の行があり、appendOnlyFiles に入れると書く", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const row = lines.find((l) => l.startsWith("| decisionsFile "));
    expect(row).toBeDefined();
    expect(row).toContain("`null`");
    expect(row).toContain("appendOnlyFiles");
    const para = lines.find((l) => l.startsWith("**決定の記録**：")) ?? "";
    expect(para).toContain("decisionsFile");
    expect(para).toContain("追記だけ");
    expect(para).toContain(ENTRY_HEADING);
  });

  it("8章に、integrate の確かめ（終了コード1・--skip-decision・節がなければ警告・ID の形は警告）がある", async () => {
    const text = await read("docs/spec.md");
    const start = text.indexOf("**決定の記録**（6章 decisionsFile。integrate");
    expect(start).toBeGreaterThan(0);
    const sec = text.slice(
      start,
      text.indexOf("**記録が無視されているとき**", start),
    );
    expect(sec).toContain("終了コード1");
    expect(sec).toContain("マージしない");
    expect(sec).toContain("--skip-decision");
    expect(sec).toContain("人間が頼んだときだけ");
    expect(sec).toContain("文案の節がない設計書は、警告を出して通す");
    expect(sec).toContain("ID の形");
    expect(sec).toContain("設計書に決定の記録の文案がありますが");
    expect(sec).toContain("の先頭と同じではありません");
    expect(sec).toContain("rebase のあと");
    expect(sec).toContain("merge=union");
    expect(sec).toContain("`--skip-decision` ではこの確かめは飛ばない");
  });

  it("9.1 と 10.1 の箇条に、おまかせのときの書き方と run の確かめ方がある", async () => {
    const text = await read("docs/spec.md");
    const s91 = text.slice(
      text.indexOf("**決定の記録の文案**（decisionsFile"),
      text.indexOf("**書き方の決まり**"),
    );
    expect(s91).toContain("おすすめどおり（おまかせで統括役が決めた）");
    expect(s91).toContain("「承認：」で始まる決めたこと");
    expect(s91).toContain("git show 〈baseBranch〉:〈decisionsFile〉");
    const s101 = text.slice(
      text.indexOf("**決定の記録**（6章 decisionsFile）のスキルの扱い"),
      text.indexOf("### 10.2"),
    );
    expect(s101).toContain("おすすめどおり（おまかせで統括役が決めた）");
    expect(s101).toContain("git show 〈baseBranch〉:〈decisionsFile〉");
    expect(s101).toContain("「警告：」で始まらない行");
    const autoStart = text.indexOf("**おまかせ**（8章）のスキルの扱い");
    const auto = text.slice(
      autoStart,
      text.indexOf("**決定の記録**（6章 decisionsFile）のスキルの扱い"),
    );
    const autoLine = bulletLine(auto, "- approve・integrate：");
    expect(autoLine).toContain("おすすめどおり（おまかせで統括役が決めた）");
    expect(autoLine).toContain("「承認：」で始めて");
  });

  it("10.1 の表の行は、main のいちばん長い行より長くせず、削った文を保つ", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const row = (cmd: string) =>
      lines.find((l) => l.startsWith(`| \`/orca-flow:${cmd} `)) ?? "";
    for (const cmd of ["spec", "approve", "run", "integrate"]) {
      expect([...row(cmd)].length, cmd).toBeLessThanOrEqual(4700);
    }
    expect(row("run")).toContain("④の verify の前「テストを流している」");
    expect(row("spec")).toContain("（readFirst が正とする文書を変えない）");
    expect(row("integrate")).toContain(
      "revert して `orca-flow main-check run` を流す",
    );
    expect(row("integrate")).toContain("ログと `main-check run` を伝える");
  });

  it("9.1 に、文案の節・項の形・書かないもの・参照の決まり・足す時期がある", async () => {
    const text = await read("docs/spec.md");
    const start = text.indexOf("**決定の記録の文案**（decisionsFile");
    expect(start).toBeGreaterThan(0);
    const sec = text.slice(start, text.indexOf("**書き方の決まり**", start));
    expect(sec).toContain("「設計の経緯（run のときに読む）」の次");
    expect(sec).toContain("「なし」とだけ書く");
    expect(sec).toContain(
      "見出し・決めたこと・理由・捨てた案と理由・人が選んだことの箇条書き",
    );
    expect(sec).toContain(ENTRY_HEADING);
    expect(sec).toContain(NOT_WRITE);
    expect(sec).toContain("おすすめどおり（承認で決まった）");
    expect(sec).toContain("報告の前");
    expect(sec).toContain("verify をやり直す");
    expect(sec).toContain("「設計書を見て」と書かず");
    expect(sec).toContain("設計書・報告のパスと ID は書かない");
  });

  it("10.1 の approve の行と、スキルの扱いの箇条に決定の記録がある", async () => {
    const text = await read("docs/spec.md");
    const lines = text.split("\n");
    // spec・run・integrate の行は幅を固定する別のテストがあり、決定の記録の文は下の箇条にある
    for (const cmd of ["approve"]) {
      const row = lines.find((l) => l.startsWith(`| \`/orca-flow:${cmd} `));
      expect(row, cmd).toBeDefined();
      expect(row, cmd).toMatch(/決定の記録|decisionsFile|--skip-decision|文案/);
    }
    const start = text.indexOf(
      "**決定の記録**（6章 decisionsFile）のスキルの扱い",
    );
    expect(start).toBeGreaterThan(0);
    const sec = text.slice(start);
    for (const w of ["- spec：", "- run：", "- approve：", "- integrate："]) {
      expect(sec, w).toContain(w);
    }
    expect(sec).toContain("--skip-decision");
    expect(sec).toContain("⑦の verify のやり直しに含める");
  });
});
