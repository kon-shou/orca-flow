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

/** 本文のうち、正規表現に当たる最初の行を返す。 */
function lineMatching(text: string, re: RegExp): string | undefined {
  return text.split("\n").find((line) => re.test(line));
}

/** 本文のうち、`〈数〉. ` で始まる手順の行を返す。 */
function stepLine(text: string, n: number): string | undefined {
  return lineMatching(text, new RegExp(`^${n}\\. `));
}

/** 見出しに当たる行の次から、次の「## 」の前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("skills/run/SKILL.md の verify", () => {
  it("手順5は orca-flow verify を流し、config の verify を順に流す書き方を残さない", async () => {
    const text = await read("skills/run/SKILL.md");
    const step = stepLine(text, 5);
    expect(step, "手順5の行が見つかりません").toBeDefined();
    expect(step).toContain("orca-flow verify");
    expect(text).not.toContain("config の verify のコマンドを順に");
  });

  it("手順5に、git diff --name-only による範囲の確認が残っている", async () => {
    const text = await read("skills/run/SKILL.md");
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^5\. /.test(l));
    const end = lines.findIndex((l, i) => i > start && /^6\. /.test(l));
    const block = lines.slice(start, end).join("\n");
    expect(block).toContain("範囲の確認");
    expect(block).toContain("git diff --name-only 〈baseBranch〉...HEAD");
  });

  it("手順10は orca-flow verify を orca-flow status integrate-wait より前に流す", async () => {
    const text = await read("skills/run/SKILL.md");
    const step = stepLine(text, 10);
    expect(step, "手順10の行が見つかりません").toBeDefined();
    const verify = (step ?? "").indexOf("orca-flow verify");
    const wait = (step ?? "").indexOf("orca-flow status integrate-wait");
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(wait).toBeGreaterThan(verify);
  });

  it("手順の番号は1から11まで変わらない", async () => {
    const text = await read("skills/run/SKILL.md");
    for (let n = 1; n <= 11; n++) {
      expect(stepLine(text, n), `手順${n}がありません`).toBeDefined();
    }
    expect(stepLine(text, 12)).toBeUndefined();
  });

  it("統括役からの知らせで、統合待ちなら verify を流し直して integrate-wait に戻す", async () => {
    const text = await read("skills/run/SKILL.md");
    const s = section(text, /^## 統括役から知らせが来たら/);
    const line = lineMatching(s, /統合待ち/);
    expect(line, "統合待ちの扱いの行が見つかりません").toBeDefined();
    expect(line).toContain("orca-flow verify");
    expect(line).toContain("orca-flow status integrate-wait");
    expect(s).toContain("orca-flow status question");
  });

  it("verify の終了コード3（rebase の競合）の直し方を書いている", async () => {
    const text = await read("skills/run/SKILL.md");
    const line = lineMatching(text, /^\s*- 3/);
    expect(line, "終了コード3の行が見つかりません").toBeDefined();
    expect(line).toContain("git rebase 〈baseBranch〉");
    expect(line).toContain("git rebase --continue");
  });
});

describe("docs/spec.md の verify", () => {
  it("6章に verifySkipPaths がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 6\. /);
    expect(s).toContain("verifySkipPaths");
  });

  it("8章に verify のサブコマンドの行と --verify-here がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 8\. /);
    expect(lineMatching(s, /^\| `verify`/)).toBeDefined();
    expect(s).toContain("--verify-here");
  });

  it("10.1 の run の行に orca-flow verify があり、integrate の行に --verify-here がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 10\. /);
    const run = lineMatching(s, /^\| `\/orca-flow:run /);
    expect(run).toContain("orca-flow verify");
    const integrate = lineMatching(s, /^\| `\/orca-flow:integrate /);
    expect(integrate).toContain("--verify-here");
  });

  it("12章に、記録が使えないときの打ち直しがある", async () => {
    const s = section(await read("docs/spec.md"), /^## 12\. /);
    expect(s).toContain("integrate-wait");
    expect(s).toContain("記録");
  });
});
