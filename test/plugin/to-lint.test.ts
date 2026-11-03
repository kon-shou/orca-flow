import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 「N. 」で始まる手順の行と、その下のインデントされた行をまとめる。 */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  const out = [lines[start] as string];
  for (const l of lines.slice(start + 1)) {
    if (/^\s+\S/.test(l) || l.trim() === "") out.push(l);
    else break;
  }
  return out.join("\n");
}

const HEADINGS = [
  "道具",
  "決まりの置き場",
  "足し方",
  "確かめ方",
  "流すコマンド",
];

describe("to-lint：スキル", () => {
  it("frontmatter に name と disable-model-invocation がある", async () => {
    const text = await read("skills/to-lint/SKILL.md");
    const fm = text.split("---")[1] ?? "";
    expect(fm).toMatch(/^name: to-lint$/m);
    expect(fm).toMatch(/^disable-model-invocation: true$/m);
  });

  it("手順2：終了コード0のときだけ教訓を読み、使えなければ誤りの説明で進む", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 2);
    expect(b).toContain("終了コード0で使えるときだけ教訓を読む");
    expect(b).toContain("渡された文を誤りの説明として扱う");
    expect(b).toContain("人に誤りの説明を聞いて待つ");
    expect(b).toContain("終了コードが0でない・サブコマンドがない");
  });

  it("手順3：3つの分け方があり、lint にできる以外ではそれぞれ止まる", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 3);
    const lines = b.split("\n");
    const test = lines.find((l) => l.includes("「テストにする」")) ?? "";
    const md = lines.find((l) => l.includes("「md に残す」")) ?? "";
    expect(lines.some((l) => l.includes("「lint にできる」"))).toBe(true);
    expect(test).toContain("/orca-flow:new");
    expect(test).toContain("止まる");
    expect(md).toContain("止まる");
    expect(b).toContain(
      "「lint にできる」以外では、ここで止まる（new を流さない）",
    );
  });

  it("手順4：baseBranch の lint.md を読み、なければ雛形から人に聞いて作る", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 4);
    expect(b).toContain("`git show 〈baseBranch〉:.orca-flow/lint.md`");
    expect(b).not.toContain("git show main:");
    expect(b).toContain("${CLAUDE_PLUGIN_ROOT}/templates/lint.md");
    expect(b).toContain("人に聞いて作る");
    expect(b).toContain("道具を入れるタスクを勧めて止まる");
  });

  it("手順4：lint.md の下書きは mktemp -d の外のディレクトリに Write で書き、消す", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 4);
    expect(b).toContain("`mktemp -d`");
    expect(b).toContain("Write ツールで書く");
    expect(b).toContain("ヒアドキュメントや echo で書かない");
    expect(b).toContain(
      "コミットしたあとも、止まるときも、そのディレクトリを消す",
    );
  });

  it("手順4：統括役の場所の3つの条件を確かめ、満たさなければ止まる", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 4);
    expect(b).toContain("`git branch --show-current` が baseBranch");
    expect(b).toContain("`git rev-parse --git-common-dir` が `.git`");
    expect(b).toContain("`git status --porcelain --untracked-files=no` が空");
    expect(b).toContain("満たさなければ、人に伝えて止まる");
  });

  it("手順4：lint.md だけを add し、統括役の名前の件名でコミットし、push しない", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 4);
    expect(b).toContain("`git add -- .orca-flow/lint.md` だけを add し");
    expect(b).toContain(
      "件名 `〈integratorName〉: lint の決まりの足し方を置く` でコミットする",
    );
    expect(b).toContain("push はしない");
  });

  it("手順5：流すコマンドが verify か pathVerify になければ、事前変更として足すと書く", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 5);
    expect(b).toContain("設定の verify か pathVerify のコマンドにあるかを見る");
    expect(b).toContain("「main への事前変更」");
    expect(b).toContain("`.orca-flow/config.json` の verify に");
  });

  it("手順6：new を --request-file で流し、依頼に例・理由・教訓から消す1行を入れる", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 6);
    expect(b).toContain("skills/new/SKILL.md");
    expect(b).toContain("--request-file");
    expect(b).toContain("落ちる例");
    expect(b).toContain("通る例");
    const msg =
      b.split("\n").find((l) => l.includes("決まりのメッセージ")) ?? "";
    expect(msg).toContain("教訓の決まりと理由を短く入れる");
    expect(b).toContain("main に入ったら教訓から消す：");
    expect(b).toContain("`orca-flow lessons remove`");
    expect(b).toContain("「main への事前変更」の節");
  });

  it("手順6：タスク名は一重引用符で囲み、二重引用符で囲まない", async () => {
    const b = stepBlock(await read("skills/to-lint/SKILL.md"), 6);
    expect(b).toContain("--title '〈タスク名〉'");
    expect(b).not.toContain('--title "');
    expect(b).toContain("中の ' は '\\'' にする");
  });

  it("5つの見出しの名前を使い、タスクの worktree を書き換えない", async () => {
    const text = await read("skills/to-lint/SKILL.md");
    for (const h of HEADINGS) expect(text, h).toContain(`「${h}」`);
    expect(text).toContain("worktree の中のファイルを");
  });
});

describe("to-lint：雛形", () => {
  it("templates/lint.md が5つの見出しをこの順に持つ", async () => {
    const text = await read("templates/lint.md");
    const found = text
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).trim());
    expect(found).toEqual(HEADINGS);
  });

  it("例の道具と、確かめ方の落ちる例・通る例の置き場がある", async () => {
    const text = await read("templates/lint.md");
    for (const w of ["ESLint", "ruff", "semgrep", "ast-grep", "スクリプト"]) {
      expect(text, w).toContain(w);
    }
    expect(text).toContain("落ちる例");
    expect(text).toContain("通る例");
  });
});
