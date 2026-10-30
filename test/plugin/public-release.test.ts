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

async function readJson(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(rel)) as Record<string, unknown>;
}

/** LICENSE の1行目から種類を読む。 */
function licenseKind(text: string): string | undefined {
  const first = text.trim().split("\n")[0] ?? "";
  return /^(.+?) License$/.exec(first.trim())?.[1];
}

/** `Copyright (c) 〈年〉 〈権利者〉` の権利者を読む。 */
function licenseHolder(text: string): string | undefined {
  return /^Copyright \(c\) \d{4} (.+)$/m.exec(text)?.[1]?.trim();
}

describe("公開のファイル：LICENSE", () => {
  it("LICENSE の種類が package.json の license と一致する", async () => {
    const pkg = await readJson("package.json");
    const kind = licenseKind(await read("LICENSE"));
    expect(kind).toBeDefined();
    expect(typeof pkg.license).toBe("string");
    expect(kind).toBe(pkg.license);
    expect(kind).toBe("MIT");
  });

  it("LICENSE の権利者・プラグインの作者名・マーケットプレイスの持ち主が一致する", async () => {
    const holder = licenseHolder(await read("LICENSE"));
    const plugin = await readJson(".claude-plugin/plugin.json");
    const market = await readJson(".claude-plugin/marketplace.json");
    const author = (plugin.author as { name?: string }).name;
    const owner = (market.owner as { name?: string }).name;
    expect(holder).toBeTruthy();
    expect(author).toBe(holder);
    expect(owner).toBe(holder);
  });
});

describe("公開のファイル：README", () => {
  it("README が仕様書に案内し、LICENSE に案内する", async () => {
    const readme = await read("README.md");
    expect(readme).toContain("docs/spec.md");
    expect(readme).toContain("LICENSE");
  });

  it("README が公開から抜くパスにリンクも言及もしない", async () => {
    const readme = await read("README.md");
    const excluded = (await read("scripts/public/exclude.txt"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(excluded.length).toBeGreaterThan(0);
    for (const p of excluded) {
      const bare = p.replace(/\/+$/, "");
      expect(readme, `README が ${bare} に触れています`).not.toContain(bare);
    }
  });
});
