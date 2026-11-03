import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const lineOf = (text: string, start: string) =>
  text.split("\n").find((l) => l.startsWith(start)) ?? "";

describe("union で行が消えるときの止め方（文のテスト）", () => {
  it("push のスキルの「後始末で止まった」の原因に記録の行が消える件がある", async () => {
    const text = await read("skills/push/SKILL.md");
    const line = lineOf(text, "   - 様子は");
    expect(line).toContain("後始末で止まった");
    expect(line).toContain("手元の行が取り込んだあとの先頭に残りません");
    expect(line).toContain("取り込みは戻");
  });

  it("run のスキルに verify も同じ確かめで止まることがある", async () => {
    const text = await read("skills/run/SKILL.md");
    expect(text).toContain("先頭とそのまま同じか");
    expect(text).toContain(
      "も rebase のあと（しなかったときも）テストの前に同じ確かめをして止まる",
    );
    expect(text).toContain("の先頭と同じではありません");
  });

  it("integrate のスキルの「CLI が戻すのは」に verify がある", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).toMatch(/CLI が戻すのは[^）]*verify/);
  });

  it("仕様の8章の verify の行に空行の戻しと追記だけの確かめがある", async () => {
    const spec = await read("docs/spec.md");
    const row = lineOf(spec, "| `verify`");
    expect(row).toContain("追記だけの確かめ");
    expect(row).toContain("の先頭と同じではありません");
    expect(row).toContain("マージで欠けた決定の記録の空行を戻す");
  });

  it("仕様の7章の2と push の道の後始末に行が消えたら止めることがある", async () => {
    const spec = await read("docs/spec.md");
    const rule = lineOf(spec, "2. **追記だけのファイルは union でマージする**");
    expect(rule).toContain("行がまとめられて消えたら");
    const cleanup = lineOf(spec, "- マージを見つけたときの後始末は");
    expect(cleanup).toContain("手元の行が取り込んだあとの先頭に残りません");
    expect(cleanup).toContain("取り込みを何も変えずに戻");
  });
});
