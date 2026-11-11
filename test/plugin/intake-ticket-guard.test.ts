import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** `n. ` で始まる手順の行から、次の手順の前までを返す。 */
function step(text: string, n: number): string {
  const start = text.indexOf(`\n${n}. `);
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(`\n${n + 1}. `, start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

const lineMatching = (text: string, re: RegExp) =>
  text.split("\n").find((l) => re.test(l));
const linesOf = (text: string) => text.split("\n");

const s8 = async () => step(await read("skills/intake/SKILL.md"), 8);

/** 章の見出し `## n.` から次の `## ` の前まで。 */
function chapter(text: string, n: number): string {
  const start = text.indexOf(`\n## ${n}. `);
  expect(start, `${n}章が見つかりません`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

describe("intake 手順8：節は末尾に足す形だけで書く", () => {
  it("末尾に足す形だけを使い、置き換えの形を使わない旨の行がある", async () => {
    const lines = linesOf(await s8());
    const i = lines.findIndex((l) => /末尾に足す形だけ/.test(l));
    expect(i).toBeGreaterThanOrEqual(0);
    for (const w of ["全文の置き換え", "検索と置き換え", "子ページを消"]) {
      expect(lines[i]).toContain(w);
    }
    // 言葉があるだけでなく、それを「使わない」と否定しているかまで見る
    expect(lines[i]).toMatch(/全文の置き換え[^。]*子ページを消[^。]*使わない/);
  });

  it("その行か次の行に、足す形がなければ「節を足せないとき」に回す旨がある", async () => {
    const lines = linesOf(await s8());
    const i = lines.findIndex((l) => /末尾に足す形だけ/.test(l));
    const two = `${lines[i]}\n${lines[i + 1] ?? ""}`;
    expect(two).toMatch(/足す形がなければ[^\n]*「節を足せないとき」に回す/);
  });
});

describe("intake 手順8：足す前に読んで線より上を覚える", () => {
  it("チケットを読んで線より上を覚える文が、節を足す文より前にある", async () => {
    const s = await s8();
    const lines = linesOf(s);
    const read_ = lines.findIndex(
      (l) => /チケットを全文読み/.test(l) && /線より上/.test(l),
    );
    const add = lines.findIndex((l) => /チケットの末尾に節を足す/.test(l));
    expect(read_).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(read_);
    expect(lines[read_]).toContain("覚える");
    expect(lines[read_]).toContain("既存の節より上");
  });
});

describe("intake 手順8：作ったあとの読み直し", () => {
  it("線より上が同じかを確かめ、違えば戻さず人間に伝え、子ページの場所の確かめも残る", async () => {
    const l = lineMatching(await s8(), /読み直/);
    expect(l).toBeDefined();
    for (const w of [
      "線より上",
      "同じか",
      "戻さ",
      "人間に伝える",
      "子ページ",
      "節の下",
      "動かさず",
      "消さず",
    ]) {
      expect(l).toContain(w);
    }
  });

  it("節を足せなかったときは、新しい子ページを除いた本文で比べる", async () => {
    const l = lineMatching(await s8(), /読み直/);
    expect(l).toMatch(/足せなかった[^。]*除い/);
  });
});

describe("intake 手順8：すでにこの節の見分け", () => {
  it("区切りの線・見出し「自動で追記」・説明の1行・子ページの4つがある", async () => {
    const l = lineMatching(await s8(), /すでにこの節/);
    expect(l).toBeDefined();
    for (const w of [
      "区切りの線",
      "見出し「自動で追記」",
      "説明の1行",
      "子ページ",
    ]) {
      expect(l).toContain(w);
    }
    expect(l).toContain("足さない");
  });
});

describe("workspace.md の守ること", () => {
  it("親が書く行に、チケットの末尾の節・仕様のページ・一時ファイル・もとの本文を変えないがある", async () => {
    const text = await read("skills/intake/workspace.md");
    const guards = text.slice(
      text.indexOf("## 守ること"),
      text.indexOf("## 手順2の差し替え"),
    );
    const l = lineMatching(guards, /親が書く/);
    expect(l).toBeDefined();
    for (const w of [
      "末尾の節",
      "仕様のページ",
      "一時ファイル",
      "もとの本文",
    ]) {
      expect(l).toContain(w);
    }
    expect(l).toMatch(/もとの本文[^。]*変えない/);
  });
});

describe("仕様書", () => {
  it("3章の親の箇条に、チケットの末尾の節と、仕様のページと一時ファイルが書いてよいものとして並ぶ", async () => {
    const s = chapter(await read("docs/spec.md"), 3);
    const l = lineMatching(s, /親が書いてよいのは/);
    expect(l).toBeDefined();
    for (const w of ["末尾の節", "仕様のページ", "一時ファイル"]) {
      expect(l).toContain(w);
    }
    expect(l).toMatch(/もとの本文[^。]*変えない/);
  });

  it("10.1 の intake の段落の子ページの箇条に、置き換えを使わない・線より上の読み直し・説明の1行を含む節の見分けがある", async () => {
    const spec = await read("docs/spec.md");
    const start = spec.indexOf(
      "**Notion の要件から始める**（`/orca-flow:intake`）",
    );
    const end = spec.indexOf("\n**複数のリポジトリをまたぐ要件**", start);
    const para = spec.slice(start, end);
    const bullet = lineMatching(para, /^- チケットの子ページとして/);
    expect(bullet).toBeDefined();
    expect(bullet).toMatch(/置き換え[^。]*使わない/);
    expect(bullet).toMatch(/作ったあとチケットを読み直[^。]*線より上/);
    expect(bullet).toMatch(/すでにこの節[^）]*説明の1行/);
    // 段落は頭の一文のあと箇条だけ
    const rest = para
      .split("\n")
      .slice(1)
      .filter((x) => x.trim() !== "");
    for (const x of rest) expect(x.startsWith("- ")).toBe(true);
  });
});

describe("Notion のドメインを書かない", () => {
  it("新しいテストと変えたスキル・仕様書にない", async () => {
    for (const f of [
      "test/plugin/intake-ticket-guard.test.ts",
      "skills/intake/SKILL.md",
      "skills/intake/workspace.md",
      "docs/spec.md",
    ]) {
      expect(await read(f), f).not.toMatch(
        new RegExp(`${"notion"}\\.(so|com|site)`),
      );
    }
  });
});
