import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/common",
);

const sources = async () =>
  (await readdir(DIR)).filter((f) => f.endsWith(".ts")).sort();

describe("src/common の決まり", () => {
  it("node: と同じ置き場のファイルのほかを import しない", async () => {
    const files = await sources();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(path.join(DIR, file), "utf8");
      const specs = [
        ...text.matchAll(/\bfrom\s+["']([^"']+)["']/g),
        ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
        ...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
        ...text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
      ].map((m) => m[1]!);
      for (const spec of specs) {
        const ok =
          spec.startsWith("node:") ||
          (/^\.\/[^/]+\.ts$/.test(spec) && existsSync(path.join(DIR, spec)));
        expect(
          ok,
          `${file} が ${spec} を読み込んでいます。src/common は node: と同じ置き場のファイルしか読み込めません`,
        ).toBe(true);
      }
    }
  });

  it("manifest.json と .ts が1対1で、版の形が正しく、sha256 が合う", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(DIR, "manifest.json"), "utf8"),
    ) as { files: Record<string, { version: string; sha256: string }> };
    const files = await sources();
    const listed = Object.keys(manifest.files).sort();
    const missing = files.filter((f) => !listed.includes(f));
    const extra = listed.filter((f) => !files.includes(f));
    expect(
      { missing, extra },
      `manifest.json と src/common の .ts が合いません。manifest.json にない：${missing.join("、") || "なし"}／.ts がない：${extra.join("、") || "なし"}。足りない名前は manifest.json の files に項目（version と sha256）を足し、余る名前は項目を消してください`,
    ).toEqual({ missing: [], extra: [] });
    for (const file of files) {
      const entry = manifest.files[file]!;
      expect(entry.version, `${file} の版の形`).toMatch(
        /^\d{4}-\d{2}-\d{2}(\.\d+)?$/,
      );
      const actual = createHash("sha256")
        .update(await readFile(path.join(DIR, file)))
        .digest("hex");
      expect(
        actual,
        `${file} の中身が変わりました。manifest.json の version を上げ（同じ日は 2026-11-04.2 のように枝番）、sha256 を ${actual} に直してください。もう1つの PR を回す道具の写しも、この版で古さに気づきます`,
      ).toBe(entry.sha256);
    }
  });
});
