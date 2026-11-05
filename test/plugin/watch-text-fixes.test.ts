import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function loadSpec(): Promise<string> {
  return readFile(path.join(ROOT, "docs/spec.md"), "utf8");
}

function chapterLines(text: string, no: number): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return end < 0 ? rest : rest.slice(0, end);
}

/** 全角を2、半角を1と数える（prettier の表の幅の数え方）。 */
function width(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}

function firstCell(row: string): string {
  return row.slice(1).split(/(?<!\\)\|/)[0] ?? "";
}

describe("見張りの文と説明のずれ", () => {
  it("12章の PR で統合する道に、上限の場合がある", async () => {
    const para = chapterLines(await loadSpec(), 12).find((l) =>
      l.startsWith("**PR で統合する道**"),
    );
    expect(para).toBeDefined();
    expect(para).toContain("12回か1時間");
  });

  it("13章の点数の見積もりに、めくりの分がある", async () => {
    const row = chapterLines(await loadSpec(), 13).find(
      (l) => l.startsWith("|") && l.includes("GraphQL の点数"),
    );
    expect(row).toBeDefined();
    expect(row).toContain("めくり");
    expect(row).toContain("最大3");
  });

  it("その行の1列目が、ほかの行の1列目の最大の幅を越えない", async () => {
    const rows = chapterLines(await loadSpec(), 13).filter((l) =>
      l.startsWith("|"),
    );
    const mine = rows.find((l) => l.includes("GraphQL の点数"));
    expect(mine).toBeDefined();
    // 区切りの行（| --- |）は列の最大の幅に伸びるので、比べる相手から外す
    const others = rows
      .filter((l) => l !== mine && !/^\|\s*:?-/.test(l))
      .map((l) => width(firstCell(l).trim()));
    expect(width(firstCell(mine ?? "").trim())).toBeLessThanOrEqual(
      Math.max(...others),
    );
  });

  it("lastWokeAt の説明に、試した時刻がある", async () => {
    const src = await readFile(
      path.join(ROOT, "src/lib/pr-watch/types.ts"),
      "utf8",
    );
    const lines = src.split("\n");
    const i = lines.findIndex((l) => l.includes("lastWokeAt:"));
    expect(i).toBeGreaterThan(0);
    expect(lines[i - 1]).toContain("試した");
  });
});
