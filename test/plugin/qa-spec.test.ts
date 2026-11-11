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

/** 全角（幅広）を2、それ以外を1と数えた見た目の幅 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

const ASK = "Bash(orca-flow qa deploy *)";

describe("仕様書：QA 環境への deploy", () => {
  it("6章の表に qa の行があり、その意味の列は表のいちばん長いセルより短い（表の幅が変わらない）", async () => {
    const c6 = chapter(await read("docs/spec.md"), 6);
    const rows = c6.split("\n").filter((l) => l.startsWith("| "));
    const row = rows.find((l) => l.startsWith("| qa "));
    expect(row, "6章の表に qa の行がありません").toBeDefined();
    const cells = (row as string).split(/(?<!\\)\|/).slice(1, -1);
    expect(cells).toHaveLength(3);
    expect(cells[1]).toContain("null");
    const table = rows.filter((l) => /^\| (baseBranch|idPrefix) /.test(l));
    expect(table.length).toBe(2);
    const longest = Math.max(
      ...rows
        .filter((l) => l.split(/(?<!\\)\|/).length === 5)
        .filter((l) => !l.startsWith("| qa "))
        .map((l) => width(l.split(/(?<!\\)\|/)[3]?.trim() ?? "")),
    );
    expect(width(cells[2]?.trim() ?? "")).toBeLessThan(longest);
  });

  it("6章の『QA 環境』の段落に、キーと決まりがある", async () => {
    const c6 = chapter(await read("docs/spec.md"), 6);
    const at = c6.indexOf("**QA 環境**");
    expect(at, "『QA 環境』の段落がありません").toBeGreaterThanOrEqual(0);
    const para = c6.slice(at).split("\n\n")[0] as string;
    for (const word of [
      "qa.url",
      "qa.envs",
      "qa.envField",
      "qa.successText",
      "qa.branchFields",
      "qa.selfField",
      "qa.fields",
      "qa.databaseField",
      "qa.appUrl",
      "qa.authEnv",
      "ユーザー",
      "qa-leases.json",
      "XDG_STATE_HOME",
      "重なる",
      ASK,
      "許可の ask",
    ])
      expect(para, `${word} が段落にありません`).toContain(word);
  });

  it("8章に qa の節があり、終了コードと送らない場面・承認の決まりがある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    expect(c8).toMatch(/^\| `qa /m);
    const at = c8.indexOf("**qa（");
    expect(at, "8章に qa の節がありません").toBeGreaterThanOrEqual(0);
    const part = c8.slice(at, c8.indexOf("**おまかせ**"));
    for (const word of [
      "qa plan",
      "qa deploy",
      "qa list",
      "qa release",
      "--head",
      "--env",
      "--branch",
      "--database",
      "ls-remote",
      "60秒",
      "成功の印",
      "終了コード2",
      "終了コード1",
      ASK,
      "人が承認する",
      "出さない",
      "`--json` を受けない",
    ])
      expect(part, `${word} が qa の節にありません`).toContain(word);
  });

  it("init の許可の案内・10.1・12章の許可の ask に qa deploy があり、send と merge も残る", async () => {
    const text = await read("docs/spec.md");
    const c8 = chapter(text, 8);
    const c10 = chapter(text, 10);
    const c12 = chapter(text, 12);
    const guide8 = c8
      .split("\n")
      .find((l) => l.startsWith("**init の許可の案内**"));
    const guide10 = c10
      .split("\n")
      .find((l) => l.startsWith("**許可の ask の案内**"));
    const guide12 = c12.split("\n").find((l) => l.startsWith("**許可の ask**"));
    for (const [name, line] of [
      ["8章", guide8],
      ["10.1", guide10],
      ["12章", guide12],
    ] as const) {
      expect(line, `${name}の許可の案内がありません`).toBeDefined();
      expect(line, name).toContain(ASK);
      expect(line, name).toContain("Bash(orca-flow send *)");
      expect(line, name).toContain("Bash(orca-flow merge *)");
    }
    expect(chapter(text, 7)).toContain(ASK);
    expect(c12).toContain("`send` と `merge` だけが許可の画面を出す");
    expect(c12).toContain("`qa deploy` が加わる");
    expect(c12).not.toContain("`qa deploy` も同じく出す");
  });

  it("13章に、管理画面のキューが deploy に進むかの行が2列である", async () => {
    const c13 = chapter(await read("docs/spec.md"), 13);
    const row = c13
      .split("\n")
      .find(
        (l) => l.startsWith("|") && l.includes("キューから deploy に進むか"),
      );
    expect(row, "13章に行がありません").toBeDefined();
    expect((row as string).split("|").length - 2).toBe(2);
    expect(row).toContain("管理画面を開く");
  });

  it("6章の『QA 環境』の段落に、組のモードで selfField 以外が同じという決まりがある", async () => {
    const c6 = chapter(await read("docs/spec.md"), 6);
    const para = c6.slice(c6.indexOf("**QA 環境**")).split("\n\n")[0] as string;
    for (const word of [
      "組のモード",
      "selfField` を除いて全部同じ",
      "終了コード1",
    ])
      expect(para, `${word} が段落にありません`).toContain(word);
  });

  it("8章の qa の節に、組のモードの節がある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const part = c8.slice(c8.indexOf("**qa（"), c8.indexOf("**おまかせ**"));
    const at = part.indexOf("- 組のモード：");
    expect(at, "組のモードの節がありません").toBeGreaterThanOrEqual(0);
    const end = part.indexOf("\n- ", at + 1);
    expect(end, "組のモードの節の終わりがありません").toBeGreaterThan(at);
    const group = part.slice(at, end);
    expect(group).not.toContain("- 管理画面は");
    for (const word of [
      "orca-flow-workspace.json",
      "qa plan",
      "qa deploy",
      "--head 〈名前〉=〈先頭〉",
      "使い直す",
      "qa list",
      "qa release",
      "枝の取り込みの確かめ",
      "終了コード2",
      "終了コード1",
      ASK,
      "ワークスペースのフォルダの `.claude/settings.json`",
      "`permissions.ask` にも `Bash(orca-flow qa deploy *)` を入れる",
      "組の貸し出しを返さない",
      "qa release --env 〈番号〉",
      "同じ ID を組が借りている旨を1行添える",
    ])
      expect(group, `${word} が組のモードの節にありません`).toContain(word);
  });

  it("組のモードの節に「組とブランチ」の小項目があり、共通がなくてもよいとある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const part = c8.slice(c8.indexOf("**qa（"), c8.indexOf("**おまかせ**"));
    const line = part
      .split("\n")
      .find((l) => l.startsWith("  - 組とブランチ："));
    expect(line, "組とブランチの小項目がありません").toBeDefined();
    expect(line).toContain("仕様のページのブランチ");
    expect(line).toContain("同じ ID");
    expect(line).toContain("共通がなくてもよい");
  });

  it("6章と8章の表の qa の行は、8章の1列めにブランチ名があり、説明にワークスペースのフォルダではブランチ名だけを受けるとある", async () => {
    const text = await read("docs/spec.md");
    const cells = (line: string | undefined) =>
      (line as string)
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((c) => c.trim());
    const row6 = chapter(text, 6)
      .split("\n")
      .find((l) => l.startsWith("| qa "));
    expect(cells(row6)).toEqual([
      "qa",
      "`null`",
      "空いている QA 環境へ deploy する設定（8章 `qa`）。下の『QA 環境』",
    ]);
    const row8 = chapter(text, 8)
      .split("\n")
      .find((l) => l.startsWith("| `qa <plan"));
    const c8 = cells(row8);
    expect(c8[0]).toBe(
      "`qa <plan\\|deploy\\|list\\|release> [〈ID〉\\|〈ブランチ名〉]`",
    );
    expect(c8[1]).toBe("だれでも");
    expect(c8[2]).toBe(
      "空いている QA 環境を選んで deploy する・見る・返す。ワークスペースのフォルダでは 〈ID〉 の代わりにブランチ名だけを受け、ID の形は打ち直しの1行を出して終了コード1（下の『qa』の段落、6章『QA 環境』）",
    );
  });

  it("6章の『QA 環境』に、組の貸し出しの持ち主を記録のどのブランチで比べるかと、古い記録の扱いがある", async () => {
    const c6 = chapter(await read("docs/spec.md"), 6);
    const para = c6.slice(c6.indexOf("**QA 環境**")).split("\n\n")[0] as string;
    const sentences = para.split("。");
    const owner = sentences.find((s) =>
      s.startsWith(
        "組の貸し出しの持ち主は、借り手と貸し出しの両方にブランチ名があれば、リポジトリとブランチ名で比べ、ID の欄は見ない：",
      ),
    );
    expect(owner, "持ち主の比べ方の文がありません").toBeDefined();
    expect(owner).toContain("子の貸し出しは記録の `branch`");
    expect(owner).toContain(
      "組の貸し出しは `apps` の各 `branch` が組のブランチ名と同じなら ID の欄が違っても同じ持ち主とし、違えば",
    );
    expect(owner).toContain("同じ ID でも別の持ち主とみなす");
    expect(owner).toContain("番号だけ同じ無関係なタスクがありうる");
    const old = sentences.find((s) => s.startsWith("記録の形は変えず"));
    expect(old, "古い記録の扱いの文がありません").toBe(
      "記録の形は変えず、どちらかにブランチ名のない古い形の記録は今までどおり ID で比べる",
    );
    expect(sentences.indexOf(old as string)).toBe(
      sentences.indexOf(owner as string) + 1,
    );
  });

  it("3章の親の書いてよいものに、QA の貸し出しの記録がある", async () => {
    const c3 = chapter(await read("docs/spec.md"), 3);
    const line = c3.split("\n").find((l) => l.includes("親が書いてよいのは"));
    expect(line, "親の行がありません").toBeDefined();
    expect(line).toContain("QA の貸し出しの記録");
    expect(line).toContain("qa-leases.json");
  });

  it("導入先の名前や URL を書いていない", async () => {
    const text = await read("docs/spec.md");
    const c8 = chapter(text, 8);
    const part = c8.slice(c8.indexOf("**qa（"), c8.indexOf("**おまかせ**"));
    expect(part).not.toMatch(/https?:\/\/(?!qa\d*\.example\.test)/);
  });
});
