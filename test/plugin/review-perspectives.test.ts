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

/** 手順の行（`〈数〉. ` で始まる行）から、次の手順の行の前まで */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}がありません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (l, i) => i > start && new RegExp(`^(${n + 1}\\. |## )`).test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** 手順3の中の「- 〈観点〉：」の主な見出しの行から、次の同じ深さの項目の前まで */
function perspectiveBlock(body: string, name: string): string {
  const step3 = stepBlock(body, 3).split("\n");
  const start = step3.findIndex((l) => l.startsWith(`   - ${name}：`));
  expect(start, `観点「${name}」がありません`).toBeGreaterThanOrEqual(0);
  const end = step3.findIndex((l, i) => i > start && /^ {3}- \S/.test(l));
  return step3.slice(start, end < 0 ? undefined : end).join("\n");
}

const PERSPECTIVE_WORDS: [string, string[]][] = [
  [
    "正しさ",
    ["黙って壊れる", "空の絞り込み", "失敗", "成功", "対称性", "コミットの後"],
  ],
  [
    "セキュリティ",
    ["閉じる側", "一括", "書き出し", "直接の呼び出し", "隠した値"],
  ],
  ["設計", ["もっと単純な案", "先回り", "頼まれていない整理"]],
  [
    "テスト",
    ["再現テスト", "正解として固定", "名前", "期待が変わる", "偽物", "境界"],
  ],
  [
    "運用と互換性",
    ["上限の件数", "ループの中の問い合わせ", "先に読み込み済み"],
  ],
];

/** 定義に入れない、フレームワーク・データベース・言語の名前 */
const PRODUCT_NAMES = [
  "Laravel",
  "Vue",
  "MySQL",
  "PHP",
  "PostgreSQL",
  "Rails",
  "Django",
  "Redis",
  "React",
];

describe("レビュー役の定義：手順3の観点の小項目", () => {
  for (const [name, words] of PERSPECTIVE_WORDS) {
    it(`${name}のブロックに足した観点の言葉がある`, async () => {
      const block = perspectiveBlock(
        await read("agents/code-reviewer.md"),
        name,
      );
      for (const w of words) expect(block, `${name}：${w}`).toContain(w);
    });
  }

  it("運用と互換性のブロックに、止めずに出すときの場面と重さの決まりがある", async () => {
    const block = perspectiveBlock(
      await read("agents/code-reviewer.md"),
      "運用と互換性",
    );
    for (const w of [
      "並んで動く間",
      "キャッシュ",
      "積んだジョブ",
      "セッション",
      "戻せるか",
      "ロック",
      "開いたままの古い画面",
      "先に出しても動く",
      "「出し方」",
      "欄のない設計書",
      "出す順を人が守る",
      "判断事項にする",
      "承認されたもの",
    ]) {
      expect(block, w).toContain(w);
    }
  });

  it("判断事項の印を外すものに「出し方」が入っている", async () => {
    const body = await read("agents/code-reviewer.md");
    const skip = body.split("\n").find((l) => l.includes("- 外すもの："));
    expect(skip).toBeDefined();
    expect(skip).toContain("「出し方」に書かれて承認された選択");
  });

  it("足した小項目は1行ずつで、150文字くらいまで", async () => {
    const step3 = stepBlock(await read("agents/code-reviewer.md"), 3);
    for (const line of step3.split("\n").filter((l) => /^ {5}- /.test(l))) {
      expect(line.trim().length, line).toBeLessThanOrEqual(170);
    }
  });
});

describe("レビュー役の定義：手順7の裏取り", () => {
  it("言い切る指摘の裏取りと、まとめ方の言葉がある", async () => {
    const step7 = stepBlock(await read("agents/code-reviewer.md"), 7);
    for (const w of [
      "「テストがない」",
      "「使われていない」",
      "全体を検索",
      "親や隣のファイル",
      "呼び出し元を全部",
      "確認だけ",
      "代表",
    ]) {
      expect(step7, w).toContain(w);
    }
  });
});

describe("担当の定義：直す前の確かめ", () => {
  it("手順5の下に、呼び出し元・旧名・再現テスト・頼まれていない整理の言葉がある", async () => {
    const step5 = stepBlock(await read("agents/task-worker.md"), 5);
    for (const w of [
      "全呼び出し元",
      "全入口",
      "旧名",
      "再現テスト",
      "頼まれていない整理",
      "デバッグの残り",
    ]) {
      expect(step5, w).toContain(w);
    }
  });

  it("手順の番号が 1〜9 のまま並ぶ", async () => {
    const nums = (await read("agents/task-worker.md"))
      .split("\n")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("仕様書 10.2：足した観点の決まり", () => {
  async function sec(): Promise<string> {
    const spec = await read("docs/spec.md");
    return spec.slice(spec.indexOf("### 10.2 "), spec.indexOf("### 10.3 "));
  }

  it("担当の定義の項目4に、直す前の確かめの1文があり、項目の数は9のまま", async () => {
    const worker = (await sec()).split("**agents/task-reviewer.md**")[0] ?? "";
    const items = worker.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(items.map((l) => Number(/^(\d+)/.exec(l)?.[1]))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const item4 = items[3] ?? "";
    expect(item4).toContain("呼び出し元");
    expect(item4).toContain("再現テスト");
    expect(item4).toContain("頼まれていない整理");
  });

  it("レビュー役の定義の項目の数は8のまま", async () => {
    const reviewer =
      (await sec())
        .split("**agents/code-reviewer.md**")[1]
        ?.split("**agents/review-verifier.md**")[0] ?? "";
    const nums = reviewer
      .split("\n")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("レビューの観点の決まりに、導入先に固有の観点は導入先の文書に置く1項目がある", async () => {
    const s = await sec();
    const rule = s.slice(s.indexOf("**レビューの観点の決まり**"));
    const bullets = rule.split("\n").filter((l) => l.startsWith("- "));
    const hits = bullets.filter((l) => l.includes("導入先に固有の観点"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("`.orca-flow/review.md`");
    expect(hits[0]).toContain("先に読む文書");
    expect(bullets).toHaveLength(8);
  });
});

describe("定義・スキル・テンプレートに固有の製品の名前を入れない", () => {
  for (const rel of [
    "agents/code-reviewer.md",
    "agents/task-worker.md",
    "skills/spec/SKILL.md",
    "templates/spec-template.md",
  ]) {
    it(rel, async () => {
      const body = await read(rel);
      for (const name of PRODUCT_NAMES) {
        expect(body.toLowerCase(), name).not.toContain(name.toLowerCase());
      }
    });
  }
});
