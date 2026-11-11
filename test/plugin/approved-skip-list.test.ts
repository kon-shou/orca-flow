import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const APPROVED = "「作るもの」「設計の経緯」「出し方」に書かれて承認された選択";

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** 始まりの行から、終わりの行の前まで（終わりがなければ最後まで） */
function blockFrom(text: string, start: RegExp, end: RegExp): string {
  const lines = text.split("\n");
  const s = lines.findIndex((l) => start.test(l));
  expect(s, `行が見つかりません：${start}`).toBeGreaterThanOrEqual(0);
  const e = lines.findIndex((l, i) => i > s && end.test(l));
  return lines.slice(s, e < 0 ? undefined : e).join("\n");
}

/** 手順の行（`〈数〉. ` で始まる行）から、次の手順の行の前まで */
function stepBlock(text: string, n: number): string {
  return blockFrom(text, new RegExp(`^${n}\\. `), new RegExp(`^${n + 1}\\. `));
}

function lineStarting(text: string, re: RegExp): string {
  const line = text.split("\n").find((l) => re.test(l));
  expect(line, `行が見つかりません：${re}`).toBeDefined();
  return line as string;
}

describe("判断事項から外す承認済みの選択の一覧が4か所でそろう", () => {
  it("レビュー役の手順3の「外すもの」の行", async () => {
    const body = await read("agents/code-reviewer.md");
    const line = lineStarting(stepBlock(body, 3), /^\s*- 外すもの：/);
    expect(line).toContain(APPROVED);
  });

  it("検証役の手順7", async () => {
    const body = await read("agents/review-verifier.md");
    expect(stepBlock(body, 7)).toContain(APPROVED);
  });

  it("review のスキルの「判断事項：」の段落", async () => {
    const body = await read("skills/review/SKILL.md");
    const para = lineStarting(body, /^判断事項：/);
    expect(para).toContain(APPROVED);
  });

  it("仕様書 10.2 のレビュー役の項目5", async () => {
    const spec = await read("docs/spec.md");
    const sec = blockFrom(spec, /^### 10\.2 /, /^##+ /);
    const reviewer = blockFrom(
      sec,
      /^\*\*agents\/code-reviewer\.md\*\*/,
      /^\*\*agents\//,
    );
    const item = lineStarting(reviewer, /^5\. /);
    expect(item).toContain(APPROVED);
  });
});
