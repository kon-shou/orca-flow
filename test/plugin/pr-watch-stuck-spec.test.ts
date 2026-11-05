import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 8章の「**見張り（pr-watch）**」の段落から、次の太字の見出しの段落の前まで */
async function watchSection(): Promise<string> {
  const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("**見張り（pr-watch）**"));
  expect(start, "見張りの節がありません").toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("**"));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

describe("仕様書：見張りの締め切りと止まったときの扱い", () => {
  it("回の締め切り45秒を書いている", async () => {
    const s = await watchSection();
    expect(s).toContain("45秒");
    expect(s).toContain("次の回にやり直");
  });

  it("後始末のやり直しの上限（12回か1時間）と、上限のときの「後始末で止まった」を書いている", async () => {
    const s = await watchSection();
    expect(s).toContain("12回か1時間");
    expect(s).toContain("cleanup-stopped");
    expect(s).toContain("後始末で止まった：PR #n");
    expect(s).toContain("push をもう一度打つとやり直します");
    expect(s).toContain("自動でやり直さない");
    expect(s).toContain("push の打ち直し");
    expect(s).toContain("`mergeCommit` があれば");
  });

  it("クローズは上限の扱いを変えないと書いている", async () => {
    const s = await watchSection();
    expect(s).toContain("クローズ");
    expect(s).toContain("札を書き直すだけ");
  });

  it("終わった PR と回数の記録を30日残すと書いている", async () => {
    const s = await watchSection();
    expect(s).toContain("30日");
    expect(s).toContain("usage-〈日付〉.jsonl");
    expect(s).toContain("2段目に入れない");
  });

  it("見張りは通っても下書きを外さず、古い解除の記録（releasePending・releaseStop）を読み飛ばすと書いている", async () => {
    const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    expect(text).toContain("通っても下書きを外さない");
    expect(text).toContain("下書きの解除は見張りの仕事ではない");
    expect(text).toContain("`releasePending`・`releaseStop` は読み飛ばす");
    expect(text).toContain("承認済み・CI 待ちの古い案があっても見張りは送らず");
  });
});

describe("仕様書：WSL の形と落ち続けの案内", () => {
  it("8章の見張りに WSL の形（wsl.exe）と断る形を書き、今の precheck の文は残している", async () => {
    const s = await watchSection();
    expect(s).toContain("wsl.exe");
    expect(s).toContain("WSL_DISTRO_NAME");
    expect(s).toContain("--cd ~ -e");
    expect(s).toContain("PATH の `orca-flow` に頼らず");
    expect(s).toContain("CMD で渡せない");
  });

  it("8章の見張りに落ち続けの決め方と、usage・push で同じ文を書いている", async () => {
    const s = await watchSection();
    expect(s).toContain("落ち続けています");
    expect(s).toContain("lastRunAt");
    expect(s).toContain("間隔の2回分");
    expect(s).toContain("10分");
    expect(s).toContain(
      "orca-flow pr-watch install を打ち直すと、今の形に直ります",
    );
    expect(s).toContain("orca automations runs --id");
  });

  it("8章の pr-watch の行に WSL の形と落ち続けの案内がある", async () => {
    const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    const row = text
      .split("\n")
      .find((l) => l.startsWith("| `pr-watch [usage"));
    expect(row).toBeDefined();
    expect(row).toContain("wsl.exe");
    expect(row).toContain("落ち続けています");
  });

  it("12章の見張りの項に、落ち続けの案内と打ち直しを書いている", async () => {
    const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("## 12. "));
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    const body = rest.slice(0, end).join("\n");
    const para = body.split("\n").find((l) => l.startsWith("**見張り**")) ?? "";
    expect(para).toContain("落ち続けています");
    expect(para).toContain("orca-flow pr-watch install");
    expect(para).toContain("WSL");
  });
});
