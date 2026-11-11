import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function lineStarting(text: string, head: string): string {
  const found = text.split("\n").filter((l) => l.startsWith(head));
  expect(found, head).toHaveLength(1);
  return found[0] ?? "";
}

describe("split の子に先に読む文書を届ける", () => {
  it("split の手順9の new に --read-first-from 〈親の ID〉 がいつも付く", async () => {
    const step = lineStarting(
      await read("skills/split/SKILL.md"),
      "9. 子を始める：",
    );
    expect(step).toMatch(/`orca-flow new [^`]*--read-first-from \$0`/);
    expect(step).toContain("いつも付ける");
    expect(step).toContain("親に記録がなくても付けてよい");
    expect(step).toContain("new が落ちたとき");
  });

  it("6章の記録の段落に、split の子の new が親の記録を写すことと、どちらも付けない new が古い記録を消すことがある", async () => {
    const l = lineStarting(
      await read("docs/spec.md"),
      "**先に読む文書の記録**",
    );
    expect(l).toContain("--read-first-from 〈親の ID〉");
    expect(l).toMatch(/split[^\n]*--read-first-from/);
    expect(l).toContain("親に記録がなければ子の記録も作らない");
    expect(l).toContain(
      "`--read-first-json` と `--read-first-from` のどちらも付けない `new` は、同じ ID の古い記録を消す",
    );
  });

  it("8章の子の new --read-first-json の項のすぐ後ろに、new --read-first-from の項がある", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const i = lines.findIndex((x) =>
      x.startsWith("- 子の `new --read-first-json`："),
    );
    expect(i).toBeGreaterThanOrEqual(0);
    const l = lines[i + 1] ?? "";
    expect(l.startsWith("- `new --read-first-from 〈親の ID〉`")).toBe(true);
    for (const w of [
      "Orca を呼ぶ前に子の記録",
      "親に記録がなければ子の記録を書かず",
      "古い記録を消す",
      "ORCA_FLOW_FROM_WORKSPACE` は求めない",
      "`idPrefix`",
      "`--read-first-json` と一緒",
      "壊れている",
      "読めない",
      "依頼のファイルも記録も worktree も作らず終了コード1",
    ]) {
      expect(l, w).toContain(w);
    }
    expect(l).toMatch(/## 先に読む文書[^\n]*節からは読む文書を決めない/);
  });

  it("10.1 の split の分け方の項で、子を始める new に --read-first-from 〈親〉 が付く", async () => {
    const spec = await read("docs/spec.md");
    const sec = spec.slice(
      spec.indexOf("\n### 10.1 "),
      spec.indexOf("\n### 10.2 "),
    );
    const l = lineStarting(sec, "- 分け方：");
    expect(l).toMatch(/`orca-flow new [^`]*--read-first-from 〈親〉`/);
    expect(l).toContain("いつも付け");
  });
});
