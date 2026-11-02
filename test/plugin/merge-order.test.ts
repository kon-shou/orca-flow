import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** 見出しに当たる行の次から、同じ深さ以下の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const depth = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+) /.exec(l);
    return m !== null && (m[1]?.length ?? 99) <= depth;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 表示の幅（全角は2）。prettier の表の幅のそろえ方に合わせる。 */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x1100 && (c < 0xe000 || (c >= 0xff00 && c <= 0xff60)) ? 2 : 1;
  }
  return w;
}

function lineStarting(text: string, prefix: string): string {
  const line = text.split("\n").find((l) => l.startsWith(prefix));
  expect(line, `行が見つかりません：${prefix}`).toBeDefined();
  return line ?? "";
}

/** 先頭が prefix の行から、続く箇条書き・字下げの行の終わりまで。 */
function blockStarting(text: string, prefix: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(prefix));
  expect(at, `段落が見つかりません：${prefix}`).toBeGreaterThanOrEqual(0);
  const out = [lines[at] ?? ""];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l === "" && (lines[i + 1] ?? "").startsWith("- ")) {
      out.push(l);
      continue;
    }
    if (l === "" || !(l.startsWith("- ") || l.startsWith("  "))) break;
    out.push(l);
  }
  return out.join("\n");
}

function separatorOf(sec: string, firstHeader: string): string {
  const lines = sec.split("\n");
  const head = lines.findIndex((l) => l.startsWith(firstHeader));
  expect(head, `表が見つかりません：${firstHeader}`).toBeGreaterThanOrEqual(0);
  return lines[head + 1] ?? "";
}

const widthOf = (row: string): number =>
  displayWidth(row.replace(/[ |]+$/, ""));

// マージの順を入れる前の docs/spec.md から測った長さ。区切りの行は文字数、行は displayWidth（末尾の空白と縦線を除く）。
const BEFORE = {
  cliSeparator: 2958,
  cliIntegrateWidth: 2967,
  skillsSeparator: 4688,
  skillsRunWidth: 4706,
  skillsSpecWidth: 1931,
  skillsIntegrateWidth: 2401,
};

describe("マージの順：skills/spec/SKILL.md", () => {
  it("同じ鎖の相手との重なりでは question で止まらず進み、設計書の重なりの節に順を書く", async () => {
    const text = await read("skills/spec/SKILL.md");
    const sec = section(text, /^## 手順/);
    const block = lineStarting(sec, "   - 標準エラーに「マージの順」");
    expect(block).toContain("同じ鎖");
    expect(block).toContain("終了コードは0");
    expect(block).toContain("止まらず");
    expect(block).toContain("作業中のほかのタスクとの重なり");
    expect(block).toContain("前か後");
    expect(block).toContain("とは書かない");
    expect(block).toContain("が入ってから run する");
    expect(block).toContain("番号の取り合い");
    expect(block).toContain("状態ストアの版");
  });

  it("「重なるので、マージの順に足しました」の警告が出て終了コード0なら、question で止まらず重なりの節に相手・場所・前後を1行書く", async () => {
    const text = await read("skills/spec/SKILL.md");
    const sec = section(text, /^## 手順/);
    const block = lineStarting(
      sec,
      "   - 標準エラーに「警告（マージの順）：重なるので",
    );
    expect(block).toContain("足しました");
    expect(block).toContain("終了コードは0");
    expect(block).toContain("止まらず");
    expect(block).toContain("作業中のほかのタスクとの重なり");
    expect(block).toContain("相手の ID・重なる場所・相手の前か後か");
    expect(block).toContain("統括役のタブで orca-flow order");
    expect(block).toContain("が入ってから run する");
  });

  it("question の箇条は、自動で決めきれなかったときに絞られている", async () => {
    const text = await read("skills/spec/SKILL.md");
    const sec = section(text, /^## 手順/);
    const block = lineStarting(sec, "   - 終了コード1で、足せなかった理由");
    expect(block).toContain("自動で決めきれなかった");
    expect(block).toContain("orca-flow status question --note");
    expect(block).toContain("autoOrderOnOverlap");
  });

  it("鎖にない相手との重なりは今までどおり question にし、順は統括役が決める", async () => {
    const text = await read("skills/spec/SKILL.md");
    const sec = section(text, /^## 手順/);
    expect(sec).toContain("orca-flow status question --note");
    expect(sec).toContain("orca-flow order");
    expect(sec).toContain("同じ鎖にいない");
  });

  it("統括役の「overlap を流し直して進めて」の知らせの扱いがある", async () => {
    const text = await read("skills/spec/SKILL.md");
    const sec = section(text, /^## 統括役から知らせが来たら/);
    expect(sec).toContain("overlap を流し直して進めて");
    expect(sec).toContain("orca-flow overlap");
    // これまでの知らせの扱いを消していない
    expect(sec).toContain("「main に 〈ID〉 が入りました」");
    expect(sec).toContain("spec-review に戻して");
  });
});

describe("マージの順：skills/run/SKILL.md", () => {
  it("「マージの順」の節に、rebase-review --done と rebase のたびの流し方がある", async () => {
    const text = await read("skills/run/SKILL.md");
    const sec = section(text, /^## マージの順/);
    expect(sec).toContain("orca-flow order");
    expect(sec).toContain("鎖");
    expect(sec).toContain("orca-flow rebase-review --done");
    expect(sec).toContain("報告を書く前");
    expect(sec).toContain("git rev-parse HEAD");
    expect(sec).toContain("orca-flow rebase-review 〈覚えた HEAD〉");
    expect(sec).toContain("終了コード0");
    expect(sec).toContain("終了コード1");
  });

  it("rebase-review が1なら review の見直しの形で検証役に確かめさせ、直して --done のあと verify", async () => {
    const text = await read("skills/run/SKILL.md");
    const sec = section(text, /^## マージの順/);
    expect(sec).toContain("/orca-flow:review $0 〈baseBranch〉...HEAD 見直し");
    expect(sec).toContain("検証役1つ");
    expect(sec).toContain("直させるもの");
    expect(sec).toContain("やり直しと同じ");
    expect(sec).toContain("orca-flow verify");
    expect(sec.indexOf("--done")).toBeLessThan(
      sec.lastIndexOf("orca-flow verify"),
    );
  });

  it("鎖を見直し、verify の rebase でも見直しを流し、off・light の扱いがある", async () => {
    const text = await read("skills/run/SKILL.md");
    const sec = section(text, /^## マージの順/);
    const again = lineStarting(sec, "- 鎖の見直し");
    expect(again).toContain("手順8の前");
    expect(again).toContain("知らせを受けたとき");
    expect(again).toContain("orca-flow order --json");
    const rb = lineStarting(sec, "- rebase のたび");
    expect(rb).toContain("orca-flow verify");
    expect(rb).toContain("verify の前にも HEAD を覚え");
    const light = lineStarting(sec, "- codeReview が `off`・`light`");
    expect(light).toContain("何も確かめず");
    expect(light).toContain("--done");
  });

  it("手順6から「マージの順」の節を指す", async () => {
    const text = await read("skills/run/SKILL.md");
    const steps = section(text, /^## 手順/);
    expect(steps).toContain("下の「マージの順」の節");
  });

  it("統合待ちで入ったのが前のタスクなら、after-merge でも自分で rebase し、見直しと verify をして integrate-wait に戻る", async () => {
    const text = await read("skills/run/SKILL.md");
    const sec = section(text, /^## 統括役から知らせが来たら/);
    const block = lineStarting(sec, "- 順にあるタスクの統合待ち");
    expect(block).toContain("前のタスク");
    expect(block).toContain("orca-flow order");
    expect(block).toContain("after-merge");
    expect(block).toContain("git rebase 〈baseBranch〉");
    expect(block).toContain("orca-flow rebase-review 〈覚えた HEAD〉");
    expect(block).toContain("orca-flow verify");
    expect(block).toContain("orca-flow status integrate-wait");
    expect(block).toContain("前のタスクでなければ");
  });

  it("integrate の「取り込み、見直して」の知らせの扱いがある", async () => {
    const text = await read("skills/run/SKILL.md");
    const sec = section(text, /^## 統括役から知らせが来たら/);
    expect(sec).toContain("を取り込み、見直して verify をやり直し");
    expect(sec).toContain("見直しの記録");
  });

  it("これまでの文（統合待ちで何もしない・rebase しない）を消していない", async () => {
    const text = await read("skills/run/SKILL.md");
    const sec = section(text, /^## 統括役から知らせが来たら/);
    expect(sec).toContain("rebase しない。担当が全員終わった区切りで");
    expect(sec).toContain("何もしない。rebase も `orca-flow verify` もしない");
  });
});

describe("マージの順：見直しの形の分かれ道と統合済みの ID", () => {
  it("review の手順1は、設定・ID・範囲の確かめのあとに見直しの形の節へ進み、off・light の扱いは見直しの節に1か所", async () => {
    const text = await read("skills/review/SKILL.md");
    const steps = section(text, /^## 手順/);
    // 設定の読み込みと形の確かめのあとで分かれる
    expect(steps).toContain(
      "見直しの形（$2）なら、上の「見直しの形」の節へ進む",
    );
    expect(steps.indexOf("見直しの形（$2）")).toBeLessThan(
      steps.indexOf("codeReview が `off` なら"),
    );
    const sec = section(text, /^## 見直しの形/);
    expect(sec).toContain("`off` か `light`");
    expect(sec).toContain("見直しの確かめはしない");
  });

  it("spec.md と approve に、統合済みの ID は作業中でなくてよく前に置く、がある", async () => {
    const spec = await read("docs/spec.md");
    expect(lineStarting(spec, "- order：")).toContain(
      "統合済みの ID は作業中でなくてよく、前に置く",
    );
    const approve = await read("skills/approve/SKILL.md");
    const sec = section(approve, /^## 重なりを自動で決めきれなかったとき/);
    expect(sec).toContain("統合済みの ID は作業中でなくてよく、前に置く");
    expect(sec).toContain("order T12,T14,T15");
  });

  it("spec.md の run の行は統合待ちなら待たずに rebase と書き、integrate の括弧は verify の文字を入れない", async () => {
    const spec = await read("docs/spec.md");
    expect(lineStarting(spec, "- run：順にあるタスクは")).toContain(
      "after-merge でも待たずに自分で rebase",
    );
    const integ = await read("skills/integrate/SKILL.md");
    expect(integ).toContain("`orca-flow verify` の文字は入らない");
    expect(integ).not.toContain("「verify をやり直して」は入らない");
  });
});

describe("マージの順：skills/approve/SKILL.md", () => {
  it("重なりを自動で決めきれなかったとき、順を決めて order を流し、tell で overlap の流し直しを送る", async () => {
    const text = await read("skills/approve/SKILL.md");
    const sec = section(text, /^## 重なりを自動で決めきれなかったとき/);
    expect(sec).toContain("orca-flow order 〈ID〉,〈ID〉");
    expect(sec).toContain("orca-flow tell");
    expect(sec).toContain("overlap を流し直して進めて");
    expect(sec).toContain("鎖");
    expect(sec).toContain("前のタスク");
    expect(sec).toContain("人間");
  });

  it("節の頭に、自動で足せたときは来ない・来るのは決めきれなかったときだと書く", async () => {
    const text = await read("skills/approve/SKILL.md");
    const sec = section(text, /^## 重なりを自動で決めきれなかったとき/);
    expect(sec).toContain("autoOrderOnOverlap");
    expect(sec).toContain("自動で足せたとき");
    expect(sec).toContain("決めきれなかったとき");
    expect(sec).toContain("orca-flow order");
    expect(sec).toContain("統括役のタブで orca-flow order");
  });
});

describe("マージの順：skills/integrate/SKILL.md", () => {
  it("終了コード2の「マージの順」の扱い（先にのときは人に伝える。それ以外は CLI が送り済み）", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const block = lineStarting(text, "   - 2 で、標準エラーに「マージの順」");
    expect(block).toContain("先に 〈ID〉");
    expect(block).toContain("--skip-order");
    expect(block).toContain("orca-flow order --remove");
    expect(block).toContain("tell` は送らない");
    expect(block).toContain("送り済み");
    expect(block).toContain("送れませんでした");
    // verify のやり直しの終了コード2とは別
    expect(
      block.replace("`orca-flow verify` の文字は入らない", ""),
    ).not.toContain("orca-flow verify");
    expect(block).not.toContain("main の確かめが");
  });

  it("--skip-order は人が頼んだときだけ使う", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const line = lineStarting(text, "   順の門を飛ばす逃げ道として");
    expect(line).toContain("`orca-flow integrate $0 --skip-order`");
    expect(line).toContain("人間が頼んだときだけ");
    expect(line).toContain("統合済みの印");
  });

  it("これまでの文（verify のやり直しの終了コード2）を消していない", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).toContain("標準エラーに `orca-flow verify` の文字が入る");
    expect(text).toContain("integrate-wait に戻ったら、もう一度");
  });
});

describe("マージの順：skills/review/SKILL.md", () => {
  it("見直しの形（3つ目の引数「見直し」）で、レビュー役を起動せず検証役1つに rebase-review の出力を渡す", async () => {
    const text = await read("skills/review/SKILL.md");
    expect(text).toContain("見直しの形");
    const sec = section(text, /^## 見直しの形/);
    expect(sec).toContain("レビュー役は起動せず");
    expect(sec).toContain("検証役1つ");
    expect(sec).toContain("orca-flow rebase-review");
    expect(sec).toContain("変わった所だけ");
    expect(sec).toContain("直させるもの");
  });

  it("引数の説明に「見直し」がある", async () => {
    const text = await read("skills/review/SKILL.md");
    expect(text).toMatch(/^argument-hint: .*見直し/m);
    expect(text).toContain("形：$2");
    expect(text).toContain("「見直し」のときは「見直しの形」");
  });

  it("これまでの形（最初の形・やり直しの形）を消していない", async () => {
    const text = await read("skills/review/SKILL.md");
    expect(text).toContain("「やり直し」のときだけ「やり直しの形」");
    expect(text).toContain("## 手順");
  });
});

describe("マージの順：docs/spec.md", () => {
  it("7章の3が、順を決めれば重なるタスクも並行にでき、--depends は進捗表に出すだけと書く", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 7\. /);
    const line = lineStarting(sec, "3. **");
    expect(line).toContain("マージの順");
    expect(line).toContain("orca-flow order");
    expect(line).toContain("--depends");
    expect(line).toContain("進捗表に書くだけ");
  });

  it("8章の表に order と rebase-review の行があり、integrate の行に --skip-order がある", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 8\. /);
    const order = lineStarting(sec, "| `order");
    expect(order).toContain("--remove");
    expect(order).toContain("--clear");
    expect(order).toContain("統括役");
    expect(order).toContain("--json");
    const rr = lineStarting(sec, "| `rebase-review");
    expect(rr).toContain("--done");
    expect(rr).toContain("タスク長");
    expect(rr).toContain("--json");
    const integrate = lineStarting(sec, "| `integrate 〈ID〉");
    expect(integrate).toContain("[--skip-order]");
  });

  it("8章に「マージの順」の段落があり、決まりが入っている", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 8\. /);
    const para = blockStarting(sec, "**マージの順**");
    for (const word of [
      "鎖",
      "T12 → T14 → T15",
      "merge-order.json",
      "reviewed/",
      "指紋",
      "タスク自身の変更",
      "先に 〈ID〉",
      "--skip-order",
      "order --remove",
      "rebase-review",
      "--done",
      "git merge-base",
      "終了コード2",
      "統合済み",
      "送れませんでした",
    ]) {
      expect(para, word).toContain(word);
    }
    expect(para).toContain("orca-flow verify` の文字を入れない");
    expect(para).toContain("メインの作業ツリー");
  });

  it("9.2 の3つ目が、同じ鎖の相手との重なりは警告に下げると書く", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^### 9\.2 /);
    const line = lineStarting(sec, "3. ");
    expect(line).toContain("作業中のほかのタスク");
    expect(line).toContain("同じ鎖");
    expect(line).toContain("マージの順");
    expect(line).toContain("警告");
  });

  it("10.1 の表の下に spec・run・approve・integrate・review の順の扱いがある", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^### 10\.1 /);
    const para = blockStarting(sec, "**マージの順**");
    for (const word of [
      "spec",
      "run",
      "approve",
      "integrate",
      "review",
      "orca-flow order",
      "rebase-review --done",
      "overlap を流し直して進めて",
      "見直しの形",
      "--skip-order",
      "前のタスク",
    ]) {
      expect(para, word).toContain(word);
    }
  });

  it("6章の表に autoOrderOnOverlap の行があり、いちばん長い行より短い", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 6\. /);
    const row = lineStarting(sec, "| autoOrderOnOverlap");
    expect(row).toContain("`true`");
    expect(row).toContain("マージの順");
    const rows = sec.split("\n").filter((l) => l.startsWith("| "));
    expect(widthOf(row)).toBeLessThan(Math.max(...rows.map(widthOf)));
  });

  it("8章『マージの順』に、overlap の自動の足し・書ける範囲・ロック・自動の印・未読の印がある", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 8\. /);
    const para = blockStarting(sec, "**マージの順**");
    for (const word of [
      "autoOrderOnOverlap",
      "新しい鎖",
      "最後に自分を足す",
      "警告（マージの順）：重なるので、マージの順に足しました",
      "順を変えるときは統括役のタブで orca-flow order",
      "足せなかった理由",
      "worktree から書けるのは overlap の足すだけ",
      "merge-order.lock",
      "生きていない",
      "自動で足した",
      "マージの順：",
      "人が見た印",
      "未読の印だけ",
      "comment と状態は変えない",
      "overlap が足すときだけ作る",
    ]) {
      expect(para, word).toContain(word);
    }
    expect(para).not.toContain("ファイルがなければ作らず、");
  });

  it("8章『マージの順』に、--json の項目名とロックの抜け方・足す前の確かめがある", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 8\. /);
    const para = blockStarting(sec, "**マージの順**");
    for (const word of [
      "autoOrder",
      "added",
      "chain",
      "reason",
      "order",
      "auto",
      "ロックのファイルを消してやり直す",
      "ID の形と、ID が作業中のタスクであることを確かめて",
      "自分を足すことだけ",
    ]) {
      expect(para, word).toContain(word);
    }
    expect(para).toContain("`active --json`");
    expect(para).toContain("orderWarnings");
  });

  it("9.2 の3つ目に、鎖にない相手との重なりは自動で足し、決めきれないときだけ一覧を出して終了コード1と書く", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^### 9\.2 /);
    const line = lineStarting(sec, "3. ");
    expect(line).toContain("autoOrderOnOverlap");
    expect(line).toContain("自動で");
    expect(line).toContain("決めきれない");
    expect(line).toContain("終了コード1");
  });

  it("10.1 の spec・approve の箇条が、自動で決めきれないときだけ止まると書く", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^### 10\.1 /);
    const para = blockStarting(sec, "**マージの順**");
    const spec = lineStarting(para, "- spec：");
    expect(spec).toContain("足しました");
    expect(spec).toContain("決めきれない");
    const approve = lineStarting(para, "- approve：");
    expect(approve).toContain("決めきれなかった");
    expect(approve).toContain("orca-flow order");
  });

  it("12章の手順5が、重なりは自動で順に足され、決めきれないときだけ質問になると書く", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 12\. /);
    const line = lineStarting(sec, "5. **実行中**");
    expect(line).toContain("自動で");
    expect(line).toContain("決めきれ");
    expect(line).toContain("orca-flow order 〈ID〉,〈ID〉,…");
  });

  it("13章に、メインのカードに未読の印だけをつけられるかがある", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 13\. /);
    expect(sec).toContain("メインのカードに未読の印だけをつけられるか");
  });

  it("12章に、重なるタスクを順で並行に進める使い方がある", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 12\. /);
    expect(sec).toContain("orca-flow order");
    expect(sec).toContain("マージの順");
    expect(sec).toContain("先に");
    expect(sec).toContain("--skip-order");
  });

  it("例の ID は作り物（T と数）で、このリポジトリのタスクの番号と個人のパスを書いていない", async () => {
    for (const rel of [
      "docs/spec.md",
      "skills/spec/SKILL.md",
      "skills/run/SKILL.md",
      "skills/approve/SKILL.md",
      "skills/integrate/SKILL.md",
      "skills/review/SKILL.md",
    ]) {
      const text = await read(rel);
      expect(text, rel).not.toMatch(/\/Users\/[A-Za-z0-9._-]+/);
      expect(text, rel).not.toMatch(/\bP\d+\b/);
    }
  });
});

describe("マージの順：docs/spec.md の表の長さ（のびると表全体の幅がそろえ直される）", () => {
  it("8章の表：区切りの行と integrate の行が変更の前を超えない", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 8\. /);
    expect(separatorOf(sec, "| サブコマンド").length).toBe(BEFORE.cliSeparator);
    const row = lineStarting(sec, "| `integrate 〈ID〉");
    expect(widthOf(row)).toBeLessThanOrEqual(BEFORE.cliIntegrateWidth);
    // 新しい行は、いちばん長い行より長くしない
    const rows = sec.split("\n").filter((l) => l.startsWith("| `"));
    const longest = Math.max(...rows.map(widthOf));
    for (const prefix of ["| `order", "| `rebase-review"]) {
      expect(widthOf(lineStarting(sec, prefix))).toBeLessThan(longest);
    }
  });

  it("10.1 の表：区切りの行と run・spec・integrate の行が変更の前を超えない", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^### 10\.1 /);
    expect(separatorOf(sec, "| スキル").length).toBe(BEFORE.skillsSeparator);
    expect(widthOf(lineStarting(sec, "| `/orca-flow:run"))).toBeLessThanOrEqual(
      BEFORE.skillsRunWidth,
    );
    expect(
      widthOf(lineStarting(sec, "| `/orca-flow:spec")),
    ).toBeLessThanOrEqual(BEFORE.skillsSpecWidth);
    expect(
      widthOf(lineStarting(sec, "| `/orca-flow:integrate")),
    ).toBeLessThanOrEqual(BEFORE.skillsIntegrateWidth);
  });
});
