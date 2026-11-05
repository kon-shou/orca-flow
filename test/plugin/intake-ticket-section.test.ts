import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const NEW_MARK = "要件から自動で作った仕様のページ";
const OLD_MARK = "orca-flow の intake が作った仕様のページ";
const TOOL = "orca-flow";

/** `n. ` で始まる手順の行から、次の手順の前までを返す。 */
function step(text: string, n: number): string {
  const start = text.indexOf(`\n${n}. `);
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(`\n${n + 1}. `, start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

const lineMatching = (text: string, re: RegExp) =>
  text.split("\n").find((l) => re.test(l));

const skill = () => read("skills/intake/SKILL.md");

/** 手順8の、節の見出しと説明の1行（Notion に書く決まった文）。 */
async function fixedSentences(): Promise<string[]> {
  const s8 = step(await skill(), 8);
  const heading = /見出し「([^」]+)」/.exec(s8)?.[1];
  const explain = /説明の1行は「([^」]+)」/.exec(s8)?.[1];
  expect(heading).toBeDefined();
  expect(explain).toBeDefined();
  return [heading as string, explain as string];
}

describe("intake 手順8：チケットの末尾の節", () => {
  it("線・見出し「自動で追記」・説明の1行がこの順で、子ページを作る文より前にある", async () => {
    const s8 = step(await skill(), 8);
    const line = s8.indexOf("区切りの線");
    const head = s8.indexOf("見出し「自動で追記」");
    const explain = s8.indexOf("説明の1行");
    expect(line).toBeGreaterThanOrEqual(0);
    expect(head).toBeGreaterThan(line);
    expect(explain).toBeGreaterThan(head);
    expect(s8).toContain("`##`");
    const make = s8.search(/子ページとして仕様のページを作る。Notion/);
    expect(make).toBeGreaterThan(explain);
  });

  it("末尾がすでにこの節なら足さない", async () => {
    const s8 = step(await skill(), 8);
    const l = lineMatching(s8, /すでにこの節/);
    expect(l).toBeDefined();
    expect(l).toContain("子ページだけ");
    expect(l).toContain("足さない");
  });

  it("作ったあとチケットを読み直し、ずれたら動かさず消さず人に場所を伝える", async () => {
    const s8 = step(await skill(), 8);
    const l = lineMatching(s8, /読み直/);
    expect(l).toBeDefined();
    for (const w of [
      "子ページ",
      "節の下",
      "動かさず",
      "消さず",
      "人間に伝える",
    ]) {
      expect(l).toContain(w);
    }
  });

  it("節を足せないときは子ページを作って続け、人に伝える", async () => {
    const s8 = step(await skill(), 8);
    const l = lineMatching(s8, /節を足せないときは/);
    expect(l).toBeDefined();
    for (const w of ["子ページ", "続け", "人間に伝える"]) {
      expect(l).toContain(w);
    }
  });

  it("子ページを作れないときは、印・下書きの全文・URL・手順9が今までどおりあり、見出しの下へ頼む", async () => {
    const s8 = step(await skill(), 8);
    const l = lineMatching(s8, /作れない/);
    expect(l).toBeDefined();
    for (const w of [
      "印",
      "下書きの全文",
      "URL",
      "手順9",
      "見出しの下",
      "頼",
    ]) {
      expect(l).toContain(w);
    }
  });
});

describe("intake：印", () => {
  it("手順4と手順8に新しい印があり、手順4は前の印も印とみなす。インラインのコードにしない", async () => {
    const text = await skill();
    const s4 = step(text, 4);
    const s8 = step(text, 8);
    expect(s4).toContain(NEW_MARK);
    expect(s8).toContain(NEW_MARK);
    expect(s4).toContain(OLD_MARK);
    expect(s4).toMatch(/前の印[^。]*印とみなす/);
    expect(s8).not.toContain(OLD_MARK);
    expect(text).not.toContain(`\`${NEW_MARK}\``);
    expect(text).not.toContain(`\`${OLD_MARK}\``);
  });

  it("節の見出しと説明の1行に、新しい印も前の印も入っていない", async () => {
    for (const t of await fixedSentences()) {
      expect(t).not.toContain(NEW_MARK);
      expect(t).not.toContain(OLD_MARK);
      expect(t).not.toContain("仕様のページ");
    }
    expect((await fixedSentences())[0]).toBe("自動で追記");
  });
});

describe("intake：orca-flow の語を Notion に書かない", () => {
  it("「守ること」に行があり、リポジトリの名前の例外がある", async () => {
    const text = await skill();
    const guards = text.slice(text.indexOf("## 守ること"));
    const l = lineMatching(guards, /orca-flow の語を入れない/);
    expect(l).toBeDefined();
    for (const w of [
      "Notion",
      "仕様のページ",
      "チケットの節",
      "ID の書き込み",
      "リポジトリの名前",
      "除く",
    ]) {
      expect(l).toContain(w);
    }
  });

  it("Notion に書く決まった文（新しい印・見出し・説明の1行・節の名前）に orca-flow の語がない", async () => {
    for (const t of [NEW_MARK, ...(await fixedSentences())]) {
      expect(t).not.toContain(TOOL);
    }
    const pageSkill = await read("skills/integrate/spec-page.md");
    const capture = await read("skills/integrate/spec-page-capture.md");
    for (const text of [pageSkill, capture]) {
      expect(text).toMatch(/Notion に書く行[^。]*orca-flow の語を入れない/);
    }
  });
});

describe("intake：チケットのもとの本文を変えない", () => {
  it("「本文を変えない」の行が2つ以上あり、どれも子ページ・末尾の節・イシューは読むだけを含む", async () => {
    const lines = (await skill())
      .split("\n")
      .filter((l) => l.includes("本文を変えない"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      expect(l).toContain("子ページ");
      expect(l).toContain("末尾の節");
      expect(l).toContain("イシューは読むだけ");
    }
  });
});

describe("Notion の URL を書かない", () => {
  it("足した文とテストに Notion のドメインがない", async () => {
    const files = [
      "skills/intake/SKILL.md",
      "skills/integrate/spec-page.md",
      "test/plugin/intake-ticket-section.test.ts",
    ];
    for (const f of files) {
      expect(await read(f), f).not.toMatch(
        new RegExp(`${"notion"}\\.(so|com|site)`),
      );
    }
  });
});
