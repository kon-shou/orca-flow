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

const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

describe("仕様書：E2E のコマンドをアプリごとに（6章）", () => {
  it("companion の行と決まりの箇条に、command がアプリの名前をキーにしたオブジェクトでも書けるとある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const row = s.split("\n").find((l) => l.includes("`repos[].companion`"));
    expect(row).toMatch(/`command`[^|]*文字列か[^|]*キーにしたオブジェクト/);
    const rule =
      s.split("\n").find((l) => l.startsWith("- `companion` は、")) ?? "";
    for (const w of [
      "`apps` の名前をキーにした空でないオブジェクト",
      "自分のキーの印",
      "キーのない `apps` のアプリは、ほかのコマンドの印の相手としてだけ使える",
      "キーが `apps` にない",
      "空のオブジェクト",
      "値が空",
      "自分のキーの印がない",
    ]) {
      expect(rule, w).toContain(w);
    }
  });

  it("録画の設定の箇条に、capture.command もオブジェクトで書けるとある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const b = s.split("\n").find((l) => l.startsWith("- 録画の設定")) ?? "";
    expect(b).toMatch(/`command`[^\n]*文字列か[^\n]*オブジェクト/);
  });

  it("伴う記録の段落に、2つの形と古い文字列の記録の読み方がある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const p = s.split("\n").find((l) => l.startsWith("**伴う記録**")) ?? "";
    expect(p).toMatch(/`command`[^\n]*文字列か[^\n]*オブジェクト/);
    expect(p).toContain("古い文字列の記録はそのまま読む");
    const cap =
      s.split("\n").find((l) => l.startsWith("**伴う記録の `capture`**")) ?? "";
    expect(cap).toMatch(/写すもの[^\n]*なければ[^\n]*`capture` を書かない/);
  });
});

describe("仕様書：E2E のコマンドをアプリごとに（8章）", () => {
  it("表の e2e の行に --app がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = lines.find((l) => l.startsWith("| `e2e ")) ?? "";
    expect(row).toContain("[--app 〈名前〉]");
  });

  it("e2e の段落に、1つずつ流す・--app・runs・そろうかの確かめ・テストの指定の決まりがある", async () => {
    const p = para(chapter(await read("docs/spec.md"), 8), "**e2e");
    for (const w of [
      "記録の `apps` の順",
      "1つずつ",
      "残りも流す",
      "`--app 〈名前〉`",
      "`runs`",
      "`app`・`result`",
      "記録の全部のアプリ",
      "`--app` で選んだアプリのコマンドにだけ",
      "コマンドが2本以上でテストの指定があり `--app` がない",
      "文字列の記録",
      "`--capture` なしで",
    ]) {
      expect(p, w).toContain(w);
    }
    const cap = bullet(p, "- `--capture 〈流れ〉");
    expect(cap).toMatch(/`capture\.command` がオブジェクト[^\n]*`--app`/);
    expect(cap).toMatch(/キーがなければ[^\n]*終了コード1/);
  });

  it("--app の箇条に、--wait・--capture-clear と一緒に使えず1になるとある", async () => {
    const p = para(chapter(await read("docs/spec.md"), 8), "**e2e");
    const b = bullet(p, "- `--app 〈名前〉`");
    expect(b).toMatch(
      /`--wait`・`--capture-clear` と一緒には使えず[^\n]*終了コード1/,
    );
  });

  it("--json の箇条に、runs の result の値と、runs が出る場合がある", async () => {
    const p = para(chapter(await read("docs/spec.md"), 8), "**e2e");
    const b = bullet(p, "- `--json`");
    expect(b).toMatch(/`result` は `passed`・`failed` の2つ/);
    expect(b).toContain("時間切れも `failed`");
    expect(b).toMatch(/`runs` は[^\n]*流したとき（終了コード0か1）だけ/);
    for (const w of ["終了コード2", "`--capture`", "`--wait`"]) {
      expect(b, w).toContain(w);
    }
  });

  it("workspace の --companion の箇条に、キーのある分だけを写すことと止まる場合がある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const b = bullet(s, "- `new` に伴う相手を渡す：");
    for (const w of [
      "キーのある",
      "だけを写す",
      "写すコマンドが1つもない",
      "`capture` を書かない",
    ]) {
      expect(b, w).toContain(w);
    }
    const child = bullet(s, "- 子の `new --companion-json 〈JSON〉`");
    expect(child).toContain("オブジェクト");
  });
});

describe("仕様書：E2E のコマンドをアプリごとに（10.1）", () => {
  it("伴う項目がアプリごとの判定で、渡すのはブランチにあるアプリだけで、印の相手のコマンドも流れることがある", async () => {
    const s = chapter(await read("docs/spec.md"), 10);
    const line = s.split("\n").find((l) => l.startsWith("- 伴う項目：")) ?? "";
    for (const w of [
      "アプリごと",
      "当たったアプリと、そのコマンドの印のアプリのうち、そのブランチにあるもの",
      "`--companion` にはブランチにある `apps` のアプリだけを渡す",
      "印の相手として渡したアプリにキーがあれば、そのコマンドも流れる",
      "またぐテストを分ける",
      "コマンドの印のアプリがそのブランチになくても、それを理由に項目を足すのをやめない",
      "`baseApps`",
    ]) {
      expect(line, w).toContain(w);
    }
    expect(line).not.toContain("印のアプリがブランチにないコマンドは流さない");
    expect(line).not.toContain("当たって流せるアプリ");
  });

  it("当たらないときだけ変えない1行を書き、印のアプリが足りないことを理由に足さない・1行を書く決まりがない", async () => {
    const s = chapter(await read("docs/spec.md"), 10);
    const line = s.split("\n").find((l) => l.startsWith("- 伴う項目：")) ?? "";
    expect(line).toContain("当たらなければ（当たるアプリが1つもなければ）");
    expect(line).not.toContain("当たらなければ（流せるアプリが1つもなければ）");
    expect(line).not.toContain("印不足");
    expect(line).not.toMatch(/画面も要るがこのブランチにない旨/);
  });
});

describe("スキルの文書：E2E のコマンドをアプリごとに", () => {
  it("intake の workspace.md の伴う項目が、アプリごとの判定と、どのアプリの分のテストかと根拠を書かせる", async () => {
    const b = bullet(await read("skills/intake/workspace.md"), "- 伴う項目：");
    for (const w of [
      "アプリごと",
      "どのアプリの分のテストか",
      "当たったアプリと、そのコマンドの印のアプリのうち、そのブランチにあるもの",
      "`--companion` には、そのブランチにある `apps` のアプリだけを渡す",
      "印の相手として渡したアプリにキーがあれば、そのコマンドも流れる",
      "またぐテストを分ける",
      "それを理由に項目を足すのをやめない",
      "`baseApps`",
    ]) {
      expect(b, w).toContain(w);
    }
    expect(b).not.toContain("印のアプリがブランチにないコマンドは流さない");
    expect(b).not.toContain("当たって流せるアプリ");
  });

  it("intake の workspace.md が、当たらないときだけ変えない1行を書き、印のアプリが足りないときはその1行を書かない", async () => {
    const b = bullet(await read("skills/intake/workspace.md"), "- 伴う項目：");
    expect(b).toContain("当たらないとき（当たるアプリが1つもないとき）");
    expect(b).not.toContain("当たらないとき（流せるアプリが1つもないとき）");
    expect(b).not.toContain("印不足");
    expect(b).toMatch(
      /印のアプリがブランチにないとき[^\n]*「〈リポジトリ〉は変えない：〈理由〉」の1行も書かない/,
    );
  });

  it("page-format.md が、印のアプリがブランチにないことを、足さない理由にも変えない1行の理由にもしない", async () => {
    const t = await read("skills/intake/page-format.md");
    expect(t).toMatch(
      /コマンドの印のアプリがそのブランチにないことは、E2E の項目を足さない理由にも、この1行の理由にもしない/,
    );
    expect(t).not.toMatch(
      /E2E の項目を足したブランチにも[^\n]*〈リポジトリ〉は変えない：〈理由〉/,
    );
    expect(t).not.toContain("印のアプリがそのブランチに足りないときも含む");
  });

  it("run/e2e.md に --app とアプリごとの結果の書き方がある", async () => {
    const t = await read("skills/run/e2e.md");
    expect(t).toContain("--app 〈名前〉");
    expect(t).toMatch(/アプリごと[^\n]*結果/);
    expect(t).toMatch(/コマンドが2本以上[^\n]*テストの指定[^\n]*--app/);
  });

  it("run/e2e.md が、流す前に止まった1を引数の直しに分け、--wait に --app を付けないとある", async () => {
    const t = await read("skills/run/e2e.md");
    const stopped =
      t.split("\n").find((l) => l.includes("1（流す前に止まった）")) ?? "";
    expect(stopped).toContain("引数の誤り");
    expect(stopped).toContain("`--app` の名前が記録のキーにない");
    expect(stopped).toMatch(
      /コマンドが2本以上でテストの指定があるのに `--app` がない/,
    );
    expect(stopped).toContain("引数を直して流し直す");
    expect(stopped).toContain("テストを直しに行かない");
    expect(t).toMatch(/`--wait` には `--app` を付けない/);
    expect(t).toMatch(/時間がアプリの数だけ延びる[^\n]*背景で流す/);
  });

  it("workspace のスキルが、アプリごとのコマンドの案を出す", async () => {
    const t = await read("skills/workspace/SKILL.md");
    expect(t).toMatch(/アプリの名前をキーにしたオブジェクト/);
    expect(t).toContain("自分のキーの印");
    expect(t).toMatch(/\{"app-a": "[^"]*\{previewUrl:app-a\}/);
  });

  it("書いた文書とテストに、タスクの ID と手元のパスがない", async () => {
    for (const rel of [
      "skills/intake/workspace.md",
      "skills/intake/page-format.md",
      "skills/run/e2e.md",
      "skills/workspace/SKILL.md",
      "test/plugin/e2e-per-app-spec.test.ts",
    ]) {
      const t = await read(rel);
      expect(idForm.test(t), `${rel} にタスクの ID があります`).toBe(false);
      expect(homePath.test(t), `${rel} に手元のパスがあります`).toBe(false);
    }
    const lines = (await read("docs/spec.md")).split("\n");
    for (const l of lines.filter((x) => x.includes("キーにしたオブジェクト"))) {
      expect(l).not.toMatch(idForm);
      expect(l).not.toMatch(homePath);
    }
  });
});
