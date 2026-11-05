import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const OLD_NAME = "人間に確認が必要なこと";
const NEW_NAME = "人間に決めてほしいこと";

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 「N. 」で始まる手順の行（折り返さずに1行で書く決まり）。 */
function step(text: string, n: number): string {
  const line = text.split("\n").find((l) => new RegExp(`^${n}\\. `).test(l));
  expect(line, `手順${n}が見つかりません`).toBeDefined();
  return line ?? "";
}

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

function reportFormatLine(text: string): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l === "## 報告の形");
  expect(i).toBeGreaterThanOrEqual(0);
  const line = lines.slice(i + 1).find((l) => l.startsWith("〈reportsDir〉"));
  expect(line).toBeDefined();
  return line ?? "";
}

describe("run：報告の書き方", () => {
  it("手順8が3つの節と、項目の起きること・推奨・理由を含む", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    for (const w of [
      "共有のファイルの変更の依頼",
      NEW_NAME,
      "後回しにしたもの",
      "起きること",
      "根拠",
      "推奨",
      "理由",
      "後続のタスクにする",
      "このままにする",
    ]) {
      expect(s8, w).toContain(w);
    }
  });

  it("古い名前が残っていない", async () => {
    expect(await read("skills/run/SKILL.md")).not.toContain(OLD_NAME);
  });

  it("範囲の外・2回で直らない・未実施・humanReview の行が新しい節を指す", async () => {
    const text = await read("skills/run/SKILL.md");
    const lines = text.split("\n");
    const pick = (re: RegExp) => lines.find((l) => re.test(l)) ?? "";
    expect(pick(/書き込んでよい場所」の外/)).toContain(NEW_NAME);
    expect(pick(/2回で直らなかったもの/)).toContain(NEW_NAME);
    expect(pick(/「未実施」とした観点/)).toContain(NEW_NAME);
    expect(pick(/`humanReview` が true/)).toContain(NEW_NAME);
  });

  it("コードレビューの残りは1項目にまとめて推奨をつける", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    expect(s8).toMatch(/直したほうがよい/);
    expect(s8).toMatch(/1項目にまとめ/);
  });

  it("手順11は決めてほしいことを推奨つきで伝え、統合のとき聞くと添える", async () => {
    const s11 = step(await read("skills/run/SKILL.md"), 11);
    expect(s11).toContain(NEW_NAME);
    expect(s11).toContain("推奨");
    expect(s11).toContain("統合");
    expect(s11).toContain("今答えなくて");
  });
});

describe("integrate：手順4", () => {
  it("選択肢で聞き、推奨どおり・後続のタスク・このままを扱う", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    for (const w of [
      "AskUserQuestion",
      "推奨どおり",
      "後続のタスク",
      "このまま",
      "skills/new/SKILL.md",
      OLD_NAME,
      NEW_NAME,
      "後回しにしたもの",
      "後で決める",
      "今は決めない",
    ]) {
      expect(s4, w).toContain(w);
    }
  });

  it("統括役が推奨を確かめ、項目ごとは1回4問まで", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    expect(s4).toMatch(/統括役.*差分.*コード.*推奨を確かめ/s);
    expect(s4).toMatch(/1回(に)?4問まで/);
    expect(s4).toContain("タスク長は");
  });

  it("後続のタスクは依頼のファイルに元の項目の全文と元の報告の場所を写す", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    expect(s4).toContain("全文");
    expect(s4).toContain("元の報告の場所");
    expect(s4).toContain("`git show 〈baseBranch〉:〈reportsDir〉/$0.md`");
    expect(s4).not.toContain("git show main:");
    expect(s4).toContain("${CLAUDE_PLUGIN_ROOT}/skills/new/SKILL.md");
    expect(s4).toContain("要約しない");
    expect(s4).toContain("終了コード2");
    expect(s4).toContain("/orca-flow:new");
  });

  it("手順5の残りに「後で決める」「今は決めない」が入る", async () => {
    const s5 = stepBlock(await read("skills/integrate/SKILL.md"), 5);
    expect(s5).toContain("後で決める");
    expect(s5).toContain("今は決めない");
    expect(s5).toContain("後回しにしたもの");
  });
});

describe("new と spec：後続のタスクの背景", () => {
  it("new の手順5は、ほかのタスクの報告の項目を指すとき全文と元の報告の場所を写す", async () => {
    const s5 = stepBlock(await read("skills/new/SKILL.md"), 5);
    expect(s5).toContain("全文");
    expect(s5).toContain("元の報告の場所");
    expect(s5).toContain("`git show 〈baseBranch〉:〈reportsDir〉/〈ID〉.md`");
    expect(s5).not.toContain("git show main:");
    expect(s5).toContain("要約しない");
  });

  it("spec の手順1は依頼の元の報告を読み、手順4は作るものになぜ要るかと出どころを添える", async () => {
    const text = await read("skills/spec/SKILL.md");
    const s1 = step(text, 1);
    expect(s1).toContain("元の報告の場所");
    expect(s1).toContain("該当の項目");
    const s4 = stepBlock(text, 4);
    expect(s4).toContain("なぜ要るか");
    expect(s4).toContain("出どころ");
    expect(s4).toContain("報告の");
  });
});

describe("報告の形の文", () => {
  it("テンプレート・.orca-flow のテンプレート・仕様 9.1 が同じ文で、3つの節を含む", async () => {
    const tpl = reportFormatLine(await read("templates/spec-template.md"));
    const local = reportFormatLine(await read(".orca-flow/spec-template.md"));
    expect(tpl).toBe(local);
    for (const w of [
      "共有のファイルの変更の依頼",
      NEW_NAME,
      "後回しにしたもの",
    ]) {
      expect(tpl, w).toContain(w);
    }
    const spec = await read("docs/spec.md");
    expect(spec).toContain(tpl);
    expect(tpl).not.toContain(OLD_NAME);
  });
});

describe("docs/spec.md", () => {
  it("10.1 の run と integrate の行は新しい名前を含み、古い名前を含まない", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    for (const cmd of ["run", "integrate"]) {
      const row = lines.find((l) => l.startsWith(`| \`/orca-flow:${cmd} `));
      expect(row, cmd).toBeDefined();
      expect(row, cmd).toContain(NEW_NAME);
      expect(row, cmd).not.toContain(OLD_NAME);
    }
  });

  it("12章の統合に「推奨どおり」がある", async () => {
    const text = await read("docs/spec.md");
    const line = text.split("\n").find((l) => /^7\. \*\*統合\*\*/.test(l));
    expect(line).toBeDefined();
    expect(line).toContain("推奨どおり");
  });

  it("仕様全体から古い名前が消えている", async () => {
    expect(await read("docs/spec.md")).not.toContain(OLD_NAME);
  });
});

/** 手順 n のブロックの中の、行の頭が prefix の箇条の行（インデントは問わない）。 */
function bulletLine(block: string, prefix: string): string {
  const line = block.split("\n").find((l) => l.trim().startsWith(prefix));
  expect(line, `${prefix} の箇条が見つかりません`).toBeDefined();
  return line ?? "";
}

describe("報告の決定事項：integrate の手順4（後続のタスクの作成が失敗しても手順5へ進む）", () => {
  it("new が終了コード1か2でも手順5へ進み、人が打つ文を残りに入れる", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- new の手順の「止まる」");
    expect(line).toContain("手順5へ進む");
    expect(line).toContain("終了コード1か2");
    expect(line).toContain("作り直さず");
    expect(line).toContain("/orca-flow:new");
    expect(line).toContain("手順5の残り");
    expect(line).toContain("一時ディレクトリ");
  });

  it("共有のファイルのコミットは new より前で、verify が落ちたら戻して手順5の残りに入れる", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const commit = bulletLine(s4, "- 「main で今変える」の変更は");
    expect(commit).toContain("new より前");
    expect(commit).toContain("未コミットの変更");
    expect(commit).toMatch(/verify が落ちたら.*戻し.*手順5の残り/);
    expect(s4.indexOf(commit)).toBeLessThan(
      s4.indexOf(bulletLine(s4, "- 「後続のタスクにする」")),
    );
  });

  it("後続のタスクの箇条は、統括役が1つにまとめて new の手順で作り、人に打たせる文がない", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 「後続のタスクにする」");
    expect(line).toContain("統括役が");
    expect(line).toContain("1つのタスクにまとめ");
    expect(line).toContain(
      "`${CLAUDE_PLUGIN_ROOT}/skills/new/SKILL.md` の手順で作る",
    );
    expect(line).not.toContain("/orca-flow:new");
    expect(line).not.toContain("打");
  });

  it("共有のファイルの箇条は、一覧に何をどう変えるかを出し、選んだことを承認とみなす", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 共有のファイルの変更の項目");
    expect(line).toContain("「main で今変える」「変えない」「後で決める」");
    expect(line).toContain("何をどう変えるか");
    expect(line).toContain("一覧");
    expect(line).toContain("承認とみなし");
    expect(line).toContain("聞き直さない");
    expect(line).toContain("すべて推奨どおり");
    expect(line).toContain("違ってしまうときだけ");
    expect(line).toContain("/reload-plugins");
    expect(line).toContain("手順5で伝える");
  });

  it("報告に「人が選んだこと」がある項目は聞き直さない", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 報告に「人が選んだこと」がある項目");
    expect(line).toContain("決まったもの");
    expect(line).toContain("聞き直さない");
  });

  it("手順1は baseBranch も読む", async () => {
    const s1 = step(await read("skills/integrate/SKILL.md"), 1);
    expect(s1).toContain("baseBranch");
  });
});

describe("報告の決定事項：run の手順8と、統合の前に人が決めるもの", () => {
  it("手順8に3つの節の箇条があり、決めてほしいことの下に根拠の箇条がある", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    const lines = s8.split("\n");
    // 手順の直下の箇条の字下げは、「8. 」の幅（番号の桁数＋2）。2桁の手順でも同じ式で求める。
    const width = String(8).length + 2;
    const under = " ".repeat(width);
    for (const head of [
      "- 「共有のファイルの変更の依頼」",
      `- 「${NEW_NAME}」`,
      "- 「後回しにしたもの」",
    ]) {
      expect(
        lines.some((l) => l.startsWith(`${under}${head}`)),
        head,
      ).toBe(true);
    }
    const i = lines.findIndex((l) => l.startsWith(`${under}- 「${NEW_NAME}」`));
    expect(i, NEW_NAME).toBeGreaterThanOrEqual(0);
    const j = lines.findIndex(
      (l, k) => k > i && new RegExp(`^ {${width}}- `).test(l),
    );
    const inner = lines.slice(i + 1, j < 0 ? undefined : j);
    expect(inner.some((l) => /^\s+- 根拠：/.test(l))).toBe(true);
  });

  it("共有のファイルの変更の依頼の箇条に、推奨（main で今変える・変えない）と理由がある", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    const line = bulletLine(s8, "- 「共有のファイルの変更の依頼」");
    expect(line).toContain("推奨");
    expect(line).toContain("「main で今変える」");
    expect(line).toContain("「変えない」");
    expect(line).toContain("理由");
  });

  it("2回で直らなかった必ず直すものと未実施の観点は、integrate-wait の前に question で聞く", async () => {
    const text = await read("skills/run/SKILL.md");
    const line = bulletLine(text, "- 統合の前に人が決めるもの");
    expect(line).toContain("2回で直らなかった");
    expect(line).toContain("未実施");
    expect(line).toContain("integrate-wait の前");
    expect(line).toContain("`orca-flow status question");
    expect(line).toContain("人が選んだこと");
    expect(line).toContain("答え（直す・後続のタスクにする・このままにする）");
  });

  it("手順8に「この節に書かず」がなく、人が選んだことを書く箇条がある", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    expect(s8).not.toContain("この節に書かず");
    expect(s8).toMatch(/- 人が選んだこと：/);
  });
});

describe("報告の決定事項：元の報告の場所は baseBranch で指す", () => {
  it("skills/ の下に git show main: がない", async () => {
    const entries = await readdir(path.join(ROOT, "skills"), {
      withFileTypes: true,
    });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const d of dirs) {
      const text = await read(`skills/${d}/SKILL.md`);
      expect(text, d).not.toContain("git show main:");
    }
  });

  it("new の手順2は baseBranch と reportsDir も読む", async () => {
    const s2 = step(await read("skills/new/SKILL.md"), 2);
    expect(s2).toContain("baseBranch");
    expect(s2).toContain("reportsDir");
  });

  it("new の手順5は、依頼のファイルに実際の値を入れて書く", async () => {
    const s5 = stepBlock(await read("skills/new/SKILL.md"), 5);
    expect(s5).toContain("実際の値");
  });

  it("integrate の手順4も、実際の値を入れて書く", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    expect(s4).toContain("実際の値");
  });
});

describe("報告の決定事項：spec の手順4の作るものの形", () => {
  it("1行に、作るもの・なぜ要るか・1文・出どころ（〈ID〉の報告の〈番号〉）がそろう", async () => {
    const s4 = stepBlock(await read("skills/spec/SKILL.md"), 4);
    const line = bulletLine(s4, "- 後続のタスク");
    for (const w of [
      "「作るもの」",
      "なぜ要るか",
      "1文",
      "出どころ（〈ID〉の報告の〈番号〉）",
    ]) {
      expect(line, w).toContain(w);
    }
  });
});

describe("報告の決定事項：docs/spec.md", () => {
  it("9.1 で、報告の節の箇条と設計書の決まりの箇条が見出しの1行で分かれる", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const last = lines.findIndex((l) => l.startsWith("- 「後回しにしたもの」"));
    const next = lines.findIndex((l) => l.startsWith("- 「要点」は4行"));
    expect(last).toBeGreaterThan(0);
    expect(next).toBeGreaterThan(last);
    const between = lines.slice(last + 1, next).filter((l) => l.trim() !== "");
    const reportBullets = lines
      .slice(last + 1, next)
      .filter((l) => l.startsWith("- "));
    // 後回しにしたものの次の箇条（統合の前に人が決めるもの）までが報告の箇条
    expect(reportBullets.length).toBe(1);
    expect(reportBullets[0]).toContain("integrate-wait の前");
    const headings = between.filter((l) => !l.startsWith("- "));
    expect(headings).toEqual(["**設計書の決まり**："]);
    const hi = lines.indexOf("**設計書の決まり**：");
    expect(lines[hi - 1]).toBe("");
    expect(lines[hi + 1]).toBe("");
    expect(hi).toBeLessThan(next);
  });

  it("9.1 に、共有のファイルの項目の推奨と、統合の前に question で聞くものがある", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const shared = lines.find((l) =>
      l.startsWith("- 「共有のファイルの変更の依頼」"),
    );
    expect(shared).toContain("「main で今変える」");
    expect(shared).toContain("「変えない」");
    expect(shared).toContain("承認とみなし");
    const ask = lines.find((l) => l.startsWith("- 統合の前に人が決めるもの"));
    expect(ask).toContain("2回で直らなかった");
    expect(ask).toContain("未実施");
    expect(ask).toContain("`status question`");
    expect(ask).toContain("人が選んだこと");
  });

  it("10.1 の integrate の行は「。⑤」で、new の手順で作ることなどを足している", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const row =
      lines.find((l) => l.startsWith("| `/orca-flow:integrate ")) ?? "";
    expect(row).toContain("。⑤");
    expect(row).not.toMatch(/[^。]⑤ マージ/);
    expect(row).toContain("承認とみなし");
    expect(row).toContain("終了コード1か2");
    expect(row).toContain("人が選んだこと");
    expect(row).toContain("git show 〈baseBranch〉:");
  });

  it("10.1 の new の行は git show 〈baseBranch〉: で、main: がない", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const row = lines.find((l) => l.startsWith("| `/orca-flow:new ")) ?? "";
    expect(row).toContain("git show 〈baseBranch〉:");
    expect(row).not.toContain("git show main:");
    expect(await read("docs/spec.md")).not.toContain("git show main:");
  });

  it("10.1 の run の行は、統合の前に question で聞くことを含む", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const row = lines.find((l) => l.startsWith("| `/orca-flow:run ")) ?? "";
    expect(row).toContain("integrate-wait の前");
    expect(row).toContain("人が選んだこと");
    expect(row).toContain("「main で今変える」「変えない」");
  });
});

const SCOPE =
  "`.claude/` の下（CLAUDE.md を除く）・`.orca-flow/` の下・`orca.yaml`・`package.json`（ファイル全体）・`.worktreeinclude`";

describe("差分を見せてから入れる：大事な共有のファイルは差分を見せてから入れる", () => {
  it("integrate の手順4に範囲の箇条があり、差分・新しいファイル・入れる入れないを書く", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 大事な共有のファイル");
    expect(line).toContain(SCOPE);
    expect(line).toContain("コミットの前");
    expect(line).toContain("差分");
    expect(line).toContain("新しいファイル");
    expect(line).toContain("中身全体");
    expect(line).toContain("AskUserQuestion");
    expect(line).toContain("「入れる」");
    expect(line).toContain("「入れない」");
    expect(line).toMatch(/「入れない」なら.*戻し.*消し.*手順5の残り/);
    expect(s4.indexOf(line)).toBeLessThan(
      s4.indexOf(bulletLine(s4, "- 「main で今変える」の変更は")),
    );
  });

  it("一覧か共有のファイルの箇条に「差分を見てから入れる」と添える", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    expect(bulletLine(s4, "- 共有のファイルの変更の項目")).toContain(
      "差分を見てから入れる",
    );
  });

  it("run の手順8の共有のファイルの箇条と spec 9.1 に、差分を見せてから入れるとある", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    const run = bulletLine(s8, "- 「共有のファイルの変更の依頼」");
    expect(run).toContain("差分を見せてから入る");
    const spec = (await read("docs/spec.md"))
      .split("\n")
      .find((l) => l.startsWith("- 「共有のファイルの変更の依頼」"));
    expect(spec).toContain("差分を見せてから入れる");
  });

  it("integrate の手順4と spec 9.1 に、同じ範囲が書いてある", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    expect(s4).toContain(SCOPE);
    expect(await read("docs/spec.md")).toContain(SCOPE);
  });
});

describe("差分を見せてから入れる：run の手順6、統合の前の question の答えのあと", () => {
  it("「直す」は直しの指示と同じに扱い、数え直し、担当が直している、手順5からやり直す", async () => {
    const s6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = bulletLine(s6, "- 人が「直す」と選んだとき");
    expect(line).toContain(
      "直しの指示（下の「統括役から知らせが来たら」）と同じに、",
    );
    expect(line).toContain("0から数え直し");
    expect(line).toContain("担当が直している");
    expect(line).toContain("手順5からやり直す");
  });

  it("「直す」のあと full はやり直しの形で流し、また直らなければ聞き、直ったものは直したものに書く", async () => {
    const s6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = bulletLine(s6, "- 人が「直す」と選んだとき");
    expect(line).toContain("full");
    expect(line).toContain("やり直しの形");
    expect(line).toContain("前の回の直させるもの");
    expect(line).toContain("もう一度");
    expect(line).toContain("question");
    expect(line).toContain("直したもの");
    expect(line).toContain("残さない");
  });

  it("「直す」は担当に戻す前に直す前のコミットを覚え、light・off は review を呼ばず、確認役のものだけなら「なし」と書き出す", async () => {
    const s6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = bulletLine(s6, "- 人が「直す」と選んだとき");
    expect(line).toContain(
      "担当に戻す前に〈直す前のコミット〉（`git rev-parse HEAD`）を覚え、直し終わったらすぐ、上の箇条と同じに取り込みより前に〈直し終わりの先頭〉を覚えて、review の範囲を `〈直す前のコミット〉..〈直し終わりの先頭〉` にする",
    );
    expect(line).toContain("差分が空なら直っていないとして数えるのも上と同じ");
    expect(line).toContain(
      "人が「直す」を選んだもののうち review の直させるものだけを書き出す（確認役のものだけなら「なし」と書き出す）",
    );
    expect(line).toContain(
      "`light`・`off` では review を呼ばない（確認役だけやり直す。`light` の「最初の1回」は数え直さない）",
    );
    expect(line).toContain("直しの指示との違い");
  });

  it("手順6の答えの箇条と手順8に、「直す」で直ったものを除く但し書きがある", async () => {
    const run = await read("skills/run/SKILL.md");
    const ask = bulletLine(stepBlock(run, 6), "- 統合の前に人が決めるもの");
    expect(ask).toContain("答え（直す・後続のタスクにする・このままにする）");
    expect(ask).toContain(
      "の項目に（「直す」で直ったものを除く）「人が選んだこと」として書く",
    );
    const s8 = bulletLine(stepBlock(run, 8), "- 統合の前に人が決めるもの");
    expect(s8).toContain(
      "は（「直す」で直ったものを除く）、「人間に決めてほしいこと」に「人が選んだこと」を添えて書く",
    );
  });

  it("未実施の観点の答えは流し直す・後続のタスクにする・このままにするで、最初の形の review を流す", async () => {
    const s6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = bulletLine(s6, "- 未実施の観点の答え");
    expect(line).toContain(
      "「流し直す」「後続のタスクにする」「このままにする」",
    );
    expect(line).toContain("最初の形");
    expect(line).toContain("`/orca-flow:review $0 〈baseBranch〉...HEAD`");
    expect(line).toContain("また未実施なら、もう一度聞く");
  });

  it("手順11は、人が選んだことのある項目に人の答えを添え、今答えなくてよいは選んでいない項目だけ", async () => {
    const s11 = step(await read("skills/run/SKILL.md"), 11);
    expect(s11).toContain("人が選んだこと");
    expect(s11).toContain("人の答えを添え");
    expect(s11).toMatch(/今答えなくてよい.*人が選んだことのない項目だけ/);
  });
});

describe("差分を見せてから入れる：integrate の手順4、聞き済みの項目と new の失敗", () => {
  it("「人が選んだこと」の箇条は「人間に決めてほしいこと」の節に絞り、AskUserQuestion の箇条より前で、一覧に決まり済みと出す", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 報告に「人が選んだこと」がある項目");
    expect(line).toContain(`「${NEW_NAME}」の節の項目だけ`);
    expect(line).toContain("ほかの節");
    expect(line).toContain("聞く");
    expect(line).toContain("統合の前に決まり済み：〈答え〉");
    expect(line).toContain("選択肢では聞かない");
    const ask = s4
      .split("\n")
      .find(
        (l) => l.trim().startsWith("- 一覧") && l.includes("AskUserQuestion"),
      );
    expect(ask).toBeDefined();
    expect(s4.indexOf(line)).toBeLessThan(s4.indexOf(ask ?? ""));
  });

  it("new が worktree を作ったあとに失敗したら、残っているものと片付けのコマンドを残りに入れる", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- new が worktree を作ったあとに失敗");
    expect(line).toContain("残っているもの");
    expect(line).toContain("片付けのコマンド");
    expect(line).toContain("手順5の残り");
    expect(line).toContain("流さず");
    expect(line).toContain("人に伝えるだけ");
    expect(line).toContain("片付けてから /orca-flow:new");
  });
});

describe("差分を見せてから入れる：docs/spec.md", () => {
  it("9.1 の「統合の前に人が決めるもの」の箇条に、直しの指示と同じ・もう一度聞く・流し直す", async () => {
    const ask =
      (await read("docs/spec.md"))
        .split("\n")
        .find((l) => l.startsWith("- 統合の前に人が決めるもの")) ?? "";
    expect(ask).toContain("直しの指示と同じに扱");
    expect(ask).toContain("もう一度聞く");
    expect(ask).toContain("流し直す");
  });

  it("10.1 の integrate の行に、差分・「人間に決めてほしいこと」の節だけ・片付けのコマンドがある", async () => {
    const row =
      (await read("docs/spec.md"))
        .split("\n")
        .find((l) => l.startsWith("| `/orca-flow:integrate ")) ?? "";
    expect(row).toContain("差分を見せて「入れる」と答えたものだけ");
    expect(row).toContain("決めてほしいこと」の節の項目だけ");
    expect(row).toContain("片付けのコマンド");
  });

  it("9.1 の「統合の前に人が決めるもの」の箇条に、「直す」で直ったものを除く但し書きと、light・off は review を呼ばないとある", async () => {
    const ask =
      (await read("docs/spec.md"))
        .split("\n")
        .find((l) => l.startsWith("- 統合の前に人が決めるもの")) ?? "";
    expect(ask).toContain("（「直す」で直ったものを除く）「人が選んだこと」");
    expect(ask).toContain(
      "`full` ならやり直しの形で流し、`light` と `off` は呼ばない",
    );
  });

  it("12章の7に、大事な共有のファイルは差分を見て選ぶとある", async () => {
    const line =
      (await read("docs/spec.md"))
        .split("\n")
        .find((l) => /^7\. \*\*統合\*\*/.test(l)) ?? "";
    expect(line).toContain("差分を見て");
  });
});
