import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 見出しに当たる行から、次の「## 」の見出しの前までを返す。 */
function chapter(text: string, no: number): { heading: string; body: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return {
    heading: lines[start] ?? "",
    body: (end < 0 ? rest : rest.slice(0, end)).join("\n"),
  };
}

// このリポジトリのタスクの番号の形（idPrefix の P のあとに数字）。
// 自分のファイルに番号の形を書かないよう、実行時に組む。
const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);

describe("公開の木：docs/spec.md の13章・14章", () => {
  it("14章は「契約のファイル」の見出しで、作る順番の表がない", async () => {
    const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    const c = chapter(text, 14);
    expect(c.heading).toBe("## 14. 契約のファイル（このリポジトリの開発）");
    expect(c.body).toContain("`src/cli.ts`");
    expect(c.body).not.toMatch(/^\| ID /m);
    expect(c.body).not.toMatch(idForm);
  });

  it("13章の見出しにタスクの番号の形がない", async () => {
    const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    const c = chapter(text, 13);
    expect(c.heading).toBe("## 13. まだ確かめていないこと");
    expect(c.heading).not.toMatch(idForm);
  });

  it("spec.md 全体にタスクの番号の形がない", async () => {
    const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    const hits = text.split("\n").filter((l) => idForm.test(l));
    expect(hits).toEqual([]);
  });
});
