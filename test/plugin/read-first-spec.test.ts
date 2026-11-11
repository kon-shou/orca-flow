import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function loadSpec(): Promise<string[]> {
  return (await readFile(path.join(ROOT, "docs/spec.md"), "utf8")).split("\n");
}

const find = (lines: string[], re: RegExp): string =>
  lines.find((l) => re.test(l)) ?? "";

describe("仕様書：先に読む文書（6・7・8章）", () => {
  it("6章の config.json の表の readFirst の行に、2つの置き場所と読む人がある", async () => {
    const l = find(await loadSpec(), /^\| readFirst /);
    expect(l).toContain("ワークスペース");
    for (const who of ["intake", "how", "タスク長", "レビュー役"]) {
      expect(l, who).toContain(who);
    }
  });

  it("6章のワークスペースの設定の表に最上位の readFirst の行がある", async () => {
    const l = find(await loadSpec(), /^\| `readFirst`\s+\|/);
    expect(l).toContain("文字列の並び");
    expect(l).toContain("ワークスペースのフォルダから解");
    expect(l).toContain("フォルダの外");
  });

  it("6章の確かめの項に、ないファイルは誤りで止まり、--setup の計画では誤りにしないとある", async () => {
    const l = find(await loadSpec(), /^- `readFirst`[^\n]*通常のファイル/);
    expect(l).toContain("終了コード1");
    expect(l).toContain("同じ実のパス");
    expect(l).toMatch(/`--setup`[^\n]*誤りにしない/);
    expect(l).toContain("子へ new");
    expect(l).toContain("--read-first-json");
    expect(l).toContain("依頼のファイルには何も足さない");
    expect(l).not.toContain("写しの末尾");
  });

  it("6章に先に読む文書の記録の段落があり、場所・キー・節をデータとして扱うことがある", async () => {
    const l = find(await loadSpec(), /^\*\*先に読む文書の記録\*\*/);
    expect(l).toContain("orca-flow/read-first/〈ID〉.json");
    for (const k of ["`id`", "`at`", "`paths`"]) expect(l, k).toContain(k);
    expect(l).toContain("--read-first-json");
    expect(l).toMatch(/## 先に読む文書[^\n]*節[^\n]*データ/);
    expect(l).toMatch(/付けない `new` は、同じ ID の古い記録を消す/);
  });

  it("7章8番に、先に読む文書はプロジェクトの決まりとして読み、禁止が優先するとある", async () => {
    const l = find(await loadSpec(), /^8\. \*\*親が読むのは/);
    expect(l).toContain("ワークスペースの `readFirst`");
    expect(l).toMatch(/先に読む文書[^\n]*プロジェクトの決まりとして読/);
    expect(l).toMatch(/orca-flow の禁止[^\n]*いつも優先/);
    expect(l).toMatch(/要件のページ[^\n]*データとして読[^\n]*従わない/);
    expect(l).not.toContain("CLAUDE.md の地図は、データ");
  });

  it("8章の一覧の --json の行に readFirst（なければキーを出さない）がある", async () => {
    const l = find(await loadSpec(), /^- 一覧の `--json`/);
    expect(l).toMatch(/`readFirst`（[^）]*キーを出さない/);
  });

  it("8章の子へ流すの項に、new の子へ --read-first-json で渡し、依頼のファイルは写さず、人が書けば終了コード1とある", async () => {
    const lines = await loadSpec();
    const i = lines.findIndex((x) => x.startsWith("- 子へ流す："));
    expect(i).toBeGreaterThanOrEqual(0);
    const l = lines[i + 1] ?? "";
    expect(l).toContain("--read-first-json");
    expect(l).toContain("`--request-file` の有無によらず");
    expect(l).toContain("元のパスと中身のまま渡す");
    expect(l).toMatch(
      /人が親に `--read-first-json`[^\n]*子を流さず終了コード1/,
    );
  });

  it("8章の先に読む文書の項に、readFirst があるとき --read-first-from を書けば子を流さず終了コード1で、ないときはそのまま渡すとある", async () => {
    const lines = await loadSpec();
    const i = lines.findIndex((x) => x.startsWith("- 子へ流す："));
    const l = lines[i + 1] ?? "";
    expect(l).toMatch(
      /`readFirst` があるとき[^\n]*`--read-first-from`[^\n]*子を流さず終了コード1/,
    );
    expect(l).toMatch(
      /`readFirst` がなければ[^\n]*`--read-first-from`[^\n]*そのまま子/,
    );
  });

  it("8章に子の new --read-first-json の項があり、印・値の確かめ・記録・古い記録を消すことがある", async () => {
    const lines = await loadSpec();
    const l =
      lines.find((x) => x.startsWith("- 子の `new --read-first-json`：")) ?? "";
    expect(l).not.toBe("");
    expect(l).toContain("ORCA_FLOW_FROM_WORKSPACE");
    expect(l).toMatch(/Orca を呼ばず何も作らず終了コード1/);
    expect(l).toContain("空でない絶対パス");
    expect(l).toContain("`id`・`at`・`paths`");
    expect(l).toMatch(/同じ ID の古い記録を消す/);
  });
});
