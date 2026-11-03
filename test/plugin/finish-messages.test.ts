import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

describe("new のスキルの例", () => {
  it("打ち直しの案内に --auto を頭に置く例があり、古い形が残らない", async () => {
    const text = await read("skills/new/SKILL.md");
    expect(text).toContain("`/orca-flow:new [--auto] 〈やりたいこと〉`");
    expect(text).not.toContain("`/orca-flow:new 〈やりたいこと〉`");
    expect(text).toContain("頭に置く");
  });

  it("タスク名は一重引用符で囲み、中の ' は '\\'' にする", async () => {
    const text = await read("skills/new/SKILL.md");
    expect(text).toContain("--title '〈タスク名〉'");
    expect(text).toContain("'\\''");
    expect(text).not.toContain('--title "');
  });
});

describe("ロックのコメント", () => {
  it.each(["src/commands/integrate.ts", "src/commands/approve.ts"])(
    "%s は背景の後始末と書かず、ロックの相手を書く",
    async (file) => {
      const text = await read(file);
      expect(text).not.toContain("背景の後始末");
      const line = text
        .split("\n")
        .find((l) => l.includes("main を書き換える") && l.includes("ロック"));
      expect(line).toBeDefined();
      expect(line).toContain("push の道の後始末");
      expect(line).toContain("new");
    },
  );
});
