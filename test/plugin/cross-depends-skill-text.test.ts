import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

describe("またぐ依存の文（スキルと仕様書）", () => {
  it("run の「戻す」の箇条は merge だけを挙げる", async () => {
    const t = await read("skills/run/SKILL.md");
    const line = t.split("\n").find((l) => l.startsWith("- 戻す"));
    expect(line).toBeDefined();
    expect(line).toContain("`orca-flow merge` が");
    expect(line).not.toContain("`orca-flow integrate` か");
  });

  it("push の「PR が閉じられた」の文に、記録のあるタスクは打ち直しだけとある", async () => {
    const t = await read("skills/push/SKILL.md");
    const line = t
      .split("\n")
      .find((l) => l.includes("「PR が閉じられた」のときは"));
    expect(line).toBeDefined();
    expect(line).toContain("/orca-flow:integrate");
    expect(line).toContain("またぐ依存の記録");
    expect(line).toContain("/orca-flow:push $0");
  });

  it("integrate のおまかせの決まりの8番", async () => {
    const t = await read("skills/integrate/SKILL.md");
    const sec = t.slice(
      t.indexOf("## おまかせの決まり"),
      t.indexOf("## 守ること"),
    );
    const eight = sec.split("\n").find((l) => l.startsWith("8. "));
    expect(eight).toBeDefined();
    expect(eight).toContain("またぐ依存");
    expect(eight).toContain("auto off $0 --reason '");
    expect(eight).toContain("/orca-flow:push $0");
    expect(eight).toMatch(/--skip-cross-depends[^。]*使わない/);
    expect(sec).toMatch(/^3\. 手順3の「orca-flow verify」のやり直し/m);
    expect(sec).toMatch(/^6\. 後続のタスクを作るときは、聞かず/m);
  });

  it("仕様書の8章と10.1", async () => {
    const t = await read("docs/spec.md");
    const lines = t.split("\n");
    const closed = lines.find((l) =>
      l.startsWith("- PR が閉じられたら（マージなし）"),
    );
    expect(closed).toContain("push の打ち直しか integrate");
    expect(closed).toContain("またぐ依存の記録");
    expect(lines.find((l) => l.startsWith("- 飛ばさない所："))).toContain(
      "またぐ依存",
    );
    expect(lines.find((l) => l.startsWith("- approve・integrate："))).toContain(
      "またぐ依存",
    );
  });
});
