import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function loadSpec(): Promise<string> {
  return readFile(path.join(ROOT, "docs/spec.md"), "utf8");
}

/** 「## 〈番号〉. 」の見出しの行から、次の「## 」の前までを返す。 */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("PR を出すときの承認：15章から移した部分", () => {
  it("移した行が仕様書に残っていない", async () => {
    const spec = await loadSpec();
    for (const gone of [
      "- 「リモートへの push と PR の作成は人間が行う」を直す",
      '- `taskEnd` が `"integrate"` のリポジトリの動きは変えない。',
      "- 待つ間、タスク長の会話は閉じ",
      "- PR を出したとき、`orca worktree set --pr 〈番号〉` でカードと PR を結ぶ。",
      '- `prReady` の `"after-ci"` に足す：',
      '- `taskEnd` を `"pr"` にしても、作業中のタスクは',
      "| `taskEnd` |",
      "- `push 〈ID〉`（今の行を直す）",
      "- `send` が送り終えたあと、閉じる前に",
      "- `/orca-flow:push 〈ID〉`（今の行を直す）",
      "- `/orca-flow:integrate` に足す：",
      "- 統合待ちになったら、`/orca-flow:integrate` の代わりに",
      "統合待ち（一言に「次は push」）",
    ]) {
      expect(spec, `${gone} が仕様書に残っています`).not.toContain(gone);
    }
    // この2行は13章の「まだ確かめていないこと」へ移った
    const c13 = chapter(spec, 13);
    for (const moved of [
      "| `orca worktree set --pr` がカードにどう出るか",
      "| 閉じたタスク長の会話に、人が戻ってきたいとき",
    ]) {
      expect(c13, `${moved} が13章にありません`).toContain(moved);
    }
  });

  it("automation がないと案内する文は、15章から1章と8章へ移った（taskEnd によらない）", async () => {
    const text = await loadSpec();
    expect(text).not.toContain("automation を作る道は、まだ決めていない");
    const ch1 = chapter(text, 1);
    expect(ch1).toContain("見張りの automation がない");
    expect(ch1).toContain("`orca-flow pr-watch install`");
    expect(ch1).toContain("`taskEnd` によらず");
    const row = chapter(text, 8)
      .split("\n")
      .find((l) => l.startsWith("| `push 〈ID〉"));
    expect(row).toContain(
      "見張りの automation がなければ（`taskEnd` によらず）",
    );
  });

  it("送ったあとの流れの図は2章にあり、push の最初の段は図に重ならず1つだけ", async () => {
    const c2 = chapter(await loadSpec(), 2);
    // push の図は1つだけ（送ったあとの図に、push の最初の段を重ねない）
    expect(
      c2.split("/orca-flow:push 〈ID〉 ──→ integrate と同じ確かめ"),
    ).toHaveLength(2);
    expect(c2).toContain("5分おき：1段目の問い合わせ");
    expect(c2).toContain("/orca-flow:respond 〈ID〉");
    expect(c2).toContain("merge 〈ID〉 --head 〈見せた先頭〉");
  });
});

describe("PR を出すときの承認：移し先", () => {
  it("1章：承認した案だけを送る・integrate の動きは変えない", async () => {
    const c1 = chapter(await loadSpec(), 1);
    expect(c1).toMatch(/\/orca-flow:send[^\n]*承認した案だけ/);
    expect(c1).toContain(
      "承認なしには、同僚に見える書き込みをしない（例外は7章7番）",
    );
    expect(c1).not.toContain("承認なしには GitHub に書かない");
    expect(c1).toMatch(/`taskEnd` が `"integrate"`[^\n]*動きは変えない/);
  });

  it("2章：統合待ちから push・send・会話を閉じるまでの流れ", async () => {
    const c2 = chapter(await loadSpec(), 2);
    expect(c2).toContain("/orca-flow:push 〈ID〉");
    expect(c2).toContain("送る前の確認待ち");
    expect(c2).toContain("worktree set --pr");
    expect(c2).toContain("send 〈ID〉 --expect");
    expect(c2).toMatch(/タスク長の会話[^\n]*閉じ/);
    expect(c2).toContain("/orca-flow:new");
  });

  it("4章：set --pr・送る前の確認待ちと CI 待ちを付ける道", async () => {
    const c4 = chapter(await loadSpec(), 4);
    expect(c4).toContain("orca worktree set --pr 〈番号〉");
    expect(c4).not.toContain("見張りがこの流れを進める道はまだ動かない");
    expect(c4).toMatch(
      /送る前の確認待ちは push と outbox が付け、CI 待ちは send が付ける/,
    );
  });

  it("6章：taskEnd の行・作業中のタスクの扱い・prReady は読み飛ばす", async () => {
    const c6 = chapter(await loadSpec(), 6);
    expect(c6).toMatch(/^\| taskEnd\s+\| `"integrate"`/m);
    expect(c6).toContain("作業中のタスクは今までの終わり方のまま進められる");
    const row = c6.split("\n").find((l) => l.startsWith("| prReady")) ?? "";
    expect(row).toContain("書いてあっても読み飛ばし、設定の誤りにしない");
    expect(c6).not.toContain('prReady が `"after-ci"` のとき');
    expect(c6).not.toContain("先頭が承認のときと同じ");
    expect(c6).toContain("`--after-ci` はなくなり");
  });

  it("7章の7番：push も案を積む・push の直接書きの行がない", async () => {
    const c7 = chapter(await loadSpec(), 7);
    expect(c7).toContain(
      "案は `orca-flow outbox add` と `orca-flow push` が積み",
    );
    expect(c7).not.toContain("まだ案を通さず直接書く");
    expect(c7).not.toContain("`markPrReady`）は");
  });

  it("8章：push の行と節が、積んで見せる形になっている", async () => {
    const c8 = chapter(await loadSpec(), 8);
    const row = c8.split("\n").find((l) => l.startsWith("| `push 〈ID〉"));
    expect(row).toBeDefined();
    expect(row).toContain("案を積み");
    expect(row).toContain("送る前の確認待ち");
    expect(row).toContain("GitHub に書くのは人が承認した `send` だけ");
    expect(row).not.toContain("下書きの PR を出す。");
    const pushPart = c8.slice(
      c8.indexOf("**push（PR の道）**"),
      c8.indexOf("**おまかせ**"),
    );
    expect(pushPart).toContain("期待値");
    expect(pushPart).toContain("積むときに決め");
    expect(pushPart).not.toContain("push 〈ID〉 --watch。人は打たない");
    expect(pushPart).toContain(
      "send は送り終えたあとに背景の待ち受けを起こさない",
    );
  });

  it("8章：outbox と send に、期待値・本文の確かめ・送り終えたあとの処理・閉じる条件がある", async () => {
    const c8 = chapter(await loadSpec(), 8);
    const part = c8.slice(
      c8.indexOf("**outbox と send**"),
      c8.indexOf("**init の許可の案内**"),
    );
    expect(part).not.toContain("後の実装");
    expect(part).toContain("--force-with-lease");
    expect(part).toContain("期待値");
    expect(part).toMatch(/案と指紋と `show` に入れ/);
    expect(part).toMatch(/pr-create[^\n]*手元のパス[^\n]*終了コード1/);
    expect(part).toContain("送る前の確認待ち：〈案の種類と版〉");
    expect(part).toContain("`pushedHead`");
    expect(part).toContain("orca worktree set --pr");
    expect(part).toContain("CI 待ち");
    expect(part).toContain("orca terminal close --terminal 〈ハンドル〉");
    expect(part).toContain("`--tab`・`--all` はつけず");
    // 閉じる条件の「積んだまま」に数えるものと数えないもの
    expect(part).toMatch(/積んだ・送っている・確かでない・送らなかった/);
    expect(part).toMatch(/承認済み・CI 待ち・送った・取り下げた[^\n]*数えない/);
    // 見張りは下書きを外さない。承認済み・CI 待ちは古い記録で、何も送らない
    expect(part).toMatch(
      /「承認済み・CI 待ち」の古い案は、send も見張りも送らず、一覧と表示で読め、取り下げられる/,
    );
    expect(part).not.toContain(
      "見張り（8章『見張り（pr-watch）』）が、承認済み・CI 待ちの `pr-ready` を",
    );
    expect(part).toMatch(/`gh pr ready` を呼ばず送ったとして終え/);
    expect(part).toContain("送った記録は、後の案が落ちても書く");
  });

  it("8章：taskEnd が pr のときの統合待ちの一言", async () => {
    const c8 = chapter(await loadSpec(), 8);
    expect(c8).toMatch(/統合待ち[^\n]*push を勧める/);
  });

  it("10.1：push は送らない・send の最後に閉じた結果・integrate は taskEnd で勧める", async () => {
    const c10 = chapter(await loadSpec(), 10);
    const rows = c10.split("\n");
    const push = rows.find((l) => l.startsWith("| `/orca-flow:push 〈ID〉`"));
    expect(push).toBeDefined();
    expect(push).toContain("送らない");
    const send = rows.find((l) => l.startsWith("| `/orca-flow:send 〈ID〉`"));
    expect(send).toContain("会話を閉じたか");
    const integrate = rows.find((l) =>
      l.startsWith("| `/orca-flow:integrate 〈ID〉`"),
    );
    // 勧めはマージのあと（⑤）ではなく、流す前の段落にある。
    expect(integrate).not.toContain("/orca-flow:push");
    expect(c10).toMatch(
      /\*\*integrate と push の勧め\*\*：`taskEnd` が `"pr"`[^\n]*\/orca-flow:push/,
    );
  });

  it("12章：毎回の push の項・PR で統合する道", async () => {
    const c12 = chapter(await loadSpec(), 12);
    expect(c12).toMatch(
      /^10\. \*\*PR で出すタスクの送り\*\*[^\n]*送る前の確認待ち/m,
    );
    expect(c12).toContain(
      "`/orca-flow:integrate` の代わりに `/orca-flow:push 〈ID〉`",
    );
    const way = c12
      .split("\n")
      .find((l) => l.startsWith("**PR で統合する道**"));
    expect(way).toBeDefined();
    expect(way).toContain("送らない");
    expect(way).toContain("/orca-flow:send");
    expect(way).not.toContain(
      "タスクのブランチが push され、下書きの PR が出る",
    );
  });

  it("13章：set --pr・閉じる・戻るの確かめの行（terminal close の行も13章へ移した）", async () => {
    const c13 = chapter(await loadSpec(), 13);
    expect(c13).toContain("orca worktree set --pr");
    expect(c13).toContain("閉じたタスク長の会話");
    expect(c13).toContain("orca terminal close");
    const text = await loadSpec();
    expect(text).not.toMatch(/^## 15\. /m);
  });
});

describe("integrate のスキル：taskEnd が pr のとき、流す前に push を勧める", () => {
  it("手順1の直後で taskEnd を見て勧め、手順5は main の形に戻る", async () => {
    const text = await readFile(
      path.join(ROOT, "skills/integrate/SKILL.md"),
      "utf8",
    );
    const lines = text.split("\n");
    const at = lines.findIndex((l) =>
      l.startsWith("1. `orca-flow config --json`"),
    );
    const advice = lines[at + 1] ?? "";
    expect(advice).toContain('`taskEnd` が `"pr"`');
    expect(advice).toContain("`/orca-flow:push $0`");
    expect(advice).toContain("integrate を続ける");
    expect(advice).toContain("`orca-flow integrate` を流す前");
    const last = lines.find((l) => l.startsWith("5. 人間に次を伝える"));
    expect(last).toBeDefined();
    expect(last).toContain("push はあなたが行ってください");
    expect(last).not.toContain("taskEnd");
    expect(last).not.toContain("/orca-flow:push");
  });

  it("spec の integrate の行：勧めは流す前、⑤は人の push", async () => {
    const text = await loadSpec();
    const row = text
      .split("\n")
      .find((l) => l.startsWith("| `/orca-flow:integrate 〈ID〉`"));
    expect(row).toBeDefined();
    expect(row).toContain("人の push を添える");
    expect(row).not.toContain("ほかは人の push を添える");
    const para = text
      .split("\n")
      .find((l) => l.startsWith("**integrate と push の勧め**"));
    expect(para).toBeDefined();
    expect(para).toContain("`orca-flow integrate` を流す前");
    expect(para).toContain("マージのあと（⑤）では勧めない");
  });

  it("push・send・gh の書き込みを新しく流さない", async () => {
    const text = await readFile(
      path.join(ROOT, "skills/integrate/SKILL.md"),
      "utf8",
    );
    expect(text).not.toMatch(/orca-flow (push|send)\s/);
    expect(text).not.toMatch(/gh pr (create|merge)|git push/);
  });
});
