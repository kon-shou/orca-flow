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
    expect(s).toMatch(/仕様のページと一時ファイルだけ/);
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

  it("8章の表に workspace の2行があり、許すのは4つだけで、ほかは終了コード1", async () => {
    const rows = chapter(await loadSpec(), 8)
      .split("\n")
      .filter((l) => l.startsWith("| `workspace"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("`workspace [--json]`");
    expect(rows[0]).toContain("読むだけ");
    const allowed = rows[1] ?? "";
    expect(allowed).toContain("`workspace 〈名前〉 〈サブコマンド〉 [引数]`");
    const list = /許すのは(.*?)だけ/.exec(allowed)?.[1] ?? "";
    const subs = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(subs).toEqual(["config", "active", "merged", "new"]);
    expect(allowed).toMatch(/ほかは終了コード1/);
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
