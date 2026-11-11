import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 見出しの行から、同じ高さ以上の次の見出しの前までを返す */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i] ?? "");
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** 全角（幅広）の文字を2、それ以外を1と数えた見た目の幅 */
function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

describe("Notion の要件から始める：docs/spec.md", () => {
  it("1章の push と PR の項に、分け方は書くが PR は出さないと添えてある", async () => {
    const ch1 = section(await read("docs/spec.md"), /^## 1\. /);
    const line = ch1.split("\n").find((l) => l.includes("push と PR")) ?? "";
    expect(line).toContain("人間が行う");
    expect(line).toContain("分け方");
    expect(line).toContain("PR は出さない");
  });

  it("3章の役割の表に goldfish-reviewer の行がある", async () => {
    const ch3 = section(await read("docs/spec.md"), /^## 3\. /);
    const row =
      ch3.split("\n").find((l) => l.includes("orca-flow:goldfish-reviewer")) ??
      "";
    expect(row.startsWith("|")).toBe(true);
    expect(row).toContain("opus");
    expect(row).toContain("書かない");
  });

  it("10.1 に intake の行と「10。」「ほかの9つ」と段落がある", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    expect(s).toMatch(/^\| `\/orca-flow:intake /m);
    expect(s).toContain("10。");
    expect(s).toContain("ほかの9つ");
    expect(s).toContain("**Notion の要件から始める**");
    expect(s).toContain("splitting.md");
    expect(s).toContain("goldfish-reviewer");
    expect(s).toContain("--request-file");
  });

  it("10.1 の表の区切りの行の長さは変わらず、intake の行は run の行より長くない", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    const lines = s.split("\n");
    const head = lines.findIndex((l) => l.startsWith("| スキル"));
    expect((lines[head + 1] ?? "").length).toBe(4688);
    const width = (l: string): number => displayWidth(l.replace(/[ |]+$/, ""));
    const run = lines.find((l) => l.startsWith("| `/orca-flow:run")) ?? "";
    const intake =
      lines.find((l) => l.startsWith("| `/orca-flow:intake")) ?? "";
    expect(run).not.toBe("");
    expect(intake).not.toBe("");
    expect(width(intake)).toBeLessThanOrEqual(width(run));
    expect(intake.length).toBeLessThanOrEqual(4688);
  });

  it("10.2 に goldfish-reviewer の定義がある", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.2/);
    const at = s.indexOf("**agents/goldfish-reviewer.md**");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = s.slice(at);
    expect(block).toContain("`name: goldfish-reviewer`");
    expect(block).toContain("`tools: Read, Glob, Grep`");
    expect(block).toContain("`model: opus`");
    expect(block).toContain("`effort: high`");
    expect(block).toContain("`background: true`");
    expect(block).toContain("読み解き");
    expect(block).toContain("レビュー");
    expect(block).toContain("必ず直す・直したほうがよい・確認だけ");
  });

  it("12章に /orca-flow:intake の使い方と Notion の MCP を人がつなぐことがある", async () => {
    const s = section(await read("docs/spec.md"), /^## 12\./);
    expect(s).toContain("`/orca-flow:intake ");
    expect(s).toContain("Notion の MCP");
    const item =
      s.split("\n").find((l) => l.includes("**Notion の要件から始める**")) ??
      "";
    expect(item).toContain("「よい」と言う");
    expect(item).toContain("新しいタブで「よい」と言う");
    expect(item).toContain("同じタブ");
    expect(item).toContain(
      "統括役のタブでは `/orca-flow:intake 〈仕様のページの URL〉`",
    );
    expect(item).toContain(
      "本体のタブが残っていればそこで `/orca-flow:intake --here 〈仕様のページの URL〉`",
    );
    expect(item).toContain("始める項目の一覧");
  });

  it("13章に Notion の MCP の道具・プロパティ・子ページの行がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 13\./);
    const row = s.split("\n").find((l) => l.includes("Notion の MCP")) ?? "";
    expect(row.startsWith("|")).toBe(true);
    expect(row).toContain("道具の名前");
    expect(row).toContain("プロパティ");
    expect(row).toContain("子ページ");
    expect(row).toContain("印の行を含む下書きを人に示し");
    expect(row).toContain("イシューの URL");
    expect(row).not.toContain("イシューのURL");
  });

  it("10.1 の段落：印のあるページからも一覧を示して「よい」を待ち、件名は完全一致で見る", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    const all = s.split("\n");
    const from = all.findIndex((l) =>
      l.startsWith("**Notion の要件から始める**"),
    );
    const to = all.findIndex((l, i) => i > from && l.startsWith("## "));
    const para =
      from < 0 ? "" : all.slice(from, to < 0 ? undefined : to).join("\n");
    expect(para).not.toBe("");
    expect(para).not.toContain("下書きを飛ばして");
    expect(para).toContain("始める項目の一覧");
    expect(para).toMatch(
      /印のあるページの URL を渡されたとき[\s\S]*始める項目の一覧を示し、人の「よい」を待/,
    );
    expect(para).toContain("完全に同じ");
    expect(para).toContain("本文の先頭");
    expect(para).toContain("印の行を含む下書きの全文");
    expect(para).toContain("決めてほしいこと");
    expect(para).toContain("従わない");
    expect(para).toMatch(/子ページを足すだけ/);
    expect(para).toContain("区切りの線");
    expect(para).toContain("自動で追記");
    expect(para).toContain("要件から自動で作った仕様のページ");
    expect(para).toContain("前の印");
    expect(para).toContain("orca-flow の語を入れない");
    expect(para).toContain("もとの本文は変えず");
  });

  it("5章のプラグインの構成に skills/intake と goldfish-reviewer がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 5\. /);
    expect(s).toContain("intake");
    expect(s).toContain("splitting.md");
    expect(s).toContain("guards.md");
    expect(s).toContain("agents/goldfish-reviewer.md");
  });
});

describe("Notion の要件から始める：README.md", () => {
  it("/orca-flow:intake と、Notion の MCP を人がつなぐことが書いてある", async () => {
    const text = await read("README.md");
    expect(text).toContain("/orca-flow:intake");
    expect(text).toContain("Notion の MCP");
    expect(text).toContain("つな");
  });
});

describe("intake を新しいタブで走らせる：docs/spec.md", () => {
  it("8章の表に intake 〈URL〉 の行があり、場所の見分け・渡すプロンプト・落ちたときの案内がある", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    const row =
      ch8.split("\n").find((l) => l.startsWith("| `intake 〈URL〉")) ?? "";
    expect(row, "intake の行").not.toBe("");
    expect(row).toContain("orca agent launch");
    expect(row).toContain("--here");
    expect(row).toContain("orca-flow-workspace.json");
    expect(row).toContain("終了コード2");
    expect(row).toContain("同じタブ");
    expect(row).toContain("立っていないかを先に確かめ");
    expect(row).toContain("設定の lead を lead.agent が claude のときだけ");
    expect(row).toContain("git も Notion も書かない");
  });

  it("10.1 に入口と本体の項があり、Notion を読むのは本体のタブとある", async () => {
    const s = await read("docs/spec.md");
    const para = s.slice(s.indexOf("**Notion の要件から始める**"));
    const head = para.slice(0, para.indexOf("\n\n"));
    expect(head).not.toContain("Notion を読むのは統括役のタブだけ");
    expect(head).toContain("Notion を読むのは本体のタブ");
    expect(head).not.toContain("CLI は変えない");
    expect(head).toContain("`orca-flow intake`（8章）だけを足す");
    expect(para).toMatch(/- 入口：[^\n]*立っていないかを先に確かめ/);
    expect(para).toMatch(/- 入口：[^\n]*--here/);
    expect(para).toMatch(/- 本体：[^\n]*新しい/);
  });

  it("8章の intake の行に、手元のパスの受け方と受け渡しのファイルがある", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    const row =
      ch8.split("\n").find((l) => l.startsWith("| `intake 〈URL〉")) ?? "";
    expect(row).toContain("〈手元のパス〉");
    expect(row).toContain("--path-file");
    expect(row).toContain("source.json");
    expect(row).toContain("orca-flow-intake-");
    expect(row).toContain("`--here 〈実のパス〉`");
  });

  it("10.1 の入口に、手元のパスでも新しいタブが立つことがある", async () => {
    const s = await read("docs/spec.md");
    const para = s.slice(s.indexOf("**Notion の要件から始める**"));
    expect(para).toMatch(/- 入口：[^\n]*手元のパス[^\n]*新しいタブ/);
    expect(para).toMatch(/- 入口：[^\n]*Notion の道具を探さず/);
  });

  it("12章の9番に、新しいタブで続きを答えることがある", async () => {
    const ch12 = section(await read("docs/spec.md"), /^## 12\. /);
    const line = ch12.split("\n").find((l) => l.startsWith("9. ")) ?? "";
    expect(line).toContain("新しいタブ");
    expect(line).toContain("--here");
  });
});
