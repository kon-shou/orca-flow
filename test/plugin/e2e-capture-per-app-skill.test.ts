import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const skill = () =>
  readFile(path.join(ROOT, "skills/run/e2e-capture.md"), "utf8");

/** 「## 〈名前〉」の見出しの次の行から、次の「## 」の前までを返す。 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  expect(start, `${heading} の見出しが見つかりません`).toBeGreaterThanOrEqual(
    0,
  );
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 「〈番号〉. 」で始まる手順の行と、その下の字下げした行を返す。 */
function step(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${no}. `));
  expect(start, `手順${no}が見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.startsWith(" "));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

describe("スキル：アプリごとの録画のコマンド", () => {
  it("手順2で、録画のコマンドのあるアプリを --app に選ぶ", async () => {
    const line = step(section(await skill(), "録る手順"), 2);
    expect(line).toContain("--app");
    expect(line).toContain("録画のコマンドのあるアプリ");
  });

  it("手順3に、「の分がありません」が出たら選び直して流し直す項がある", async () => {
    const items = step(section(await skill(), "録る手順"), 3)
      .split("\n")
      .filter((l) => l.trimStart().startsWith("- "));
    const item = items.find((l) => l.includes("の分がありません")) ?? "";
    expect(item, "「の分がありません」の項がありません").not.toBe("");
    expect(item).toContain("1");
    expect(item).toContain("選び直");
    expect(item).toContain("流し直");
  });

  it("手順3の「capture がありません」の項が、渡したアプリの分がないときも含むと書く", async () => {
    const items = step(section(await skill(), "録る手順"), 3)
      .split("\n")
      .filter((l) => l.includes("capture がありません"));
    expect(items).toHaveLength(1);
    expect(items[0]).toContain("`--companion` で渡したアプリの分");
  });

  it("録る時期に、伴うアプリの分がないときも録らない扱いになると書く", async () => {
    const s = section(await skill(), "録る時期");
    const line =
      s.split("\n").find((l) => l.startsWith("- 録らない場合")) ?? "";
    expect(line, "録らない場合の項がありません").not.toBe("");
    expect(line).toContain("アプリごと");
    expect(line).toContain("`--companion` で渡したアプリの分");
    expect(line).toContain("capture がありません");
  });
});
