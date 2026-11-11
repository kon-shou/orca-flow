import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readFirstItem(): Promise<string> {
  const text = await readFile(path.join(ROOT, "skills/init/SKILL.md"), "utf8");
  const l = text.split("\n").find((x) => /^\s+- readFirst：/.test(x));
  expect(l, "readFirst の項").toBeDefined();
  return l ?? "";
}

describe("init のスキルの readFirst の項", () => {
  it("「設計の前に必ず読む」の古い言い方が残らない", async () => {
    const l = await readFirstItem();
    expect(l).not.toContain("設計の前に必ず読む");
  });

  it("先に読む文書で、タスク長が担当と確認役にも渡し、担当を起こすたびに読まれる", async () => {
    const l = await readFirstItem();
    expect(l).toContain("先に読む文書");
    expect(l).toContain("全文読み");
    expect(l).toContain("タスク長が担当と確認役にも渡す");
    expect(l).toContain("担当を起こすたびに読まれる");
  });

  it("種類ごとの決まりは readFirst に入れず、文書の側の表から指す。既定の CLAUDE.md が残る", async () => {
    const l = await readFirstItem();
    expect(l).toContain(
      "ファイルの種類（パターン）ごとに読む決まりは readFirst に入れず",
    );
    expect(l).toContain("文書の側の表から指す");
    expect(l).toContain("既定は `CLAUDE.md`");
  });
});
