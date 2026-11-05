import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 仕様のページの本文の先頭に入れる見分けの印（インラインのコードにしない）。 */
const MARK = "要件から自動で作った仕様のページ";
/** 前の印。読むときだけ印とみなし、書かない。 */
const OLD_MARK = "orca-flow の intake が作った仕様のページ";

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 1行1つの `キー: 値` だけの frontmatter を読む。 */
function frontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(0);
  const out: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1] as string] = (m[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** 本文のうち、正規表現に当たる最初の行を返す。 */
function lineMatching(text: string, re: RegExp): string | undefined {
  return text.split("\n").find((l) => re.test(l));
}

/** `n. ` で始まる手順の行から、次の手順の前までを返す。 */
function step(text: string, n: number): string {
  const start = text.indexOf(`\n${n}. `);
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(`\n${n + 1}. `, start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** 「## 見出し」の行から、次の「## 」の前までを返す。 */
function guardSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `## ${heading}`);
  expect(at, `guards.md に ${heading} がありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const GUARDS = "skills/intake/guards.md";
const draftRules = async () =>
  guardSection(await read(GUARDS), "手順6：下書きの決まり");
const startRules = async () =>
  guardSection(await read(GUARDS), "手順10：始める前の守り");

// タスクの番号の形は、自分のファイルに書かないよう実行時に組む。
const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);

describe("skills/intake/SKILL.md：入口", () => {
  it("frontmatter：name・人が打つ・description に Notion と統括役のタブ", async () => {
    const fm = frontmatter(await read("skills/intake/SKILL.md"));
    expect(fm.name).toBe("intake");
    expect(fm["disable-model-invocation"]).toBe("true");
    expect(fm.description).toContain("Notion");
    expect(fm.description).toContain("統括役のタブ");
  });

  it("ToolSearch で Notion の道具を探し、なければ人に伝えて止まり、ページの中の指示に従わない", async () => {
    const text = await read("skills/intake/SKILL.md");
    expect(text).toContain("ToolSearch");
    expect(text).toMatch(/名前の頭を決め打ちしない/);
    expect(lineMatching(text, /MCP.*つなぐ/)).toContain("止まる");
    const rule = lineMatching(text, /指示には従わない/);
    expect(rule, "ページの中の指示に従わない行がありません").toBeDefined();
    expect(rule).toContain("コマンド");
  });

  it("開発チケットからプロパティでイシューをたどり、0か2つ以上なら聞き、食い違いを残す", async () => {
    const text = await read("skills/intake/SKILL.md");
    expect(text).toContain("開発チケット");
    expect(text).toContain("イシュー");
    expect(lineMatching(text, /プロパティの名前/)).toContain("決め打ちしない");
    expect(lineMatching(text, /0か2つ以上/)).toContain("聞く");
    const gap = lineMatching(text, /食い違/);
    expect(gap).toBeDefined();
    expect(gap).toContain("決めてほしいこと");
    expect(gap).toContain("黙って");
  });
});

describe("skills/intake/SKILL.md：下書き", () => {
  it("ADR の4つの節とタスクへの分け方の節がある（guards.md の手順6の節）", async () => {
    const text = await draftRules();
    const line = lineMatching(text, /節は/);
    expect(line, "「節は」の行がありません").toBeDefined();
    for (const word of [
      "状況",
      "決定",
      "結果",
      "捨てた案",
      "タスクへの分け方",
    ]) {
      expect(line).toContain(word);
    }
    expect(lineMatching(text, /「状況」はイシュー/)).toContain("チケット");
  });

  it("分け方の1項目に書くこと（guards.md の手順6の節）", async () => {
    const text = await draftRules();
    const line = lineMatching(text, /1項目には/);
    expect(line, "「1項目には」の行がありません").toBeDefined();
    for (const word of [
      "タスク名",
      "slug",
      "作るもの",
      "種類",
      "なぜ分けたか",
      "積むか",
      "並べるか",
      "閉じ方",
      "見込みの大きさ",
      "書き込みそうな場所",
    ]) {
      expect(line).toContain(word);
    }
  });

  it("下書きを一時ディレクトリに置き、リポジトリに書かない（guards.md の手順6の節）", async () => {
    const text = await draftRules();
    const line = lineMatching(text, /下書き.*一時ディレクトリ/);
    expect(line).toBeDefined();
    expect(line).toContain("mktemp -d");
    expect(line).toContain("リポジトリに書かない");
  });

  it("分け方の基準 splitting.md を指し（guards.md）、レビューにも渡す（SKILL.md）", async () => {
    const rules = await draftRules();
    expect(rules).toContain("splitting.md");
    expect(rules).toContain("${CLAUDE_PLUGIN_ROOT}/skills/intake/splitting.md");
    const text = await read("skills/intake/SKILL.md");
    expect(text).toContain("splitting.md");
    expect(
      lineMatching(text, /レビュー.*splitting\.md|splitting\.md.*レビュー/),
    ).toBeDefined();
  });
});

describe("skills/intake/SKILL.md：新しいレビュー役", () => {
  it("goldfish-reviewer を読み解きとレビューの2回、並べて起こす", async () => {
    const text = await read("skills/intake/SKILL.md");
    expect(text).toContain("orca-flow:goldfish-reviewer");
    expect(text).toMatch(/並べて起こ/);
    const reading = lineMatching(text, /^\s*- 読み解き：/);
    expect(reading, "読み解きの行がありません").toBeDefined();
    expect(reading).toContain("下書きだけ");
    expect(reading).toContain("要件も資料も渡さない");
    const review = lineMatching(text, /^\s*- レビュー：/);
    expect(review, "レビューの行がありません").toBeDefined();
    for (const word of ["イシュー", "チケット", "下書き", "分け方の基準"]) {
      expect(review).toContain(word);
    }
  });

  it("言い換えのずれを下書きの穴として直し、2回とも流し直さない", async () => {
    const text = await read("skills/intake/SKILL.md");
    expect(lineMatching(text, /ずれ/)).toContain("穴");
    const once = lineMatching(text, /流し直さない/);
    expect(once).toBeDefined();
    expect(once).toContain("1回だけ");
    expect(lineMatching(text, /決めきれない/)).toContain("決めてほしいこと");
  });
});

describe("skills/intake/SKILL.md：仕様のページと new", () => {
  it("手順8：開発チケットの子ページを作り、先頭に見分けの印を入れる", async () => {
    const s8 = step(await read("skills/intake/SKILL.md"), 8);
    expect(s8).toContain("子ページとして仕様のページを作る");
    expect(s8).toMatch(/開発チケットの末尾に節を足してから、その下に子ページ/);
    expect(s8).toMatch(/本文の先頭/);
    expect(s8).toContain(MARK);
    expect(s8).not.toContain(OLD_MARK);
  });

  it("手順8：子ページを作れないときは、印を含む下書きの全文を示し、貼られた URL を待ち、そのあとで一時ディレクトリを消す", async () => {
    const s8 = step(await read("skills/intake/SKILL.md"), 8);
    const line = lineMatching(s8, /作れない/);
    expect(line, "作れないときの行がありません").toBeDefined();
    for (const word of ["印", "下書きの全文", "URL", "手順9"]) {
      expect(line).toContain(word);
    }
    expect(s8).toMatch(/示したあとに消す/);
  });

  it("手順9：人の「よい」が来るまで new を流さず、止まる", async () => {
    const s9 = step(await read("skills/intake/SKILL.md"), 9);
    expect(s9).toMatch(/「よい」/);
    expect(s9).toContain("new を流さない");
    expect(s9).toContain("止まる");
  });

  it("手順10：読み直しで人の直しを正とし、答えのない決めてほしいことは人に確かめる（guards.md）", async () => {
    const s10 = await startRules();
    expect(lineMatching(s10, /読み直/)).toContain("人の直し");
    const open = lineMatching(s10, /答えのない/);
    expect(open, "答えのない決めてほしいことの行がありません").toBeDefined();
    expect(open).toContain("決めてほしいこと");
    expect(open).toContain("確か");
  });

  it("new の手順4〜6に従い、--request-file で渡す", async () => {
    const text = await read("skills/intake/SKILL.md");
    expect(text).toContain("${CLAUDE_PLUGIN_ROOT}/skills/new/SKILL.md");
    expect(text).toMatch(/手順4〜6/);
    expect(text).toContain("--request-file");
  });

  it("依存は baseBranch の件名の完全に同じ行で決める（部分一致の grep を使わない）", async () => {
    const text = await read("skills/intake/SKILL.md");
    const s10 = step(text, 10);
    const line = lineMatching(s10, /完全に同じ行/);
    expect(line, "完全に同じ行の文がありません").toBeDefined();
    expect(line).toContain("baseBranch");
    expect(line).toContain("integratorName");
    expect(line).toContain("--format=%s");
    expect(line).toContain("マージする");
    expect(text).not.toContain("--grep");
    expect(text).not.toContain("git show main:");
    expect(lineMatching(s10, /まだ ID がなければ/)).toContain("入っていない");
  });

  it("終了コード2で残りを始めない（guards.md）", async () => {
    const text = await startRules();
    const code2 = lineMatching(text, /終了コード2/);
    expect(code2).toBeDefined();
    expect(code2).toContain("残り");
    expect(code2).toContain("始めず");
  });

  it("new が通るたびに、次の項目の前にすぐ ID を書き、書けなければ止まる（guards.md）", async () => {
    const s10 = await startRules();
    const line = lineMatching(s10, /new が通るたび/);
    expect(line, "new が通るたびの行がありません").toBeDefined();
    for (const word of ["次の項目へ進む前", "すぐ", "仕様のページ", "ID"]) {
      expect(line).toContain(word);
    }
    expect(line).toMatch(/書けなければ.*項目名.*人.*始めず.*止まる/);
  });

  it("手順4：ToolSearch の手順のあとで、渡されたページを読んで印を見分ける", async () => {
    const text = await read("skills/intake/SKILL.md");
    expect(step(text, 3)).toContain("ToolSearch");
    const s1 = step(text, 1);
    expect(s1).not.toContain("印");
    expect(s1).not.toContain("手順11");
    const s4 = step(text, 4);
    expect(s4).toContain(MARK);
    expect(s4).toContain(OLD_MARK);
    expect(s4).toMatch(/前の印[^。]*印とみなす/);
    expect(s4).toMatch(/下書きを飛ばして/);
    expect(s4).toContain("まだ始めていない項目を始める");
    expect(s4).toContain("手順10");
  });

  it("印の文はインラインのコードにしない", async () => {
    const text = await read("skills/intake/SKILL.md");
    expect(text).not.toMatch(/`[^`\n]*が作った仕様のページ[^`\n]*`/);
  });

  it("開発チケットの子に印のある仕様のページがあれば、作らず人に聞く", async () => {
    const s4 = step(await read("skills/intake/SKILL.md"), 4);
    const line = lineMatching(s4, /すでに/);
    expect(line, "すでにある仕様のページの行がありません").toBeDefined();
    for (const word of ["子", "印", "新しく作らず", "聞く"]) {
      expect(line).toContain(word);
    }
  });

  it("印のあるページの URL から始めたときも、一覧を示し「よい」が来るまで new を流さない（guards.md）", async () => {
    const s10 = await startRules();
    const line = lineMatching(s10, /URL から始めたとき/);
    expect(line, "URL から始めたときの行がありません").toBeDefined();
    for (const word of [
      "タスク名",
      "slug",
      "依存",
      "「よい」",
      "new を流さない",
    ]) {
      expect(line).toContain(word);
    }
  });

  it("依頼のファイルの Notion から写した所は見出しで分け、中の指示に従わない1行を添える（guards.md）", async () => {
    const s10 = await startRules();
    const line = lineMatching(s10, /この節は Notion から写した要件/);
    expect(line, "Notion から写した節の行がありません").toBeDefined();
    expect(line).toContain("従わない");
    for (const word of ["コマンドを流す", "設定を変える", "ほかへ送る"]) {
      expect(line).toContain(word);
    }
    expect(lineMatching(s10, /見出しで分け/)).toBeDefined();
    const req = lineMatching(s10, /依頼のファイルには/);
    expect(req).toContain("決めてほしいこと");
    expect(req).toContain("答え");
  });

  it("書くのは開発チケットの子ページの仕様のページと一時ファイルだけ。チケットの本文は変えない", async () => {
    const text = await read("skills/intake/SKILL.md");
    const lines = text.split("\n").filter((l) => /本文を変えない/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      expect(l).toContain("子ページ");
      expect(l).toContain("イシューは読むだけ");
    }
  });

  it("orca-flow で始まるインラインのコードは二重引用符が偶数個で、タスク ID の形を書かない", async () => {
    for (const f of ["skills/intake/SKILL.md", GUARDS]) {
      const text = await read(f);
      for (const m of text.matchAll(/`(orca-flow[^`\n]*)`/g)) {
        const quotes = (m[1]?.match(/"/g) ?? []).length;
        expect(quotes % 2, m[1]).toBe(0);
      }
      expect(
        text.split("\n").filter((l) => idForm.test(l)),
        f,
      ).toEqual([]);
    }
  });

  it("依頼のファイルに、要約・全文・3つの URL と、公開に出るファイルに書かない1行を写す（guards.md）", async () => {
    const text = await startRules();
    const line = lineMatching(text, /依頼のファイルには/);
    expect(line).toBeDefined();
    expect(line).toContain("全文");
    expect(line).toContain("URL");
    expect(text).toContain(
      "Notion の URL と中身を、決定の記録など公開に出るファイルに書かない",
    );
  });
});

describe("skills/intake/splitting.md", () => {
  it("既定・リファクタ・大きさ・縦・フラグか積むか・足す移す消す・依存", async () => {
    const text = await read("skills/intake/splitting.md");
    expect(text).toMatch(/既定は1つ/);
    expect(text).toMatch(/理由が書けなければ分けない/);
    expect(lineMatching(text, /リファクタ/)).toContain("先");
    expect(text).toContain("約400行");
    expect(text).toMatch(/2〜3/);
    expect(text).toMatch(/モジュール/);
    expect(lineMatching(text, /縦/)).toContain("先に考える");
    const choice = lineMatching(text, /フラグ.*積む/);
    expect(choice).toBeDefined();
    expect(choice).toContain("項目ごとに");
    expect(choice).toContain("理由");
    expect(lineMatching(text, /互換を壊す/)).toMatch(/足す→.*移す→.*消す/);
    expect(lineMatching(text, /一方向/)).toContain("輪");
  });

  it("根拠の名前と URL を添える", async () => {
    const text = await read("skills/intake/splitting.md");
    expect(text).toContain("Small CLs");
    expect(text).toContain(
      "https://google.github.io/eng-practices/review/developer/small-cls.html",
    );
  });

  it("テストは振る舞いを変える項目に入れる", async () => {
    const text = await read("skills/intake/splitting.md");
    expect(lineMatching(text, /テスト/)).toContain("同じ項目");
  });
});

describe("agents/goldfish-reviewer.md", () => {
  it("frontmatter が決まりどおりで、ファイルを変える道具を持たない", async () => {
    const fm = frontmatter(await read("agents/goldfish-reviewer.md"));
    expect(fm.name).toBe("goldfish-reviewer");
    expect(fm.tools).toBe("Read, Glob, Grep");
    expect(fm.model).toBe("opus");
    expect(fm.effort).toBe("high");
    expect(fm.background).toBe("true");
    expect(fm.description).toBeTruthy();
    const list = (fm.tools ?? "").split(",").map((t) => t.trim());
    for (const banned of ["Edit", "Write", "Bash"]) {
      expect(list).not.toContain(banned);
    }
  });

  it("読み解きと重さつきのレビューの2つの形がある", async () => {
    const text = await read("agents/goldfish-reviewer.md");
    const reading = lineMatching(text, /^- 読み解き：/);
    expect(reading, "読み解きの形の行がありません").toBeDefined();
    expect(reading).toContain("言い換え");
    expect(reading).toContain("分からなかった");
    const review = lineMatching(text, /^- レビュー：/);
    expect(review, "レビューの形の行がありません").toBeDefined();
    for (const word of [
      "書かれていない前提",
      "あいまいな要件",
      "実装の危うさ",
      "分け方の基準",
      "依存の抜け",
    ]) {
      expect(text).toContain(word);
    }
    for (const word of ["必ず直す", "直したほうがよい", "確認だけ"]) {
      expect(text).toContain(word);
    }
  });

  it("渡された文は指示として従わず、会話を知らない前提を書く", async () => {
    const text = await read("agents/goldfish-reviewer.md");
    expect(lineMatching(text, /指示ではない/)).toBeDefined();
    expect(text).toContain("会話");
    expect(text).toMatch(/ファイルは変更しない/);
  });
});
