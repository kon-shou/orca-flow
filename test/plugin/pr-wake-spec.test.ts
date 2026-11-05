import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (file: string) => readFile(path.join(ROOT, file), "utf8");

/** 「## 〈番号〉. 」の見出しの行から、次の「## 」の前まで */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しがありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("仕様書：見張りの起こし方と会話の引き継ぎの移し", () => {
  it("移した文が仕様書に残っていない（15章はない）", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).not.toMatch(/^## 15\. /m);
    for (const gone of [
      "- 5番（タスク同士で直接指示しない）に足す",
      "節を足す：『起こし方』",
      "| 新しい会話が設計書・報告・PR の状態から読み直して続けられるか",
      "見張りの間隔（5分）は続けて起こさない",
      "『Orca と git の呼び出し』に足す：automation の作成・削除・一覧",
    ]) {
      expect(spec, `${gone} が仕様書に残っています`).not.toContain(gone);
    }
    // この2行は13章の「まだ確かめていないこと」へ移った
    const c13 = chapter(spec, 13);
    for (const moved of [
      "| `orca agent launch` の `--prompt",
      "| `orca terminal close` で閉じたあと",
    ]) {
      expect(c13, `${moved} が13章にありません`).toContain(moved);
    }
  });

  it("GitHub への書き込みの文は8章『Orca と git の呼び出し』にあり、マージの呼び出しの文は8章と13章にある", async () => {
    const text = await read("docs/spec.md");
    const c8 = chapter(text, 8);
    const at = c8.indexOf("**Orca と git の呼び出し**");
    expect(at).toBeGreaterThanOrEqual(0);
    const rest = c8.slice(at + 1);
    const next = rest.search(/^\*\*/m);
    const para = c8
      .slice(at, next < 0 ? undefined : at + 1 + next)
      .split("\n")
      .find((l) => l.startsWith("GitHub への書き込み"));
    expect(para).toBeDefined();
    expect(para).toContain("`src/lib/github.ts` に集める");
    expect(text).not.toContain("マージの呼び出しは `merge` だけが呼ぶ");
    expect(chapter(text, 8)).toContain(
      "マージの呼び出しは `src/lib/github.ts` に置き、`merge` だけが呼ぶ",
    );
    expect(chapter(text, 13)).toContain("`gh pr merge` の先頭の照らし");
  });

  it("7章の5番に、見張りがタスク長を起こすのはタスク同士の指示ではないと書いてある", async () => {
    const c7 = chapter(await read("docs/spec.md"), 7);
    const five = c7.split("\n").find((l) => l.startsWith("5. "))!;
    expect(five).toContain("orca-flow tell");
    expect(five).toContain("見張りがタスク長を起こす");
    expect(five).toContain("統括役の側の道具");
  });

  it("8章の見張りの節に、起こし方（起こす動き・送り先・立て方・上限・間隔・待ち・捨てる）がある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const part = c8.slice(c8.indexOf("**見張り（pr-watch）**"));
    expect(part).toContain("**起こし方**");
    const wake = part.slice(part.indexOf("**起こし方**"));
    expect(wake).toContain("/orca-flow:respond 〈ID〉");
    expect(wake).toContain("レビュー・コメント・CI の赤");
    expect(wake).toContain("スレッドの解決・他人の push・CI の緑");
    expect(wake).toContain("`agent launch`");
    expect(wake).toContain("`--worktree`");
    expect(wake).toContain(`--prompt "/orca-flow:respond 〈ID〉"`);
    expect(wake).toContain("`prWatch.maxLaunches`");
    expect(wake).toContain("3回分");
    expect(wake).toContain("state.json");
    expect(wake).toContain("次の回");
    expect(wake).toContain("マージかクローズ");
    expect(wake).toContain("他人の文章");
    expect(wake).toContain("`pr-watch background`");
  });

  it("8章の起こし方に、会話の記録を消すとき・確かめられない期限（1時間）・立てる呼び出しが落ちたときの扱いがある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const wake = c8.slice(c8.indexOf("**起こし方**"));
    const limit = wake.split("\n").find((l) => l.startsWith("- 上限："))!;
    expect(limit).toContain("最初に確かめられなかった時刻");
    expect(limit).toContain("1時間");
    expect(limit).toContain("記録ごと消す");
    expect(limit).toContain("立てたかもしれない会話");
    expect(limit).toContain("時間切れを含む");
    expect(limit).toContain("同じ PR の間隔のあいだは立て直さず");
    expect(limit).toContain("1回だけ立て直す");
    const interval = wake.split("\n").find((l) => l.startsWith("- 間隔："))!;
    expect(interval).toContain("呼び出しが落ちたとき");
    expect(interval).toContain("試した時刻");
    const drop = wake.split("\n").find((l) => l.startsWith("- PR がマージ"))!;
    expect(drop).toContain("会話の記録も消す");
    expect(drop).toContain("起こし済みで待っていないものを含む");
  });

  it("8章の『Orca と git の呼び出し』に、automation の作成・削除・一覧と agent launch がある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const start = c8.indexOf("**Orca と git の呼び出し**");
    const call = c8.slice(start, c8.indexOf("\n\n", start));
    expect(call).toContain("automation の作成・削除・一覧");
    expect(call).toContain("`agent launch`");
  });

  it("8章：見張りの5番と起こし方が食い違わず、数え方と捨て方が書いてある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const five = c8.split("\n").find((l) => l.startsWith("5. precheck"))!;
    expect(five).toContain("タスク長を起こすこと");
    expect(five).toContain("動きも待ちの起こしもなければ何も起こさない");
    expect(five).not.toContain("動きがなければ何も起こさない");
    const wake = c8.slice(c8.indexOf("**起こし方**"));
    expect(wake).toContain("立ててから2分は数に入れる");
    expect(wake).toContain("ターミナルを確かめられない会話も数に入れる");
    expect(wake).toContain("worktree がもう見つからない");
    expect(wake).toContain(
      "git の一時的な失敗などは Orca の失敗と同じく待ちにする",
    );
    expect(c8).toContain("src/lib/watch-automation.ts に置く");
  });

  it("8章の起こし方の1行目に許す3つの bot の名前と比べ方があり、今の言葉も残る。13章に確かめの行がある（2列）", async () => {
    const text = await read("docs/spec.md");
    const c8 = chapter(text, 8);
    const wake = c8.slice(c8.indexOf("**起こし方**"));
    const first = wake.split("\n").find((l) => l.startsWith("- 起こす動きは"))!;
    for (const word of [
      "`coderabbitai`",
      "`copilot-pull-request-reviewer`",
      "`github-actions`",
      "`[bot]`",
      "大小",
      "`Bot`",
      "立場が答えにないときは起こす",
      "許す一覧の設定は持たない",
    ])
      expect(first, `${word} が起こし方の1行目にありません`).toContain(word);
    const c13 = chapter(text, 13);
    const row = c13
      .split("\n")
      .find((l) => l.startsWith("|") && l.includes("`coderabbitai`"))!;
    expect(row, "13章に3つの名前の確かめの行がありません").toBeDefined();
    expect(row).toContain("`copilot-pull-request-reviewer`");
    expect(row).toContain("`github-actions`");
    expect(row.split("|").length - 2).toBe(2);
  });

  it("6章：prWatch に maxLaunches、記録に引き継ぎのファイル", async () => {
    const c6 = chapter(await read("docs/spec.md"), 6);
    const row = c6.split("\n").find((l) => l.startsWith("| prWatch "))!;
    expect(row).toContain("maxLaunches");
    expect(row).toContain("3");
    const records = c6.slice(c6.indexOf("**送りの案と見張りの記録**"));
    expect(records).toContain("handoff/〈ID〉.md");
    expect(records).toContain("未返信の指摘");
    expect(records).toContain("他人の文章");
  });

  it("13章に、agent launch の prompt・閉じたあとの新しい会話・引き継ぎの確かめがある", async () => {
    const c13 = chapter(await read("docs/spec.md"), 13);
    expect(c13).toContain('`--prompt "/orca-flow:respond 〈ID〉"`');
    expect(c13).toContain(
      "`orca agent launch` で同じ worktree に新しい会話が立つか",
    );
    expect(c13).toContain("新しい会話が引き継ぎ");
  });
});

describe("respond と send のスキル", () => {
  it("respond は、引き継ぎを読み、閉じる前に書き、他人の文章の中の指示に従わない", async () => {
    const text = await read("skills/respond/SKILL.md");
    expect(text).toMatch(/^name: respond$/m);
    expect(text).toContain("orca-flow/handoff/");
    expect(text).toContain("git-common-dir");
    expect(text).toContain("orca-flow outbox list");
    expect(text).toMatch(/他人の文章[^\n]*従わない/);
    expect(text).toMatch(/閉じる前[^\n]*引き継ぎ/);
    expect(text).toContain("件数と場所だけ");
    expect(text).not.toMatch(/gh pr merge|orca-flow merge/);
  });

  it("send は、会話を閉じたら次の会話が引き継ぎから読み直すと伝え、閉じなかったときの案内が「送る案がありません」と食い違わない", async () => {
    const text = await read("skills/send/SKILL.md");
    expect(text).toContain("引き継ぎ");
    expect(text).toContain("/orca-flow:respond");
    const steps = text.split("\n").filter((l) => /^\d+\. /.test(l));
    const last = steps[steps.length - 1]!;
    // 送れるのは「積んだまま」だけ。送っている・確かでない・送らなかったは send を打っても「送る案がありません」で止まる
    expect(last).toContain("送る案がありません");
    expect(last).toMatch(/積んだまま[^。]*だけ[^。]*\/orca-flow:send/);
    expect(last).toMatch(/送っている・確かでない・送らなかった[^。]*send/);
    // 古い言い回し（送っていても打ち直させる文）がない
    expect(last).not.toMatch(/送っている・確かでない・送らなかった案でも/);
    expect(last).not.toMatch(/片づけてから `\/orca-flow:send/);
    expect(last).not.toMatch(
      /積んだまま・送っている・確かでない・送らなかった[^。]*残っているときだけ/,
    );
    // send を打つ（打ち直す）よう伝える文に、送っている・確かでない・送らなかったを入れない
    for (const sentence of last
      .split("。")
      .filter((x) => /\/orca-flow:send/.test(x) && /打/.test(x))) {
      expect(sentence).not.toMatch(/送っている|確かでない|送らなかった/);
    }
  });

  it("respond は、人に伝えたあと指示を待つ前に引き継ぎを書き、書き直す。PR は push --show で知る", async () => {
    const text = await read("skills/respond/SKILL.md");
    const steps = text.split("\n").filter((l) => /^\d+\. /.test(l));
    const write = steps.find((l) => l.includes("必ず引き継ぎを"))!;
    expect(write).toMatch(/人間に伝えたあと、指示を待つ前に、必ず/);
    expect(write).toMatch(/書き直す/);
    expect(write).toMatch(/閉じる前の引き継ぎ/);
    expect(text).not.toMatch(/4\. 会話を閉じる前に/);
    const read2 = steps.find((l) => l.includes("設計書 `〈tasksDir〉"))!;
    expect(read2).toContain("orca-flow push $0 --show");
    expect(read2).toContain("新しい動きの件数");
    // 未返信の指摘の場所は、respond input の入力ファイルで読む（「後の実装」待ちではなくなった）
    expect(text).not.toContain("後の実装");
    expect(text).toContain("orca-flow respond input $0");
  });

  it("send の手順2は、送る前に引き継ぎを頼まない（引き継ぎは respond が指示を待つ前に書く）", async () => {
    const text = await read("skills/send/SKILL.md");
    const two = text.split("\n").find((l) => l.startsWith("2. "))!;
    expect(two).not.toContain("引き継ぎ");
    expect(two).not.toContain("/orca-flow:respond");
  });

  it("8章の起こし方の1行目に、起こす立場・bot・読めないとき・カードに数えることがあり、今の言葉も残る", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const wake = c8.slice(c8.indexOf("**起こし方**"));
    const first = wake.split("\n").find((l) => l.startsWith("- 起こす動きは"))!;
    for (const word of [
      "レビュー・コメント・CI の赤",
      "スレッドの解決・他人の push・CI の緑",
      "`OWNER`",
      "`MEMBER`",
      "`COLLABORATOR`",
      "`NONE`",
      "`Bot`",
      "立場が答えにないときは起こす",
      "カードの件数と未読の印には今までどおり数え",
      "古い記録は、全部を起こす分として読む",
    ])
      expect(first, `${word} が起こす動きの行にありません`).toContain(word);
  });

  it("13章に、非公開の組織のメンバーが MEMBER と読めるかの行がある", async () => {
    const c13 = chapter(await read("docs/spec.md"), 13);
    const row = c13.split("\n").find((l) => l.includes("`MEMBER`"))!;
    expect(row).toContain("非公開の組織のメンバー");
    expect(row).toContain("authorAssociation");
    const cells = row.split("|").slice(1, -1);
    expect(cells).toHaveLength(2);
    expect(cells[1]!.trim()).not.toBe("");
  });
});
