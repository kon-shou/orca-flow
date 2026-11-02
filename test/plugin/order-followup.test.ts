import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function lineWith(text: string, needle: string): string {
  const line = text.split("\n").find((l) => l.includes(needle)) ?? "";
  expect(line, `行が見つかりません：${needle}`).not.toBe("");
  return line;
}

describe("順のファイルの壊れ", () => {
  it("integrate：終了コード1は、タスク長に送らず統括役が main で直す", async () => {
    const line = lineWith(
      await read("skills/integrate/SKILL.md"),
      "マージの順のファイルが壊れています",
    );
    expect(line).toContain("タスク長には送らない");
    expect(line).toContain("統括役が main で行う");
    expect(line).toContain("orca-flow order --clear");
  });

  it("spec：overlap が同じ文で止まったら、設計書を直さず question にして統括役に回す", async () => {
    const line = lineWith(
      await read("skills/spec/SKILL.md"),
      "マージの順のファイルが壊れています",
    );
    expect(line).toContain("設計書は直さない");
    expect(line).toContain("orca-flow status question");
    expect(line).toContain("統括役");
  });

  it("docs/spec.md：壊れたときは統括役が main で直す", async () => {
    const line = lineWith(
      await read("docs/spec.md"),
      "- 順のファイルが壊れたとき",
    );
    expect(line).toContain("統括役が main で");
    expect(line).toContain("order --clear");
  });
});

describe("分かれ道の位置", () => {
  it("review：手順1で、設定の読み込みと形の確かめが見直しの形への分かれ目より前にある", async () => {
    const step1 = lineWith(
      await read("skills/review/SKILL.md"),
      "1. `orca-flow config --json`",
    );
    const config = step1.indexOf("orca-flow config --json");
    const idShape = step1.indexOf("〈idPrefix〉〈数〉の形でない");
    const range = step1.indexOf("〈ref〉..〈ref〉か〈ref〉...〈ref〉の形");
    const fork = step1.indexOf("見直しの形（$2）なら");
    expect(config).toBeGreaterThanOrEqual(0);
    expect(idShape).toBeGreaterThan(config);
    expect(range).toBeGreaterThan(idShape);
    expect(fork).toBeGreaterThan(range);
    expect(step1).toContain("codeReview が off・light のときの扱いだけ");
  });

  it("approve：重なりの分かれ目が「## 手順」より前にある", async () => {
    const text = await read("skills/approve/SKILL.md");
    const steps = text.indexOf("\n## 手順");
    expect(steps).toBeGreaterThan(0);
    const before = text.slice(0, steps);
    expect(before).toContain("手順1〜4を流さず");
    expect(before).toContain(
      "「重なりを自動で決めきれなかったとき」の節へ進む",
    );
  });
});
