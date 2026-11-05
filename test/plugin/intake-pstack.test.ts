import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 見出しの行から、同じ高さ以上の次の見出しの前までを返す */
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

/** 10.1 の段落『Notion の要件から始める』の全文 */
async function specParagraph(): Promise<string> {
  const s = section(await read("docs/spec.md"), /^### 10\.1/);
  const all = s.split("\n");
  const from = all.findIndex((l) =>
    l.startsWith("**Notion の要件から始める**"),
  );
  expect(from).toBeGreaterThanOrEqual(0);
  const to = all.findIndex((l, i) => i > from && l.startsWith("**"));
  return all.slice(from, to < 0 ? undefined : to).join("\n");
}

/** 段落の中の、指定の語で始まる箇条 1 つ */
function bullet(para: string, start: string): string {
  const lines = para.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`- ${start}`));
  expect(at, `箇条が見つかりません：${start}`).toBeGreaterThanOrEqual(0);
  return lines[at] ?? "";
}

const WORDS = [
  "/how",
  "orca-flow pstack skills/how/SKILL.md --json",
  "git status --porcelain",
  "pstack なし",
  "見込みの根拠",
];

/** SKILL.md の手順6に残る語（how を呼ぶ時と回数、前後の比べ） */
const SKILL_WORDS = ["/how", "git status --porcelain"];
/** guards.md の手順6の節に移した語（呼び方・終了コードの扱い・根拠の書き方） */
const GUARD_WORDS = [
  "orca-flow pstack skills/how/SKILL.md --json",
  "pstack なし",
  "見込みの根拠",
];

/** guards.md の「## 手順6：下書きの決まり」の節 */
async function guard6(): Promise<string> {
  return section(
    await read("skills/intake/guards.md"),
    /^## 手順6：下書きの決まり/,
  );
}

describe("intake から pstack の how を呼ぶ：docs/spec.md", () => {
  it("10.1 の intake の行に /how がある", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    const row =
      s.split("\n").find((l) => l.startsWith("| `/orca-flow:intake")) ?? "";
    expect(row).toContain("pstack があれば `/how` でコードを読み");
  });

  it("段落に必要な語がそろう", async () => {
    const para = await specParagraph();
    for (const w of [...WORDS, "skills/how/SKILL.md", "harness"]) {
      expect(para, w).toContain(w);
    }
    expect(para).toContain("setup-pstack");
    expect(para).not.toContain("claude plugin list --json");
  });

  it("how を呼ぶ時と回数、続けるときは呼ばないこと、ほかのスキルを呼ばないことがある", async () => {
    const para = await specParagraph();
    const b = bullet(para, "pstack があれば");
    expect(b).toMatch(/分け方を決める前に[^。]*を1回だけ呼び/);
    expect(b).toMatch(/印のあるページ[^。]*呼ばない/);
    expect(b).toMatch(/ほかの pstack のスキル[^。]*呼ばない/);
    expect(b).toContain("要件の決定の要約");
    expect(b).toContain("pstack なし（要件から推し量った）");
  });

  it("切り出した段落は箇条だけで、次の太字の段落を含まない", async () => {
    const para = await specParagraph();
    expect(para).not.toContain("**画面の記録とスナップショット**");
    expect(para).toContain("- 分け方の1項目は orca-flow のタスク1つ");
    const bodies = para
      .split("\n")
      .slice(1)
      .filter((l) => l !== "");
    for (const l of bodies) expect(l, l).toMatch(/^- /);
  });

  it("how が使えないときの扱いと、how の指示が禁止に優先しないことがある", async () => {
    const b = bullet(await specParagraph(), "pstack があれば");
    expect(b).toContain("how が使えなかった（要件から推し量った）");
    expect(b).toMatch(/how の指示は[^。]*禁止[^。]*より優先しない/);
    expect(b).toMatch(/終わらなかった|落ちた/);
  });

  it("1項目に書くことに「見込みの根拠」と推し量りの添えがある", async () => {
    const para = await specParagraph();
    const b = bullet(para, "仕様は ADR の形");
    expect(b).toContain("見込みの根拠");
    expect(para).toContain("推し量り");
  });
});

describe("intake から pstack の how を呼ぶ：スキル", () => {
  it("SKILL.md の手順6に how を呼ぶ時と回数・前後の比べが残り、guards.md の手順6の節に呼び方と終了コードの扱いと、1項目には の行の見込みの根拠がある", async () => {
    const text = await read("skills/intake/SKILL.md");
    const m = /^6\. [\s\S]*?(?=^7\. )/m.exec(text);
    const step6 = m?.[0] ?? "";
    expect(step6).not.toBe("");
    for (const w of SKILL_WORDS) expect(step6, w).toContain(w);
    expect(step6).toMatch(/分け方を決める前に[^。]*を1回だけ呼び/);
    expect(step6).toMatch(/印のあるページ[^。]*呼ばない/);
    expect(step6).not.toContain("claude plugin list --json");
    const g6 = await guard6();
    for (const w of GUARD_WORDS) expect(g6, w).toContain(w);
    for (const w of [
      "要件の決定の要約",
      "pstack なし（要件から推し量った）",
      "skills/how/SKILL.md",
      "harness",
      "理由の1行",
      "setup-pstack",
    ]) {
      expect(g6, w).toContain(w);
    }
    expect(g6).not.toContain("claude plugin list --json");
    expect(g6).toMatch(/終了コードが0以外[^。]*読まずに飛ばし/);
    expect(g6).toMatch(/ほかの pstack のスキル[^。]*呼ばない/);
    const item = g6.split("\n").find((l) => l.includes("1項目には")) ?? "";
    expect(item).toContain("見込みの根拠");
  });

  it("guards.md の手順6の節に、how が使えなかったときの扱いと、禁止より優先しないことがある", async () => {
    const step6 = await guard6();
    expect(step6).toContain("how が使えなかった（要件から推し量った）");
    expect(step6).toMatch(/how の指示は[^。]*禁止[^。]*より優先しない/);
    expect(step6).toMatch(/終わらなかった|落ちた/);
  });

  it("splitting.md に、how が使えなかったときの根拠の書き方がある", async () => {
    const s = section(
      await read("skills/intake/splitting.md"),
      /^## 1項目に書くこと/,
    );
    expect(s).toContain("pstack なし（要件から推し量った）");
    expect(s).toContain("how が使えなかった（要件から推し量った）");
  });

  it("SKILL.md の手順の番号は 1〜11 のまま", async () => {
    const text = await read("skills/intake/SKILL.md");
    for (let i = 1; i <= 11; i++) {
      expect(text).toMatch(new RegExp(`^${i}\\. `, "m"));
    }
    expect(text).not.toMatch(/^12\. /m);
  });

  it("splitting.md の「1項目に書くこと」に見込みの根拠がある", async () => {
    const s = section(
      await read("skills/intake/splitting.md"),
      /^## 1項目に書くこと/,
    );
    expect(s).toContain("見込みの根拠");
  });
});

describe("pstack の英語の文を写さない", () => {
  it("仕様書・SKILL.md・guards.md・splitting.md に how の節の英語の見出しがない", async () => {
    const texts = [
      await specParagraph(),
      await read("skills/intake/SKILL.md"),
      await read("skills/intake/guards.md"),
      await read("skills/intake/splitting.md"),
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/^#+ (Process|Output|When to use|Rules)\b/m);
      expect(t).not.toMatch(/Read[- ]only/);
    }
  });
});
