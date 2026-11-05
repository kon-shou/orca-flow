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

  it("orca-flow pstack で opening-a-pr の手引きを引いて読む", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain(
      "orca-flow pstack skills/poteto-mode/playbooks/opening-a-pr.md --json",
    );
    expect(text).toContain("harness");
    expect(text).toMatch(/file[^\n]*手引き[^\n]*読む/);
    expect(text).toContain("6つの節");
    expect(text).not.toContain("claude plugin list --json");
    expect(text).not.toContain("opening-a-pr の SKILL.md");
  });

  it("終了コードが0以外なら飛ばして短い形で書き、「pstack なし」と CLI の理由を人に伝える", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("終了コードが0以外");
    expect(text).toContain("飛ばして");
    expect(text).toContain("短い形");
    expect(text).toContain("pstack なし");
    expect(text).toContain("理由の1行");
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
    expect(text).toContain("/orca-flow:merge");
    expect(text).not.toContain("マージは人が GitHub で行う");
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

  it("push は案を積んで見せるだけで、send・gh・git push を流さず、承認した send で送るよう伝える", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toMatch(/`orca-flow send`・`gh`・`git push` を流さない/);
    expect(text).toContain("案を積んで");
    expect(text).toContain("束の指紋");
    expect(text).toContain("/orca-flow:send $0");
    expect(text).toContain("送る前の確認待ち");
    expect(text).toContain("--force-with-lease");
    // 手順に send・gh・git push を流す指示がない
    const steps = section(text, "## 手順");
    expect(steps).not.toMatch(/`(orca-flow send|gh |git push)[^`]*` を流す/);
    expect(text).not.toMatch(/push して、下書きの PR を出す。/);
    // PR は下書きでない形で出る。CI のあとの自動の解除はない
    expect(text).toContain("下書きでない形で出る");
    expect(text).not.toContain("下書きの PR の作成");
    expect(text).not.toContain('"after-ci"` なら');
    expect(text).toContain("prReady は読まない");
  });

  it("先頭が変わっていない2回目は見張りの案内だけと書き、見張りの automation の作り方を伝える", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("確かめも push もせず");
    expect(text).toContain("見張りの案内だけを出して");
    expect(text).toContain(
      "開いた PR が下書きなら `pr-ready` の案（下書きを外す）だけを積んで",
    );
    expect(text).toContain("積んだままの `pr-ready` の案を取り下げる");
    expect(text).toContain("見張りの automation がない");
    expect(text).toContain("orca-flow pr-watch install");
    expect(text).toContain("今すぐ実行");
    expect(text).toContain("待ち受けが後始末をしています");
    expect(text).toContain("orca-flow pr-watch usage");
  });
});

describe("docs/spec.md：push の道", () => {
  it("8章に push の行がある", async () => {
    const text = await read("docs/spec.md");
    const s = section(text, "## 8. CLI");
    expect(s).toMatch(/\| `push 〈ID〉 \[--body-file 〈パス〉\] \[--show\]`/);
  });

  it("6章の prReady の行は、使わない・書いてあっても読み飛ばし・設定の誤りにしないと書く", async () => {
    const text = await read("docs/spec.md");
    const s = section(text, "## 6. リポジトリごとの設定");
    const row = s.split("\n").find((l) => l.startsWith("| prReady"));
    expect(row, "prReady の行がありません").toBeDefined();
    expect(row).toContain("使わない");
    expect(row).toContain("読み飛ばし");
    expect(row).toContain("設定の誤りにしない");
    expect(row).not.toContain("CI が通ったら orca-flow が外す");
  });

  it("push の節：skip を使えない・起こし直し・main のロック・カードの印", async () => {
    const text = await read("docs/spec.md");
    const s = section(text, "## 8. CLI");
    expect(s).toContain("`--skip-order`・`--skip-decision` は push にない");
    expect(s).toContain("orca-flow order --remove");
    expect(s).toContain(
      "確かめも push もせず、開いた PR が下書きなら `pr-ready` の案（下書きを外す）だけを積んで束を出し、下書きでなければ見張りの案内だけを出す",
    );
    expect(s).toContain("積んだままの `pr-ready` の案を取り下げる");
    expect(s).not.toContain("確かめも案積みもせず");
    expect(s).toContain("orca-flow/main.lock");
    expect(s).toContain("待ち受けが後始末をしています");
  });

  it("1章の範囲に PR の道がある", async () => {
    const text = await read("docs/spec.md");
    const s = section(text, "## 1. 目的と範囲");
    expect(s).toContain("push の道（`/orca-flow:push`）では");
    expect(s).toContain("`/orca-flow:send` で");
    expect(s).toContain("承認した案だけを orca-flow が送る");
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
