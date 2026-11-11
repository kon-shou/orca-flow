import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const CHAPTER = "## スキル";
const HUMAN = "### 人が打つスキル";
const INTERNAL = "### 中で使うスキル";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 名前のあとに ` か空白が続く形にして、qa と qa-check のような前方一致を避ける。 */
const headingRe = (name: string) =>
  new RegExp(`^#### \`/orca-flow:${escape(name)}[\` ]`);
const rowRe = (name: string) =>
  new RegExp(`^\\| \`/orca-flow:${escape(name)}[\` ]`);

/** 見出しの行から、同じかより上の階層の次の見出しの手前まで。 */
function block(lines: string[], start: number): string[] {
  const level = (lines[start] as string).match(/^#+/)?.[0].length ?? 2;
  const end = lines.findIndex(
    (l, i) =>
      i > start && /^#+ /.test(l) && (l.match(/^#+/)?.[0].length ?? 9) <= level,
  );
  return lines.slice(start, end < 0 ? undefined : end);
}

/** 仕様書の 10.1 の表から、スキルの名前と「打つ人と場所」が「人間が」で始まるか。 */
function humanTyped(spec: string): Map<string, boolean> {
  const lines = spec.split("\n");
  const start = lines.findIndex((l) => l.startsWith("### 10.1"));
  expect(start, "仕様書に 10.1 がありません").toBeGreaterThanOrEqual(0);
  const out = new Map<string, boolean>();
  for (const l of block(lines, start)) {
    const name = l.match(/^\| `\/orca-flow:([\w-]+)/)?.[1];
    if (name === undefined) continue;
    const who = (l.split("|")[2] ?? "").trim();
    out.set(name, who.startsWith("人間が"));
  }
  return out;
}

let readme: string;
let lines: string[];
let chapter: string[];
let human: string[];
let internal: string[];
let skills: string[];
let typed: Map<string, boolean>;

beforeAll(async () => {
  readme = await read("README.md");
  lines = readme.split("\n");
  const start = lines.indexOf(CHAPTER);
  chapter = start < 0 ? [] : block(lines, start);
  const sub = (h: string) => {
    const i = chapter.indexOf(h);
    return i < 0 ? [] : block(chapter, i);
  };
  human = sub(HUMAN);
  internal = sub(INTERNAL);
  skills = (await readdir(path.join(ROOT, "skills"), { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  typed = humanTyped(await read("docs/spec.md"));
});

describe("README のスキルの章", () => {
  it("「## スキル」が1つだけあり、使い始め方と Windows で使うの間にある", () => {
    expect(lines.filter((l) => l === CHAPTER)).toHaveLength(1);
    const before = lines.indexOf("## 使い始め方");
    const after = lines.indexOf("## Windows で使う");
    expect(before).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(CHAPTER)).toBeGreaterThan(before);
    expect(lines.indexOf(CHAPTER)).toBeLessThan(after);
  });

  it("人が打つ節と中で使う節が1つずつある", () => {
    expect(chapter.filter((l) => l === HUMAN)).toHaveLength(1);
    expect(chapter.filter((l) => l === INTERNAL)).toHaveLength(1);
  });

  it("スキルのディレクトリがある", () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  it("スキルごとに見出しが1つあり、次の見出しまでに段落がある", () => {
    for (const name of skills) {
      const at = chapter
        .map((l, i) => (headingRe(name).test(l) ? i : -1))
        .filter((i) => i >= 0);
      expect(at, `${name} の見出し`).toHaveLength(1);
      const body = block(chapter, at[0] as number).slice(1);
      const paragraph = body.some(
        (l) => l.trim() !== "" && !/^(#|\||\s*- |\s*\d+\. )/.test(l),
      );
      expect(paragraph, `${name} の解説の段落`).toBe(true);
    }
  });

  it("スキルごとに概要の表の行が1つある", () => {
    for (const name of skills) {
      expect(
        chapter.filter((l) => rowRe(name).test(l)),
        `${name} の表の行`,
      ).toHaveLength(1);
    }
  });

  it("表の行と見出しは、仕様書の「打つ人と場所」に合う節にある", () => {
    for (const name of skills) {
      expect(typed.has(name), `仕様書の 10.1 に ${name} の行`).toBe(true);
      const [here, other] = typed.get(name)
        ? [human, internal]
        : [internal, human];
      for (const re of [headingRe(name), rowRe(name)]) {
        expect(
          here.some((l) => re.test(l)),
          `${name}：${re}`,
        ).toBe(true);
        expect(
          other.some((l) => re.test(l)),
          `${name}：${re}`,
        ).toBe(false);
      }
    }
  });

  it("タスクの ID の形と、公開から抜くパスが出ない", async () => {
    const text = chapter.join("\n");
    expect(text).not.toMatch(/\b[A-Z]\d{2,}\b/);
    const excluded = (await read("scripts/public/exclude.txt"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    for (const p of excluded) {
      expect(text).not.toContain(p.replace(/\/+$/, ""));
    }
  });
});
