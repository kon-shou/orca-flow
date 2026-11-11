import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function run(): Promise<string> {
  return readFile(path.join(ROOT, "skills/run/SKILL.md"), "utf8");
}

function between(text: string, from: string, to: string): string {
  const s = text.indexOf(from);
  expect(s, `${from} が見つかりません`).toBeGreaterThanOrEqual(0);
  const e = text.indexOf(to, s + from.length);
  expect(e, `${to} が見つかりません`).toBeGreaterThan(s);
  return text.slice(s, e);
}

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

describe("run：大きくなった PR を分ける", () => {
  it("手順の数は11のまま", async () => {
    const text = await run();
    const body = between(text, "\n## 手順\n", "\n## 厳格モード");
    const nums = body
      .split("\n")
      .flatMap((l) => l.match(/^(\d+)\. /)?.[1] ?? [])
      .map(Number);
    expect(nums).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });

  it("手順8に大きさの確かめと「分ける案」の節がある", async () => {
    const text = await run();
    const step8 = between(text, "\n8. ", "\n9. ");
    expectAll(step8, [
      "大きさの確かめ",
      "小さな差分",
      "テストのファイルの見分け方",
      "上の端",
      "コードが",
      "約400行",
      "「分ける案」",
      "切る所",
      "書き込む場所",
      "並べるか積むか",
      "子が親の分を使うとき",
    ]);
  });

  it("大きさのしきい値の数を run に写さない", async () => {
    const text = await run();
    const step8 = between(text, "\n8. ", "\n9. ");
    expect(step8).not.toContain("300");
    expect(step8).not.toContain("約700行");
  });

  it("手順11に split の案内がある", async () => {
    const text = await run();
    const step11 = between(text, "\n11. ", "\n## 厳格モード");
    expectAll(step11, ["分けるなら", "/orca-flow:split $0"]);
  });

  it("知らせの節に、分けたあとの手直しがある", async () => {
    const text = await run();
    const notice = text.slice(text.indexOf("\n## 統括役から知らせが来たら"));
    const from = notice.indexOf("- 「〈子の ID〉 に分けました」");
    expect(from).toBeGreaterThanOrEqual(0);
    const next = notice.indexOf("\n- ", from + 1);
    expect(next).toBeGreaterThan(from);
    expectAll(notice.slice(from, next), [
      "に分けました」",
      "親の枝から外して",
      "コミット",
      "移した完了条件",
      "確認役",
      "orca-flow verify",
      "integrate-wait",
      "抜け・テストの削除として扱わない",
      "「分けた」の節に添える",
      "つなぎ直し",
      "最後の review のあとの確かめ",
      "外すだけならやり直さない",
      "`strict` なら「厳格モード」の節のとおり最初の形を流し直す",
    ]);
  });
});
