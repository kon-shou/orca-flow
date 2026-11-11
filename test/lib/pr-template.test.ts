import { describe, expect, it } from "vitest";
import {
  findPrTemplate,
  headingsOf,
  missingHeadings,
} from "../../src/lib/pr-template.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const find = (root: string, ref = "main") =>
  findPrTemplate(testRunner, root, ref);

describe("PR のテンプレートを探す", () => {
  it(".github/pull_request_template.md を見つけてパスと中身を返す", async () => {
    const root = await makeRepo(
      {},
      {
        ".github/pull_request_template.md": "## 概要\n",
      },
    );
    expect(await find(root)).toEqual({
      kind: "one",
      template: {
        path: ".github/pull_request_template.md",
        content: "## 概要\n",
      },
    });
  });

  it("名前の大文字小文字と拡張子（.md・.txt・なし）を問わない", async () => {
    for (const name of [
      "PULL_REQUEST_TEMPLATE.md",
      "Pull_Request_Template.txt",
      "PULL_REQUEST_TEMPLATE",
    ]) {
      const root = await makeRepo({}, { [name]: "本文\n" });
      const found = await find(root);
      expect(found.kind).toBe("one");
      if (found.kind === "one") expect(found.template.path).toBe(name);
    }
  });

  it(".github/ → 直下 → docs/ の順で最初の1つを使う", async () => {
    const files = {
      "docs/pull_request_template.md": "docs\n",
      "pull_request_template.md": "root\n",
      ".github/pull_request_template.md": "github\n",
    };
    const root = await makeRepo({}, files);
    const found = await find(root);
    expect(found.kind === "one" && found.template.content).toBe("github\n");

    const root2 = await makeRepo(
      {},
      {
        "docs/pull_request_template.md": "docs\n",
        "pull_request_template.md": "root\n",
      },
    );
    const found2 = await find(root2);
    expect(found2.kind === "one" && found2.template.content).toBe("root\n");

    const root3 = await makeRepo(
      {},
      { "docs/pull_request_template.md": "docs\n" },
    );
    const found3 = await find(root3);
    expect(found3.kind === "one" && found3.template.path).toBe(
      "docs/pull_request_template.md",
    );
  });

  it("1つのファイルがなく、PULL_REQUEST_TEMPLATE/ の下に1つならそれを使う", async () => {
    const root = await makeRepo(
      {},
      {
        ".github/pull_request_template/only.md": "only\n",
      },
    );
    const found = await find(root);
    expect(found).toEqual({
      kind: "one",
      template: {
        path: ".github/pull_request_template/only.md",
        content: "only\n",
      },
    });
  });

  it("2つ以上なら全部を候補として返し、.md 以外は数えない", async () => {
    const root = await makeRepo(
      {},
      {
        ".github/PULL_REQUEST_TEMPLATE/b.md": "b\n",
        ".github/PULL_REQUEST_TEMPLATE/a.md": "a\n",
        ".github/PULL_REQUEST_TEMPLATE/c.txt": "c\n",
      },
    );
    const found = await find(root);
    expect(found.kind).toBe("many");
    if (found.kind === "many")
      expect(found.templates.map((t) => t.path)).toEqual([
        ".github/PULL_REQUEST_TEMPLATE/a.md",
        ".github/PULL_REQUEST_TEMPLATE/b.md",
      ]);
  });

  it("直下や docs/ の PULL_REQUEST_TEMPLATE/ の下に1つならそれを使う", async () => {
    for (const p of [
      "PULL_REQUEST_TEMPLATE/x.md",
      "docs/PULL_REQUEST_TEMPLATE/x.md",
    ]) {
      const root = await makeRepo({}, { [p]: "x\n" });
      expect(await find(root)).toEqual({
        kind: "one",
        template: { path: p, content: "x\n" },
      });
    }
  });

  it("PULL_REQUEST_TEMPLATE/ が複数の場所にあれば、場所の順（直下 → docs/）で並べる", async () => {
    const root = await makeRepo(
      {},
      {
        "docs/PULL_REQUEST_TEMPLATE/x.md": "docs\n",
        "pull_request_template/y.md": "root\n",
      },
    );
    const found = await find(root);
    expect(found.kind).toBe("many");
    if (found.kind === "many")
      expect(found.templates.map((t) => t.path)).toEqual([
        "pull_request_template/y.md",
        "docs/PULL_REQUEST_TEMPLATE/x.md",
      ]);
  });

  it("1つのファイルがあれば PULL_REQUEST_TEMPLATE/ の下は見ない", async () => {
    const root = await makeRepo(
      {},
      {
        "docs/pull_request_template.md": "file\n",
        ".github/PULL_REQUEST_TEMPLATE/a.md": "a\n",
        ".github/PULL_REQUEST_TEMPLATE/b.md": "b\n",
      },
    );
    const found = await find(root);
    expect(found.kind === "one" && found.template.content).toBe("file\n");
  });

  it("ないと none", async () => {
    const root = await makeRepo({}, { "docs/other.md": "x\n" });
    expect(await find(root)).toEqual({ kind: "none" });
  });

  it("作業ツリーだけの変更や別のブランチのテンプレートは見ない", async () => {
    const root = await makeRepo({}, {});
    await writeFiles(root, {
      ".github/pull_request_template.md": "未コミット\n",
    });
    expect(await find(root)).toEqual({ kind: "none" });
    await git(root, "switch", "--quiet", "-c", "other");
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "テンプレート");
    await git(root, "switch", "--quiet", "main");
    expect(await find(root, "main")).toEqual({ kind: "none" });
    expect((await find(root, "other")).kind).toBe("one");
  });
});

describe("見出しの確かめ", () => {
  it("<!-- --> の中とコードの囲みの中の # の行を数えない", () => {
    const text = [
      "## 概要",
      "<!--",
      "## 消える見出し",
      "-->",
      "```",
      "## コードの中",
      "```",
      "~~~md",
      "## 波線の中",
      "~~~",
      "### 確認 ###",
      "#タグ",
      "",
    ].join("\n");
    expect(headingsOf(text)).toEqual(["概要", "確認"]);
  });

  it("欠けた見出しを返し、揃えば null", () => {
    const t = { path: "t.md", content: "## 概要\n## 確認\n" };
    expect(missingHeadings("## 概要\n本文\n", [t])).toEqual({
      path: "t.md",
      missing: ["確認"],
    });
    expect(missingHeadings("## 確認\n## 概要\n## 補足\n", [t])).toBeNull();
  });

  it("候補が複数のときは、どれか1つが揃えば null", () => {
    const a = { path: "a.md", content: "## 甲\n## 乙\n" };
    const b = { path: "b.md", content: "## 丙\n" };
    expect(missingHeadings("## 丙\n", [a, b])).toBeNull();
    expect(missingHeadings("## 甲\n## 丁\n", [a, b])).toEqual({
      path: "a.md",
      missing: ["乙"],
    });
  });

  it("テンプレートがなければ null", () => {
    expect(missingHeadings("本文", [])).toBeNull();
  });
});
