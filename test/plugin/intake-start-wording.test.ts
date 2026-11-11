import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const GUARDS = "skills/intake/guards.md";
const FORMAT = "skills/intake/page-format.md";

/** 見出しの行から、同じ高さ以上の次の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i] ?? "");
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** 頭の言葉で始まる行を1つ返す。 */
function item(text: string, head: string): string {
  const hits = text.split("\n").filter((l) => l.startsWith(head));
  expect(hits, `「${head}」で始まる行`).toHaveLength(1);
  return hits[0] as string;
}

describe("intake の文が、前を待つ印をつけて全部始める今の始め方だけに読める", () => {
  it("guards.md の手順10の前を待つ印の項に、消えた句の読み替えがない", async () => {
    const t = await read(GUARDS);
    const mark = item(section(t, /^## 手順10：/), "- 前を待つ印");
    expect(mark).not.toContain("入ったとして始める");
    expect(mark).not.toContain("印なしで始める条件として読む");
    expect(mark).toContain("`page-format-prev.md`");
    expect(mark).toContain("`new` が決める");
    expect(t).not.toContain("入ったときだけ、入ったとして始める");
  });

  it("page-format.md の形の見分けで、親をたどる理由が全部の項目を順に始めることになっている", async () => {
    const s = section(await read(FORMAT), /^## 形の見分け/);
    expect(s).not.toContain("依存が入った項目しか始めない");
    const follow = item(s, "- 渡された URL がタスクのページなら");
    expect(follow).toContain("親と同じに扱う");
    expect(follow).toContain("待つ先が前になる順");
  });

  it("page-format.md の依存の解き方で、ほかのリポジトリの待つ先は前を待つ印で待つ", async () => {
    const t = await read(FORMAT);
    const s = section(t, /^## 依存の書き方と解き方/);
    expect(s).not.toContain("ブランチを待つのは全部の項目が入ってから");
    const other = item(s, "- 解いた ID のうち");
    expect(other).toContain("ほかのリポジトリの待つ先は前を待つ印で待つ");
    expect(other).toContain("`--cross-depends` に渡すと");
    expect(t).not.toContain("入ったとして始める");
  });
});
