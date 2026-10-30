import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 設計書の要点に書く行。spec と review で同じ文字を使う */
const POINT_LINE = "- コードレビュー：テストだけ（観点を絞る）";
/** 文書だけの宣言の行（文書だけが先） */
const DOCS_LINE = "- コードレビュー：文書だけ（軽く回す）";

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** `## 見出し` から次の `## ` の前まで */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

/** 手順の行（`〈数〉. ` で始まる行）から、次の手順の行の前まで */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}がありません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (l, i) => i > start && new RegExp(`^${n + 1}\\. `).test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

async function testOnlySection(): Promise<string> {
  return section(await read("skills/review/SKILL.md"), /^## テストだけ/);
}

describe("review のテストだけの節", () => {
  it("見分け方に条件が書いてある", async () => {
    const s = await testOnlySection();
    expect(s).toContain(`\`${POINT_LINE}\``);
    expect(s).toMatch(/codeReview が full/);
    expect(s).toContain("reviewBackend が claude");
    expect(s).toContain("sharedPaths");
    expect(s).toContain("pathVerify");
    expect(s).toContain("`〈baseBranch〉...HEAD`");
    expect(s).toContain("文書だけの判定が先");
    expect(s).toContain("1つでも外れたら");
  });

  it("テストのファイルの見分け方が名前つきで1か所に書いてある", async () => {
    const text = await read("skills/review/SKILL.md");
    const lines = text
      .split("\n")
      .filter((l) => l.startsWith("テストのファイルの見分け方："));
    expect(lines.length).toBe(1);
    const line = lines[0] as string;
    for (const word of [
      "test/",
      "tests/",
      "__tests__/",
      "__snapshots__/",
      "*.test.*",
      "*.spec.*",
      "*_test.*",
      "test_*.py",
      "helpers",
      "fixtures",
      "snapshot",
      "vitest.config.ts",
    ]) {
      expect(line, word).toContain(word);
    }
  });

  it("回し方に、2つの観点・レビュー役の数・検証役がある", async () => {
    const s = await testOnlySection();
    expect(s).toContain("正しさとテストの2つだけ");
    expect(s).toContain("小さな差分のしきい値まではレビュー役を1つ");
    expect(s).toContain("超えたら");
    expect(s).toContain("2つ並べ");
    expect(s).toContain("検証役を起動する");
  });

  it("やり直しの形では検証役を起動し、秘密と個人のパスの確かめも流し直す", async () => {
    const s = await testOnlySection();
    const line = s
      .split("\n")
      .find((l) => l.startsWith("やり直しの形（テストだけ）"));
    expect(line).toBeDefined();
    expect(line).toContain("検証役を起動");
    expect(line).toContain("秘密と個人のパスの確かめ");
    expect(line).toContain("流し直");
  });

  it("文書だけの判定が先で、文書だけの節は残っている", async () => {
    const text = await read("skills/review/SKILL.md");
    expect(text).toContain(`\`${DOCS_LINE}\``);
    expect(text.indexOf("## 文書だけ")).toBeLessThan(
      text.indexOf("## テストだけ"),
    );
    expect(text).toContain("文書だけ（検証役なし）");
  });
});

describe("テストでないファイルの一覧のコマンド", () => {
  async function command(): Promise<string> {
    const lines = (await read("skills/review/SKILL.md"))
      .split("\n")
      .filter((l) => l.startsWith("テストでないファイルの一覧："));
    expect(lines.length).toBe(1);
    const found = [...(lines[0] as string).matchAll(/`([^`]*)`/g)];
    expect(found.length, "バッククォートの中のコマンドは1つ").toBe(1);
    const cmd = (found[0] as RegExpMatchArray)[1] as string;
    expect(cmd).toContain("--no-renames");
    return cmd
      .replaceAll("〈baseBranch〉", "main")
      .replaceAll("〈tasksDir〉", "docs/tasks")
      .replaceAll("〈reportsDir〉", "docs/tasks/reports")
      .replaceAll("〈ID〉", "T1");
  }

  const BASE = {
    "src/a.ts": "a\n",
    "keep.txt": "keep\n",
    "docs/tasks/T1.md": "# 設計書\n",
    "src/old.ts": "one\ntwo\nthree\nfour\n",
  };

  /** base に BASE を置き、work で files を書き足して、コマンドが出すファイル（並べ替え済み） */
  async function listed(
    files: Record<string, string>,
    move?: [string, string],
  ): Promise<string[]> {
    const dir = await makeRepo({}, BASE);
    await git(dir, "checkout", "-q", "-b", "work");
    await writeFiles(dir, files);
    if (move) {
      await mkdir(path.dirname(path.join(dir, move[1])), { recursive: true });
      await git(dir, "mv", move[0], move[1]);
    }
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "change");
    const result = await testRunner("sh", ["-c", await command()], {
      cwd: dir,
    });
    expect(result.code, result.stderr).toBe(0);
    return [
      ...new Set(result.stdout.split("\n").filter((l) => l !== "")),
    ].sort();
  }

  it("git が落ちたら、出力が空でも終了コードが0にならない（テストだけに見せない）", async () => {
    const dir = await makeRepo({}, BASE);
    // main のない木：1つ目の git diff が落ちる
    await git(dir, "checkout", "-q", "-b", "work");
    await git(dir, "branch", "-q", "-D", "main");
    const result = await testRunner("sh", ["-c", await command()], {
      cwd: dir,
    });
    expect(result.code).not.toBe(0);
    const text = await read("skills/review/SKILL.md");
    expect(text).toContain("終了コードが0で、出力が空ならテストだけ");
  });

  it("テストのファイルと設計書・報告だけの差分では何も出ない", async () => {
    const out = await listed({
      "test/a.test.ts": "x\n",
      "test/helpers/repo.ts": "x\n",
      "test/fixtures/data.json": "{}\n",
      "test/__snapshots__/a.snap": "x\n",
      "tests/b.ts": "x\n",
      "pkg/__tests__/c.ts": "x\n",
      "pkg/__snapshots__/d.snap": "x\n",
      "src/deep/test/e.ts": "x\n",
      "src/f.test.ts": "x\n",
      "src/g.spec.js": "x\n",
      "src/h_test.go": "x\n",
      "scripts/test_i.py": "x\n",
      "a.test.ts": "x\n",
      "docs/tasks/T1.md": "# 設計書\n変えた\n",
      "docs/tasks/reports/T1.md": "# 報告\n",
    });
    expect(out).toEqual([]);
  });

  it("テストでないファイルが混ざると、それが出る", async () => {
    const out = await listed({
      "test/a.test.ts": "x\n",
      "src/a.ts": "changed\n",
      "vitest.config.ts": "x\n",
      "skills/spec/SKILL.md": "x\n",
      "docs/spec.md": "x\n",
      "scripts/test.sh": "x\n",
      "scripts/test_i.sh": "x\n",
      "src/test-utils/b.ts": "x\n",
      "src/latest/a.ts": "x\n",
      "src/testing.ts": "x\n",
      "docs/tasks/T2.md": "別のタスクの設計書\n",
    });
    expect(out).toEqual(
      [
        "docs/spec.md",
        "docs/tasks/T2.md",
        "scripts/test.sh",
        "scripts/test_i.sh",
        "skills/spec/SKILL.md",
        "src/a.ts",
        "src/latest/a.ts",
        "src/test-utils/b.ts",
        "src/testing.ts",
        "vitest.config.ts",
      ].sort(),
    );
  });

  it("秘密を置くファイルは、テストの場所の下でも名前が test でも出る", async () => {
    const out = await listed({
      "test/a.test.ts": "x\n",
      ".env.test.local": "x\n",
      "test/.env": "x\n",
      "test/id_rsa": "x\n",
      "test/fixtures/server.pem": "x\n",
      "tests/api.key": "x\n",
    });
    expect(out).toEqual(
      [
        ".env.test.local",
        "test/.env",
        "test/fixtures/server.pem",
        "test/id_rsa",
        "tests/api.key",
      ].sort(),
    );
  });

  it("src/old.ts から test/a.ts への移動では、移動元が出る", async () => {
    const out = await listed({}, ["src/old.ts", "test/a.ts"]);
    expect(out).toEqual(["src/old.ts"]);
  });
});

describe("手順の分かれ道", () => {
  it("手順1・3・4・7・9に、テストだけの分かれ道がある", async () => {
    const text = await read("skills/review/SKILL.md");
    for (const n of [1, 3, 4, 7, 9]) {
      expect(stepBlock(text, n), `手順${n}`).toContain("テストだけ");
    }
    expect(stepBlock(text, 1)).toContain("sharedPaths");
    expect(stepBlock(text, 3)).toContain("正しさとテスト");
  });

  it("手順4で、指摘が0件の行より前に秘密と個人のパスの確かめを流す", async () => {
    const step4 = stepBlock(await read("skills/review/SKILL.md"), 4);
    const at = step4.indexOf("テストだけ");
    expect(at).toBeGreaterThan(-1);
    const rest = step4.slice(at);
    const check = rest.indexOf("秘密と個人のパスの確かめ");
    expect(check).toBeGreaterThan(-1);
    expect(rest).toContain("指摘の有無によらず");
    expect(check).toBeLessThan(rest.indexOf("指摘が1つもなければ"));
  });

  it("手順7で、テストだけのやり直しは検証役と確かめの流し直しをする", async () => {
    const step7 = stepBlock(await read("skills/review/SKILL.md"), 7);
    expect(step7).toContain("テストだけ");
    expect(step7).toContain("秘密と個人のパスの確かめ");
  });

  it("件数に「テストだけで絞った」と書き、「未実施」と書かない", async () => {
    const step9 = stepBlock(await read("skills/review/SKILL.md"), 9);
    const line = step9.split("\n").find((l) => l.includes("テストだけ"));
    expect(line).toBeDefined();
    expect(line).toContain("セキュリティ・設計・運用と互換性");
    expect(line).toContain("テストだけで絞った");
    expect(line).toMatch(/「未実施」と書かない/);
  });

  it("手順6で未実施にする観点は渡した観点の全部で、テストだけは残る3つを絞ったままにする", async () => {
    const step6 = stepBlock(await read("skills/review/SKILL.md"), 6);
    expect(step6).toContain("渡した観点の全部");
    expect(step6).not.toContain("5つとも");
    expect(step6).toContain("「テストだけで絞った」のまま");
  });

  it("手順3で、テストだけの観点の数（2つ）が書き分けてある", async () => {
    const step3 = stepBlock(await read("skills/review/SKILL.md"), 3);
    expect(step3).toContain("テストだけなら正しさとテストの2つ");
    expect(step3).toContain("テストだけなら2つの観点ごとに2つ並べる");
    const opens = step3.split("（").length;
    const closes = step3.split("）").length;
    expect(opens).toBe(closes);
  });

  it("手順1で読む設定に reportsDir がある", async () => {
    expect(stepBlock(await read("skills/review/SKILL.md"), 1)).toContain(
      "reportsDir",
    );
  });

  it("見分け方に、秘密を置くファイルはテストのファイルにしないと書いてある", async () => {
    const line = (await read("skills/review/SKILL.md"))
      .split("\n")
      .find((l) => l.startsWith("テストのファイルの見分け方：")) as string;
    for (const w of [
      ".env*",
      "*.pem",
      "*.key",
      "id_rsa*",
      "テストのファイルにしない",
    ]) {
      expect(line, w).toContain(w);
    }
  });

  it("既存の文書だけの確かめの行は1つのまま", async () => {
    const lines = (await read("skills/review/SKILL.md"))
      .split("\n")
      .filter((l) => l.startsWith("秘密と個人のパスの確かめ："));
    expect(lines.length).toBe(1);
  });
});

describe("spec・run のスキル", () => {
  it("spec のスキルに宣言の行と条件がある", async () => {
    const text = await read("skills/spec/SKILL.md");
    expect(text).toContain(`\`${POINT_LINE}\``);
    const line = text.split("\n").find((l) => l.includes(POINT_LINE));
    expect(line).toContain("テストのファイル");
    expect(line).toContain("sharedPaths");
    expect(line).toContain("pathVerify");
    expect(line).toContain("変わること");
    expect(line).toContain("文書だけ");
  });

  it("run の手順8に、テストだけとして観点を絞ったことを書く決まりがある", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 8);
    expect(block).toContain("テストだけとして観点を絞った");
  });
});

describe("レビュー役の定義", () => {
  it("5つより少ない観点の一覧でも観点ごとに分けて返す（5つ全部の行も残る）", async () => {
    const body = await read("agents/code-reviewer.md");
    const line = body
      .split("\n")
      .find((l) => /5つより少ない/.test(l)) as string;
    expect(line).toBeDefined();
    expect(line).toContain("観点ごとに分けて返す");
    expect(body).toMatch(/5つ全部渡されたとき[^\n]*観点ごとに分けて返す/);
  });
});

describe("docs/spec.md のテストだけ", () => {
  it("3章の表の下に書いてある", async () => {
    const spec = await read("docs/spec.md");
    const chapter = spec.slice(spec.indexOf("## 3. "), spec.indexOf("## 4. "));
    expect(chapter).toContain(POINT_LINE);
    expect(chapter).toContain("検証役");
  });

  it("10.1 の spec・review・run の行に書いてある", async () => {
    const rows = (await read("docs/spec.md")).split("\n");
    for (const head of [
      "| `/orca-flow:spec ",
      "| `/orca-flow:review ",
      "| `/orca-flow:run ",
    ]) {
      const row = rows.find((l) => l.startsWith(head));
      expect(row, head).toBeDefined();
      expect(row, head).toContain("テストだけ");
    }
    const specRow = rows.find((l) => l.startsWith("| `/orca-flow:spec "));
    expect(specRow).toContain(POINT_LINE);
  });
});
