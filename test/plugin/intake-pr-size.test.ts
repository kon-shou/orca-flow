import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

function criterion3(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("3. "));
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l));
  return lines.slice(at, at + 1 + (end < 0 ? rest.length : end)).join("\n");
}

describe("PR 全体の行の目安：分け方の基準", () => {
  it("基準3の目安はテストを除く約400行とモジュールの数だけで、全体の約700行はない", async () => {
    const c = criterion3(await read("skills/intake/splitting.md"));
    expectAll(c, ["約400行", "テストを除く", "モジュール"]);
    expect(c).not.toContain("約700行");
  });

  it("番号の行は1〜8のままで、基準3の下に箇条がある", async () => {
    const t = await read("skills/intake/splitting.md");
    const nums = t
      .split("\n")
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => Number(l.split(".")[0]));
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const c = criterion3(t);
    expectAll(c, ["分けた案", "どこで切る", "待ちや版の回数", "上の端"]);
  });

  it("数え方とレビューの小さな差分への言及があり、しきい値の数は書かれていない", async () => {
    const t = await read("skills/intake/splitting.md");
    expectAll(criterion3(t), [
      "足す行と消す行",
      ".md",
      "テストのファイルの見分け方",
      "移すだけ",
      "小さな差分",
    ]);
    expect(t).not.toContain("300");
  });

  it("レビュー役が、分けた案があるかを見る文がある", async () => {
    const c = criterion3(await read("skills/intake/splitting.md"));
    expectAll(c, ["レビュー役", "分けた案があるかを見る"]);
    expect(c).not.toContain("分けない理由");
  });

  it("1項目に書くことと手順6の行に、コード・テスト・全体の行とモジュールの数がある", async () => {
    const s = await read("skills/intake/splitting.md");
    const g = await read("skills/intake/guards.md");
    const line = (t: string, key: string) =>
      t.split("\n").find((l) => l.includes(key)) ?? "";
    for (const l of [line(s, "見込みの大きさ（"), line(g, "1項目には")]) {
      expectAll(l, ["コード", "テスト", "全体", "モジュールの数", "移すだけ"]);
    }
  });
});

describe("PR 全体の行の目安：仕様のページの形と一言", () => {
  it("前の形：一覧にコード・テスト・全体の行を書く形と目安超えがあり、例に入っている", async () => {
    const t = await read("skills/intake/page-format-prev.md");
    expectAll(t, [
      "目安超え",
      "コード 130〜200・テスト 100〜180・全体 230〜380",
    ]);
    const row = t.split("\n").find((l) => l.startsWith("> | 2 ")) as string;
    expectAll(row, ["コード", "テスト", "全体"]);
  });

  it("前の形：列の中身の形を確かめず、今の形の列もそのまま読む文がある", async () => {
    const t = await read("skills/intake/page-format-prev.md");
    expectAll(t, ["確かめない", "「小」「中」だけ", "書き換えない"]);
  });

  it("タスクのページの要点に、コード・テスト・全体の行と目安超えを書き、形は確かめない", async () => {
    const t = await read("skills/intake/page-format.md");
    expectAll(t, [
      "目安超え",
      "コード 130〜200・テスト 100〜180・全体 230〜380",
      "確かめない",
      "「小」「中」だけ",
      "書き換えない",
    ]);
    const ex = t.split("\n").find((l) => l.startsWith("> 大きさ：")) as string;
    expectAll(ex, ["コード", "テスト", "全体"]);
  });

  it("一言の決まりは手順6の節にあり、各手順がそれを指す", async () => {
    const section = (text: string, start: string) => {
      const lines = text.split("\n");
      const at = lines.findIndex((l) => l.startsWith(start));
      const rest = lines.slice(at + 1);
      const end = rest.findIndex((l) => l.startsWith("## "));
      return lines.slice(at, at + 1 + (end < 0 ? rest.length : end)).join("\n");
    };
    const g = section(
      await read("skills/intake/guards.md"),
      "## 手順6：下書きの決まり",
    );
    expectAll(g, [
      "人に示す一言（目安を超える見込みだった要件と、超えたまま残した項目）",
      "PR 全体の見込み",
    ]);
    const sk = await read("skills/intake/SKILL.md");
    const skLines = sk.split("\n");
    const s6 = skLines.findIndex((l) => l.startsWith("6. "));
    const s7 = skLines.findIndex((l) => l.startsWith("7. "));
    const step6 = skLines.slice(s6, s7);
    const step9 = skLines.filter((l) => l.startsWith("9. "));
    const hit6 = step6.filter((l) => l.includes("人に示す一言"));
    const hit9 = step9.filter((l) => l.includes("人に示す一言"));
    expect(hit6.some((l) => l.includes("単位の案"))).toBe(true);
    expect(hit9.some((l) => l.includes("リンク"))).toBe(true);
    const w = section(
      await read("skills/intake/workspace.md"),
      "## 手順6の差し替え",
    );
    expectAll(w, ["人に示す一言", "手順9"]);
  });

  it("一言の行は基準3を名前で指し、目安の数を写さない", async () => {
    const g = await read("skills/intake/guards.md");
    const line = g.split("\n").find((l) => l.includes("人に示す一言（")) ?? "";
    expectAll(line, ["基準3", "モジュールの数"]);
    expect(line).not.toContain("約400");
    expect(line).not.toContain("約700");
    for (const f of [
      "SKILL.md",
      "workspace.md",
      "page-format.md",
      "page-format-prev.md",
      "guards.md",
    ]) {
      const t = await read(`skills/intake/${f}`);
      expect(t, f).not.toContain("約400");
      expect(t, f).not.toContain("約700");
    }
    expect(await read("skills/intake/splitting.md")).toContain("約400行");
  });

  it("仕様書 10.1 の箇条に目安・行の内訳・一言がある", async () => {
    const spec = await read("docs/spec.md");
    const line =
      spec.split("\n").find((l) => l.startsWith("- 仕様は ADR の形")) ?? "";
    expectAll(line, ["約400行", "コード・テスト・全体", "一言"]);
    expect(line).not.toContain("約700行");
  });
});
