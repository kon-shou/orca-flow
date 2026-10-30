import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
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

describe("スキルの文", () => {
  it("init は、手順1で .gitignore を見せ、手順3で config.json を直したら流し直し、手順6で .gitignore もコミットする", async () => {
    const text = await read("skills/init/SKILL.md");
    const step = (n: number) => {
      const start = text.indexOf(`\n${n}. `);
      const end = text.indexOf(`\n${n + 1}. `);
      return text.slice(start, end === -1 ? undefined : end);
    };
    expect(step(1)).toContain(".gitignore");
    expect(step(1)).toContain("追跡中の記録");
    expect(step(3)).toContain(
      "config.json を直したら、必ず `orca-flow init --yes` をもう一度流して",
    );
    expect(step(6)).toContain(".gitignore");
    expect(text).not.toMatch(TASK_ID);
  });

  it("スキルの `orca-flow` で始まるインラインのコードは、二重引用符を偶数個持つ", async () => {
    const dir = path.join(ROOT, "skills");
    const bad: string[] = [];
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = await readFile(file, "utf8");
      for (const m of text.matchAll(/`(orca-flow[^`\n]*)`/g)) {
        const quotes = (m[1]!.match(/"/g) ?? []).length;
        if (quotes % 2 !== 0) bad.push(`${name}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
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
