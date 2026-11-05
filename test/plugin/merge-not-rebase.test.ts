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

/** 見出しに当たる行から、次の「## 」の前までを返す。 */
function chapter(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const SKILLS = ["run", "integrate", "spec", "approve", "push", "review"];

describe("main の取り込みは rebase でなく merge", () => {
  for (const name of SKILLS) {
    it(`skills/${name}/SKILL.md に「git rebase」の指示がない`, async () => {
      const text = await read(`skills/${name}/SKILL.md`);
      expect(text).not.toMatch(/git rebase/);
    });
  }

  it("仕様書の2・6・7・8・10章に「git rebase」の指示がない", async () => {
    const spec = await read("docs/spec.md");
    for (const n of [2, 6, 7, 8, 10]) {
      const ch = chapter(spec, new RegExp(`^## ${n}\\. `));
      expect(ch, `${n}章`).not.toMatch(/git rebase/);
      expect(ch, `${n}章`).not.toMatch(/git rebase 〈baseBranch〉/);
    }
  });

  it("13章の GitHub のマージの方式の行は変えない", async () => {
    const ch = chapter(await read("docs/spec.md"), /^## 13\. /);
    expect(ch).toContain("マージの方式（merge・squash・rebase）");
  });

  it("8章の integrate の行に「git merge 〈baseBranch〉」がある", async () => {
    const ch = chapter(await read("docs/spec.md"), /^## 8\. /);
    const line = ch.split("\n").find((l) => l.startsWith("| `integrate"));
    expect(line).toBeDefined();
    expect(line).toContain("git merge 〈baseBranch〉");
  });

  it("run の競合の直し方に git merge 〈baseBranch〉 と git commit --no-edit がある", async () => {
    const text = await read("skills/run/SKILL.md");
    const line = text.split("\n").find((l) => /^\s*- 3（/.test(l));
    expect(line, "終了コード3の行が見つかりません").toBeDefined();
    expect(line).toContain("git merge 〈baseBranch〉");
    expect(line).toContain("git add");
    expect(line).toContain("git commit --no-edit");
    expect(text).not.toContain("--continue");
  });

  it("run の直しのやり直しは 〈直す前のコミット〉..〈直し終わりの先頭〉 を使い、HEAD~〈数〉 で求めない", async () => {
    const text = await read("skills/run/SKILL.md");
    expect(text).toContain("〈直す前のコミット〉..〈直し終わりの先頭〉");
    expect(text).not.toMatch(/HEAD~/);
    expect(text).not.toContain("直しのコミットの数");
    const review = await read("skills/review/SKILL.md");
    expect(review).not.toMatch(/HEAD~/);
  });

  it("push の期待値の説明は「履歴を書き換えたあと」にしている", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("履歴を書き換えたあと（手で rebase したときなど）");
    expect(text).toContain("--force-with-lease");
  });
});
