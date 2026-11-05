import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const PUSH_CMD =
  "orca-flow pstack skills/poteto-mode/playbooks/opening-a-pr.md --json";
const REVIEW_CMD = "orca-flow pstack skills/blast-radius/SKILL.md --json";
const HOW_CMD = "orca-flow pstack skills/how/SKILL.md --json";

/** 見出しの行から、同じ高さ以上の次の見出しの前まで */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i] ?? "");
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** guards.md の「## 手順6：下書きの決まり」の節 */
const guard6 = async () =>
  section(await read("skills/intake/guards.md"), /^## 手順6：下書きの決まり/);

const step = (text: string, n: number) =>
  new RegExp(`^${n}\\. [\\s\\S]*?(?=^${n + 1}\\. )`, "m").exec(text)?.[0] ?? "";

describe("pstack の入手元：スキル", () => {
  it("push の手順3は orca-flow pstack で引き、claude plugin list と opening-a-pr の SKILL.md がない", async () => {
    const text = await read("skills/push/SKILL.md");
    const s3 = step(text, 3);
    expect(s3).toContain(PUSH_CMD);
    expect(text).not.toContain("claude plugin list --json");
    expect(text).not.toContain("opening-a-pr の SKILL.md");
    expect(text).not.toMatch(/skills\/opening-a-pr\//);
  });

  it("intake の手順6（guards.md の節）は orca-flow pstack で引き、claude plugin list がない", async () => {
    const text = await read("skills/intake/SKILL.md");
    const g6 = await guard6();
    expect(g6).toContain(HOW_CMD);
    expect(text).not.toContain("claude plugin list --json");
    expect(await read("skills/intake/guards.md")).not.toContain(
      "claude plugin list --json",
    );
  });

  it("2つのスキルに、0以外なら読まずに飛ばし「pstack なし」と CLI の理由を伝えることがある", async () => {
    const push = step(await read("skills/push/SKILL.md"), 3);
    const intake = await guard6();
    for (const t of [push, intake]) {
      expect(t).toMatch(/終了コードが0以外/);
      expect(t).toContain("pstack なし");
      expect(t).toContain("理由の1行");
      expect(t).toContain("harness");
    }
    expect(push).toMatch(/手引きを読まずに飛ばして/);
    expect(intake).toMatch(/読まずに飛ばし/);
  });

  it("2つのスキルに、終了コード0でも warning があれば1行を人に伝える（読むのは file だけ）ことがある", async () => {
    const push = step(await read("skills/push/SKILL.md"), 3);
    const intake = await guard6();
    for (const t of [push, intake]) {
      expect(t).toMatch(/終了コード0でも[^。\n]*`warning`/);
      expect(t).toContain("読むのは `file` だけ");
    }
  });

  it("review の影響範囲の節と手順2は orca-flow pstack で引き、claude plugin list がない", async () => {
    const text = await read("skills/review/SKILL.md");
    expect(section(text, /^## 影響範囲（blast-radius）/)).toContain(REVIEW_CMD);
    expect(step(text, 2)).toContain(REVIEW_CMD);
    expect(text).not.toContain("claude plugin list");
    expect(text).not.toContain("installPath");
  });

  it("intake に、how が落ちたときの書き分けと、how の指示が禁止より優先しない一文が残る", async () => {
    const s6 = await guard6();
    expect(s6).toContain("how が使えなかった（要件から推し量った）");
    expect(s6).toMatch(/how の指示は[^。]*禁止[^。]*より優先しない/);
  });
});

describe("pstack の入手元：docs/spec.md", () => {
  it("8章の始めに pstack があり、表に pstack の行と正の2つの入手元がある", async () => {
    const s8 = section(await read("docs/spec.md"), /^## 8\. /);
    expect(s8).toMatch(/init・context・pstack 以外は/);
    const row = s8.split("\n").find((l) => l.startsWith("| `pstack ")) ?? "";
    expect(row).not.toBe("");
    expect(row).toContain("cursor/plugins");
    expect(row).toContain("painhardcore/pstack");
    for (const w of [
      "0＝",
      "1＝",
      "2＝",
      "--json",
      "harness",
      "docs/harness/claude-code.md",
    ]) {
      expect(row, w).toContain(w);
    }
  });

  it("8章の pstack の行に warning と、終了コード2の新しい言い回しがあり、「候補が2つ以上」が残らない", async () => {
    const spec = await read("docs/spec.md");
    const row = spec.split("\n").find((l) => l.startsWith("| `pstack ")) ?? "";
    expect(row).toContain("`warning`");
    expect(row).toContain("別の入手元");
    expect(row).toContain("「注意：」");
    expect(row).toMatch(
      /2＝[^、]*正の入手元を通った候補の installPath が2つ以上違う/,
    );
    expect(spec).not.toContain("候補が2つ以上");
  });

  it("8章の pstack の行に、ref は終了コード2、外を指す harness と配列でない一覧は終了コード1とある", async () => {
    const spec = await read("docs/spec.md");
    const row = spec.split("\n").find((l) => l.startsWith("| `pstack ")) ?? "";
    const one = /1＝.*?、2＝/.exec(row)?.[0] ?? "";
    expect(one).toContain("harness");
    expect(one).toContain("pstack の外");
    expect(one).toContain("配列");
    const two = /2＝[^。]*/.exec(row)?.[0] ?? "";
    expect(two).toContain("ref");
  });

  it("10.1 の push の行と how の箇条が orca-flow pstack で引く形で、claude plugin list が残らない", async () => {
    const spec = await read("docs/spec.md");
    const s = section(spec, /^### 10\.1/);
    const pushRow =
      s.split("\n").find((l) => l.startsWith("| `/orca-flow:push")) ?? "";
    expect(pushRow).toContain(PUSH_CMD);
    const how =
      s.split("\n").find((l) => l.startsWith("- pstack があれば")) ?? "";
    expect(how).toContain(HOW_CMD);
    expect(spec).not.toContain("claude plugin list --json");
  });

  it("10.1 の review の箇条が orca-flow pstack で引き、warning と CLI の理由を書く", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    const rv =
      s.split("\n").find((l) => l.startsWith("- review：影響範囲")) ?? "";
    expect(rv).toContain(REVIEW_CMD);
    expect(rv).toContain("終了コードが0以外なら起動せず");
  });

  it("10.1 の push の行と how の箇条に、warning を人に伝えることがある", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    const pushRow =
      s.split("\n").find((l) => l.startsWith("| `/orca-flow:push")) ?? "";
    const how =
      s.split("\n").find((l) => l.startsWith("- pstack があれば")) ?? "";
    for (const l of [pushRow, how]) {
      expect(l).toMatch(/終了コード0でも `warning` があれば/);
    }
  });

  it("足した文に手元のパス（ホームの下）がない", async () => {
    const spec = await read("docs/spec.md");
    const row = spec.split("\n").find((l) => l.startsWith("| `pstack ")) ?? "";
    const s = section(spec, /^### 10\.1/);
    const pushRow =
      s.split("\n").find((l) => l.startsWith("| `/orca-flow:push")) ?? "";
    const how =
      s.split("\n").find((l) => l.startsWith("- pstack があれば")) ?? "";
    for (const t of [
      row,
      pushRow,
      how,
      await read("skills/push/SKILL.md"),
      await read("skills/intake/SKILL.md"),
      await read("skills/intake/guards.md"),
    ]) {
      expect(t).not.toMatch(/\/home\/|\/Users\/|~\//);
    }
  });
});
