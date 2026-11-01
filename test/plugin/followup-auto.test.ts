import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 見出しに当たる行の次から、同じ深さ以下の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const depth = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+) /.exec(l);
    return m !== null && (m[1]?.length ?? 99) <= depth;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 番号つきの手順の行と、続くインデントの行。 */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  const out = [lines[start] as string];
  for (const l of lines.slice(start + 1)) {
    if (/^\s+\S/.test(l) || l.trim() === "") out.push(l);
    else break;
  }
  return out.join("\n");
}

function bulletLine(block: string, prefix: string): string {
  const line = block.split("\n").find((l) => l.trim().startsWith(prefix));
  expect(line, `${prefix} の箇条が見つかりません`).toBeDefined();
  return line ?? "";
}

describe("後続のタスクのおまかせの選び方：integrate", () => {
  it("手順4：一覧と同じ AskUserQuestion の2問目で、ふつうに作るが先頭の Recommended", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 後続のタスクの作り方");
    expect(line).toContain("後続のタスクの作り方");
    expect(line).toContain("2問目");
    expect(line).toContain("AskUserQuestion と同じ呼び出し");
    expect(line).toContain("ふつうに作る（Recommended）");
    expect(line).toContain("おまかせで作る");
    expect(line.indexOf("ふつうに作る")).toBeLessThan(
      line.indexOf("おまかせで作る"),
    );
    expect(line).toContain("答えを使わない");
  });

  it("手順4：後続の箇条は、おまかせで作るときだけ --auto をつけ、auto log を残す", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 「後続のタスクにする」");
    expect(line).toContain("「おまかせで作る」");
    expect(line).toMatch(/「おまかせで作る」なら[^\n]*`--auto` つき/);
    expect(line).toContain("orca-flow auto log 〈後続の ID〉 '〈決めたこと〉'");
    expect(line).toContain("'\\''");
    expect(line).toContain("「ふつうに作る」");
    expect(line).toMatch(/ふつうに作る」[^\n]*つけない/);
  });

  it("手順4：new が止まっても、おまかせで作るなら人が打つ文に --auto を残す", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- new の手順の「止まる」");
    expect(line).toMatch(
      /「おまかせで作る」なら[^\n]*`\/orca-flow:new --auto /,
    );
  });

  it("手順4：決定の記録の箇条に、おまかせで作る・ふつうに作るがある", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 統合のときに決まった選択");
    expect(line).toContain("おまかせで作る");
    expect(line).toContain("ふつうに作る");
  });

  it("手順5：後続をどちらで作ったかを添える", async () => {
    const s5 = stepBlock(await read("skills/integrate/SKILL.md"), 5);
    expect(s5).toContain("おまかせで作ったか");
  });

  it("おまかせの決まり：聞かず、--auto をつけず、auto on を案内する", async () => {
    const rule = section(
      await read("skills/integrate/SKILL.md"),
      /^## おまかせの決まり/,
    );
    const line = bulletLine(rule, "6. ");
    expect(line).toContain("`--auto` をつけない");
    expect(line).toContain("聞かず");
    expect(line).toContain(
      "orca-flow auto log $0 '後続の 〈ID〉 をふつうに作った'",
    );
    expect(line).toContain("/orca-flow:auto on 〈ID〉");
  });
});

describe("後続のタスクのおまかせの選び方：new・auto", () => {
  it("new の手順5：おまかせで作ると選んだときだけ --auto をつける", async () => {
    const text = await read("skills/new/SKILL.md");
    const line = bulletLine(text, "- `orca-flow new --title");
    expect(line).toContain("後続のタスクを作る流れ");
    expect(line).toContain("おまかせで作る");
    expect(line).toContain("だけ `--auto` をつける");
  });

  it("auto の守ること：番では --auto をつけず、/orca-flow:auto on で後からおまかせにできる", async () => {
    const rules = section(await read("skills/auto/SKILL.md"), /^## 守ること/);
    const line = bulletLine(rules, "- 番で後続のタスク");
    expect(line).toContain("`--auto` をつけない");
    expect(line).toContain("/orca-flow:auto on");
  });
});

describe("後続のタスクのおまかせの選び方：docs/spec.md", () => {
  it("8章・10.1・12章に「おまかせで作る」があり、引き継がない旧文が残らない", async () => {
    const spec = await read("docs/spec.md");
    for (const h of [/^## 8\. CLI/, /^### 10\.1/, /^## 12\. /]) {
      expect(section(spec, h)).toContain("おまかせで作る");
    }
    const auto101 = section(spec, /^### 10\.1/);
    for (const prefix of ["- new：", "- approve・integrate："]) {
      const lines = auto101
        .split("\n")
        .filter((l) => l.startsWith(prefix) && l.includes("おまかせで作る"));
      expect(lines.length, `10.1 の ${prefix} の箇条`).toBeGreaterThan(0);
    }
    expect(spec).not.toContain("後続のタスクにはおまかせを引き継がない");
    expect(spec).not.toContain("後続のタスクにはおまかせは引き継がれない");
  });
});
