import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 「ローカルレビュー（reviewBackend: local）」の節だけを切り出す（次の `## ` の前まで）。 */
async function localSection(): Promise<string> {
  const text = await readFile(path.join(ROOT, "skills/run/SKILL.md"), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) =>
    /^## ローカルレビュー（reviewBackend: local）/.test(l),
  );
  expect(start, "ローカルレビューの節がありません").toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 節の中で、正規表現に合う「- 」の項目（次の項目の前まで）を返す。 */
function bullet(section: string, re: RegExp): string {
  const lines = section.split("\n");
  const start = lines.findIndex((l) => /^- /.test(l) && re.test(l));
  expect(start, `項目が見つかりません：${re}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^(- |#)/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("run スキルのローカルレビューの節（ローカルレビューの仕様に合わせる）", () => {
  it("redo の範囲を、直し終わりの先頭（取り込みより前に覚えたもの）で 〈直す前のコミット〉..〈直し終わりの先頭〉 にする", async () => {
    const b = bullet(await localSection(), /やり直しの範囲/);
    expect(b).toContain("redo");
    expect(b).toContain("〈直す前のコミット〉");
    expect(b).toContain("〈直し終わりの先頭〉");
    expect(b).toContain("取り込みより前");
    expect(b).toContain("git rev-parse HEAD");
    expect(b).toContain("手順6");
    expect(b).toContain("〈直す前のコミット〉..〈直し終わりの先頭〉");
    expect(b).not.toContain("HEAD~");
    expect(b).not.toContain("直しのコミットの数");
  });

  it("直しの差分が空なら review-local を流さずその段を止める", async () => {
    const b = bullet(await localSection(), /直しの差分/);
    expect(b).toContain("git diff --name-only 〈直す前のコミット〉..HEAD");
    expect(b).toContain("空");
    expect(b).toContain("直っていない");
    expect(b).toMatch(/`review-local` を流さず/);
    expect(b).toContain("その段を止める");
  });

  it("verify の時間切れはすぐ question、終了コード1の回数は手順5と同じく通算で数える", async () => {
    const b = bullet(await localSection(), /修正のあと/);
    expect(b).toContain("手順5");
    expect(b).toMatch(/時間切れ.*すぐ `orca-flow status question`/s);
    expect(b).toContain("通算");
    expect(b).toContain("落ちた回数");
    expect(b).toContain("同じテスト");
    expect(b).toContain("2回");
    expect(b).toContain("その段を止め");
  });

  it("節のあとの進み方：手順7へ進み、手順9・10は Claude のレビューと同じ", async () => {
    const s = await localSection();
    const lines = s.split("\n");
    const start = lines.findIndex((l) => /^### 終わったあと/.test(l));
    expect(
      start,
      "「終わったあと」の見出しがありません",
    ).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && /^###? /.test(l));
    const after = lines.slice(start, end < 0 ? undefined : end).join("\n");
    expect(after).toContain("手順7へ進む");
    expect(after).toContain("手順9");
    expect(after).toContain("手順10");
    expect(after).toContain("Claude のレビューと同じ");
  });

  it("古い書き方（記号のままの範囲）を残さない", async () => {
    const s = await localSection();
    expect(s).not.toMatch(/HEAD~〈数〉`?\s*を(そのまま)?渡す/);
  });
});
