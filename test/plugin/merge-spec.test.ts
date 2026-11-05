import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const loadSpec = () => readFile(path.join(ROOT, "docs/spec.md"), "utf8");

/** 「## 〈番号〉. 」の見出しから、次の「## 」の前までを返す */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("仕様書：マージ待ちと merge の分を15章から移した", () => {
  it("15章も小節（15.1〜15.9）もなく、merge の分は移した先にある", async () => {
    const text = await loadSpec();
    expect(text).not.toMatch(/^## 15\. /m);
    expect(text).not.toMatch(/^### 15\./m);
    expect(text).not.toContain("承認の門に足す");
    expect(text).not.toContain("7番に足す");
    expect(text).not.toContain("流れの末尾");
    // 15.6 の merge の分：8章の merge の節にある。15章の言い方（「足す」の指示）はない
    const c8 = chapter(text, 8);
    for (const word of [
      "merge 〈ID〉 --show",
      "merge 〈ID〉 --head",
      "**マージの前の確かめ**",
      "マージの呼び出しは `src/lib/github.ts` に置き、`merge` だけが呼ぶ",
    ]) {
      expect(c8, `8章に ${word} がありません`).toContain(word);
    }
    // 15.7 の merge の分：スキルの節は『PR の道』を持たず、merge を打たない文はスキルの表にある
    expect(text).not.toContain("『PR の道』");
    expect(text).not.toContain("merge を打たない");
    // 旧15.3 の merge-wait は4章、旧15.7 の /orca-flow:merge はスキルの表（10章）に移った
    expect(chapter(text, 4)).toContain("merge-wait");
    expect(chapter(text, 4)).toContain("マージ待ち → `integrated`");
    expect(chapter(text, 10)).toContain("/orca-flow:merge");
    expect(chapter(text, 10)).toMatch(/^- merge：打たない/m);
    // 15.9 の merge の2行は13章にある
    const c13 = chapter(text, 13);
    expect(c13).toContain("--match-head-commit");
    expect(c13).toContain("マージの方式");
    expect(text).not.toContain("『ブランチの保護』");
  });

  it("流れの図は2章、他人の文章の行は7章、指摘対応の行は12章、risk の行は6章にある", async () => {
    const text = await loadSpec();
    expect(chapter(text, 2)).toContain("merge 〈ID〉 --head 〈見せた先頭〉");
    expect(chapter(text, 6)).toMatch(/^\| risk /m);
    expect(chapter(text, 7)).toContain("他人の文章");
    expect(chapter(text, 8)).toContain("**Orca と git の呼び出し**");
    expect(chapter(text, 12)).toContain("指摘対応中");
  });

  it("1章：目的とレビュー・自己承認を範囲に入れないことと、マージは merge の1本", async () => {
    const c1 = chapter(await loadSpec(), 1);
    expect(c1).toMatch(/Orca の画面だけで回せるようにする/);
    expect(c1).toContain("他の人の PR のレビュー");
    expect(c1).toContain("自己承認と品質ゲート");
    expect(c1).toContain("GitHub の画面からマージしない");
    expect(c1).not.toMatch(/マージは人が GitHub で行う/);
  });

  it("2章・8章の push の行・10章の push のスキルは、マージは人が /orca-flow:merge で行うと書く", async () => {
    const text = await loadSpec();
    const c2 = chapter(text, 2);
    expect(c2).toContain("マージは人が `/orca-flow:merge` で行い");
    expect(c2).not.toMatch(/マージは人が GitHub で行/);
    const c10 = chapter(text, 10);
    const pushRow = c10
      .split("\n")
      .find((l) => l.startsWith("| `/orca-flow:push"));
    expect(pushRow).toContain("`/orca-flow:merge` で行い");
    expect(pushRow).not.toMatch(/マージは人が GitHub で行/);
    expect(chapter(text, 12)).not.toMatch(/マージは人が GitHub で行/);
  });

  it("4章：merge-wait の表と、状態の流れの末尾", async () => {
    const c4 = chapter(await loadSpec(), 4);
    expect(c4).toMatch(
      /^\s*\| merge-wait\s+\|[^\n]*in-review[^\n]*マージ待ち：PR #〈番号〉[^\n]*つける/m,
    );
    expect(c4).toContain("マージ待ち → `integrated`");
    expect(c4).toContain("後始末が失敗したら `cleanup-stopped`");
  });

  it("6章：依存の記録の置き場と中身、outbound.allow に merge を入れると設定の誤り", async () => {
    const c6 = chapter(await loadSpec(), 6);
    expect(c6).toContain("orca-flow/depends/〈ID〉.json");
    expect(c6).toMatch(/ID・依存の ID の並び・[^\n]*時刻/);
    expect(c6).toContain("intake の項目の依存もここで渡る");
    expect(c6).toMatch(/`allow` に `merge` を入れると設定の誤り/);
    expect(c6).toContain("`merge` を入れない");
  });

  it("7章：3番・4番・7番・承認の門に merge の分がある", async () => {
    const c7 = chapter(await loadSpec(), 7);
    expect(c7).toMatch(
      /3\. \*\*依存のあるタスクは同時に走らせない\*\*[^\n]*baseBranch に入るまで止まる/,
    );
    expect(c7).toMatch(
      /4\. \*\*統合は1つずつ\*\*[^\n]*orca-flow merge[^\n]*確かめてから入れる/,
    );
    expect(c7).toMatch(
      /7\. \*\*GitHub への書き込みは、送りの案を通る\*\*[^\n]*GitHub の画面からマージしない/,
    );
    expect(c7).toContain("引数の `--head` だけを");
  });

  it("8章：merge の行と、--show・--head・--drop-depend・確かめの表と終了コード", async () => {
    const c8 = chapter(await loadSpec(), 8);
    const row = c8.split("\n").find((l) => l.startsWith("| `merge 〈ID〉"));
    expect(row).toBeDefined();
    for (const w of ["--show", "--head", "--drop-depend"])
      expect(row).toContain(w);
    expect(c8).toContain("**マージの前の確かめ**");
    expect(c8).toMatch(
      /\| 依存[^\n]*\| 入っていない ID と抜け方を出す\s+\| 2\s+\|/,
    );
    expect(c8).toMatch(/\| 全員 OK[^\n]*\| 判定の理由を出す\s+\| 1\s+\|/);
    expect(c8).toMatch(
      /\| `--head` が PR の今の先頭と[^\n]*\| 違う先頭を出す\s+\| 1\s+\|/,
    );
    expect(c8).toMatch(/\| PR が開いていて[^\n]*\| 1\s+\|/);
    expect(c8).toContain("`--match-head-commit 〈先頭〉`");
    expect(c8).toContain("`cleanupMergedPr`");
    expect(c8).toContain("`reviewDecision` が空なので、全員 OK にしない");
    expect(c8).toMatch(
      /統括役の場所の確認[^\n]*`merge` は `--head`・`--drop-depend` で行い、`--show` は行わず/,
    );
    expect(c8).toContain("`merge-wait`");
    expect(c8).toContain("`outbound.window`・`interval` は当てない");
  });

  it("10章：/orca-flow:merge の行、PR の道の扱い、おまかせは merge を打たない", async () => {
    const c10 = chapter(await loadSpec(), 10);
    const row = c10
      .split("\n")
      .find((l) => l.startsWith("| `/orca-flow:merge"));
    expect(row).toBeDefined();
    expect(row).toContain("disable-model-invocation: true");
    expect(row).toContain("--show");
    expect(row).toContain("--head");
    expect(c10).toContain("**PR の道**のスキルの扱い");
    expect(c10).toMatch(
      /\(人が打った `\/orca-flow:merge` の手順を除く|（人が打った `\/orca-flow:merge` の手順を除く/,
    );
    expect(c10).toMatch(/^- merge：打たない/m);
  });

  it("12章：ブランチの保護と、マージ待ちのあとの手順、許可の ask に merge", async () => {
    const c12 = chapter(await loadSpec(), 12);
    expect(c12).toContain("**ブランチの保護**");
    expect(c12).toContain("必須レビュー・必須の CI・管理者も含める");
    expect(c12).toContain("保護の設定を代わりに行わない");
    expect(c12).toContain(
      "カードが「マージ待ち」になったら、統括役のタブで `/orca-flow:merge 〈ID〉`",
    );
    expect(c12).toContain("`send` と `merge` だけが許可の画面を出す");
    expect(c12).toContain(
      "`/orca-flow:send` と `/orca-flow:merge` の最初の実行で",
    );
  });

  it("13章：merge の2行（先頭の照らしとマージの方式）が移っている", async () => {
    const c13 = chapter(await loadSpec(), 13);
    expect(c13).toContain(
      "`gh pr merge` の先頭の照らし（`--match-head-commit`）",
    );
    expect(c13).toContain("マージの方式（merge・squash・rebase）");
  });

  it("merge のスキルが plugin にあり、仕様書の merge の入口と同じ名前を使う", async () => {
    const skill = await readFile(
      path.join(ROOT, "skills/merge/SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(/^name: merge$/m);
    expect(existsSync(path.join(ROOT, "src/lib/depends.ts"))).toBe(true);
  });

  it("outbound.allow に merge を入れると、仕様のとおり設定の誤りになる", () => {
    expect(() => parseConfig({ outbound: { allow: ["merge"] } })).toThrow(
      /outbound\.allow は/,
    );
    expect(parseConfig({}).outbound.allow).not.toContain("merge");
  });
});

describe("仕様書：merge の確かめの追加分（8章）", () => {
  it("--show の先頭の照らし・打ち直しの案内・依存先の後始末・スレッドの合計を読んでめくる決まり・壊れた記録・後始末が止まったときの終了コード2が書いてある", async () => {
    const c8 = chapter(await loadSpec(), 8);
    const at = c8.indexOf("**merge（マージ）**");
    expect(at).toBeGreaterThanOrEqual(0);
    const rest = c8.slice(at + 1);
    const next = rest.search(/^\*\*(?!マージの前の確かめ)/m);
    const text = c8.slice(at, next < 0 ? undefined : at + 1 + next);
    for (const word of [
      "`--show` でも外れとして出す",
      "git fetch origin 〈baseBranch〉",
      "/orca-flow:push 〈依存先〉",
      "スレッドの合計",
      "最大3回めくって数える（330件まで）",
      "数えきれないとして全員 OK にせず",
      "依存の記録（6章）が読めない",
      "`merged: true`",
    ]) {
      expect(text, `${word} がありません`).toContain(word);
    }
    expect(text).not.toContain("30件以上あるときも通らない");
    expect(text).toMatch(/どの止まり方でも[^。]*終了コード2/);
  });
});

describe("仕様書：見張りの2段目と見積もりのスレッドのめくり（8章）", () => {
  it("合計を読み、前があるときだけ解決の印をめくること・3回と330件・使った回数と点数に足すことが書いてある", async () => {
    const c8 = chapter(await loadSpec(), 8);
    for (const word of [
      "合計（`totalCount`）",
      "前があった PR だけ",
      "解決の印（`isResolved`）と `pageInfo` だけ",
      "1回の読みにつき3回まで",
      "330件まで",
      "めくった問い合わせも使った回数と点数に足す",
    ]) {
      expect(c8, `${word} がありません`).toContain(word);
    }
  });
});
