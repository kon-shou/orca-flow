import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  idFromMergeSubject,
  mergeSubject,
} from "../../src/lib/merge-subject.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("mergeSubject / idFromMergeSubject", () => {
  it("作った件名から同じ ID が取り出せる", () => {
    expect(mergeSubject("統括役", "T12")).toBe("統括役: T12 をマージする");
    expect(idFromMergeSubject("統括役", mergeSubject("統括役", "T12"))).toBe(
      "T12",
    );
  });

  it("integratorName の正規表現の記号は文字どおりに当たる", () => {
    const name = "a.b(c)";
    expect(idFromMergeSubject(name, mergeSubject(name, "Q1"))).toBe("Q1");
    expect(idFromMergeSubject(name, "aXb(c): Q1 をマージする")).toBeNull();
    expect(idFromMergeSubject(name, "a.bc: Q1 をマージする")).toBeNull();
  });

  it("前後に文字がある・ID に空白がある・ほかの名前の件名は取り出さない", () => {
    const ok = mergeSubject("統括役", "T1");
    expect(idFromMergeSubject("統括役", `前${ok}`)).toBeNull();
    expect(idFromMergeSubject("統括役", `${ok}後`)).toBeNull();
    expect(idFromMergeSubject("統括役", "統括役: T 1 をマージする")).toBeNull();
    expect(
      idFromMergeSubject("統括役", mergeSubject("別の役", "T1")),
    ).toBeNull();
  });
});

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTs(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("件名の字の置き場", () => {
  it("src と scripts の .ts で「 をマージする」があるのは merge-subject.ts だけ", () => {
    const found = [
      ...listTs(path.join(ROOT, "src")),
      ...listTs(path.join(ROOT, "scripts")),
    ]
      .filter((file) => readFileSync(file, "utf8").includes(" をマージする"))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
    expect(found).toEqual(["src/lib/merge-subject.ts"]);
  });
});
