import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function expectAll(text: string, words: string[]): void {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

/** 見出しの行から、同じ高さ以上の次の見出しの前までを返す。 */
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

/** `n. ` で始まる手順の行から、次の手順か見出しの前までを返す。 */
function step(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(\d+\. |## )/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** 頭の言葉で始まる行がちょうど1つあり、それを返す。 */
function item(text: string, head: string): string {
  const hits = text.split("\n").filter((l) => l.startsWith(head));
  expect(hits, `「${head}」で始まる行`).toHaveLength(1);
  return hits[0] as string;
}

/** head で始まる行から、空行の前まで。頭の行のすぐ後ろの空行のあとに箇条が続く形も拾う。 */
function paragraph(text: string, head: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(head));
  expect(at, `段落がありません：${head}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const l of lines.slice(at)) {
    if (l.trim() === "" && out.length > 0) {
      const next = lines[at + out.length + 1] ?? "";
      if (out.length === 1 && next.startsWith("- ")) {
        out.push(l);
        continue;
      }
      break;
    }
    out.push(l);
  }
  return out.join("\n");
}

const SPEC = "docs/spec.md";
const ch = async (re: RegExp) => section(await read(SPEC), re);

describe("approve のスキル：先の承認", () => {
  it("前が整っていないときの問いの先頭が「先に承認しておく（Recommended）」で、--when-ready を流す", async () => {
    const text = await read("skills/approve/SKILL.md");
    const before = text.slice(0, text.indexOf("\n## 手順\n"));
    const para = item(before, "前を待つ印");
    expectAll(para, [
      "AskUserQuestion",
      "「先に承認しておく（Recommended）」",
      "「今承認する」",
      "「待つ」",
      "`orca-flow approve $0 --when-ready`",
      "「先に承認しました」",
      "設計書が変わると先の承認は外れ",
    ]);
    const first = para.indexOf("「先に承認しておく（Recommended）」");
    expect(first).toBeLessThan(para.indexOf("「今承認する」"));
    expect(first).toBeLessThan(para.indexOf("「待つ」"));
    expect(para).not.toContain("「待つ（Recommended）」");
  });

  it("おまかせの決まりに、先の承認が有効なら人の手順で承認し、auto log を「承認：」で始めない項がちょうど1つある", async () => {
    const rule = section(
      await read("skills/approve/SKILL.md"),
      /^## おまかせの決まり/,
    );
    const hits = rule
      .split("\n")
      .filter((l) => /^\d+\. /.test(l) && l.includes("「先の承認：有効」"));
    expect(hits).toHaveLength(1);
    expectAll(hits[0] as string, [
      "`orca-flow auto show $0`",
      "人の承認",
      "「先に人が承認した設計のまま承認した」で始め",
      "「承認：」で始めない",
      "「先の承認：設計書が変わったので外れました」",
      "この節の決まりで承認する",
    ]);
  });
});

describe("approve のスキル：読んだ設計書の指紋を渡す", () => {
  const skill = () => read("skills/approve/SKILL.md");

  it("手順2に、以降のすべての orca-flow approve に --doc-blob を足す決まりがちょうど1か所ある", async () => {
    const text = await skill();
    const rule = "以降のすべての `orca-flow approve`";
    expect(text.split(rule)).toHaveLength(2);
    expectAll(item(step(text, 2), "   - 承認のコマンドに指紋を渡す："), [
      rule,
      "`--when-ready`",
      "`--prechanges-done`",
      "`--doc-blob 〈設計書の blob〉`",
    ]);
  });

  it("おまかせの決まりの9で、先の承認が有効なら preApproval.blob を渡し、事前変更の前に手順2の blob と比べる", async () => {
    const rule = section(await skill(), /^## おまかせの決まり/);
    expectAll(step(rule, 9), [
      "`orca-flow auto show $0 --json`",
      "`preApproval.blob`",
      "`--doc-blob`",
      "手順3の事前変更を入れる前に",
      "手順2の blob",
      "外れたとして扱う",
    ]);
  });

  it("無視された設計書の blob を求める式は、どれも --no-filters で改行の変換をかけない", async () => {
    const text = await skill();
    const plain =
      "`git hash-object -w 〈タスクの worktree〉/〈tasksDir〉/$0.md`";
    const raw =
      "`git hash-object -w 〈タスクの worktree〉/〈tasksDir〉/$0.md --no-filters`";
    expect(text).not.toContain(plain);
    expect(text.split(raw)).toHaveLength(4);
    const spec = await read("docs/spec.md");
    expect(spec).not.toContain("`git hash-object -w 〈worktree の設計書〉`");
    expect(spec).toContain(
      "`git hash-object -w 〈worktree の設計書〉 --no-filters`",
    );
  });

  it("手順4の終了コード1に、設計書が変わったときの人の道と番の道の扱いがある", async () => {
    const l = item(
      step(await skill(), 4),
      "   - 1 で、標準エラーに「設計書が読んだときから変わっています」",
    );
    expectAll(l, [
      "読み直して",
      "打ち直",
      "9の先の承認",
      "`orca-flow auto show $0`",
      "手順1から1回だけ読み直し",
      "2回目も変わっていれば",
    ]);
  });
});

describe("auto のスキル：先の承認と前の直しの見張り", () => {
  it("一覧と show の先の承認・off で消えること・見張りと待ち受けの続け方を書く", async () => {
    const text = await read("skills/auto/SKILL.md");
    const intro = text.slice(0, text.indexOf("## 手順"));
    const pre = item(intro, "先の承認：");
    expectAll(pre, [
      "`/orca-flow:approve`",
      "「先の承認：有効」",
      "「先の承認：設計書が変わったので外れました」",
      "人の承認として",
      "おまかせの決まり",
      "`off 〈ID〉`",
      "先の承認も消す",
    ]);
    const watch = item(intro, "前の直しの見張り：");
    expectAll(watch, [
      "「前の枝が進んだ」",
      "送り直す",
      "乗せた先が作業中",
      "番なしで終わらない",
    ]);
    expect(section(text, /^## 番が来たら/)).toContain(
      "乗せた先が作業中の乗せたタスク",
    );
  });
});

describe("spec のスキル：手順8の先の承認の分かれ道", () => {
  it("手順8に「先に承認してあります」「先の承認は、設計書が変わったので外れました」「先に承認しておけます」の分かれ道があり、手順は9つのまま", async () => {
    const text = await read("skills/spec/SKILL.md");
    const s8 = step(text, 8);
    const done = item(s8, "     - 同じ行に「先に承認してあります」");
    expectAll(done, ["前が整ったら統括役の待ち受けが実装を始めます", "手順9"]);
    const off = item(
      s8,
      "     - 同じ行に「先の承認は、設計書が変わったので外れました」",
    );
    expectAll(off, ["/orca-flow:approve $0", "先に承認し直せます", "手順9"]);
    const can = item(
      s8,
      "     - 同じ行に「/orca-flow:approve で先に承認しておけます」",
    );
    expectAll(can, ["/orca-flow:approve $0", "先に承認しておけます"]);
    const nums = section(text, /^## 手順$/)
      .split("\n")
      .flatMap((x) => /^(\d+)\. /.exec(x)?.[1] ?? [])
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("intake のスキル：先に承認できること", () => {
  it("手順11に、印をつけた項目を先に承認できることがある", async () => {
    const s11 = step(await read("skills/intake/SKILL.md"), 11);
    expectAll(s11, [
      "`/orca-flow:approve 〈ID〉`",
      "先に承認しておける",
      "人の承認として実装を始める",
    ]);
  });

  it("guards.md の印のあとの進み方に、先の承認と乗せられない前がある", async () => {
    const guard = section(
      await read("skills/intake/guards.md"),
      /^## 手順10：/,
    );
    const l = item(guard, "- 印のあとの進み方");
    expectAll(l, [
      "先に承認しておける",
      "`/orca-flow:approve 〈ID〉`",
      "人の承認として実装を始める",
      "設計書が変われば先の承認は外れ",
      "乗せられない前",
      "枝に乗らず",
    ]);
  });
});

describe("仕様書：先の承認・乗せられない前・知らせの記録", () => {
  it("8章の approve の行に --when-ready と --doc-blob がある", async () => {
    const ch8 = await ch(/^## 8\. /);
    const row = item(ch8, "| `approve 〈ID〉");
    expect(row).toContain(
      "`approve 〈ID〉 [--prechanges-done] [--when-ready] [--doc-blob 〈blob〉]`",
    );
    expectAll(row, ["`--doc-blob` があれば", "終了コード1"]);
  });

  it("「前を待つ印」の段落に、乗せられない前の動きと先の承認の項がちょうど1つずつある", async () => {
    const p = paragraph(
      await ch(/^## 8\. /),
      "**前を待つ印（`new --start-after`）**：",
    );
    const pre = item(p, "- 先の承認");
    expectAll(pre, [
      "`approve 〈ID〉 --when-ready`",
      "「先に承認しました」",
      "blob",
      "おまかせの記録",
      "「先に承認してあります」",
      "「先の承認は、設計書が変わったので外れました」",
      "「/orca-flow:approve で先に承認しておけます」",
      "「先の承認：有効」",
      "`auto off`",
      "人の承認として",
      "「先に人が承認した設計のまま承認した」",
      "終了コード1",
      "終了コード2",
      "`--doc-blob`",
      "先の承認の blob",
    ]);
    expect(pre).toContain(
      "`--doc-blob` が blob の形でないか今の設計書の blob と違うは、終了コード1で記録を書かない",
    );
    const nostack = item(p, "- 乗せられない前");
    expectAll(nostack, [
      "ほかのリポジトリ",
      "同じリポジトリの前が2つ以上",
      "枝に乗らず",
      "待つ条件",
      "承認を待つ",
    ]);
  });

  it("「乗せる」の段落に、前の枝が進んだ知らせの送り直しがある", async () => {
    const p = paragraph(
      await ch(/^## 8\. /),
      "**乗せる（`new --stack-on`）**：",
    );
    expectAll(item(p, "- 知らせの送り直し："), [
      "verify の記録の先頭",
      "「前の枝が進んだ」",
      "間を置いて",
      "送れた先頭",
      "乗せた先が入った",
    ]);
  });

  it("「おまかせ」の段落に、先の承認の欄と待ち受けの続け方がある", async () => {
    const p = paragraph(await ch(/^## 8\. /), "**おまかせ**（統括役が");
    expect(item(p, "- 記録：")).toContain("先の承認（設計書の blob と時刻）");
    expectAll(item(p, "- 待ち受けの続け方："), [
      "乗せる記録",
      "乗せた先が作業中",
      "番なしで終わらない",
      "`/orca-flow:auto`",
    ]);
  });

  it("6章に知らせの記録がちょうど1つある", async () => {
    const l = item(await ch(/^## 6\. /), "**後ろへの知らせの記録**：");
    expectAll(l, [
      "`〈git の共通ディレクトリ〉/orca-flow/stack-notice/〈ID〉.json`",
      "送れた",
      "verify",
    ]);
  });

  it("10.1 に先の承認のスキルの扱いがある", async () => {
    const l = item(await ch(/^### 10\.1 /), "- 先の承認：");
    expectAll(l, [
      "approve",
      "「先に承認しておく（Recommended）」",
      "auto",
      "spec",
      "intake",
      "「先の承認：有効」",
      "`--doc-blob`",
      "`preApproval.blob`",
    ]);
  });
});
