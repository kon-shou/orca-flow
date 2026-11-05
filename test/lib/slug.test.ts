import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SLUG_PATTERN } from "../../src/lib/slug.ts";

const srcDir = path.resolve(import.meta.dirname, "../../src");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );

describe("slug の形", () => {
  it.each(["t12", "shopping-fix", "0a"])("%s は通る", (s) => {
    expect(SLUG_PATTERN.test(s)).toBe(true);
  });
  it.each(["", "-a", "A", "a_b", "あ", "a b"])("%j は通らない", (s) => {
    expect(SLUG_PATTERN.test(s)).toBe(false);
  });
  it("正規表現の字面を持つのは src/lib/slug.ts だけ", () => {
    const literal = "[a-z0-9][a-z0-9-]*";
    const hits = walk(srcDir)
      .filter((f) => readFileSync(f, "utf8").includes(literal))
      .map((f) => path.relative(srcDir, f));
    expect(hits).toEqual(["lib/slug.ts"]);
  });
  it("src の下に `as FlowConfig` がない", () => {
    const hits = walk(srcDir).filter((f) =>
      readFileSync(f, "utf8").includes("as FlowConfig"),
    );
    expect(hits).toEqual([]);
  });
});
