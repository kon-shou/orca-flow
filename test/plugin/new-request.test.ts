import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

describe("依頼の全文の受け渡し", () => {
  it("new のスキルは全文を一時ファイルに書き、--request-file で渡す", async () => {
    const text = await read("skills/new/SKILL.md");
    expect(text).toContain("--request-file");
    expect(text).toMatch(/一時ファイル/);
    expect(text).toMatch(/全文/);
  });

  it("new のスキルは mktemp -d と Write ツールで書き、15秒ほどかかることと一時ディレクトリを消すことを書く", async () => {
    const text = await read("skills/new/SKILL.md");
    expect(text).toContain("mktemp -d");
    expect(text).toContain("Write ツール");
    expect(text).toMatch(/ヒアドキュメント.*書かない/);
    expect(text).toContain("15秒ほど");
    expect(text).toMatch(/終了コードにかかわらず.*一時ディレクトリを消す/);
  });

  it("spec のスキルの手順1は依頼のファイルを読み、なければ今までどおり進む", async () => {
    const text = await read("skills/spec/SKILL.md");
    const step1 = text.split("\n").find((l) => /^1\. /.test(l)) ?? "";
    expect(step1).toContain("orca-flow/requests/");
    expect(step1).toContain("--git-common-dir");
    expect(step1).toContain("今までどおり");
  });
});
