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
function chapter(text: string, no: number): { heading: string; body: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return {
    heading: lines[start] ?? "",
    body: (end < 0 ? rest : rest.slice(0, end)).join("\n"),
  };
}

// タスクの番号の形は、自分のファイルに書かないよう実行時に組む。
const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

describe("仕様書：複数のリポジトリをまたぐ要件（16章は外した）", () => {
  it("「## 16. 」の見出しも「### 16.」の小見出しも、「16章」を指す文ももない", async () => {
    const text = await loadSpec();
    expect(text.split("\n").filter((l) => l.startsWith("## 16. "))).toEqual([]);
    expect(text).not.toMatch(/^### 16\./m);
    expect(text).not.toMatch(/16章/);
    expect(text).not.toMatch(/16\.[0-9]+/);
    const all = text.split("\n").filter((l) => l.startsWith("## "));
    expect(all[all.length - 1]).toMatch(/^## 14\. /);
  });

  it("8章の new と workspace に、またぐ依存の指定（段2の行の移し先）がある", async () => {
    const lines = chapter(await loadSpec(), 8).body.split("\n");
    const row = lines.find((l) => l.startsWith("| `new --title ")) ?? "";
    expect(row).toContain("--cross-depends-json");
    expect(lines.join("\n")).toMatch(
      /workspace 〈名前〉 new[^\n]*--cross-depends[^\n]*--bumps|--cross-depends[^\n]*--bumps[^\n]*workspace 〈名前〉 new/,
    );
  });

  it("8章の integrate と merge に、またぐ依存の門（段2の門の行の移し先）がある", async () => {
    const lines = chapter(await loadSpec(), 8).body.split("\n");
    const integrate = lines.find((l) => l.startsWith("| `integrate ")) ?? "";
    expect(integrate).toContain("--skip-cross-depends");
    const merge = lines.find((l) => l.startsWith("| `merge ")) ?? "";
    expect(merge).toContain("--drop-depend");
    expect(lines.some((l) => l.startsWith("| またぐ依存"))).toBe(true);
  });

  it("スキルの名前が10章と5章の skills/intake の行にある", async () => {
    const spec = await loadSpec();
    expect(
      chapter(spec, 10).body,
      "skills/intake/workspace.md が10章にありません",
    ).toContain("skills/intake/workspace.md");
    expect(
      chapter(spec, 5).body.split("\n"),
      "5章の skills/intake の行に workspace.md がありません",
    ).toSatisfy((ls: string[]) =>
      ls.some(
        (l) => l.includes("skills/intake/") && l.includes("workspace.md"),
      ),
    );
  });

  it("5章の skills/intake の行と10.1 の複数のリポジトリの段落の頭の行に guards.md がある", async () => {
    const spec = await loadSpec();
    expect(
      chapter(spec, 5)
        .body.split("\n")
        .some((l) => l.includes("skills/intake/") && l.includes("guards.md")),
    ).toBe(true);
    const lines = chapter(spec, 10).body.split("\n");
    const head = lines.find((l) =>
      l.startsWith("**複数のリポジトリをまたぐ要件**"),
    );
    expect(head).toBeDefined();
    expect(head).toContain("skills/intake/guards.md");
    expect(head).toMatch(/手順6・10の守り[^。]*1か所/);
  });

  it("データとして読む決まりが7章に、依存の形・配る前の確かめが10.1に書かれている", async () => {
    const spec = await loadSpec();
    const body = chapter(spec, 7).body;
    expect(body).toMatch(/要件のページ[^\n]*データとして読[^\n]*従わない/);
    const ten = chapter(spec, 10).body;
    expect(ten).toContain("`〈名前〉:〈ID〉`");
    expect(ten).toMatch(
      /全部のリポジトリで[^\n]*通るか[^\n]*1つでも外れたら1つも始めず/,
    );
  });

  it("10.1 に「複数のリポジトリをまたぐ要件」の段落と、移した9つの行がある", async () => {
    const ten = chapter(await loadSpec(), 10).body;
    const lines = ten.split("\n");
    expect(
      lines.some(
        (l) =>
          l.startsWith("**複数のリポジトリをまたぐ要件**") &&
          l.includes("skills/intake/workspace.md"),
      ),
    ).toBe(true);
    for (const w of [
      "読む",
      "書く",
      "順",
      "配る前",
      "配る",
      "版",
      "失敗",
      "ID の形",
      "`new --depends` への渡し方",
    ]) {
      expect(
        lines.some((l) => l.startsWith(`- ${w}：`)),
        `10.1 に「${w}」の行がありません`,
      ).toBe(true);
    }
  });

  it("2章に流れ（設定 → 親の intake → 子で new …）の行がある", async () => {
    const lines = chapter(await loadSpec(), 2).body.split("\n");
    const hit = lines.find(
      (l) => l.includes("設定 → 親の intake") && l.includes("子で `new`"),
    );
    expect(hit, "2章に流れの行がありません").toBeDefined();
    expect(hit).toContain(
      "共通の PR をマージ → 共通の版を出す（人）→ アプリの同じブランチで正式な版に戻す → アプリの PR をマージ",
    );
    expect(hit).not.toContain("共通の版 → アプリの版上げ");
  });

  it("12章にワークスペースのフォルダで intake を打つ行がある", async () => {
    const lines = chapter(await loadSpec(), 12).body.split("\n");
    expect(
      lines.some(
        (l) =>
          l.includes("ワークスペースのフォルダ") &&
          l.includes("intake を打つ") &&
          l.includes("orca-flow-workspace.json"),
      ),
    ).toBe(true);
  });

  it("共通とアプリの項目 → 共通の PR のマージ → 共通の版 → アプリの版戻し → アプリの PR のマージの順が、10章にこの並びで書かれている", async () => {
    const body = chapter(await loadSpec(), 10).body;
    const line = body
      .split("\n")
      .find((l) => l.startsWith("- 順：") && l.includes("共通の版を出す"));
    expect(line, "順を書いた行がありません").toBeDefined();
    const order = [
      "共通とアプリの項目を始める",
      "共通の PR をマージ",
      "共通の版を出す",
      "アプリの同じブランチで正式な版に戻す",
      "アプリの PR をマージ",
    ];
    const at = order.map((w) => (line ?? "").indexOf(w));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("spec.md 全体にタスクの番号の形と、ホームの下の絶対パスが出ない", async () => {
    const lines = (await loadSpec()).split("\n");
    expect(lines.filter((l) => idForm.test(l))).toEqual([]);
    expect(lines.filter((l) => homePath.test(l))).toEqual([]);
  });

  it("1章に複数のリポジトリをまたぐ要件の範囲の行がある（16章は指さない）", async () => {
    const lines = chapter(await loadSpec(), 1).body.split("\n");
    const hit = lines.find(
      (l) => l.includes("複数のリポジトリをまたぐ要件") && l.includes("共通"),
    );
    expect(hit, "1章に範囲の行がありません").toBeDefined();
    expect(hit).toContain("親は読むのと配る、子は作るのと入れる");
    expect(hit).toContain("共通の版を出すこと");
    expect(hit).toContain("リリースは人が行う");
    expect(lines.join("\n")).not.toMatch(
      /1[56]章|まだ作っていない）で広げる：1つのサービス/,
    );
  });

  it("7章の既定の一覧と src/config.ts の既定に composer の2つがあり、並びが同じ", async () => {
    const seven = chapter(await loadSpec(), 7).body;
    const row = seven
      .split("\n")
      .find((l) => l.includes("パッケージの定義とロックファイル"));
    expect(row).toBeDefined();
    expect(row).toContain("`go.sum`、`composer.json`、`composer.lock`");
    const src = await readFile(path.join(ROOT, "src/config.ts"), "utf8");
    expect(src).toMatch(/"go\.sum",\s*"composer\.json",\s*"composer\.lock",/);
  });

  it("7章3番に、またぐ依存の門が足されている", async () => {
    const line =
      chapter(await loadSpec(), 7)
        .body.split("\n")
        .find((l) =>
          l.startsWith("3. **依存のあるタスクは同時に走らせない**"),
        ) ?? "";
    expect(line).toMatch(/またぐ依存[^\n]*門/);
    expect(line).toMatch(/PR でマージ/);
    expect(line).toMatch(/共通[^。]*PR の道/);
  });

  it("12章の「複数のリポジトリをまたぐ要件」に、共通もアプリも PR の道で入れ integrate は使わないとある", async () => {
    const line =
      chapter(await loadSpec(), 12)
        .body.split("\n")
        .find((l) => l.startsWith("**複数のリポジトリをまたぐ要件**")) ?? "";
    expect(line).toMatch(/共通もアプリも PR の道/);
    expect(line).toMatch(/integrate は使わない/);
  });

  it("13章に、複数のリポジトリをまたぐ要件の確かめていないことの3行がある", async () => {
    const lines = chapter(await loadSpec(), 13).body.split("\n");
    for (const head of [
      "| Orca がコードのないフォルダをタブで開けるか",
      "| how がリポジトリの外を読むときの許可の画面",
      "| how を数回呼ぶ費用と時間（共通は全部読む分も含む）",
    ]) {
      expect(
        lines.some((l) => l.startsWith(head)),
        `13章に「${head}」の行がありません`,
      ).toBe(true);
    }
    const place =
      lines.find((l) => l.startsWith("| Orca がコードのないフォルダ")) ?? "";
    expect(place).toContain("入れ子の確かめ・ハッシュの理由も直す");
    expect(place).not.toContain("16");
  });

  it("12章に「リポジトリの地図」と、導入済みのリポジトリで sharedPaths に composer の2つを足す案内がある", async () => {
    const lines = chapter(await loadSpec(), 12).body.split("\n");
    expect(lines.some((l) => l.includes("リポジトリの地図"))).toBe(true);
    const guide = lines.filter(
      (l) =>
        l.includes("sharedPaths") &&
        l.includes("composer.json") &&
        l.includes("composer.lock") &&
        l.includes("導入済み"),
    );
    expect(guide.length).toBeGreaterThan(0);
  });
});
