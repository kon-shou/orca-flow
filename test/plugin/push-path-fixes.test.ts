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

function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => heading.test(l));
  expect(at, `${heading} が見つかりません`).toBeGreaterThanOrEqual(0);
  const level = (lines[at] ?? "").match(/^#+/)?.[0].length ?? 2;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && (m[1]?.length ?? 9) <= level;
  });
  return [lines[at], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

describe("docs/spec.md：push の道の残りの直しの仕様の文", () => {
  it("10.1 の冒頭が「10。」と「ほかの9つ」で、「10こめ」がない", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    expect(s).toContain("10。");
    expect(s).toContain("ほかの9つ");
    expect(s).not.toContain("10こめ");
  });

  it("8章 integrate の行に main のロックの一言がある", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    const row = ch8
      .split("\n")
      .find((l) => l.startsWith("| `integrate 〈ID〉"));
    expect(row).toContain("main のロック");
    expect(row).toContain("approve・new と共通");
  });

  it("8章 push の段落に、ロックの共通・止まった文の形・後始末の止め方・二つの注意がある", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    expect(ch8).toContain("approve（");
    expect(ch8).toContain("new（");
    expect(ch8).toContain(
      "〈相手〉が main を書き換えています（ロック：〈パス〉）",
    );
    expect(ch8).toContain("別の処理");
    expect(ch8).toContain("手元にしかないコミットがあるとき");
    expect(ch8).toContain("refs/pull/〈番号〉/head");
    expect(ch8).not.toContain("先頭がマージされた PR の先頭と違うとき");
    expect(ch8).toContain("信じる範囲は増えない");
    expect(ch8).toContain("進捗表を無視する設定");
  });

  it("閉じた PR のカードは「PR が閉じられた：PR #n」で、人が選ぶと書く", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    expect(ch8).toContain("PR が閉じられた：PR #n");
    expect(ch8).toContain("push の打ち直しか integrate");
    expect(ch8).not.toContain("タスクは統合待ちに戻す");
  });

  it("4章に PR の道のカードの一覧がある", async () => {
    const ch4 = section(await read("docs/spec.md"), /^## 4\. /);
    for (const card of [
      "CI 待ち",
      "レビュー待ち",
      "CI が落ちた",
      "後始末で止まった",
      "待ち受けが止まった",
      "PR が閉じられた",
    ]) {
      expect(ch4).toContain(card);
    }
  });

  it("5章のツリーの skills に push と auto がある", async () => {
    const ch5 = section(await read("docs/spec.md"), /^## 5\. /);
    expect(ch5).toMatch(/skills\/\{[^}]*\bpush\b[^}]*\}\/SKILL\.md/);
    expect(ch5).toMatch(/skills\/\{[^}]*\bauto\b[^}]*\}\/SKILL\.md/);
  });
});

describe("スキル：main のロックで止まったとき", () => {
  for (const name of ["push", "approve", "new", "integrate"]) {
    it(`${name}：「main を書き換えています」で少し待ってもう一度を伝える`, async () => {
      const text = await read(`skills/${name}/SKILL.md`);
      expect(text).toContain("main を書き換えています");
      expect(text).toContain("ロック：");
      expect(text).toContain("少し待ってもう一度");
    });
  }

  it("push のカードの一覧に「PR が閉じられた」があり、統合は人が選ぶ", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("「PR が閉じられた」");
    expect(text).toContain("/orca-flow:integrate");
    expect(text).toContain("手元のタスクのブランチにだけあるコミット");
  });
});
