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

const HEADING = "## 人に聞くとき";
const WHERE = "- このスキルで当たる所：";

const SKILLS = [
  "spec",
  "run",
  "respond",
  "merge",
  "intake",
  "split",
  "workspace",
] as const;

function section(text: string): string {
  const s = text.indexOf(`\n${HEADING}\n`);
  const e = text.indexOf("\n## ", s + 1);
  return text.slice(s + 1, e);
}

// 各スキルで当たる所の行に入っていてほしい所の名前
const WHERE_WORDS: Record<(typeof SKILLS)[number], string[]> = {
  spec: ["手順1", "手順3"],
  run: [
    "手順6",
    "統合の前に人が決めるもの",
    "教訓を聞く",
    "ローカルレビューで人に渡す所",
    "needs_human",
    "共通の版",
  ],
  respond: ["手順6", "手順9", "手順10"],
  intake: [
    "チケットの URL",
    "続けるか新しく作るか",
    "イシューのリンクの候補",
    "単位の案",
    "分ける前の問い",
    "「よい」を待つ所",
    "guards.md",
  ],
  merge: ["共通の版", "手順3"],
  split: ["手順4", "分けるか", "並べ方"],
  workspace: ["手順2", "手順3", "手順5"],
};

// 手順の番号の今の並び
const STEP_COUNTS = {
  spec: 9,
  run: 11,
  respond: 12,
  merge: 3,
  split: 12,
} as const;

describe("人に聞くとき：7つのスキルの節", () => {
  it("節がちょうど1つずつあり、置き場所が決まっている", async () => {
    for (const name of SKILLS) {
      const text = await read(`skills/${name}/SKILL.md`);
      expect(text.split(`\n${HEADING}\n`)).toHaveLength(2);
      const at = text.indexOf(`\n${HEADING}\n`);
      const steps = text.indexOf("\n## 手順\n");
      expect(steps).toBeGreaterThan(at);
      if (name === "intake") {
        expect(at).toBeGreaterThan(text.indexOf("\n## 入口\n"));
      }
      // 直前の見出しは、手順の直前（intake は入口のあと）である
      const between = text.slice(at + 1, steps);
      expect(between.match(/\n## /g)).toBeNull();
    }
  });

  it("共通の文は7つで同じ（当たる所の行を除く）", async () => {
    const common = new Set<string>();
    for (const name of SKILLS) {
      const sec = section(await read(`skills/${name}/SKILL.md`));
      const lines = sec.split("\n");
      expect(lines.filter((l) => l.startsWith(WHERE))).toHaveLength(1);
      common.add(
        lines
          .filter((l) => !l.startsWith(WHERE))
          .join("\n")
          .trimEnd(),
      );
    }
    expect(common.size).toBe(1);
  });

  it("共通の文に必要な言葉がある", async () => {
    const sec = section(await read("skills/spec/SKILL.md"));
    for (const w of [
      "AskUserQuestion",
      "（Recommended）",
      "4問",
      "選択肢4つ",
      "その他",
      "本文に説明を書いてから",
      "orca-flow status question",
      "画面を出せない",
      "知らせを待つ所は文のまま",
      "答えが返ってから",
    ]) {
      expect(sec).toContain(w);
    }
  });

  it("当たる所の行に、手順の番号か所の名前がある", async () => {
    for (const name of SKILLS) {
      const sec = section(await read(`skills/${name}/SKILL.md`));
      const line = sec.split("\n").find((l) => l.startsWith(WHERE));
      expect(line).toBeDefined();
      for (const w of WHERE_WORDS[name]) expect(line).toContain(w);
    }
  });

  it("手順の番号の並びが変わっていない", async () => {
    for (const [name, count] of Object.entries(STEP_COUNTS)) {
      const text = await read(`skills/${name}/SKILL.md`);
      const s = text.indexOf("\n## 手順\n");
      const e = text.indexOf("\n## ", s + 1);
      const nums = text
        .slice(s, e)
        .split("\n")
        .flatMap((l) => l.match(/^(\d+)\. /)?.[1] ?? [])
        .map(Number);
      expect(nums, name).toEqual(
        Array.from({ length: count }, (_, i) => i + 1),
      );
    }
  });

  it("bump・auto・approve・integrate に節がない", async () => {
    for (const name of ["bump", "auto", "approve", "integrate"]) {
      expect(await read(`skills/${name}/SKILL.md`)).not.toContain(HEADING);
    }
  });
});

describe("仕様書 10.1：人に聞く形のスキルの扱い", () => {
  it("表のあと 10.2 の前に、段落がちょうど1つある", async () => {
    const spec = await read("docs/spec.md");
    const s = spec.indexOf("\n### 10.1 ");
    const e = spec.indexOf("\n### 10.2 ");
    expect(s).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(s);
    const section10 = spec.slice(s, e);
    const after = section10.slice(section10.lastIndexOf("\n|") + 1);
    const hits = after
      .split(/\n\n+/)
      .filter((p) => p.startsWith("**人に聞く形**のスキルの扱い："));
    expect(hits).toHaveLength(1);
    const at = section10.indexOf(hits[0] ?? "");
    const pr = section10.indexOf("\n**PR の道**のスキルの扱い：");
    expect(pr).toBeGreaterThan(at);
    expect(hits[0]).toContain("AskUserQuestion");
    for (const n of SKILLS) expect(hits[0]).toContain(n);
    expect(hits[0]).toContain("bump");
    expect(hits[0]).toContain("おまかせ");
  });
});
