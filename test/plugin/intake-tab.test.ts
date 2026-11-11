import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 「## 見出し」の行から、次の「## 」の前までを返す。 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `## ${heading}`);
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("intake を新しいタブで走らせる：skills/intake/SKILL.md の入口", () => {
  it("入口の節が手順の節の前にあり、番号つきの行を使わない", async () => {
    const text = await read("skills/intake/SKILL.md");
    const body = section(text, "入口");
    expect(text.indexOf("## 入口")).toBeLessThan(text.indexOf("## 手順"));
    expect(body).not.toMatch(/^\s*\d+\. /m);
    expect(body).toMatch(/^- /m);
  });

  it("手順の番号は1〜11のまま並ぶ", async () => {
    const steps = section(await read("skills/intake/SKILL.md"), "手順");
    const nums = steps
      .split("\n")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("頭の --here の見分け：あれば外して今の手順へ、なければ入口", async () => {
    const lines = section(await read("skills/intake/SKILL.md"), "入口").split(
      "\n",
    );
    const withHere = lines.find((l) => l.includes("頭が `--here`")) ?? "";
    expect(withHere, "--here がある行").not.toBe("");
    expect(withHere).toContain("外して");
    expect(withHere).toContain("下の手順へ進む");
    expect(withHere).not.toContain("入口をする");
    const without =
      lines.find((l) => l.includes("頭に `--here` がなければ")) ?? "";
    expect(without, "--here がない行").not.toBe("");
    expect(without).toContain("本体を走らせず");
    expect(without).toContain("入口をする");
    expect(without).not.toContain("外して");
    expect(without).not.toContain("下の手順へ進む");
  });

  it("Notion の道具の確かめを入口でする", async () => {
    const body = section(await read("skills/intake/SKILL.md"), "入口");
    expect(body).toContain("ToolSearch");
    expect(body).toContain("Notion");
  });

  it("orca-flow intake を一重引用符の URL で流す", async () => {
    const body = section(await read("skills/intake/SKILL.md"), "入口");
    expect(body).toContain("orca-flow intake '〈URL〉'");
  });

  it("終了コードごとの扱いがあり、1で Orca が落ちたときは立っていないかを確かめてから --here で続ける", async () => {
    const lines = section(await read("skills/intake/SKILL.md"), "入口").split(
      "\n",
    );
    const line = (code: string): string =>
      lines.find((l) => l.includes(`終了コード${code}：`)) ?? "";
    for (const code of ["0", "1", "2"]) {
      expect(line(code), `終了コード${code}`).not.toBe("");
    }
    const one = line("1");
    expect(one).toContain("立っていないか");
    expect(one).toContain("/orca-flow:intake --here");
    expect(one.indexOf("立っていないか")).toBeLessThan(
      one.indexOf("/orca-flow:intake --here"),
    );
  });

  it("終了コード0は場所を伝えて止まり、手順を続けない", async () => {
    const lines = section(await read("skills/intake/SKILL.md"), "入口").split(
      "\n",
    );
    const zero = lines.find((l) => l.includes("終了コード0：")) ?? "";
    expect(zero).toContain("場所");
    expect(zero).toContain("止まる");
    expect(zero).toContain("何もしない");
    expect(zero).not.toContain("手順へ進む");
  });

  it("本体の手順にある打ち直しの案内には --here が付く", async () => {
    const text = await read("skills/intake/SKILL.md");
    const lines = text
      .split("\n")
      .filter((l) => /\/orca-flow:intake\s+〈/.test(l));
    expect(lines).toHaveLength(0);
    expect(text).toContain("/orca-flow:intake --here 〈仕様のページの URL〉");
  });

  it("手元のパスは、頭に --here がなければ Notion を探さず一重引用符で intake を流し、--here があれば local.md へ", async () => {
    const lines = section(await read("skills/intake/SKILL.md"), "入口").split(
      "\n",
    );
    const first = lines.find((l) => l.startsWith("- ")) ?? "";
    expect(first).toContain("頭に `--here` があれば");
    expect(first).toContain("skills/intake/local.md");
    const noHere =
      lines.find((l) => l.includes("`--here` のない手元のパス")) ?? "";
    expect(noHere, "--here のない手元のパスの項").not.toBe("");
    expect(noHere).toContain("Notion の道具を探さず");
    expect(noHere).not.toContain("外して");
    const run =
      lines.find((l) => l.includes("orca-flow intake '〈手元のパス〉'")) ?? "";
    expect(run, "手元のパスを流す項").not.toBe("");
    expect(run).toContain("一重引用符");
    expect(run).toContain("`'\\''`");
    expect(run).toContain("終了コードの扱いは URL と同じ");
  });

  it("Notion の道具を探す項は URL のときだけで、手元のパスの項より前にない", async () => {
    const body = section(await read("skills/intake/SKILL.md"), "入口");
    const search = body.split("\n").find((l) => l.includes("ToolSearch")) ?? "";
    expect(search.startsWith("- URL のとき")).toBe(true);
    expect(body.indexOf("`--here` のない手元のパス")).toBeLessThan(
      body.indexOf("ToolSearch"),
    );
  });

  it("終了コード1は手元のパスの誤りも伝え、Orca が落ちたときは --here 〈実のパス〉を案内する", async () => {
    const lines = section(await read("skills/intake/SKILL.md"), "入口").split(
      "\n",
    );
    const one = lines.find((l) => l.includes("終了コード1：")) ?? "";
    expect(one).toContain("手元のパスの誤り");
    expect(one).toContain("--here 〈実のパス〉");
  });
});
