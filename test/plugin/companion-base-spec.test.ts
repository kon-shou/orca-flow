import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 「## 〈番号〉. 」の見出しの行から、次の「## 」の前までを返す。 */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 行頭が prefix の箇条と、その下の字下げした行をまとめて返す。 */
function bullet(text: string, prefix: string): string {
  const all = text.split("\n");
  const at = all.findIndex((l) => l.startsWith(prefix));
  expect(at, `「${prefix}」がありません`).toBeGreaterThanOrEqual(0);
  const rest = all.slice(at + 1);
  const len = rest.findIndex((l) => !l.startsWith("  "));
  return all.slice(at, at + 1 + (len < 0 ? rest.length : len)).join("\n");
}

/** 行頭が「**〈名前〉」の段落から、次の「**」の段落の前までを返す。 */
function para(text: string, head: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(head));
  expect(at, `${head} の段落がありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("**"));
  return lines.slice(at, end < 0 ? undefined : at + 1 + end).join("\n");
}

function expectAll(text: string, words: string[]): void {
  for (const w of words) expect(text, w).toContain(w);
}

const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

describe("仕様書：土台のアプリ（6章）", () => {
  it("伴う記録の段落に baseApps と、古い記録・形の外れた記録の読み方がある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const p = s.split("\n").find((l) => l.startsWith("**伴う記録**")) ?? "";
    expectAll(p, [
      "`baseApps`",
      "ブランチにないアプリ",
      "`apps` と同じ形の並び",
      "ないときは空として読み",
      "`baseApps` のない古い記録は空として、今と同じに読む",
      "`baseApps` が並びでない・要素の形が外れた記録は壊れているとする",
    ]);
  });

  it("土台のアプリの記録の段落に、置き場・持ち主・リポジトリの外の作業ツリーがある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const p =
      s.split("\n").find((l) => l.startsWith("**土台のアプリの記録**")) ?? "";
    expect(p, "土台のアプリの記録の段落がありません").not.toBe("");
    expectAll(p, [
      "`〈アプリの git の共通ディレクトリ〉/orca-flow/companion-base/〈ID〉.json`",
      "E2E のタスクの ID",
      "`preview 〈ID〉 --companion-base`",
      "baseBranch の先頭",
      "持ち主（E2E のリポジトリのメインの作業ツリーの実のパスと、伴う記録の `taskBranch`",
      "リポジトリの外",
      "持ち主の違う記録があれば、立ても止めもせず終了コード1",
      "`--owner` から決める",
      "アプリのメインの作業ツリーの実のパス",
      "baseBranch の名前",
    ]);
  });
});

describe("仕様書：土台のアプリ（8章）", () => {
  it("表の preview の行に --companion-base がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = lines.find((l) => l.startsWith("| `preview ")) ?? "";
    expect(row).toContain("--companion-base");
    expect(row).toContain("--base");
  });

  it("preview の --companion-base の箇条に、立て方・止める場合・使い回し・--stop・終わりの片づけがある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const b = bullet(s, "- `--companion-base`：");
    expectAll(b, [
      "`baseApps`",
      "baseBranch の先頭",
      "E2E のタスクの ID で打つ",
      "リポジトリの外",
      "上の `--base` と同じ",
      "アプリのメインの作業ツリー",
      "固定なら立てずに終了コード2",
      "setup.sh が落ちたら作業ツリーを消して終了コード1",
      "立ても止めもせず終了コード1",
      "baseBranch の先頭と同じなら、立て直さず使い回す",
      "先頭が進んでいれば止めてから立て直す",
      "`--stop`：`down` を流し、ターミナル・作業ツリー・記録を片づける",
      "E2E のタスクの終わり",
      "止められなくても警告だけ",
      "依存元のタスクのプレビューは止めない",
    ]);
  });

  it("--owner の箇条に、立てるときは必須・伴う記録と baseApps の確かめ・--stop では任意がある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const b = bullet(s, "- `--companion-base`：");
    expectAll(b, [
      "`preview 〈ID〉 --companion-base --owner 〈E2E のリポジトリのパス〉 [--no-open] [--json]`",
      "`preview 〈ID〉 --companion-base --stop [--owner 〈E2E のリポジトリのパス〉] [--json]`",
    ]);
    const owner = bullet(s, "  - `--owner`：");
    expectAll(owner, [
      "立てるときは必須で、ないと終了コード1",
      "伴う記録",
      "このアプリがその `baseApps` にある",
      "`--stop` では任意",
      "違えば止めずに終了コード1",
      "伴う記録が消えていれば",
      "リポジトリだけで比べる",
    ]);
  });

  it("workspace --preview に、土台のアプリの立て方と止め方がある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const b = bullet(s, "- 土台のアプリの組の起動：");
    expectAll(b, [
      "`workspace --preview 〈ブランチ名〉`",
      "`baseApps`",
      "出どころ",
      "立て直さず使い回し",
      "`preview 〈依存元の ID〉 --after-setup --no-open --json`",
      "`preview 〈E2E の ID〉 --companion-base --owner 〈E2E のリポジトリのパス〉 --no-open --json`",
      "`preview 〈E2E の ID〉 --companion-base --stop --owner 〈E2E のリポジトリのパス〉 --json`",
      "決めきれなければ、その行を落ちたとして理由を出し",
      "`--stop` は `--companion-base` で立てた土台のアプリだけを",
      "止め、依存元のタスクのプレビューは止めない",
      "`--base`（前の画面の組の起動）では土台のアプリを立てない",
    ]);
  });

  it("new --companion は、印のアプリが足りなくても止めず baseApps に入れ、ほかの止めは残る", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const b = bullet(s, "- `new` に伴う相手を渡す：");
    expect(b).not.toContain("一部だけ渡せない");
    expect(b).not.toContain(
      "写したコマンドの印のアプリが `--companion` に足りない・写すコマンドが1つもないときも終了コード1",
    );
    expectAll(b, [
      "その子に `companion` がない・名前が `companion` の `apps` にない・`new` 以外で使った",
      "写すコマンドが1つもないときも終了コード1",
      "印のアプリが `--companion` に足りないときは止めず",
      "`baseApps`",
      "文字列のときも同じ",
    ]);
  });

  it("e2e の段落に、出どころの決め方・そろわないときの理由・--json の source・録画の前の画面の扱いがある", async () => {
    const p = para(chapter(await read("docs/spec.md"), 8), "**e2e");
    const base = bullet(p, "- 土台のアプリ：");
    expectAll(base, [
      "`baseApps`",
      "前を待つ印",
      "近い順",
      "依存元のタスク",
      "integrate-wait",
      "baseBranch",
      "印がない・そのアプリのリポジトリの前に当たらなければ baseBranch",
      "土台のアプリの記録",
      "作業中でも入ってもいない",
      "同じ近さに前が2つ以上",
      "決めきれない",
      "毎回読む",
      "`baseApps` のない記録の動きは今と同じ",
    ]);
    const lack = bullet(p, "- そろわないとき：");
    expectAll(lack, [
      "土台のアプリの出どころが決めきれない",
      "依存元のタスクに integrate-wait の行がない",
      "`workspace --preview 〈ブランチ名〉`（土台のアプリも立てる）",
      "終了コード2",
      "黙ってほかの URL",
    ]);
    expect(bullet(p, "- `--json`")).toContain("`source`");
    const cap = bullet(p, "- `--capture 〈流れ〉");
    expect(cap).toMatch(
      /`baseApps` のアプリの印は、前の画面でも後と同じ出どころの URL で埋める/,
    );
    expect(cap).toContain("`baseApps` のアプリは前の画面を立てず");
  });
});

describe("仕様書：土台のアプリ（10.1）", () => {
  it("伴う項目から、印のアプリが全部そのブランチにあるときだけの決まりと印不足の1行がなくなった", async () => {
    const s = chapter(await read("docs/spec.md"), 10);
    const line = s.split("\n").find((l) => l.startsWith("- 伴う項目：")) ?? "";
    expect(line).not.toBe("");
    expect(line).not.toContain("全部そのブランチにあるときだけ");
    expect(line).not.toContain("印不足");
    expect(line).not.toContain("印のアプリがブランチにないコマンドは流さない");
    expectAll(line, [
      "それを理由に項目を足すのをやめない",
      "土台のアプリ",
      "`--companion` にはブランチにある `apps` のアプリだけを渡す",
    ]);
  });

  it("仕様書のどこにも、印のアプリが全部そのブランチにあるときだけの決まりがない", async () => {
    const s = await read("docs/spec.md");
    expect(s).not.toContain("印のアプリが全部そのブランチにある");
    expect(s).not.toContain("一部だけ渡せない");
  });
});

describe("スキルの文書：土台のアプリ", () => {
  it("intake の workspace.md と page-format.md に、印のアプリが足りないことで足さない決まりがない", async () => {
    const w = await read("skills/intake/workspace.md");
    const b = bullet(w, "- 伴う項目：");
    expect(b).not.toContain("全部そのブランチにある");
    expect(b).not.toContain("印不足");
    expect(b).not.toContain("流せるアプリ");
    expectAll(b, [
      "それを理由に項目を足すのをやめない",
      "土台のアプリ",
      "前を待つ印",
      "`--companion` には、そのブランチにある `apps` のアプリだけを渡す",
    ]);
    const pf = await read("skills/intake/page-format.md");
    expect(pf).not.toContain("印のアプリがそのブランチに足りないときも含む");
    expect(pf).not.toContain("画面も要るがこのブランチにない旨");
  });

  it("run/e2e.md に、土台のアプリのそろわない理由と組のプレビューを頼む次の手がある", async () => {
    const t = await read("skills/run/e2e.md");
    const line =
      t
        .split("\n")
        .find((l) => l.includes("2（土台のアプリがそろっていない）")) ?? "";
    expect(line, "土台のアプリの2の箇条がありません").not.toBe("");
    expectAll(line, [
      "`baseApps`",
      "依存元のタスクのプレビュー",
      "土台のアプリの記録がない・答えない",
      "決めきれない",
      "`workspace --preview 〈ブランチ名〉`",
      "`orca-flow status question`",
      "`--wait`",
      "ほかの URL を印に書いて流さない",
    ]);
    expect(line).not.toContain("workspace --preview 〈ID〉");
  });

  it("書いた文書とテストに、タスクの ID と手元のパスがない", async () => {
    for (const rel of [
      "skills/intake/workspace.md",
      "skills/intake/page-format.md",
      "skills/run/e2e.md",
      "test/plugin/companion-base-spec.test.ts",
    ]) {
      const t = await read(rel);
      expect(idForm.test(t), `${rel} にタスクの ID があります`).toBe(false);
      expect(homePath.test(t), `${rel} に手元のパスがあります`).toBe(false);
    }
    const lines = (await read("docs/spec.md")).split("\n");
    for (const l of lines.filter(
      (x) => x.includes("土台のアプリ") || x.includes("`baseApps`"),
    )) {
      expect(l).not.toMatch(idForm);
      expect(l).not.toMatch(homePath);
    }
  });
});

describe("決定の記録：土台のアプリ", () => {
  const HEADING =
    /^## \d{4}-\d{2}-\d{2} E2E の印のアプリがブランチにないときは、依存元のタスクか baseBranch の先頭で立てたアプリに向けて流す$/;

  /** 見出しの行から、次の「## 」の前までを返す。 */
  function entry(lines: string[], at: number): string {
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    return lines.slice(at, end < 0 ? undefined : at + 1 + end).join("\n");
  }

  it("項がちょうど1つあり、4つの箇条と人が選んだことがある", async () => {
    const lines = (await read("docs/decisions.md")).split("\n");
    const hits = lines
      .map((l, i) => (HEADING.test(l) ? i : -1))
      .filter((i) => i >= 0);
    expect(hits).toHaveLength(1);
    const e = entry(lines, hits[0] as number);
    expectAll(e, [
      "- 決めたこと：",
      "- 決めたこと（続き）：",
      "- 理由：",
      "- 捨てた案と理由：",
      "- 人が選んだこと：前のタスクの設計で、この件を後続のタスクに分けることを人が選んだ。決めてほしいことはなく、おすすめどおり（おまかせで統括役が決めた）",
    ]);
    expect(e).not.toMatch(idForm);
    expect(e).not.toMatch(homePath);
  });

  it("項はすでにある項のあとに足し、間に差し込まない", async () => {
    const lines = (await read("docs/decisions.md")).split("\n");
    const prev = lines.indexOf(
      "## 2026-11-11 全ブランチを一度に始める仕組みは分けずに入れ、案内の残りを後続で直す",
    );
    const mine = lines.findIndex((l) => HEADING.test(l));
    expect(prev).toBeGreaterThanOrEqual(0);
    expect(mine).toBeGreaterThan(prev);
  });

  it("後続に分けたと書いた前の項は変わっていない", async () => {
    const lines = (await read("docs/decisions.md")).split("\n");
    const at = lines.findIndex(
      (l) =>
        l ===
        "## 2026-11-11 E2E のコマンドは、アプリの名前をキーにしたオブジェクトでも書け、ブランチで変えたアプリの分だけを流す",
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(entry(lines, at)).toContain(
      "- 人が選んだこと：ブランチにないアプリを、依存元のタスクか baseBranch の版で立てて印を埋める形は、後続のタスクに分けた（このタスクでは、印のアプリがブランチにないコマンドは今と同じく流さない）。ほかに決めてほしいことはなかった。",
    );
  });
});
