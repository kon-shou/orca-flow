import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function chapter6(): Promise<string> {
  const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
  const start = text.indexOf("## 6. リポジトリごとの設定");
  const end = text.indexOf("\n## 7.", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

const row = (text: string, key: string) => {
  const line = text.split("\n").find((l) => l.startsWith(`| ${key} `));
  expect(line, `${key} の行`).toBeDefined();
  return line!;
};

describe("仕様書6章：ID・ブランチ名の形", () => {
  it("idPrefix は英字で始まり英字・-・_ だけ。外れたら設定の誤り", async () => {
    const line = row(await chapter6(), "idPrefix");
    expect(line).toContain("英字で始まり");
    expect(line).toContain("英字・`-`・`_` だけ");
    expect(line).toContain("数字と `.` は使えない");
    expect(line).toContain("外れたら設定の誤り");
  });

  it.each(["branchPrefix", "baseBranch"])(
    "%s の許す形と、外れたら設定の誤りになること",
    async (key) => {
      const line = row(await chapter6(), key);
      expect(line).toContain("英数字・`.`・`_`・`-`・`/` だけ");
      expect(line).toContain("`-`・`/`・`.` で始まらず");
      expect(line).toContain("`..`・`//`・`/.` を含まず");
      expect(line).toContain("`.lock` で終わらない");
      expect(line).toContain("外れたら設定の誤り");
    },
  );

  it("baseBranch はさらに / と . で終わらない", async () => {
    expect(row(await chapter6(), "baseBranch")).toContain(
      "`/` と `.` で終わらず",
    );
  });

  it("ID の形が外れたら、記録の場所を読まず書かずに止める", async () => {
    expect(await chapter6()).toContain(
      "ID の形（英字で始まり英字・`-`・`_`、数字、後ろの英字）が外れたら、ID で組む記録の場所を読まず書かずに止める",
    );
  });
});
