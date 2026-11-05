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

  it("7章に、親が読むのは設定に載った作業ツリーだけで、許す4つだけを流すとある", async () => {
    const s = chapter(await loadSpec(), 7);
    const line = s
      .split("\n")
      .find((l) => /設定に載ったリポジトリの作業ツリーだけ/.test(l));
    expect(line, "親の読む範囲の行がありません").toBeDefined();
    expect(line).toContain("子のファイルを書かず");
    const list = /許したサブコマンド（(.*?)）だけ/.exec(line ?? "")?.[1] ?? "";
    const subs = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(subs).toEqual(["config", "active", "merged", "new"]);
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

  it("8章の表に workspace の3行があり、許すのは4つだけで、ほかは終了コード1", async () => {
    const rows = chapter(await loadSpec(), 8)
      .split("\n")
      .filter((l) => l.startsWith("| `workspace"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("`workspace [--json]`");
    expect(rows[0]).toContain("読むだけ");
    const allowed = rows[1] ?? "";
    expect(allowed).toContain("`workspace 〈名前〉 〈サブコマンド〉 [引数]`");
    const list = /許すのは(.*?)だけ/.exec(allowed)?.[1] ?? "";
    const subs = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(subs).toEqual(["config", "active", "merged", "new"]);
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
