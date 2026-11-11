import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function spec(): Promise<string[]> {
  return (await readFile(path.join(ROOT, "docs/spec.md"), "utf8")).split("\n");
}

/** 8章の「**見張り（pr-watch）**」の段落から、次の太字の見出しの段落の前まで */
async function watchSection(): Promise<string> {
  const lines = await spec();
  const start = lines.findIndex((l) => l.startsWith("**見張り（pr-watch）**"));
  expect(start, "見張りの節がありません").toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("**"));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

describe("仕様書：見張りの初めての回の数え方", () => {
  it("8章の番号つきの項の6.の直後に、初めての回の数え方の項がある", async () => {
    const lines = await spec();
    const six = lines.findIndex((l) => l.startsWith("6. 直近の回の結果"));
    expect(six).toBeGreaterThanOrEqual(0);
    expect(lines[six + 1]).toMatch(/^7\. 初めての回の数え方/);
  });

  it("まだ答えていないかで数えること、数えるもの・数えないものを書いている", async () => {
    const s = await watchSection();
    for (const word of [
      "まだ答えていないか",
      "viewer",
      "最後の発言が自分でない",
      "自分の最後の発言よりあと",
      "保留中",
      "だれのものでも数えず",
      "解決済みのスレッド",
      "起こさない書き手",
      "`quiet`",
      "時刻が読めない他人のコメントとスレッドの発言",
      "起こす側に倒す",
      "赤のときだけ",
      "`createdAt`",
      "`submittedAt`",
      "本文は取らない",
      "新しい ID だけ",
      "`prWatch.maxLaunches`",
      "拾い直さない",
    ])
      expect(s, word).toContain(word);
  });

  it("12章の「見張り」の段落に、入れる前のコメントでも起こすことと、手で respond を打つことを書いている", async () => {
    const lines = await spec();
    const para = lines.find((l) => l.startsWith("**見張り**："));
    expect(para).toBeDefined();
    expect(para).toContain("見張りを入れる前に付いた");
    expect(para).toContain("初めての回にタスク長を起こします");
    expect(para).toContain("この数え方になる前");
    expect(para).toContain("拾い直さない");
    expect(para).toContain("`/orca-flow:respond 〈ID〉`");
  });
});
