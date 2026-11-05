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

/** 先頭が prefix の行から、続く箇条書きの終わりまで（空行は箇条書きの前後だけ許す）。 */
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

function lineStarting(text: string, prefix: string): string {
  const line = text.split("\n").find((l) => l.startsWith(prefix));
  expect(line, `行が見つかりません：${prefix}`).toBeDefined();
  return line ?? "";
}

/** 見出しの次にある最初の表の区切りの行（`| --- |`）。 */
function separatorOf(sec: string, firstHeader: string): string {
  const lines = sec.split("\n");
  const head = lines.findIndex((l) => l.startsWith(firstHeader));
  expect(head, `表が見つかりません：${firstHeader}`).toBeGreaterThanOrEqual(0);
  return lines[head + 1] ?? "";
}

// 事前変更（120ff81）の docs/spec.md から測った長さ（keysSeparator は、キー名 autoOrderOnOverlap で1列目が1字広がったあとの長さ）。区切りの行は文字数、行は displayWidth（末尾の空白と縦線を除く）。
const BEFORE = {
  keysSeparator: 397,
  cliSeparator: 2958,
  cliIntegrateWidth: 2967,
  skillsSeparator: 4688,
  skillsRunWidth: 4706,
};

describe("統合後の確かめ：skills/integrate/SKILL.md", () => {
  it("手順3に、落ちた main で止まったときの扱いがある（verify のやり直しとは別）", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const step3 = section(text, /^## 手順/);
    const lines = step3.split("\n");
    const at = lines.findIndex((l) => /^ {3}- 2 で.*main の確かめが/.test(l));
    const block = lines.slice(at, at < 0 ? 0 : at + 4).join("\n");
    const line = at < 0 ? undefined : block;
    expect(line, "終了コード2の main の確かめの箇条").toBeDefined();
    expect(line).toContain("落ちています」が入る");
    expect(line).toContain("orca-flow: ");
    expect(line).toContain("git revert -m 1");
    expect(line).toContain("orca-flow main-check run");
    expect(line).toContain("--fixes-main");
    expect(line).toContain("/orca-flow:new");
    expect(line).toContain("AskUserQuestion");
    for (const choice of ["戻す", "直すタスクを作る", "今は決めない"]) {
      expect(line).toContain(`「${choice}」`);
    }
    expect(line).toContain("tell` は送らない");
  });

  it("手順5に、main の確かめを背景で始めたことと、知らせが確かめのあとに送られることがある", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const step5 = text.split("\n").find((l) => /^5\. /.test(l));
    expect(step5).toBeDefined();
    const idx = text.split("\n").findIndex((l) => /^5\. /.test(l));
    const body = text
      .split("\n")
      .slice(idx, idx + 6)
      .join("\n");
    expect(body).toContain("main の確かめ");
    expect(body).toContain("背景");
    expect(body).toContain("記録と同じ木");
    expect(body).not.toContain("確かめは起動しない");
    expect(body).toContain("確かめが通ってから送ります");
    expect(body).toContain("after-merge");
    expect(body).toContain("確かめのあと");
  });

  it("これまでの文（verify のやり直しの終了コード2）を消していない", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).toContain("標準エラーに `orca-flow verify` の文字が入る");
    expect(text).toContain("integrate-wait に戻ったら、もう一度");
  });
});

describe("統合後の確かめ：skills/run/SKILL.md", () => {
  it("知らせの節に「main の確かめが通りました」の扱いがある", async () => {
    const text = await read("skills/run/SKILL.md");
    const sec = section(text, /^## 統括役から知らせが来たら/);
    const line = blockStarting(
      sec,
      "- 「main に 〈ID〉 が入り、main の確かめが通りました」",
    );
    expect(line, "新しい知らせの箇条").toBeDefined();
    expect(line).toContain("git merge 〈baseBranch〉");
    expect(line).toContain("手順5");
    expect(line).toContain("何もしない");
    expect(line).toContain("verify");
    // 今の知らせの扱いは残す
    expect(sec).toContain("「main に 〈ID〉 が入りました」");
    expect(sec).toContain("取り込まない。担当が全員終わった区切りで");
  });
});

describe("統合後の確かめ：docs/spec.md", () => {
  it("6章の表に integrateVerify の行がある（既定 after-merge）", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 6\. /);
    const line = lineStarting(sec, "| integrateVerify");
    expect(line).toContain('"after-merge"');
    expect(line).toContain('"before-merge"');
  });

  it("8章の表に main-check の行がある（だれでも）", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 8\. /);
    const line = lineStarting(sec, "| `main-check [run]`");
    expect(line).toContain("だれでも");
    expect(line).toContain("--json");
  });

  it("8章に「マージのあとの main の確かめ」の段落があり、決まりが入っている", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 8\. /);
    const para = blockStarting(sec, "**マージのあとの main の確かめ**");
    for (const word of [
      "after-merge",
      "before-merge",
      "--fixes-main",
      "git revert -m 1",
      "orca-flow main-check run",
      "first-parent",
      "二分探索",
      "飛ばした",
      "setup.sh",
      "ロック",
      "worktree",
      "main-check/",
      "待ち",
      "確かめ中",
      "通った",
      "落ちた",
      "終了コード2",
    ]) {
      expect(para, word).toContain(word);
    }
    expect(para).toContain("verify` の文字を入れない");
    expect(para).toContain("」が入り（先頭に「orca-flow: 」がつき");
    expect(para).not.toContain("背景の確かめは起動しない");
    expect(para).toContain("必ず起動");
    expect(para).toContain("祖先のときだけ");
  });

  it("「main が進んだ知らせ」の段落に after-merge の文がある", async () => {
    const text = await read("docs/spec.md");
    const para = lineStarting(text, "**main が進んだ知らせ**");
    expect(para).toContain("after-merge");
    expect(para).toContain("main の確かめが通りました");
    expect(para).toContain("入りました");
    expect(para).toContain("送れませんでした");
  });

  it("10.1 の表の下に run の知らせの扱いがあり、integrate の行が落ちた main に触れる", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^### 10\.1 /);
    expect(sec).toContain("main の確かめが通りました");
    const integrate = lineStarting(sec, "| `/orca-flow:integrate");
    expect(integrate).toContain("main の確かめが");
    expect(integrate).toContain("git revert -m 1");
    expect(integrate).toContain("AskUserQuestion");
  });

  it("12章の7に、after-merge で待たずに入り、背景で確かめ、落ちれば次の統合で止まる", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 12\. /);
    const line = sec.split("\n").find((l) => /^7\. \*\*統合\*\*/.test(l));
    expect(line).toBeDefined();
    expect(line).toContain("after-merge");
    expect(line).toContain("背景");
    expect(line).toContain("main の確かめ");
    expect(line).toContain("次の統合で止まり");
  });
});

describe("統合後の確かめ：docs/spec.md の表の長さ（のびると表全体の幅がそろえ直される）", () => {
  it("8章の表：区切りの行と integrate の行が変更の前を超えない", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 8\. /);
    expect(separatorOf(sec, "| サブコマンド").length).toBe(BEFORE.cliSeparator);
    const row = lineStarting(sec, "| `integrate 〈ID〉");
    expect(displayWidth(row.replace(/[ |]+$/, ""))).toBeLessThanOrEqual(
      BEFORE.cliIntegrateWidth,
    );
    const mc = lineStarting(sec, "| `main-check [run]`");
    expect(displayWidth(mc.replace(/[ |]+$/, ""))).toBeLessThan(
      displayWidth(row.replace(/[ |]+$/, "")),
    );
  });

  it("10.1 の表：区切りの行と run の行が変更の前を超えない", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^### 10\.1 /);
    expect(separatorOf(sec, "| スキル").length).toBe(BEFORE.skillsSeparator);
    const run = lineStarting(sec, "| `/orca-flow:run");
    expect(displayWidth(run.replace(/[ |]+$/, ""))).toBeLessThanOrEqual(
      BEFORE.skillsRunWidth,
    );
    const integrate = lineStarting(sec, "| `/orca-flow:integrate");
    expect(displayWidth(integrate.replace(/[ |]+$/, ""))).toBeLessThanOrEqual(
      displayWidth(run.replace(/[ |]+$/, "")),
    );
  });

  it("6章の設定の表：区切りの行の長さが変わらず、integrateVerify の行がいちばん長くない", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^## 6\. /);
    expect(separatorOf(sec, "| キー").length).toBe(BEFORE.keysSeparator);
    const line = lineStarting(sec, "| integrateVerify");
    const others = sec
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| integrateVerify"))
      .filter((l) => /^\| [A-Za-z]+ +\|/.test(l));
    const width = (l: string): number => displayWidth(l.replace(/[ |]+$/, ""));
    expect(width(line)).toBeLessThan(Math.max(...others.map(width)));
  });
});

describe("統合後の確かめ（import）：integrate のスキルと仕様と import", () => {
  it("スキルは、verify のやり直しを送れなかったことを「verify のやり直しの知らせを送れませんでした」で見分ける", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).toContain(
      "「verify のやり直しの知らせを送れませんでした」が入っていたら",
    );
    expect(text).toContain("main が進んだ知らせを送れませんでした");
    // 統合待ちのタスクには 取り込みを勧めない
    expect(text).toContain("統合待ちのタスクなら何もしなくてよい");
  });

  it("スキルは、原因が分かっているときと分かっていないときで項目を分け、分かっていないときは戻すを出さない", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const lines = text.split("\n");
    const known = lines.findIndex((l) =>
      /^ {3}- 2 で、標準エラーに「main の確かめが 〈ID か件名〉 の時点/.test(l),
    );
    const unknown = lines.findIndex((l) =>
      /^ {3}- 2 で、標準エラーに「main の確かめが落ちています（…）」が入るが/.test(
        l,
      ),
    );
    expect(known).toBeGreaterThanOrEqual(0);
    expect(unknown).toBeGreaterThan(known);
    expect(lines[known]).toContain("git revert -m 1");
    expect(lines[known]).not.toContain("原因を二分探索で探している間");
    const block = lines[unknown]!;
    expect(block).toContain("「の時点」");
    expect(block).toContain("戻すコマンドを作らず、「戻す」も聞かない");
    expect(block).toContain("orca-flow main-check");
    expect(block).toContain("orca-flow main-check run");
    expect(block).toContain("「直すタスクを作る」「今は決めない」だけを聞き");
    for (const word of [
      "探している途中",
      "プロセスがもういません",
      "原因が分かりません",
    ])
      expect(block).toContain(word);
    // 戻すを条件なしで出す文を残していない
    expect(block).not.toContain("先頭のマージは原因ではない");
  });

  it("スキルに、終了コード0の「確かめられなかった」の警告の扱い（準備の失敗と環境の不調）がある", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).toContain("「警告：main の確かめができませんでした（…）」");
    expect(text).toContain("準備の失敗：…");
    expect(text).toContain("原因の1つ前も今の環境で落ちました");
    expect(text).not.toContain("準備が失敗しただけ");
  });

  it("仕様の10.1の integrate の行も同じ言葉で見分ける", async () => {
    const text = await read("docs/spec.md");
    const sec = section(text, /^### 10\.1 /);
    const integrate = lineStarting(sec, "| `/orca-flow:integrate");
    expect(integrate).toContain("verify のやり直しの知らせを送れませんでした");
    expect(integrate).toContain("の時点」と短いコミットが入るなら");
    expect(integrate).toContain("入らないなら");
    expect(integrate).toContain("確かめられなかった」の警告");
  });

  it("approve と verify は commands/integrate.ts を import しない", async () => {
    for (const file of ["approve", "verify"]) {
      const text = await read(`src/commands/${file}.ts`);
      expect(text, file).not.toMatch(/from "\.\/integrate\.ts"/);
      expect(text, file).not.toContain("commands/integrate.ts");
    }
  });

  it("落ちた main の短いコミットは、どのコマンドも shortCommit（8桁）を使う", async () => {
    for (const file of ["integrate", "main-check", "approve", "verify"]) {
      const text = await read(`src/commands/${file}.ts`);
      expect(text, file).not.toMatch(/slice\(0, [0-9]\)/);
    }
  });
});
