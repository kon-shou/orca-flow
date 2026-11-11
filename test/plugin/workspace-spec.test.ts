import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function loadSpec(): Promise<string> {
  return readFile(path.join(ROOT, "docs/spec.md"), "utf8");
}

/** 「## 〈番号〉. 」の見出しの行から、次の「## 」の前までを返す。 */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 全角を2、半角を1と数える（prettier の表の幅の数え方）。 */
function width(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}

const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

describe("仕様書：ワークスペースの設定と CLI（3・6・7・8・10章）", () => {
  it("3章に、親の統括役がワークスペースのフォルダのタブで動き、子へは workspace を通すだけとある", async () => {
    const s = chapter(await loadSpec(), 3);
    expect(s).toMatch(
      /親の統括役[^\n]*ワークスペースのフォルダ[^\n]*のタブで動/,
    );
    expect(s).toMatch(/末尾の節[^\n]*仕様のページ[^\n]*一時ファイルだけ/);
    expect(s).toMatch(/`orca-flow workspace` を通す[^\n]*直接流さない/);
  });

  it("6章に、設定のファイル名・全部のキー・共通だけの3つの欄がある", async () => {
    const s = chapter(await loadSpec(), 6);
    expect(s).toContain("orca-flow-workspace.json");
    for (const key of [
      "repos",
      "repos[].name",
      "repos[].path",
      "repos[].role",
      "repos[].keywords",
      "repos[].scope",
      "repos[].package",
      "repos[].bumpCommand",
      "repos[].branchCommand",
    ]) {
      expect(s, `${key} が6章の表にありません`).toContain(`\`${key}\``);
    }
    expect(s).toMatch(
      /`scope`・`package`・`bumpCommand` が全部要る[^\n]*アプリの欄にこの3つがあれば設定の誤り/,
    );
    expect(s).toMatch(/知らないキーも設定の誤り/);
  });

  it("6章に、確かめの各項（slug・重ならない・実のパス・メインの作業ツリー・入れ子・共通とアプリが1つ以上・終了コード）がある", async () => {
    const s = chapter(await loadSpec(), 6);
    expect(s).toMatch(/名前は重ならず slug の形/);
    expect(s).toMatch(/実のパスに解いて[^\n]*メインの作業ツリーの一番上/);
    expect(s).toMatch(/リンクした worktree[^\n]*誤り/);
    expect(s).toMatch(
      /リポジトリ同士も、ワークスペースのフォルダとリポジトリも[^\n]*一方が他方の下なら誤り/,
    );
    expect(s).toMatch(/共通とアプリがそれぞれ1つ以上ないと誤り/);
    expect(s).toMatch(/設定のファイルがなければ終了コード2[^\n]*読めなければ1/);
    expect(s).toMatch(/共通 → アプリだけ[^\n]*共通同士は依存しない/);
  });

  it("7章に、親が読むのは設定に載った作業ツリーだけで、許す5つだけを流すとある", async () => {
    const s = chapter(await loadSpec(), 7);
    const line = s
      .split("\n")
      .find((l) => /設定に載ったリポジトリの作業ツリーだけ/.test(l));
    expect(line, "親の読む範囲の行がありません").toBeDefined();
    expect(line).toContain("子のファイルを書かず");
    const list = /許したサブコマンド（(.*?)）だけ/.exec(line ?? "")?.[1] ?? "";
    const subs = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(subs).toEqual(["config", "active", "merged", "new", "preview"]);
  });

  it("7章と8章に、new の --auto は子の CLI を流さないとある", async () => {
    const text = await loadSpec();
    const line = chapter(text, 7)
      .split("\n")
      .find((l) => /設定に載ったリポジトリの作業ツリーだけ/.test(l));
    expect(line).toMatch(/`new` の `--auto`[^\n]*流さない/);
    expect(line).toMatch(/子のタブで決める/);
    const s = chapter(text, 8);
    const at = s.indexOf("**workspace（");
    const para = s.slice(at, s.indexOf("**lessons（", at));
    expect(para).toMatch(
      /`new` に `--auto`（`--auto=…` も）[^\n]*子の CLI を流さず[^\n]*終了コード1/,
    );
  });

  it("8章の一覧に、場所の確認に落ちた子の place.message の頭の文がある", async () => {
    const s = chapter(await loadSpec(), 8);
    const line = s.split("\n").find((l) => l.startsWith("- 一覧（引数なし）"));
    expect(line).toContain("`place.message`");
    expect(line).toContain("子 〈名前〉 の統括役のタブで直してください：");
  });

  it("8章の前置きの文は変わらず、workspace は設定に頼らないと別の文で書かれている", async () => {
    const s = chapter(await loadSpec(), 8);
    expect(s).toMatch(/init・context・pstack 以外は/);
    expect(s).toMatch(/`workspace` は子の設定に頼らず/);
  });

  it("8章の表に workspace の5行があり、許すのは5つだけで、ほかは終了コード1", async () => {
    const rows = chapter(await loadSpec(), 8)
      .split("\n")
      .filter((l) => l.startsWith("| `workspace"));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("`workspace [--json]`");
    expect(rows[0]).toContain("読むだけ");
    const allowed = rows[1] ?? "";
    expect(allowed).toContain("`workspace 〈名前〉 〈サブコマンド〉 [引数]`");
    const list = /許すのは(.*?)だけ/.exec(allowed)?.[1] ?? "";
    const subs = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(subs).toEqual(["config", "active", "merged", "new", "preview"]);
    expect(allowed).toMatch(/ほかは終了コード1/);
    const setup = rows[2] ?? "";
    expect(setup).toContain(
      "`workspace --setup [〈設定のファイル〉] [--marketplace 〈入手元〉] [--yes]`",
    );
    expect(setup).toMatch(/`--yes` がなければ何も変えず終了コード0/);
    expect(setup).toMatch(/まだない子だけを clone/);
    expect(setup).toMatch(/終了コードは0[^\n]*1[^\n]*2/);
    expect(setup).toContain(
      "`--json` の data は `{dir, yes, repos:[{name, path, url, action}], plugin, pstack, next}`",
    );
    expect(setup).toMatch(/pstack も[^\n]*入れ/);
  });

  it("8章に workspace --setup の別の段落があり、workspace の段落と lessons の間にある", async () => {
    const s = chapter(await loadSpec(), 8);
    const ws = s.indexOf("**workspace（");
    const at = s.indexOf("**workspace --setup（");
    const lessons = s.indexOf("**lessons（");
    const common = s.indexOf("**共通とアプリのひとまとまり**");
    expect(common).toBeGreaterThanOrEqual(0);
    expect(ws).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lessons).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(common);
    expect(at).toBeGreaterThan(ws);
    expect(at).toBeLessThan(lessons);
    const para = s.slice(at, lessons);
    expect(para).toMatch(
      /`url` を clone 元としては使わず[^\n]*形だけ確かめ[^\n]*今までどおり設定の誤り/,
    );
    expect(para).toMatch(/`url` が要る[^\n]*終了コード1/);
    expect(para).toMatch(/入れ子・名前の重なり[^\n]*clone の前に/);
    expect(para).toMatch(/中身の違う設定があれば終了コード1/);
    expect(para).toContain("`git clone -- 〈url〉 〈パス〉`");
    expect(para).toMatch(/clone が落ちたら[^\n]*残りを流さず終了コード1/);
    expect(para).toContain(
      "`claude plugin install orca-flow --marketplace 〈入手元〉 --scope user`",
    );
    expect(para).toMatch(/自分では有効にせず `claude plugin enable` を案内/);
    expect(para).toContain("`/orca-flow:init`");
    expect(para).toContain("`/orca-flow:intake`");
    expect(para).toMatch(/子の init は流さない/);
    expect(para).toMatch(/終了コード2/);
    const codes = /- 終了コード：[^\n]*/.exec(para)?.[0] ?? "";
    expect(codes, "終了コードの行がありません").not.toBe("");
    expect(codes).toMatch(/`claude plugin install` の失敗/);
    expect(codes).toMatch(/中身の違う設定があるとき[^\n]*上書きしない/);
    expect(codes).toMatch(/入力の誤りとして1/);
    expect(codes).toMatch(/2は[^\n]*プラグインの状態が読めない/);
    expect(codes).toMatch(/統括役の場所に問題がある子/);
    expect(codes).toMatch(/init がまだ[^\n]*無効[^\n]*見つからない/);
    const json = /- `--json`：[^\n]*/.exec(para)?.[0] ?? "";
    expect(json, "--json の行がありません").not.toBe("");
    expect(json).toContain(
      "{dir, yes, repos:[{name, path, url, action}], plugin, pstack, next}",
    );
    expect(para).toContain(
      "`claude plugin install pstack --marketplace cursor/plugins --scope user`",
    );
    expect(para).toMatch(/入手元は[^\n]*`--marketplace` で変えられない/);
    expect(para).toMatch(/入れ直さず[^\n]*`claude plugin uninstall 〈id〉`/);
    expect(para).toMatch(/読み直し[^\n]*正の入手元[^\n]*済んだとみなす/);
    expect(codes).toMatch(/pstack[^\n]*無効[^\n]*正でない[^\n]*読めない/);
  });

  it("6章の表に repos[].url があり、任意・--setup だけが読む・形の誤りが書かれている", async () => {
    const s = chapter(await loadSpec(), 6);
    const row = s.split("\n").find((l) => l.startsWith("| `repos[].url`"));
    expect(row, "repos[].url の行がありません").toBeDefined();
    expect(row).toContain("任意");
    expect(row).toContain("clone 元");
    expect(row).toMatch(/`workspace --setup` だけが clone 元として使う/);
    expect(row).toMatch(
      /一覧と `workspace 〈名前〉` は clone せず、形だけ確かめる/,
    );
    expect(row).toMatch(/空・`-` 始まり・文字列でないものは設定の誤り/);
  });

  it("12章に、複数のリポジトリをまたぐ要件の用意の手順の段落がある", async () => {
    const s = chapter(await loadSpec(), 12);
    const lines = s.split("\n");
    const line = lines.find((l) =>
      l.startsWith("**複数のリポジトリをまたぐ要件の用意**"),
    );
    expect(line, "用意の手順の段落がありません").toBeDefined();
    expect(line).toContain("`orca-flow workspace --setup");
    expect(line).toContain("`bin/orca-flow`");
    expect(line).toMatch(/子は親のフォルダの隣に置く/);
    expect(line).toContain("`/orca-flow:init`");
    expect(line).toContain("`/orca-flow:intake`");
    const before = lines.findIndex((l) =>
      l.startsWith("**複数のリポジトリをまたぐ要件**（"),
    );
    expect(before).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(line ?? "")).toBeGreaterThan(before);
  });

  it("追加した6・8・12章の文に、手元のパスとタスクの番号の形が出ない", async () => {
    const text = await loadSpec();
    const s = chapter(text, 8);
    const at = s.indexOf("**workspace --setup（");
    const para = s.slice(at, s.indexOf("**lessons（", at));
    const row = chapter(text, 6)
      .split("\n")
      .filter((l) => l.startsWith("| `repos[].url`"));
    const l12 = chapter(text, 12)
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("**複数のリポジトリをまたぐ要件の用意**") ||
          l.startsWith("**はじめに1回**"),
      );
    const lines = [...para.split("\n"), ...row, ...l12];
    expect(lines.filter((l) => idForm.test(l))).toEqual([]);
    expect(lines.filter((l) => homePath.test(l))).toEqual([]);
  });

  it("8章の workspace の段落に、設定がなければ2・一覧の終了コード・流す道が書かれている", async () => {
    const s = chapter(await loadSpec(), 8);
    const at = s.indexOf("**workspace（");
    expect(at).toBeGreaterThanOrEqual(0);
    const para = s.slice(at, s.indexOf("**lessons（", at));
    expect(para).toMatch(/設定がなければ終了コード2/);
    expect(para).toMatch(/子の `\.orca-flow\/config\.json` は親が読まず/);
    expect(para).toMatch(
      /子の設定の誤りが1つでもあれば1[^\n]*通らない子があれば2/,
    );
    expect(para).toMatch(/子の CLI を流さずに終了コード1/);
    expect(para).toMatch(/子の終了コードはそのまま返す/);
    expect(para).toMatch(/`--request-file`[^\n]*絶対パスに直して子へ渡す/);
  });

  it("8章の workspace --json のキーが、コマンドの実装の出力の形と同じ", async () => {
    const s = chapter(await loadSpec(), 8);
    const line = s.split("\n").find((l) => l.includes("一覧の `--json`")) ?? "";
    const src = await readFile(
      path.join(ROOT, "src/commands/workspace.ts"),
      "utf8",
    );
    const iface = (name: string) =>
      new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1] ??
      "";
    const keys = (body: string) =>
      [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
    for (const name of ["WorkspaceListing", "WorkspaceRepoStatus"]) {
      const found = keys(iface(name));
      expect(found.length, `${name} のキーが取れません`).toBeGreaterThan(0);
      for (const k of found) {
        expect(line, `${k} が8章にありません`).toContain(`\`${k}\``);
      }
    }
  });

  it("8章の workspace --setup の --json の行に、plugin のキーと5つの kind があり、計画の installed が false とある", async () => {
    const s = chapter(await loadSpec(), 8);
    const at = s.indexOf("**workspace --setup（ワークスペースの用意）**");
    const para = s.slice(at, s.indexOf("**lessons（教訓）**", at));
    const line = para.split("\n").find((l) => l.startsWith("- `--json`")) ?? "";
    expect(line, "--json の行がありません").not.toBe("");
    const src = await readFile(
      path.join(ROOT, "src/lib/workspace-setup.ts"),
      "utf8",
    );
    const body = /export type PluginState =([\s\S]*?);\n/.exec(src)?.[1] ?? "";
    const keys = new Set(
      [...body.matchAll(/(\w+)\??:/g)].map((m) => m[1] ?? ""),
    );
    keys.add("installed");
    expect(keys.has("id") && keys.has("reason")).toBe(true);
    for (const k of keys) {
      expect(line, `${k} が行にありません`).toContain(`\`${k}\``);
    }
    for (const kind of [
      "enabled",
      "disabled",
      "missing",
      "no-claude",
      "unknown",
    ]) {
      expect(line, `${kind} が行にありません`).toContain(`\`${kind}\``);
    }
    expect(line).toMatch(/計画[^。]*`installed`[^。]*`false`/);
  });

  it("8章の workspace --setup の --json の行に、pstack のキーと6つの kind がある", async () => {
    const s = chapter(await loadSpec(), 8);
    const at = s.indexOf("**workspace --setup（ワークスペースの用意）**");
    const para = s.slice(at, s.indexOf("**lessons（教訓）**", at));
    const line = para.split("\n").find((l) => l.startsWith("- `--json`")) ?? "";
    const src = await readFile(
      path.join(ROOT, "src/lib/workspace-setup.ts"),
      "utf8",
    );
    const body = /export type PstackState =([\s\S]*?);\n/.exec(src)?.[1] ?? "";
    const keys = new Set(
      [...body.matchAll(/(\w+)\??:/g)].map((m) => m[1] ?? ""),
    );
    keys.add("installed");
    expect(keys.has("id") && keys.has("reason")).toBe(true);
    const pstackPart = line.slice(line.indexOf("`pstack` は"));
    expect(line, "pstack の説明がありません").toContain("`pstack` は");
    for (const k of keys) {
      expect(pstackPart, `${k} が pstack の説明にありません`).toContain(
        `\`${k}\``,
      );
    }
    for (const kind of [
      "enabled",
      "disabled",
      "missing",
      "untrusted",
      "no-claude",
      "unknown",
    ]) {
      expect(pstackPart, `${kind} が pstack の説明にありません`).toContain(
        `\`${kind}\``,
      );
    }
    expect(pstackPart).toMatch(/計画[^。]*`installed`[^。]*`false`/);
  });

  it("8章の表の pstack の行は変わらない", async () => {
    const row = chapter(await loadSpec(), 8)
      .split("\n")
      .find((l) => l.startsWith("| `pstack 〈"));
    expect(row).toContain("入手元を確かめてから");
  });

  it("12章の「はじめに1回」に pstack を任意で入れる手順と使えるところがある", async () => {
    const line =
      chapter(await loadSpec(), 12)
        .split("\n")
        .find((l) => l.startsWith("**はじめに1回**")) ?? "";
    expect(line).toContain("/plugin marketplace add cursor/plugins");
    expect(line).toContain("/plugin install pstack@cursor-plugins");
    expect(line).toMatch(/任意/);
    expect(line).toContain("/how");
    expect(line).toContain("PR の本文");
    expect(line).toContain("影響範囲");
  });

  it("12章の用意の段落が、orca-flow と pstack の両方を入れるとある", async () => {
    const line =
      chapter(await loadSpec(), 12)
        .split("\n")
        .find((l) => l.startsWith("**複数のリポジトリをまたぐ要件の用意**")) ??
      "";
    expect(line).toMatch(/orca-flow と pstack/);
  });

  it("10.4 に、ワークスペースのフォルダ（git でなくてもよい）の context の文がある", async () => {
    const text = await loadSpec();
    const at = text.indexOf("### 10.4 ");
    const s = text.slice(at, text.indexOf("\n## ", at));
    const line = s
      .split("\n")
      .find((l) => l.includes("**ワークスペースのフォルダ**"));
    expect(line, "ワークスペースの行がありません").toBeDefined();
    expect(line).toContain("orca-flow-workspace.json");
    expect(line).toContain("親の統括役");
    expect(line).toContain("設定の確かめはしない");
  });

  it("3章と7章の8番に、組の qa が子の config だけを読むとある", async () => {
    const text = await loadSpec();
    expect(chapter(text, 3)).toMatch(
      /`orca-flow workspace` を通すときと[^\n]*組の `qa`[^\n]*`config --json` を読むときだけ。子のリポジトリで CLI を直接流さない/,
    );
    const line = chapter(text, 7)
      .split("\n")
      .find((l) => l.startsWith("8. "));
    expect(line).toMatch(
      /`preview`）だけ（組の `qa` が子で流すのも `config` だけ）/,
    );
  });

  it("8章の workspace --setup の計画・終わり・終了コードに、ない先に読む文書の扱いがある", async () => {
    const c8 = chapter(await loadSpec(), 8);
    const at = c8.indexOf("**workspace --setup（");
    const para = c8.slice(at, c8.indexOf("\n**", at + 1));
    const line = (head: string) =>
      para.split("\n").find((l) => l.startsWith(head)) ?? "";
    const plan = line("- 計画：");
    expect(plan).toContain("まだない文書があれば、1行ずつ");
    expect(plan).toContain("clone で入る見込み");
    expect(plan).toContain("置く");
    expect(plan).toMatch(/`next` に同じ文/);
    expect(plan).toContain("終了コード0");
    const end = line("- 終わり：");
    expect(end).toMatch(/先に読む文書がないことだけは誤りにせず/);
    expect(end).toMatch(/ほかの設定の誤りは今までどおり終了コード1/);
    expect(end).toMatch(/開き直しの案内[^\n]*置く文書のパス[^\n]*終了コード2/);
    const codes = line("- 終了コード：");
    expect(codes).toMatch(/先に読む文書がないことは含まない/);
    expect(codes).toMatch(/clone のあとも先に読む文書がない/);
  });

  it("8章の workspace --setup と12章の用意の段落に、settings の ask と自分では書かないことがある", async () => {
    const text = await loadSpec();
    const c8 = chapter(text, 8);
    const at = c8.indexOf("**workspace --setup（");
    const setup = c8.slice(at, c8.indexOf("\n**", at + 1));
    const line = chapter(text, 12)
      .split("\n")
      .find((l) => l.startsWith("**複数のリポジトリをまたぐ要件の用意**"));
    for (const part of [setup, line ?? ""]) {
      expect(part).toContain("permissions.ask");
      expect(part).toContain("Bash(orca-flow qa deploy *)");
      expect(part).toMatch(/自分では書き換えない|自分では書かない/);
    }
  });

  it("10.4 の行の引用に、組の qa と子の config を読むことがある", async () => {
    const text = await loadSpec();
    const at = text.indexOf("### 10.4 ");
    const line = text
      .slice(at, text.indexOf("\n## ", at))
      .split("\n")
      .find((l) => l.includes("**ワークスペースのフォルダ**"));
    expect(line).toContain(
      "子へ流せるのは config・active・merged・new・preview だけ",
    );
    expect(line).toContain("orca-flow qa は組のモードで動き");
  });

  it("16章は外れていて、16.3・16.4 も残っていない（移した文は上の3・6・7・8章で確かめる）", async () => {
    const text = await loadSpec();
    expect(text).not.toMatch(/^## 16\. /m);
    expect(text).not.toMatch(/^### 16\.[34] /m);
  });

  it("移した章にタスクの番号の形と、ホームの下の絶対パスが出ない", async () => {
    const text = await loadSpec();
    const lines = [3, 6, 7, 8].flatMap((n) => chapter(text, n).split("\n"));
    expect(lines.filter((l) => idForm.test(l))).toEqual([]);
    expect(lines.filter((l) => homePath.test(l))).toEqual([]);
  });
});

describe("仕様書：ワークスペースの設定を作る道（5・6・8・10.1・12章）", () => {
  it("5章の木の skills の並びに workspace がある", async () => {
    const s = chapter(await loadSpec(), 5);
    expect(s).toMatch(/skills\/\{[^}]*\bworkspace\b[^}]*\}\/SKILL\.md/);
  });

  it("6章が「人が書く」でなく、init は置かず /orca-flow:workspace が作ると指す", async () => {
    const s = chapter(await loadSpec(), 6);
    expect(s).not.toContain("（人が書く）");
    expect(s).toMatch(
      /`\/orca-flow:init` は置かず[^\n]*`\/orca-flow:workspace`[^\n]*作る（手で書いてもよい）/,
    );
  });

  it("8章の表に workspace --draft の行があり、読むだけで終了コードが書かれている", async () => {
    const row = chapter(await loadSpec(), 8)
      .split("\n")
      .find((l) => l.startsWith("| `workspace --draft"));
    expect(row, "--draft の行がありません").toBeDefined();
    expect(row).toContain("`workspace --draft [〈リポジトリのパス〉...]`");
    expect(row).toMatch(/読むだけ/);
    expect(row).toMatch(/0（出せた）・1（引数の誤り）・2（対象がない）/);
  });

  it("8章に workspace --draft の段落があり、setup の段落のあと lessons の前にある", async () => {
    const s = chapter(await loadSpec(), 8);
    const setup = s.indexOf("**workspace --setup（");
    const at = s.indexOf("**workspace --draft（設定の下書き）**");
    const lessons = s.indexOf("**lessons（");
    expect(at).toBeGreaterThan(setup);
    expect(at).toBeLessThan(lessons);
    const para = s.slice(at, lessons);
    expect(para).toMatch(/`--setup` と一緒に渡すと終了コード1/);
    expect(para).toMatch(/HEAD のコミットから読み/);
    expect(para).toMatch(/認証の値[^\n]*null[^\n]*`problems`/);
    expect(para).toMatch(/終了コード：0[^\n]*1[^\n]*2/);
    for (const k of [
      "name",
      "path",
      "url",
      "package",
      "manager",
      "role",
      "users",
      "problems",
    ]) {
      expect(para, `${k} が段落にありません`).toContain(`\`${k}\``);
    }
    expect(para).toContain(
      "{dir, repos:[{name, path, url, package, manager, role, users, e2e, problems}]}",
    );
  });

  it("10.1 の表に /orca-flow:workspace の行があり、人に聞く形の段落が7つを数える", async () => {
    const text = await loadSpec();
    const s = text.slice(
      text.indexOf("\n### 10.1 "),
      text.indexOf("\n### 10.2 "),
    );
    const row = s
      .split("\n")
      .find((l) => l.startsWith("| `/orca-flow:workspace"));
    expect(row, "表の行がありません").toBeDefined();
    expect(row).toContain("orca-flow workspace --draft --json");
    expect(row).toContain("orca-flow workspace --setup");
    expect(row).toContain("子の init は流さない");
    const para = s
      .split("\n")
      .find((l) => l.startsWith("**人に聞く形**のスキルの扱い："));
    expect(para).toMatch(/`split`・`workspace` の7つは/);
    expect(para).not.toContain("の6つは");
    expect(para).toContain("「## 人に聞くとき」");
  });

  it("12章の用意の段落に、/orca-flow:workspace が設定を作って setup まで続けるとあり、今の文も残る", async () => {
    const line =
      chapter(await loadSpec(), 12)
        .split("\n")
        .find((l) => l.startsWith("**複数のリポジトリをまたぐ要件の用意**")) ??
      "";
    expect(line).toContain("`/orca-flow:workspace`");
    expect(line).toMatch(/`--yes` の用意まで続ける/);
    expect(line).toContain("`bin/orca-flow`");
    expect(line).toMatch(/子は親のフォルダの隣に置く/);
    expect(line).toContain("`/orca-flow:init`");
    expect(line).toContain("`/orca-flow:intake`");
    expect(line).toMatch(/orca-flow と pstack/);
  });
});

describe("仕様書：workspace --preview", () => {
  it("8章の表に --preview の行があり、--stop・--background・--json が書かれている", async () => {
    const row = chapter(await loadSpec(), 8)
      .split("\n")
      .find((l) => l.startsWith("| `workspace --preview"));
    expect(row, "--preview の行がありません").toBeDefined();
    expect(row).toContain(
      "`workspace --preview 〈ブランチ名〉 [--stop] [--background]",
    );
    expect(row).toContain("親の統括役");
  });

  it("8章の workspace の段落に、組の起動の決まりがある", async () => {
    const s = chapter(await loadSpec(), 8);
    const at = s.indexOf("**workspace（");
    const para = s.slice(at, s.indexOf("**lessons（", at));
    expect(para).toMatch(
      /- 組の起動：[^\n]*`preview 〈ID〉 --after-setup --no-open --json`/,
    );
    expect(para).toMatch(/設定の順に1つずつ/);
    expect(para).toMatch(/落ちても残りは続け[^\n]*終了コード1/);
    expect(para).toContain("workspace-preview/〈ID〉.log");
    expect(para).toMatch(/ターミナルの出力は写さない/);
  });

  it("8章の workspace の段落に、またぐ依存の記録で組のアプリを決めることと組の外の飛ばしがある", async () => {
    const s = chapter(await loadSpec(), 8);
    const at = s.indexOf("**workspace（");
    const para = s.slice(at, s.indexOf("**lessons（", at));
    const line =
      para.split("\n").find((l) => l.startsWith("- 組の起動：")) ?? "";
    expect(line).toMatch(
      /組のアプリ[^\n]*またぐ依存の記録[^\n]*共通の子の同じ ID/,
    );
    expect(line).toMatch(/「組の外」[^\n]*飛ばし/);
    expect(line).toMatch(/`--stop` も組のアプリだけ/);
    expect(line).toMatch(/記録が壊れた子は落ちた/);
  });

  it("3章の親の書いてよいものに背景のログがある", async () => {
    const line =
      chapter(await loadSpec(), 3)
        .split("\n")
        .find((l) => l.startsWith("- 親の統括役（親）は")) ?? "";
    expect(line).toContain("親が書いてよいのは");
    expect(line).toMatch(/プレビューの背景のログ/);
  });
});

describe("仕様書：--draft の users", () => {
  it("users は読めない対象があるとき null で、role は app になる", async () => {
    const s = await loadSpec();
    expect(s).toMatch(
      /`users`（そのパッケージ名を使うほかの対象[^\n]*null[^\n]*`"app"`/,
    );
  });
});

describe("仕様書：組をブランチ名で見分ける", () => {
  const workspacePara = (s: string) => {
    const at = s.indexOf("**workspace（");
    return s.slice(at, s.indexOf("**lessons（", at));
  };
  const qaGroup = (s: string) => {
    const part = s.slice(s.indexOf("**qa（"), s.indexOf("**おまかせ**"));
    const at = part.indexOf("- 組のモード：");
    return part.slice(at, part.indexOf("\n- ", at + 1));
  };
  const cells = (line: string) =>
    line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim());

  it("8章の表の workspace --preview の行は1列めがブランチ名で表の幅を広げず、説明にブランチ名だけで打つとある", async () => {
    const rows = chapter(await loadSpec(), 8)
      .split("\n")
      .filter((l) => l.startsWith("|"));
    const row = rows.find((l) => l.startsWith("| `workspace --preview")) ?? "";
    const c = cells(row);
    expect(c[0]).toBe(
      "`workspace --preview 〈ブランチ名〉 [--stop] [--background] [--base] [--json]`",
    );
    const others = rows
      .filter((l) => l !== row && !/^\|\s*:?-/.test(l))
      .map((l) => width(cells(l)[0] ?? ""));
    expect(width(c[0] ?? "")).toBeLessThanOrEqual(Math.max(...others));
    expect(c[2]).toContain(
      "組はブランチ名だけで打ち、ID の形は打ち直しの1行を出して終了コード1",
    );
    expect(c[2]).not.toContain("ブランチ名も受ける");
  });

  it("8章の qa の組のモードに、引数の読み方・ID で打ったときの止め・形の外れ・前提がある", async () => {
    const group = qaGroup(chapter(await loadSpec(), 8));
    const arg = group.split("\n").find((l) => l.startsWith("  - 引数：")) ?? "";
    expect(arg, "組のモードに「引数：」の小項目がありません").not.toBe("");
    for (const w of [
      "〈ID〉 の位置にブランチ名だけを受ける",
      "`qa release --env 〈番号〉` と `qa list` は今のまま",
      "ID の形なら止め、そうでなければブランチ名として読む",
      "`〈branchPrefix〉〈ID〉-〈slug〉` の形のものだけ受け",
      "そのブランチ名のブランチがあるアプリだけを組にする",
      "どのアプリにもないときは終了コード1",
      "ID の形で打ったときは、候補が1つでも進まず終了コード1",
      "リポジトリごとの候補のブランチ名",
      "ブランチ名で打ち直す1行",
      "候補のないアプリの子があるときは、例の行の頭に「候補が組のブランチなら、」をつけ",
      "番号だけ同じ別のタスクのものかもしれないので組のブランチ名で打つよう、注意の1行を添える",
      "何も送らず何も借りず何も返さない",
      "番号だけ同じ組の外のブランチと取り違えないため",
      "人が手で、別々の機能に同じ ID と同じ短い名前をつけたときは見分けられない",
      "組はリポジトリとブランチ名で特定し",
      "ブランチ名と記録（またぐ依存の記録・伴う記録）が食い違えばブランチ名を信じる",
    ])
      expect(arg, w).toContain(w);
    for (const w of [
      "ID の代わりにブランチ名も受ける",
      "短い名前が全部同じなら今までどおり進む",
    ])
      expect(arg, w).not.toContain(w);
    const line = (head: string) =>
      group.split("\n").find((l) => l.startsWith(head)) ?? "";
    expect(line("  - 組のアプリ：")).not.toContain("ID で打ったときは");
    expect(line("  - `qa plan 〈ブランチ名〉`（読むだけ）：")).not.toBe("");
    expect(
      line("  - `qa deploy 〈ブランチ名〉 --env 〈番号〉 --head"),
    ).not.toBe("");
    expect(line("  - 組とブランチ：")).toContain(
      "同じ ID と短い名前で始めたリポジトリのまとまり",
    );
    expect(line("  - 枝の取り込みの確かめ：")).toContain(
      "組と同じ短い名前の枝だけを見る",
    );
    const lease = line("  - 貸し出し：");
    expect(lease).toContain(
      "同じ ID でもブランチ名の違う貸し出しは使い直さない",
    );
    expect(lease).toContain(
      "組のブランチ名と同じブランチ名の貸し出しを、ワークスペースのフォルダか組のアプリのリポジトリが借りていれば、ID の欄が違ってもその番号を使い直す",
    );
    expect(lease).toContain("ブランチ名のない古い記録は ID で比べる");
    const child = line("  - `qa list` は");
    expect(child).toContain("ブランチ名の違う組の貸し出しには出さない");
  });

  it("6章の『QA 環境』に、貸し出しの持ち主を両方にブランチ名があればリポジトリとブランチ名で比べ、古い記録は ID で比べるとある", async () => {
    const c6 = chapter(await loadSpec(), 6);
    const para = c6.slice(c6.indexOf("**QA 環境**")).split("\n\n")[0] ?? "";
    expect(para).not.toContain("ID に加えてブランチ名で比べる");
    for (const w of [
      "借り手と貸し出しの両方にブランチ名があれば、リポジトリとブランチ名で比べ、ID の欄は見ない",
      "ID の欄が違っても同じ持ち主とし",
      "記録の `branch`",
      "`apps` の各 `branch`",
      "記録の形は変えず",
      "どちらかにブランチ名のない古い形の記録は今までどおり ID で比べる",
    ])
      expect(para, w).toContain(w);
  });

  it("8章の workspace の組の起動が、ブランチ名だけを受け、ブランチ名が同じアプリも組に入れる", async () => {
    const para = workspacePara(chapter(await loadSpec(), 8));
    const line = (head: string) =>
      para.split("\n").find((l) => l.startsWith(head)) ?? "";
    const start = line("- 組の起動：");
    expect(start).toContain(
      "- 組の起動：`workspace --preview 〈ブランチ名〉` は（ブランチ名だけを受ける",
    );
    expect(start).not.toContain("ブランチ名も受ける");
    expect(start).toContain("qa の組のモードの『引数』と同じ");
    expect(start).toContain("止まるときは子の preview も背景も1つも流さない");
    expect(start).toContain(
      "打った旗（`--stop`・`--background`・`--base`）をつけた `workspace --preview 〈ブランチ名〉` にする",
    );
    expect(start).toContain("手元に組のブランチ名のブランチがある子");
    expect(start).toContain(
      "組は、組のブランチ名のブランチがあるリポジトリで決まる",
    );
    expect(start).toContain(
      "記録は、同じ ID のブランチが手元にない子を拾うのに使い",
    );
    expect(start).toMatch(
      /同じ ID で短い名前の違うブランチしかない子[^\n]*記録があっても「組の外」/,
    );
    expect(start).toContain("ブランチ名と記録が食い違えばブランチ名を信じる");
    expect(start).not.toContain("どちらにも当たらない子");
    expect(start).toContain("子には子の ID で");
    const see = line("- 組の起動の見分け");
    expect(see).toContain("共通のないブランチ（アプリが2つ以上）");
    expect(see).toContain("同じ ID のブランチが手元にない子");
    expect(see).toMatch(
      /短い名前の違うブランチしかないアプリは、伴う記録に載っていても「組の外」/,
    );
    expect(see).toContain(
      "同じ ID のブランチがなく、どちらの記録にも載らないアプリも「組の外」のまま",
    );
    expect(line("- 前の画面の組の起動：")).toContain(
      "- 前の画面の組の起動：`workspace --preview 〈ブランチ名〉 --base [--stop] [--background]`（ブランチ名だけを受ける）",
    );
  });

  it("8章の preview の組の起動と12章の使い方が、組をブランチ名で立てる", async () => {
    const text = await loadSpec();
    const c8 = chapter(text, 8);
    const sec = c8.slice(c8.indexOf("**preview（"));
    const start =
      sec.split("\n").find((l) => l.startsWith("- 組の起動：")) ?? "";
    expect(start).toContain("`workspace --preview 〈ブランチ名〉`");
    const use =
      chapter(text, 12)
        .split("\n")
        .find((l) => /^\d+\. \*\*アプリの動きを見る\*\*/.test(l)) ?? "";
    expect(use).toContain("`orca-flow workspace --preview 〈ブランチ名〉`");
    expect(use).toContain("`workspace --preview 〈ブランチ名〉 --stop`");
  });

  it("8章の qa の組のモードの『引数』に、release の止めない道と打ち直しの例の決まりがある", async () => {
    const group = qaGroup(chapter(await loadSpec(), 8));
    const arg = group.split("\n").find((l) => l.startsWith("  - 引数：")) ?? "";
    for (const w of [
      "`release` は、どのアプリの子にもないブランチ名でも止めない",
      "`plan` と `deploy` の止めでは `qa plan 〈ブランチ名〉`、`release` の止めでは `qa release 〈ブランチ名〉` にする",
      "`deploy` の `--env`・`--head` は `plan` が出す次の1行で決まるため",
      "例は、候補のうち使える形のブランチ名だけを使い",
      "なければ例の行を出さず、組のブランチを使える形のブランチ名に変えてから打ち直すよう案内する",
    ])
      expect(arg, w).toContain(w);
  });

  it("8章の qa の組の返しが、消したブランチでも返し、残った組の貸し出しを案内する", async () => {
    const group = qaGroup(chapter(await loadSpec(), 8));
    const back =
      group.split("\n").find((l) => l.startsWith("  - 組の返し：")) ?? "";
    expect(back, "組のモードに「組の返し：」の小項目がありません").not.toBe("");
    for (const w of [
      "手元にそのブランチがどのアプリの子にもなくても止めず",
      "打たれたブランチ名1つで組の貸し出しの `apps[].branch` と照らして返す",
      "ID の形の `qa release 〈ID〉` は、上の『引数』のとおり止まり、何も返さない",
      "返すものが0件で",
      "同じ ID の組の貸し出しが残っていれば",
      "「借りている環境はありません」と言わず、終了コード0",
      "番号・組のアプリとブランチと `orca-flow qa release --env 〈番号〉` を案内する",
      "`released: []`",
      "`heldByGroup`",
      "どのアプリの子にもなく、そのブランチの組の貸し出しも、同じ ID の組の貸し出しもないときは終了コード1",
    ])
      expect(back, w).toContain(w);
    const child =
      group.split("\n").find((l) => l.startsWith("  - `qa list` は")) ?? "";
    expect(child).toContain(
      "ワークスペースのフォルダでの `qa release 〈ブランチ名〉` か `qa release --env 〈番号〉`",
    );
    expect(child).toContain(
      "子の手元の `〈branchPrefix〉〈ID〉-` で始まるブランチがちょうど1つで使える形なら、そのブランチ名の `qa release 〈ブランチ名〉` と `--env` を、そうでなければ `qa release --env 〈番号〉` だけを案内し",
    );
    expect(child).toContain(
      "ワークスペースのフォルダで ID で打つ1行は出さない",
    );
    expect(child).not.toContain("決まらなければ ID");
  });

  it("8章の workspace の組の --stop が、消したブランチでも記録で組に当たる子だけを止め、組の外を止めない", async () => {
    const para = workspacePara(chapter(await loadSpec(), 8));
    const line = (head: string) =>
      para.split("\n").find((l) => l.startsWith(head)) ?? "";
    const start = line("- 組の起動：");
    for (const w of [
      "`--stop` は、そのブランチがどのアプリの子にもなくても止めず",
      "ブランチ名から ID と短い名前を読み",
      "記録で組に当たる子だけを止める",
      "同じ ID で短い名前の違うブランチしかない子と、記録の `taskBranch` が組のブランチ名と違う子は止めない",
      "止める子も落ちた子もなければ終了コード1で、子の preview を1つも流さない",
      "`--stop` のない起動と `--background` は、どのアプリの子にもないブランチ名なら今までどおり終了コード1",
    ])
      expect(start, w).toContain(w);
    for (const w of [
      "`--stop` を ID で打ったときは",
      "ブランチ名で打って止める1行を案内して",
      "1つでも記録で組に当たれば今までどおり止め",
    ])
      expect(start, w).not.toContain(w);
    expect(line("- 前の画面の組の起動：")).toContain(
      "ID の形の止めと `--stop` の扱いも上の組の起動と同じ",
    );
  });

  it("8章の workspace の組の見分けが、記録の taskBranch を組のブランチ名と比べ、ない古い記録は ID で見る", async () => {
    const para = workspacePara(chapter(await loadSpec(), 8));
    const line = (head: string) =>
      para.split("\n").find((l) => l.startsWith(head)) ?? "";
    expect(line("- 組の起動：")).toContain(
      "記録の `taskBranch`（6章）が組のブランチ名と違えば、依存があっても「組の外」にする（番号だけ同じ別の組の記録のため）。`taskBranch` のない古い記録は今までどおり ID で見る",
    );
    expect(line("- 組の起動の見分け")).toContain(
      "伴う記録の `taskBranch`（6章）が組のブランチ名と違うときも、載っていても「組の外」（`taskBranch` のない古い記録は ID で見る）",
    );
  });

  it("仕様書のワークスペースのフォルダの組の preview の打ち方に、ID の形が残らない", async () => {
    const text = await loadSpec();
    expect(text).not.toContain("workspace --preview 〈ID〉");
    expect(text).not.toContain("同じ ID のブランチを持つアプリ");
  });

  it("10.1 の intake は、共通のないブランチも組を始めたあとにブランチ名でプレビューを背景で立てる", async () => {
    const ten = chapter(await loadSpec(), 10).split("\n");
    const line = (head: string) => ten.find((l) => l.startsWith(head)) ?? "";
    const group = line("- ひとまとまり：");
    expect(group).toContain(
      "共通を含むブランチも共通のないブランチも、`new` が全部通ったあとに `orca-flow workspace --preview 〈ブランチ名〉 --background` を流す",
    );
    expect(group).toContain("そのブランチで通った `new` の出力のブランチ名");
    expect(group).toContain("ID で渡さない");
    expect(group).not.toContain("`workspace --preview` も流さない");
    expect(group).not.toContain("workspace --preview 〈ID〉");
    const form = line("- 仕様のページの形：");
    expect(form).not.toContain("`workspace --preview` も流さない");
    expect(form).toContain("ブランチ名で背景で流す");
    const comp = line("- 伴う項目：");
    expect(comp).toContain(
      "`orca-flow workspace --preview 〈ブランチ名〉 --background`",
    );
    const cap = line("**E2E の録画**");
    expect(cap).toContain("`workspace --preview 〈ブランチ名〉 --base`");
  });
});
