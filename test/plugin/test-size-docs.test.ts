import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 行頭が start に当たる行から、行頭が end に当たる次の行の前まで */
function block(text: string, start: RegExp, end: RegExp): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => start.test(l));
  expect(at, `見つかりません：${start}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(at + 1);
  const stop = rest.findIndex((l) => end.test(l));
  return lines.slice(at, at + 1 + (stop < 0 ? rest.length : stop)).join("\n");
}

const NUMBERED = /^\d+\. /;
const step = (n: number) => new RegExp(`^${n}\\. `);

async function specSection(from: string, to: string): Promise<string> {
  const spec = await read("docs/spec.md");
  const s = spec.indexOf(`\n### ${from} `);
  const e = spec.indexOf(`\n### ${to} `);
  expect(s).toBeGreaterThan(-1);
  expect(e).toBeGreaterThan(s);
  return spec.slice(s, e);
}

async function specLine(
  from: string,
  to: string,
  head: string,
): Promise<string> {
  const line = (await specSection(from, to))
    .split("\n")
    .find((l) => l.startsWith(head));
  expect(line, `見つかりません：${head}`).toBeDefined();
  return line as string;
}

type Case = {
  name: string;
  text: () => Promise<string>;
  has: string[];
};

const CASES: Case[] = [
  {
    name: "分け方の基準3：テストの行で分けず、テストは絞り方で書く",
    text: async () =>
      block(await read("skills/intake/splitting.md"), step(3), NUMBERED),
    has: ["テストの行は分ける理由にしない", "絞り方"],
  },
  {
    name: "分け方の基準2：テストの共通の部品は先の整理の項目にしてよい",
    text: async () =>
      block(await read("skills/intake/splitting.md"), step(2), NUMBERED),
    has: ["テストの共通の部品", "本体の動きの確かめは、本体の項目に残す"],
  },
  {
    name: "run の報告：「確かめていること」の節がある",
    text: async () =>
      block(await read("skills/run/SKILL.md"), step(8), step(9)),
    has: ["「確かめていること」", "今あるテストを変えたもの", "件数"],
  },
  {
    name: "担当の定義の手順5：テストの絞り方の5つ",
    text: async () =>
      block(await read("agents/task-worker.md"), step(5), step(6)),
    has: ["表にまとめ", "共通の部品", "層を1つ", "要の文", "弱めない"],
  },
  {
    name: "レビュー役のテストの観点：重なり",
    text: async () =>
      block(
        await read("agents/code-reviewer.md"),
        /^ {3}- テスト：/,
        /^ {3}- /,
      ),
    has: ["重なり", "直したほうがよい", "前からあるテスト"],
  },
  {
    name: "push の本文：どの形でも「確かめていること」を入れる",
    text: async () =>
      block(await read("skills/push/SKILL.md"), step(3), step(4)),
    has: ["確かめていること", "テンプレートの形", "pstack の形", "短い形"],
  },
  {
    name: "仕様書 10.1 の intake の箇条：テストの行で分けず、重なりを消す",
    text: async () =>
      block(await read("docs/spec.md"), /^- 仕様は ADR の形/, /^- /),
    has: ["テストの行は分ける理由にしない", "重なり"],
  },
  {
    name: "仕様書 10.1 の分ける案の箇条：run の確かめていることと push の写し",
    text: async () => specLine("10.1", "10.2", "- 分ける案："),
    has: ["「確かめていること」", "テンプレート・pstack・短い形"],
  },
  {
    name: "仕様書 10.2 の担当の項目4：絞り方と確かめていること",
    text: async () => specLine("10.2", "10.3", "4. 完了条件のテスト"),
    has: ["絞り方", "重なり", "確かめていること"],
  },
  {
    name: "仕様書 10.2 の観点の決まり：重なり",
    text: async () =>
      specLine("10.2", "10.3", "- 5つの観点と判断事項の受け持ち："),
    has: ["重なり"],
  },
  {
    name: "仕様書 9.1 の報告の節：確かめていること",
    text: async () =>
      block(
        await specSection("9.1", "9.2"),
        /^- 「確かめていること」/,
        /^(- |$)/,
      ),
    has: ["件数", "今あるテストを変えたもの", "重なり"],
  },
];

describe("テストで PR が大きくなるのを抑える文書", () => {
  it.each(CASES)("$name", async ({ text, has }) => {
    const t = await text();
    for (const w of has) expect(t, `「${w}」がありません`).toContain(w);
  });

  it("絞り方にテストの倍率のしきい値を置かない", async () => {
    const t = block(await read("agents/task-worker.md"), step(5), step(6));
    expect(t).not.toMatch(/倍/);
  });
});
