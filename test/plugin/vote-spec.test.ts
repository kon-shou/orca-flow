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

/** 「## 〈番号〉. 」の見出しから、次の「## 」の前まで。 */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章が見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("respond のスキル：合議の手順", () => {
  it("人に聞く前に、指摘ごとに vote cast を流す", async () => {
    const s = await read("skills/respond/SKILL.md");
    expect(s).toContain("orca-flow vote cast $0");
    expect(s).toContain("--target");
    expect(s).toContain("--kind");
    expect(s).toContain("--first");
    const lines = s.split("\n");
    const cast = lines.findIndex((l) => l.includes("orca-flow vote cast"));
    const ask = lines.findIndex((l) =>
      l.includes("PR ごとにまとめて人間に聞く"),
    );
    expect(cast).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(0);
    // cast の行は、人に聞く行（手順5）より前。手順7（待つ）より前でもある
    expect(cast).toBeLessThan(ask);
    const wait = lines.findIndex((l) => l.startsWith("7. 人間が答えるまで"));
    expect(cast).toBeLessThan(wait);
    expect(s).toMatch(/人に聞く前に[^\n]*vote cast/);
    expect(s).toContain("迷えば7項目の側");
  });

  it("2票目の結果によらず全部の指摘を人に聞き、2票目を人に見せない", async () => {
    const s = await read("skills/respond/SKILL.md");
    expect(s).toContain("2票目の結果によらず、全部の指摘を人に聞く");
    expect(s).toMatch(/2票目の答え[^\n]*人に見せない/);
  });

  it("人の答えが決まってから vote answer を指摘ごとに1回だけ流す（変えそうなら決まるまで待つ）", async () => {
    const s = await read("skills/respond/SKILL.md");
    expect(s).toContain("orca-flow vote answer $0");
    expect(s).toContain("--human");
    expect(s).toContain("人の答えが決まってから、指摘ごとに1回だけ");
    expect(s).toContain("決まるまで待つ");
    expect(s).not.toContain("最後の答え");
  });

  it("答え済みの指摘に cast をやり直さない（前の会話の分も）", async () => {
    const s = await read("skills/respond/SKILL.md");
    expect(s).toMatch(/答え済みの指摘[^\n]*vote cast[^\n]*やり直さない/);
    expect(s).toContain("この会話より前に答えて");
    expect(s).toContain("引き継ぎにある");
  });

  it("スレッド・会話の欄のコメント・レビューの本文を ID で合議にかけ、答え済みは CLI が断る", async () => {
    const s = await read("skills/respond/SKILL.md");
    expect(s).toMatch(
      /スレッド・会話の欄のコメント・レビューの本文の指摘[^\n]*`--target` に渡す/,
    );
    expect(s).toMatch(
      /答え済みの対象への `vote cast` は CLI が記録せず終了コード1で断る/,
    );
    expect(s).toMatch(
      /断られたら[^\n]*人には聞き[^\n]*`vote answer` は流さない/,
    );
    expect(s).not.toMatch(/スレッドの指摘だけ/);
    expect(s).not.toMatch(
      /会話の欄のコメントとレビューの本文は[^\n]*合議にかけない/,
    );
  });

  it("CI の赤の直しは合議にかけない", async () => {
    const s = await read("skills/respond/SKILL.md");
    expect(s).toMatch(/CI の赤[^\n]*合議にかけない/);
  });

  it("答えのキーは fix・wontfix・ask の3つ", async () => {
    const s = await read("skills/respond/SKILL.md");
    for (const k of ["`fix`", "`wontfix`", "`ask`"]) expect(s).toContain(k);
  });
});

describe("仕様書：実装7の分を15章から移した", () => {
  it("15章の小節（15.2・15.3・15.4・15.6・15.7）がなく、「実装7が入れる」の文もない", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).not.toMatch(/^## 15\. /m);
    for (const no of ["15.2", "15.3", "15.4", "15.6", "15.7"])
      expect(spec).not.toContain(`### ${no} `);
    expect(spec).not.toContain("実装7が入れる");
  });

  it("6章：risk の行と vote の記録", async () => {
    const c6 = chapter(await read("docs/spec.md"), 6);
    const row = c6.split("\n").find((l) => l.startsWith("| risk "));
    expect(row).toBeDefined();
    expect(row).toContain('{ "paths": [], "labels": [] }');
    expect(row).toContain("2票目をとらない");
    expect(row).toContain("判断事項の7項目");
    expect(c6).toContain("`vote/〈ID〉.jsonl`");
  });

  it("8章：vote の行（cast・answer・stats）", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const row = c8.split("\n").find((l) => l.startsWith("| `vote "));
    expect(row).toBeDefined();
    for (const w of ["vote cast", "vote answer", "vote stats", "--kind"]) {
      expect(c8, w).toContain(w);
    }
    expect(row).toContain("答え済みの対象への `cast` は");
    expect(row).toContain("記録せず、終了コード1で断る");
  });

  it("10.1：respond の行に合議にかけないものと合議の手順がある", async () => {
    const c10 = chapter(await read("docs/spec.md"), 10);
    const para = c10
      .split("\n")
      .find((l) => l.startsWith("**respond の手順**"))!;
    expect(para).toContain("`risk` に当たるものは合議にかけず人に回す");
    expect(para).toContain("vote cast");
    expect(para).toContain("vote answer");
    expect(para).toContain("2票目の結果によらず");
    expect(para).not.toMatch(/合議にかけない。人の答え/);
    expect(para).not.toContain("ID がないので合議にかけない");
    expect(para).not.toContain("ID が出るスレッドの指摘だけ");
    expect(para).toContain(
      "スレッド・会話の欄のコメント・レビューの本文の指摘で、入力ファイルの ID を `--target` に渡す",
    );
    expect(para).toContain(
      "答え済みの対象への `vote cast` は CLI が記録せず終了コード1で断るので、断られたら人には聞き、`vote answer` は流さない",
    );
    expect(para).toContain("人の答えが決まってから1回だけ");
    expect(para).toContain("`vote cast` をやり直さない");
    expect(para).not.toContain("変えたら最後の答え");
  });

  it("13章：2票目の claude -p の実物の確かめ", async () => {
    const c13 = chapter(await read("docs/spec.md"), 13);
    expect(c13).toMatch(/2票目の `claude -p`/);
  });
});
