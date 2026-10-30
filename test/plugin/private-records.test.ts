import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

// タスクの番号（idPrefix の P と数字の形）を文書に書かない。
const TASK_ID = /\bP\d{2,}\b/;

describe("タスクの記録を公開に出さない：スキル", () => {
  for (const name of ["spec", "run"]) {
    it(`${name} は、無視されていれば記録をコミットしない`, async () => {
      const text = await read(`skills/${name}/SKILL.md`);
      expect(text).toContain("無視されていればコミットしない");
      expect(text).toContain("git check-ignore -q");
      expect(text).not.toMatch(TASK_ID);
    });
  }

  it("spec は、無視されていれば設計書のタブを開いてあると案内する", async () => {
    const text = await read("skills/spec/SKILL.md");
    expect(text).toContain("設計書のタブを開いてあります");
    expect(text).toContain("右クリックし、『Markdown プレビューを開く』");
  });

  it("run は、報告をコミットしないとき verify を流し直さない", async () => {
    const text = await read("skills/run/SKILL.md");
    expect(text).toContain("HEAD が動かず手順5の記録がそのまま使えるので");
  });

  for (const name of ["approve", "integrate", "new"]) {
    it(`${name} は、無視されていればファイルを読む`, async () => {
      const text = await read(`skills/${name}/SKILL.md`);
      expect(text).toContain("無視されていればファイルを読む");
      expect(text).toContain("git check-ignore -q");
      expect(text).not.toMatch(TASK_ID);
    });
  }

  it("approve は、無視された設計書の blob を git hash-object で求める", async () => {
    const text = await read("skills/approve/SKILL.md");
    expect(text).toContain("git hash-object -w 〈タスクの worktree〉");
  });

  it("spec と run は、確かめてからコミットし、git add -f を使わない", async () => {
    for (const name of ["spec", "run"]) {
      const text = await read(`skills/${name}/SKILL.md`);
      expect(text).toContain("`git add -f` は使わない");
      expect(text.indexOf("git check-ignore -q")).toBeLessThan(
        text.indexOf("git add 〈"),
      );
    }
  });

  it("integrate は、無視された報告を直すときコミットさせない", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).toContain("報告が無視されていればコミットしない");
  });

  it("integrate と new は、元の報告をメインの作業ツリーのパスで指す", async () => {
    for (const name of ["integrate", "new"]) {
      const text = await read(`skills/${name}/SKILL.md`);
      expect(text).toContain("メインの作業ツリーの `〈reportsDir〉/");
    }
  });
});

describe("タスクの記録を公開に出さない：仕様と使い方", () => {
  it("仕様に、コミットしない・写す・タブで開く・移り方が書いてある", async () => {
    const text = await read("docs/spec.md");
    expect(text).toContain("`git check-ignore -q 〈パス〉`");
    expect(text).toContain("メインの作業ツリーの同じ相対パスへ写す");
    expect(text).toContain("orca file open");
    expect(text).toContain("git rm -r --cached");
    expect(text).toContain("trackedRecords");
    expect(text).toContain("refs/orca-flow/");
    expect(text).toContain("git commit-tree");
    expect(text).not.toMatch(TASK_ID);
  });

  it("README に、記録が既定で公開に出ないことが書いてある", async () => {
    const text = await read("README.md");
    expect(text).toContain("既定で公開に出ません");
    expect(text).not.toMatch(TASK_ID);
  });

  it("仕様の12章に、控えを上書きしない形・ブランチとタグ・checkout の注意・config を直したあとの手順がある", async () => {
    const text = await read("docs/spec.md");
    expect(text).toContain('refs/orca-flow/before-squash 〈前の先頭〉 ""');
    expect(text).toContain("`--tags`");
    expect(text).toContain("`git checkout`・`git switch` しない");
    expect(text).toContain("`init --yes` をもう一度流して行を確かめ");
    const readme = await read("README.md");
    expect(readme).toContain("`init --yes` をもう一度流して行を確かめ");
  });
});
