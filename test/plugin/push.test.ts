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

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}`);
  expect(start, `${heading} が見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(heading.length).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, heading.length + next);
}

describe("skills/push/SKILL.md", () => {
  it("frontmatter が integrate と同じ形", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toMatch(/^---\nname: push\n/);
    expect(text).toContain("argument-hint:");
    expect(text).toContain("disable-model-invocation: true");
  });

  it("pstack の場所を1回引き、opening-a-pr の SKILL.md を読む", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("claude plugin list --json");
    expect(text).toContain("opening-a-pr");
    expect(text).toMatch(/opening-a-pr[^\n]*SKILL\.md[^\n]*読む/);
    expect(text).toContain("6つの節");
  });

  it("見つからなければ飛ばして短い形で書き、「pstack なし」を人に伝える", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("見つからなければ");
    expect(text).toContain("飛ばして");
    expect(text).toContain("短い形");
    expect(text).toContain("pstack なし");
  });

  it("opening-a-pr の指示はこの定義の禁止より優先しない", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toMatch(/この定義の禁止より優先しない/);
  });

  it("本文に記録のパス・手元のパス・秘密を書かない", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toMatch(/本文に[^\n]*設計書と報告のパス[^\n]*書かない/);
    expect(text).toContain("手元のパス");
    expect(text).toContain("秘密");
  });

  it("push を流し、終了コードごとの扱いと後始末を伝える", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("orca-flow push $0 --body-file");
    expect(text).toContain("--show");
    expect(text).toContain("GitHub で行う");
    for (const code of ["0", "1", "2", "3"]) {
      expect(text).toContain(`- ${code}`);
    }
  });

  it("終了コード2で --skip-order・--skip-decision を案内しない（order --remove を案内する）", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).not.toMatch(/--skip-order[^\n]*(を使う|をつけ)/);
    expect(text).toContain("orca-flow order --remove");
    expect(text).toMatch(/push にない/);
    expect(text).not.toContain("main の確かめが落ちています");
  });

  it("先頭が変わっていない2回目は待ち受けを起こし直すだけと書く", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("確かめも push もせず");
    expect(text).toContain("待ち受けを起こし直す");
    expect(text).toContain("待ち受けが後始末をしています");
    expect(text).toContain("待ち受けが止まった");
  });
});

describe("docs/spec.md：push の道", () => {
  it("8章に push の行がある", async () => {
    const text = await read("docs/spec.md");
    const s = section(text, "## 8. CLI");
    expect(s).toMatch(/\| `push 〈ID〉 \[--body-file 〈パス〉\] \[--show\]`/);
  });

  it("6章に prReady の行がある", async () => {
    const text = await read("docs/spec.md");
    const s = section(text, "## 6. リポジトリごとの設定");
    const row = s.split("\n").find((l) => l.startsWith("| prReady"));
    expect(row, "prReady の行がありません").toBeDefined();
    expect(row).toContain('"manual"');
    expect(row).toContain('"after-ci"');
  });

  it("push の節：skip を使えない・起こし直し・main のロック・カードの印", async () => {
    const text = await read("docs/spec.md");
    const s = section(text, "## 8. CLI");
    expect(s).toContain("`--skip-order`・`--skip-decision` は push にない");
    expect(s).toContain("orca-flow order --remove");
    expect(s).toContain("確かめも push もせず、待ち受けを起こし直すだけ");
    expect(s).toContain("orca-flow/main.lock");
    expect(s).toContain("待ち受けが止まった：PR #n");
    expect(s).toContain("待ち受けが後始末をしています");
  });

  it("1章の範囲に PR の道がある", async () => {
    const text = await read("docs/spec.md");
    const s = section(text, "## 1. 目的と範囲");
    expect(s).toContain("push の道では orca-flow が PR を出し");
    expect(s).not.toContain("リモートへの push と PR の作成。人間が行う。");
  });

  it("10.1 にスキルの行、12章に人の使い方がある", async () => {
    const text = await read("docs/spec.md");
    expect(section(text, "### 10.1 スキル")).toContain(
      "`/orca-flow:push 〈ID〉`",
    );
    expect(section(text, "## 12. 人間の使い方")).toContain("/orca-flow:push");
  });
});
