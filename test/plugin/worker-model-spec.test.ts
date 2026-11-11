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

/** 見出し（開始の接頭辞）から次の同じ階層以上の見出しの前までを返す。 */
function section(text: string, startPrefix: string, endPrefix: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(startPrefix));
  expect(start, `${startPrefix} が見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => endPrefix.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("仕様書の担当のモデル", () => {
  it("2章の流れの図の担当の行は Opus・effort medium で、Sonnet がない", async () => {
    const spec = await read("docs/spec.md");
    const line = spec.split("\n").find((l) => l.includes("を背景で最大3つ"));
    expect(line).toBeDefined();
    expect(line).toContain("Opus・effort medium");
    expect(line).not.toContain("Sonnet");
  });

  it("3章の役割の表の担当の行は model: opus と effort medium で、sonnet がない", async () => {
    const spec = await read("docs/spec.md");
    const line = spec
      .split("\n")
      .find((l) => l.startsWith("| 担当（orca-flow:task-worker）"));
    expect(line).toBeDefined();
    expect(line).toContain("model: opus");
    expect(line).toContain("effort medium");
    expect(line?.toLowerCase()).not.toContain("sonnet");
  });

  it("10.2 の task-worker の段落は model: opus と effort: medium で、model: sonnet がない", async () => {
    const spec = await read("docs/spec.md");
    const line = spec
      .split("\n")
      .find((l) => l.startsWith("**agents/task-worker.md**"));
    expect(line).toBeDefined();
    expect(line).toContain("`model: opus`");
    expect(line).toContain("`effort: medium`");
    expect(line).not.toContain("model: sonnet");
  });

  it("10.3 に Sonnet がない", async () => {
    const spec = await read("docs/spec.md");
    const body = section(spec, "### 10.3 ", /^##+ /);
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("Sonnet");
  });

  it("13章の担当の model の行はちょうど1つで、前の sonnet の記録と入れ直しの確かめがある", async () => {
    const spec = await read("docs/spec.md");
    const body = section(spec, "## 13. ", /^## /);
    const rows = body
      .split("\n")
      .filter((l) => l.startsWith("|"))
      .map((l) =>
        l
          .replace(/^\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim()),
      );
    const mine = rows.filter((r) =>
      (r[0] ?? "").startsWith("プラグインの担当の定義の model が効くか"),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toHaveLength(2);
    expect(mine[0]?.[0]).toContain("`model: opus`");
    expect(mine[0]?.[1]).toContain("2026-10-23");
    expect(mine[0]?.[1]).toContain("sonnet");
    expect(mine[0]?.[1]).toContain("入れ直したあと");
    expect(
      rows.some((r) =>
        (r[0] ?? "").startsWith("プラグインの担当の `model: sonnet`"),
      ),
    ).toBe(false);
  });
});

describe("スキルと手順書の担当の呼び方", () => {
  it.each(["skills/run/SKILL.md", "docs/local-review.md"])(
    "%s に Sonnet がない",
    async (rel) => {
      expect(await read(rel)).not.toContain("Sonnet");
    },
  );
});
