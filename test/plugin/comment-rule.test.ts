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

function lineIndex(lines: string[], re: RegExp, from = 0): number {
  const i = lines.findIndex((l, n) => n >= from && re.test(l));
  expect(i, `行が見つかりません：${re}`).toBeGreaterThanOrEqual(0);
  return i;
}

/** 手順の行（`〈数〉. ` で始まる行）から、次の手順の行の前まで */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lineIndex(lines, new RegExp(`^${n}\\. `));
  const end = lines.findIndex(
    (l, i) => i > start && new RegExp(`^${n + 1}\\. `).test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** 手順3の中の「- コメント：」の項目（次の同じ深さの項目の前まで） */
function reviewerCommentItem(body: string): string {
  const lines = body.split("\n");
  const start = lineIndex(lines, /^ {3}- コメント：/);
  const end = lines.findIndex((l, i) => i > start && /^ {3}- \S/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("担当の定義：コメントの決まり", () => {
  it("手順5の下に、コメントの決まりの言葉がある", async () => {
    const body = await read("agents/task-worker.md");
    const step5 = stepBlock(body, 5);
    expect(step5).toContain("コードから読めない理由だけ");
    expect(step5).toContain("何をしているかの言い直しは書かない");
    expect(step5).toContain("そばのコメントも直すか消す");
    expect(step5).toContain("差分の外のコメントは消さない");
    expect(step5).toContain("リポジトリの決まりを優先する");
  });

  it("残してよいものを挙げている", async () => {
    const step5 = stepBlock(await read("agents/task-worker.md"), 5);
    for (const w of [
      "わざとこうしている",
      "公開 API の説明",
      "ライセンスの頭書き",
      "生成ファイルの印",
      "lint や型の抑止の理由",
    ]) {
      expect(step5, w).toContain(w);
    }
  });

  it("手順の番号が 1〜9 のまま並ぶ", async () => {
    const body = await read("agents/task-worker.md");
    const nums = body
      .split("\n")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("レビュー役の定義：コメントの項目", () => {
  it("手順3の「設計：」の後、「テスト：」の前にある", async () => {
    const lines = (await read("agents/code-reviewer.md")).split("\n");
    const step3 = lineIndex(lines, /^3\. /);
    const design = lineIndex(lines, /^ {3}- 設計：/, step3);
    const comment = lineIndex(lines, /^ {3}- コメント：/, step3);
    const test = lineIndex(lines, /^ {3}- テスト：/, step3);
    expect(comment).toBeGreaterThan(design);
    expect(comment).toBeLessThan(test);
  });

  it("見るもの・重さ・差分の外・リポジトリの決まりが書いてある", async () => {
    const item = reviewerCommentItem(await read("agents/code-reviewer.md"));
    expect(item).toContain("コードと食い違うコメント");
    expect(item).toContain("言い直しだけのコメント");
    expect(item).toContain("差分の外");
    expect(item).toContain("リポジトリの決まりを優先する");
    expect(item).toContain("直したほうがよい");
    expect(item).toContain("確認だけ");
    expect(item).toContain("「前からある」をつけない");
  });

  it("残してよいものが担当の定義と同じ言葉で書いてある", async () => {
    const item = reviewerCommentItem(await read("agents/code-reviewer.md"));
    for (const w of [
      "コードから読めない理由",
      "わざとこうしている",
      "公開 API の説明",
      "ライセンスの頭書き",
      "生成ファイルの印",
      "lint や型の抑止の理由",
    ]) {
      expect(item, w).toContain(w);
    }
  });

  it("観点の定義の版が 2026-11-11.3", async () => {
    const body = await read("agents/code-reviewer.md");
    expect(body).toMatch(/^観点の定義の版：2026-11-11\.3$/m);
  });
});

describe("仕様書 10.2：コメントの決まり", () => {
  async function sec(): Promise<string> {
    const spec = await read("docs/spec.md");
    return spec.slice(spec.indexOf("### 10.2 "), spec.indexOf("### 10.3 "));
  }

  it("担当の定義の項目にコメントの決まりがある", async () => {
    const worker = (await sec()).split("**agents/task-reviewer.md**")[0] ?? "";
    const item = worker.split("\n").find((l) => /^\d+\. コメント/.test(l));
    expect(item, "担当の定義にコメントの項目がありません").toBeDefined();
    expect(item).toContain("コメント");
    expect(item).toContain("リポジトリの決まりを優先する");
  });

  it("レビュー役の定義の項目にコメントの決まりがある", async () => {
    const s = await sec();
    const reviewer =
      s
        .split("**agents/code-reviewer.md**")[1]
        ?.split("**agents/review-verifier.md**")[0] ?? "";
    const item = reviewer.split("\n").find((l) => /^\d+\. コメント/.test(l));
    expect(item, "レビュー役の定義にコメントの項目がありません").toBeDefined();
    expect(item).toContain("コメント");
    expect(item).toContain("リポジトリの決まりを優先する");
  });

  it("レビューの観点の決まりの設計の項目が、コメントを見ると書いている", async () => {
    const s = await sec();
    const line = s
      .split("\n")
      .find((l) => l.startsWith("- 5つの観点と判断事項の受け持ち："));
    expect(line).toBeDefined();
    expect(line).toContain("設計の観点はコメントも見る");
  });
});
