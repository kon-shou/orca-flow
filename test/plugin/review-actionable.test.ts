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

function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}がありません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (l, i) => i > start && new RegExp(`^${n + 1}\\. `).test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function lineMatching(text: string, re: RegExp): string | undefined {
  return text.split("\n").find((line) => re.test(line));
}

describe("検証役に渡す指摘", () => {
  it("レビューは必ず直す・直したほうがよいだけを渡し、確認だけ・前からあるは渡さない", async () => {
    const text = await read("skills/review/SKILL.md");
    const step = stepBlock(text, 5);
    expect(step).toContain("「必ず直す」「直したほうがよい」だけ");
    expect(step).toContain("「確認だけ」と「前からある」は渡さない");
    expect(step).toContain("「検証していない」");
  });

  it("渡さなかった指摘は報告で検証していないと分かる", async () => {
    const text = await read("skills/review/SKILL.md");
    const report = lineMatching(text, /報告に書くもの：/);
    expect(report).toContain("「検証していない」");
    expect(stepBlock(text, 9)).toContain("検証に回した数");
  });

  it("検証役の定義は直させる候補だけを受ける", async () => {
    const text = await read("agents/review-verifier.md");
    expect(text).toContain("直させる候補");
    expect(text).toContain("「確認だけ」と「前からある」は渡されない");
  });

  it("タスク長は直させる前に根拠を開き、違えば外して報告する", async () => {
    const text = await read("skills/run/SKILL.md");
    const step = stepBlock(text, 6);
    expect(step).toContain("根拠のファイルと行を開いて確かめる");
    expect(step).toContain("「直させるもの」から外し");
  });

  it("仕様の review の行にも、渡す指摘の絞り込みがある", async () => {
    const text = await read("docs/spec.md");
    const row = lineMatching(text, /^\| `\/orca-flow:review /);
    expect(row).toContain("「必ず直す」「直したほうがよい」だけ");
    expect(row).toContain("「確認だけ」と「前からある」は渡さず");
    expect(row).toContain("検証していない");
  });
});
