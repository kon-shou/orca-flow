import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** `## 5. …` の行から次の `## ` の前まで */
function chapter(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${n}. `));
  expect(start, `${n}章がありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

describe("仕様書：共通の部品", () => {
  it("5章に src/common/ と版・要約値・読み込みの制限・写す側の決まりがある", async () => {
    const body = chapter(
      await readFile(path.join(ROOT, "docs/spec.md"), "utf8"),
      5,
    );
    expect(body).toContain("src/common/");
    expect(body).toContain("manifest.json");
    expect(body).toContain("版");
    expect(body).toContain("sha256");
    expect(body).toContain("`node:` で始まるもの");
    expect(body).toContain("もう1つの PR を回す道具");
  });

  it("7章7番に src/common/redact.ts と redactSecrets がある", async () => {
    const body = chapter(
      await readFile(path.join(ROOT, "docs/spec.md"), "utf8"),
      7,
    );
    const line = body
      .split("\n")
      .find((l) => l.includes("src/common/redact.ts"));
    expect(line, "7章に src/common/redact.ts がありません").toBeDefined();
    expect(line).toContain("redactSecrets");
  });

  it("8章の送る前の確かめ4番に、間隔を待ったあとの時間帯の見直しがある", async () => {
    const body = chapter(
      await readFile(path.join(ROOT, "docs/spec.md"), "utf8"),
      8,
    );
    const line = body.split("\n").find((l) => l.startsWith("4. 送る時間帯"));
    expect(line, "4番がありません").toBeDefined();
    expect(line).toContain("間隔を待ったあとにもう一度時間帯を見て");
    expect(line).toContain("次の回に回す");
  });
});
