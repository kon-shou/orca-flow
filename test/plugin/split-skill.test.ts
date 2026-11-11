import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function between(text: string, from: string, to: string): string {
  const s = text.indexOf(from);
  expect(s, `${from} が見つかりません`).toBeGreaterThanOrEqual(0);
  const e = text.indexOf(to, s + from.length);
  expect(e, `${to} が見つかりません`).toBeGreaterThan(s);
  return text.slice(s, e);
}

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

const HEADING = "## 人に聞くとき";
const WHERE = "- このスキルで当たる所：";

function askSection(text: string): string {
  const s = text.indexOf(`\n${HEADING}\n`);
  const e = text.indexOf("\n## ", s + 1);
  return text.slice(s + 1, e);
}

function commonLines(text: string): string {
  return askSection(text)
    .split("\n")
    .filter((l) => !l.startsWith(WHERE))
    .join("\n")
    .trimEnd();
}

describe("split のスキル", () => {
  it("名前と、モデルから呼ばせない印がある", async () => {
    const text = await read("skills/split/SKILL.md");
    const head = text.slice(0, text.indexOf("\n---", 4));
    expect(head).toContain("name: split");
    expect(head).toContain("disable-model-invocation: true");
    expect(head).toContain('argument-hint: "[ID]"');
  });

  it("止まる4つの所が書かれている", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(text, [
      "「分ける案」",
      "in-review",
      "orca-flow/push/",
      "orca-flow/cross-depends/",
      "orca-flow/branch-push/",
      "`branch`",
    ]);
  });

  it("子の ID は親の ID の後ろに a から使われていない英字を足す", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(text, ["使われていない英字", "a から", "refs/orca-flow/split/"]);
  });

  it("参照を親の枝の先頭に付け、new で子を始める", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(text, [
      "git update-ref refs/orca-flow/split/",
      "orca-flow new",
      "--id",
      "--request-file",
    ]);
  });

  it("--depends は積むときだけ足す", async () => {
    const text = await read("skills/split/SKILL.md");
    const line = text.split("\n").find((l) => l.includes("--depends"));
    expect(line).toBeDefined();
    expect(line).toContain("積むときだけ");
    expect(line).toContain("並べるときは");
  });

  it("後続の探し方と足し方、親への知らせがある", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(text, [
      "orca-flow depends --on",
      "orca-flow depends",
      "--add",
      "orca-flow tell",
      "に分けました",
    ]);
  });

  it("後続の調べは参照を付ける前で、落ちたら何も作らず止まる", async () => {
    const text = await read("skills/split/SKILL.md");
    const steps = text.slice(text.indexOf("\n## 手順\n"));
    const dep = steps.indexOf("orca-flow depends --on");
    const ref = steps.indexOf("git update-ref refs/orca-flow/split/");
    expect(dep).toBeGreaterThan(0);
    expect(dep).toBeLessThan(ref);
    expect(between(steps, "\n5. ", "\n6. ")).toContain("何も作らず");
    expect(between(steps, "\n9. ", "\n10. ")).toContain("手順5で控えた");
  });

  it("統合待ちの一言も確かめる", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(between(text, "\n2. ", "\n3. "), [
      "一言が「統合待ち」で始まらない",
    ]);
  });

  it("取り出しは3点の差分を --3way で当てる", async () => {
    const text = await read("skills/split/SKILL.md");
    const step8 = between(text, "\n8. ", "\n9. ");
    expectAll(step8, [
      "〈baseBranch〉...refs/orca-flow/split/〈子の ID〉",
      "git diff --binary",
      "git apply --3way",
      "競合",
    ]);
    expect(step8).not.toMatch(/`git checkout refs\/orca-flow/);
  });

  it("new が落ちても子の worktree がなければ、聞かずに参照を消す", async () => {
    const text = await read("skills/split/SKILL.md");
    const step9 = between(text, "\n9. ", "\n10. ");
    expectAll(step9, [
      "git update-ref -d refs/orca-flow/split/〈子の ID〉",
      "子の worktree ができていなければ",
      "聞かずに片付ける",
      "'\\''",
    ]);
  });

  it("続けるか片付けるかは、子が active に出るときだけ聞き、推奨は続ける", async () => {
    const text = await read("skills/split/SKILL.md");
    const step9 = between(text, "\n9. ", "\n10. ");
    const ask = step9.split("\n").find((l) => l.includes("AskUserQuestion"));
    expect(ask).toBeDefined();
    expectAll(ask ?? "", [
      "`orca-flow active` に子が出る",
      "本文に",
      "「続ける（Recommended）」",
      "「片付けてやり直す」",
    ]);
    expect(step9).toContain("聞かずに片付ける");
  });

  it("続けるは参照を消さずに残し、depends --add と手順10・11・12へ進む", async () => {
    const text = await read("skills/split/SKILL.md");
    const line = between(text, "\n9. ", "\n10. ")
      .split("\n")
      .find((l) => l.includes("続ける："));
    expect(line).toBeDefined();
    expectAll(line ?? "", [
      "参照を消さずに残す",
      "`depends --add`",
      "手順10・11・12",
    ]);
  });

  it("片付けは、タスク長を止める知らせを待ち、参照と依頼のファイルを消し、手順3の確かめをする", async () => {
    const text = await read("skills/split/SKILL.md");
    const line = between(text, "\n9. ", "\n10. ")
      .split("\n")
      .find((l) => l.includes("片付ける：子のタスク長"));
    expect(line).toBeDefined();
    expectAll(line ?? "", [
      "Orca で止めてもらい",
      "知らせを文で待つ",
      "git update-ref -d refs/orca-flow/split/〈子の ID〉",
      "orca-flow/requests/〈子の ID〉.md",
      "手順3と同じ確かめ",
      "残ったものを人間に伝えて止まる",
    ]);
  });

  it("new のメッセージの流し直しを、split の流し直しに読み替える", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(between(text, "\n9. ", "\n10. "), [
      "/orca-flow:new を流す",
      "/orca-flow:split 〈親〉 を流し直す（同じ子の ID になる）",
    ]);
  });

  it("子のページは消すか使い回すかを人に任せる", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(between(text, "\n9. ", "\n10. "), ["子のページ", "使い回す"]);
  });

  it("tell が落ちたときの扱いと、外すまで親を統合しない伝えがある", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(between(text, "\n11. ", "\n12. "), [
      "終了コード2",
      "送れなかった文",
      "親のタブで伝えて",
    ]);
    expectAll(text.slice(text.indexOf("\n12. ")), ["親を統合しない"]);
  });

  it("依頼のファイルに書くものが挙がっている", async () => {
    const text = await read("skills/split/SKILL.md");
    expectAll(text, [
      "親の依頼",
      "移す分",
      "取り出し方",
      "並べ方",
      "親が baseBranch に入ってから run する",
    ]);
  });

  it("仕様のページの直し方の文書を読ませる", async () => {
    const text = await read("skills/split/SKILL.md");
    expect(text).toContain("${CLAUDE_PLUGIN_ROOT}/skills/split/spec-page.md");
  });

  it("人に聞くときの節が、ほかの人に聞くスキルと共通の文である", async () => {
    const text = await read("skills/split/SKILL.md");
    expect(text.split(`\n${HEADING}\n`)).toHaveLength(2);
    const at = text.indexOf(`\n${HEADING}\n`);
    const steps = text.indexOf("\n## 手順\n");
    expect(steps).toBeGreaterThan(at);
    expect(text.slice(at + 1, steps).match(/\n## /g)).toBeNull();
    const lines = askSection(text).split("\n");
    const where = lines.filter((l) => l.startsWith(WHERE));
    expect(where).toHaveLength(1);
    expectAll(where[0] ?? "", [
      "分けるか",
      "並べ方",
      "手順9",
      "続けるか片付けるか",
    ]);
    const other = await read("skills/spec/SKILL.md");
    expect(commonLines(text)).toBe(commonLines(other));
  });

  it("マージと送りのコマンドを書かない", async () => {
    for (const f of ["skills/split/SKILL.md", "skills/split/spec-page.md"]) {
      const text = await read(f);
      expect(text).not.toContain("orca-flow merge");
      expect(text).not.toContain("orca-flow send");
    }
  });
});

describe("split の仕様のページの直し方", () => {
  it("読む前に page-format を読ませる", async () => {
    const text = await read("skills/split/spec-page.md");
    expect(text).toContain("skills/intake/page-format.md");
  });

  it("番号の振り直し・ブランチの番号での置き方・状態の行がある", async () => {
    const text = await read("skills/split/spec-page.md");
    expectAll(text, [
      "振り直す",
      "待つもの",
      "入れる順",
      "つながりの行",
      "親のブランチと同じ待つもの",
      "「ブランチ〈親の番号〉」",
      "このページはブランチ〈番号〉",
      "開始済み 〈子の ID〉",
      "実装で変わったこと",
    ]);
    expect(text).not.toContain("ステップ");
    expect(text).not.toContain("小見出し");
  });

  it("前の形と書けないときの扱い、URL を書かない決まりがある", async () => {
    const text = await read("skills/split/spec-page.md");
    expectAll(text, [
      "前の形",
      "書き換えない",
      "会話に出して人に渡し",
      "分けるのは止めない",
      "Notion の URL と中身をリポジトリのファイルに書かない",
    ]);
  });

  it("子はブランチの番号で置き、振り直しは子の番号以上", async () => {
    const text = await read("skills/split/spec-page.md");
    expectAll(text, [
      "子を新しいブランチとして置く番号",
      "子の番号以上の、今あるブランチの番号を 1 ずつ後ろへ",
      "待つものの順に番号を通しで振り直す",
    ]);
    expect(text).not.toContain("親の次の番号");
  });

  it("「子のページを作る」は、前の形・印や ID が合わないときは作らず、「仕様」の URL を除いて人に渡す", async () => {
    const text = await read("skills/split/spec-page.md");
    const sec = between(text, "## 子のページを作る", "\n## ");
    expectAll(sec, [
      "「仕様のページを見つける」で次へ進めたときだけ作る",
      "このページはタスク〈番号〉",
      "前の形",
      "印や ID が合わない",
      "親が読めない",
      "作らず",
      "「仕様」の URL を除き",
      "会話に出して人に渡す",
    ]);
    expect(sec).not.toContain("ステップ");
  });

  it("手順7は、前の形のページでは子のページを作らず「仕様」の URL を除く", async () => {
    const text = await read("skills/split/SKILL.md");
    const l = text.split("\n").find((x) => x.startsWith("7. ")) ?? "";
    expectAll(l, [
      "spec-page.md",
      "前の形",
      "子のページを作らず",
      "「仕様」の URL を除く",
    ]);
    expect(l).not.toContain("ステップ");
    expect(l).toMatch(
      /前の形[^。]*子のページを作らず、子の依頼のファイルから「仕様」の URL を除く/,
    );
    expect(l).not.toContain("作れなければ同じく");
  });
});
