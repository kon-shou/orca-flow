import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const TABLE = "ファイルの種類（パターン）ごとに読む決まりの表";
const SKIP = "当たらないものは読まない";

function lineWith(text: string, ...parts: string[]): string {
  const l = text.split("\n").find((x) => parts.every((p) => x.includes(p)));
  expect(l, `行：${parts.join(" / ")}`).toBeDefined();
  return l ?? "";
}

/** 見出し行（`## ` か `### `）から次の同じ深さ以上の見出しの前まで。 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const s = lines.findIndex((l) => l.startsWith(heading));
  expect(s, heading).toBeGreaterThanOrEqual(0);
  const depth = /^#+/.exec(lines[s] ?? "")?.[0].length ?? 2;
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i] ?? "");
    if (m && (m[1]?.length ?? 99) <= depth) {
      e = i;
      break;
    }
  }
  return lines.slice(s, e).join("\n");
}

describe("担当と確認役にも先に読む文書を渡す：run のスキル", () => {
  it("手順1に、先に読む文書の絶対パスを review の手順2と同じにそろえる旨がある", async () => {
    const t = await read("skills/run/SKILL.md");
    const l = lineWith(t, "1. `orca-flow config --json`");
    expect(l).toContain("先に読む文書の絶対パス");
    expect(l).toMatch(/review のスキルの手順2と同じにそろえ/);
  });

  it("手順4の渡すもの、手順6の確認役の起動、担当に直しを戻すところに先に読む文書がある", async () => {
    const t = await read("skills/run/SKILL.md");
    const pass = lineWith(t, "渡すもの：設計書のパス、ID（$0）");
    expect(pass).toContain("先に読む文書");
    expect(pass).toMatch(/起こし直し[^。]*先に読む文書/);
    expect(lineWith(t, "確認役をもう一度起動する")).toMatch(
      /確認役をもう一度起動する[^。]*先に読む文書/,
    );
    expect(lineWith(t, "6. `orca-flow status working")).toContain(
      "先に読む文書",
    );
    expect(lineWith(t, "`mustFix` を直すときは、その場所の担当に")).toContain(
      "先に読む文書",
    );
  });

  it("タスク長が担当の場所を自分で直すときも、当たる条件付きの決まりを読んでから直す", async () => {
    const t = await read("skills/run/SKILL.md");
    const l = lineWith(t, "小さな直し", "先に読む文書", "読んでから直す");
    expect(l).toContain(TABLE);
  });
});

describe("担当と確認役にも先に読む文書を渡す：役の定義", () => {
  it("担当：手順1の下に、渡されたら読む・禁止より優先しない・読まずに進む・場所の外は書かないがある", async () => {
    const t = await read("agents/task-worker.md");
    const l = lineWith(t, "先に読む文書の絶対パスを渡されたら");
    expect(l).toContain("実装の前に全文読み");
    expect(l).toContain("この定義の禁止より優先せず");
    expect(l).toContain("書き込む場所の外は書かない");
    expect(l).toMatch(/渡されない[^。]*読まずに進む/);
    const lines = t.split("\n");
    const i = lines.findIndex((x) => x.startsWith("1. 渡された設計書"));
    const j = lines.findIndex((x) => x.startsWith("2. "));
    const at = lines.indexOf(l);
    expect(at).toBeGreaterThan(i);
    expect(at).toBeLessThan(j);
  });

  it("担当：手順の番号は 1〜9 のまま", async () => {
    const t = await read("agents/task-worker.md");
    const nums = t
      .split("\n")
      .map((x) => /^(\d+)\. /.exec(x)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  const targets: [string, string, string][] = [
    ["agents/task-worker.md", "書き換えるファイル", "新しく作るもの"],
    ["agents/task-reviewer.md", "差分のファイル", ""],
    ["agents/code-reviewer.md", "差分のファイル", ""],
    ["agents/review-verifier.md", "指摘が指すファイル", ""],
    ["agents/stage-verifier.md", "差分のファイル", ""],
  ];
  for (const [f, target, extra] of targets) {
    it(`${f} に、表があれば${target}に当たる決まりだけ読み、当たらないものは読まない旨がある`, async () => {
      const t = await read(f);
      const l = lineWith(t, TABLE);
      expect(l).toContain(target);
      expect(l).toContain(SKIP);
      if (extra) expect(l).toContain(extra);
    });
  }

  it("レビュー役の条件付きの決まりは手順1にあり、手順3・4には足さない", async () => {
    const t = await read("agents/code-reviewer.md");
    const lines = t.split("\n");
    const at = lines.findIndex((x) => x.includes(TABLE));
    const s1 = lines.findIndex((x) => x.startsWith("1. "));
    const s2 = lines.findIndex((x) => x.startsWith("2. "));
    expect(at).toBeGreaterThan(s1);
    expect(at).toBeLessThan(s2);
  });

  it("確認役の手順3の「リポジトリの決まり」に先に読む文書がある", async () => {
    const t = await read("agents/task-reviewer.md");
    const l = lineWith(t, "リポジトリの決まり：");
    expect(l).toContain("先に読む文書");
    expect(lineWith(t, "先に読む文書の絶対パスを渡されたら")).toMatch(
      /渡されない[^。]*読まずに進む/,
    );
  });
});

describe("担当と確認役にも先に読む文書を渡す：仕様書", () => {
  it("3章の箇条書きに1項ある", async () => {
    const t = await read("docs/spec.md");
    const sec = section(t, "## 3. 役割");
    const l = lineWith(sec, "- タスク長は", "先に読む文書", "担当と確認役");
    expect(l).toContain(TABLE);
    expect(l).toContain(SKIP);
    expect(l).toContain("readFirst に足さず");
    expect(l).toContain("書き込んでよい場所");
    expect(l).toContain("orca-flow の禁止");
  });

  it("6章の readFirst の行に担当と確認役がある", async () => {
    const t = await read("docs/spec.md");
    const l = lineWith(t, "| readFirst ");
    expect(l).toContain("担当");
    expect(l).toContain("確認役");
    expect(l).toContain("3章");
  });

  it("10.1 に段落があり、run の行は変えない", async () => {
    const t = await read("docs/spec.md");
    const sec = section(t, "### 10.1 スキル");
    const l = lineWith(sec, "**先に読む文書を担当と確認役に渡す**");
    expect(l).toContain("review のスキルの手順2と同じにそろえ");
    expect(l).toContain("起こし直す");
    expect(lineWith(sec, "| `/orca-flow:run 〈ID〉`")).not.toContain(
      "担当と確認役",
    );
  });

  it("10.2 の5つの定義の項にそれぞれ足してある", async () => {
    const t = await read("docs/spec.md");
    const sec = section(t, "### 10.2 担当の定義");
    const worker = lineWith(sec, "先に読む文書", "書き換えるファイル");
    expect(worker).toContain(TABLE);
    expect(worker).toContain("この定義の禁止より優先");
    expect(worker).toContain(SKIP);
    const reviewer = lineWith(sec, "**agents/task-reviewer.md**");
    expect(reviewer).toContain("先に読む文書");
    expect(reviewer).toContain("差分のファイル");
    const code = lineWith(sec, "3. リポジトリの決まりは");
    expect(code).toContain("差分のファイル");
    const verifier = lineWith(sec, "4. リポジトリの決まり・渡された教訓");
    expect(verifier).toContain("指摘が指すファイル");
    const stage = lineWith(sec, "**agents/stage-verifier.md**");
    expect(stage).toContain("先に読む文書");
    expect(stage).toContain("差分のファイル");
    for (const l of [reviewer, code, verifier, stage]) {
      expect(l).toContain(TABLE);
      expect(l).toContain(SKIP);
    }
  });
});
