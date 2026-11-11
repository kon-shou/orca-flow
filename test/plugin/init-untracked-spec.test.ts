import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** 見出しに当たる行の次から、同じ深さ以下の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const depth = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+) /.exec(l);
    return m !== null && (m[1]?.length ?? 99) <= depth;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const SETUP_LINE = 'bash "$ORCA_ROOT_PATH/.orca-flow/setup.sh"';
const HEADING_2B = "# 2b. git で追跡していない orca-flow のファイルを";

describe("git に残さない導入：docs/spec.md", () => {
  it("6章：untracked の行と、どれもコミットする、の例外がある", async () => {
    const sec = section(await read("docs/spec.md"), /^## 6\. /);
    expect(sec).toMatch(/^\| untracked +\| `false`/m);
    expect(sec).toContain("info/exclude");
    expect(sec).toContain("init --untracked");
    expect(sec).not.toMatch(/どれもコミットする。$/m);
  });

  it("6章・8章：untracked のタスクの worktree では、メインの config.json を読む", async () => {
    const text = await read("docs/spec.md");
    for (const re of [/^## 6\. /, /^## 8\. /]) {
      const sec = section(text, re);
      expect(sec, String(re)).toMatch(/メインの config\.json/);
      expect(sec, String(re)).toMatch(
        /メインの review\.md|review\.md[^\n]*メイン/,
      );
    }
  });

  it("6章：決定の記録が無視されているときの扱いを書く", async () => {
    const sec = section(await read("docs/spec.md"), /^## 6\. /);
    expect(sec).toContain("## 決定の記録の項");
    expect(sec).toContain("メインの記録の末尾");
  });

  it("8章：init の untracked の動き（段落）と --json のキー・new の止まり・main-check", async () => {
    const sec = section(await read("docs/spec.md"), /^## 8\. /);
    for (const key of [
      "init --untracked",
      "trackedFlowFiles",
      "infoAttributes",
      "exclude",
      "hooks",
      HEADING_2B,
      "wait-for-setup",
    ]) {
      expect(sec, key).toContain(key);
    }
    expect(sec).toContain(SETUP_LINE);
    expect(sec).toContain("## 決定の記録の項");
    expect(sec).toMatch(/main-check[^\n]*setup\.sh/);
    expect(sec).toMatch(/untracked[^\n]*終了コード2/);
  });

  it("11章：2b の段と、画面の setup と待ってから開始", async () => {
    const sec = section(await read("docs/spec.md"), /^## 11\. /);
    expect(sec).toContain(HEADING_2B);
    expect(sec).toContain(SETUP_LINE);
    expect(sec).toContain("$ORCA_ROOT_PATH");
    expect(sec).toContain("orca.yaml");
    expect(sec).toContain("1.4.245");
    expect(sec).toContain("待ってから");
  });

  it("12章：git に残さない導入と、すでに入れたリポジトリのそろえ方", async () => {
    const sec = section(await read("docs/spec.md"), /^## 12\. /);
    expect(sec).toContain("**git に残さない導入**");
    expect(sec).toContain("init --untracked");
    expect(sec).toContain(SETUP_LINE);
    expect(sec).toContain("ワークツリーフック");
    expect(sec).toContain("追跡をやめる");
  });

  it("12章：写さないと止まり続ける、とは書かず、メインの config.json を読むと書く", async () => {
    const sec = section(await read("docs/spec.md"), /^## 12\. /);
    expect(sec).not.toMatch(/止まり続け/);
    expect(sec).toContain("settings.local.json");
    expect(sec).toMatch(/メインの config\.json/);
    expect(sec).toMatch(/メインの review\.md/);
  });

  it("10.1・10.2：メインの review.md を読む読み替えがある", async () => {
    const sec = section(await read("docs/spec.md"), /^## 10\. /);
    expect(sec).toMatch(/untracked（6章）：[^\n]*review\.md/);
  });

  it("13章：setup が失敗したときのエージェントの起動は未確認として残る", async () => {
    const sec = section(await read("docs/spec.md"), /^## 13\. /);
    expect(sec).toMatch(/setup が失敗[^\n]*エージェント/);
  });

  it("Orca で確かめたことを版つきで書く", async () => {
    const text = await read("docs/spec.md");
    expect(text).toMatch(/2026-11-10[^\n]*1\.4\.245|1\.4\.245[^\n]*2026-11-10/);
    expect(text).toContain("orca repo show --json");
    expect(text).toContain("setupAgentStartupPolicy");
  });
});

describe("git に残さない導入：README とスキル", () => {
  it("README：untracked の導入を案内する", async () => {
    const text = await read("README.md");
    expect(text).toContain("init --untracked");
    expect(text).toContain("docs/spec.md");
  });

  it("init：exclude・追跡中のファイル・画面の設定・settings.local.json・コミットしない", async () => {
    const text = await read("skills/init/SKILL.md");
    expect(text).toContain("--untracked");
    expect(text).toContain("info/exclude");
    expect(text).toContain("trackedFlowFiles");
    expect(text).toContain("settings.local.json");
    expect(text).toContain(SETUP_LINE);
    expect(text).toContain("待ってから");
    expect(text).toMatch(/untracked[^\n]*コミットしない/);
  });

  it("run：無視された決定の記録は報告の節に書き、記録にもコミットにも触れない", async () => {
    const text = await read("skills/run/SKILL.md");
    expect(text).toContain("## 決定の記録の項");
    expect(text).toMatch(/decisionsFile が無視されて/);
  });

  it("integrate：無視された共有のファイルをコミットせず、選択はメインの記録に足すだけ", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).toContain("## 決定の記録の項");
    expect(text).toMatch(/無視されて[^\n]*コミットしない/);
  });

  it("approve：untracked で .orca-flow を変えたら、そのタスクの worktree へも写す", async () => {
    const text = await read("skills/approve/SKILL.md");
    expect(text).toMatch(/untracked[^\n]*worktree[^\n]*写す/);
    expect(text).toMatch(/無視されて[^\n]*コミットしない/);
  });

  it("init：手順3は untracked で --untracked --yes を流し、exclude と attributes の行を確かめる", async () => {
    const text = await read("skills/init/SKILL.md");
    expect(text).toContain("orca-flow init --untracked --yes");
    expect(text).toContain(".git/info/attributes");
    expect(text).toMatch(/\.gitignore・\.gitattributes は触らず/);
  });

  it("approve・integrate：.orca-flow の変更は作業中のすべての worktree へ写す", async () => {
    for (const rel of [
      "skills/approve/SKILL.md",
      "skills/integrate/SKILL.md",
    ]) {
      const text = await read(rel);
      expect(text, rel).toMatch(/orca-flow active[^\n]*worktree/);
    }
    const spec = section(await read("docs/spec.md"), /^## 12\. /);
    expect(spec).toContain("自動では届かない");
  });

  it("approve・integrate：写す理由は settings.local.json が worktree のものを使うため。止まり続ける、とは書かない", async () => {
    for (const rel of [
      "skills/approve/SKILL.md",
      "skills/integrate/SKILL.md",
    ]) {
      expect(await read(rel), rel).not.toMatch(/止まり続け/);
    }
    const text = await read("skills/approve/SKILL.md");
    expect(text).toMatch(/settings\.local\.json[^\n]*worktree のものが効く/);
    expect(text).toMatch(/CLI がメインの[^\n]*config\.json[^\n]*読む/);
  });

  it("to-lint：lint.md が無視されていれば git show でなくメインのファイルを読む", async () => {
    const text = await read("skills/to-lint/SKILL.md");
    expect(text).toMatch(/lint\.md[^\n]*無視されて/);
    expect(text).toContain("メインのチェックアウトの `.orca-flow/lint.md`");
  });

  it("導入先の名前・手元のパスを書かない", async () => {
    for (const rel of ["skills/init/SKILL.md", "skills/to-lint/SKILL.md"]) {
      const text = await read(rel);
      expect(text, rel).not.toMatch(/\/home\/|\/Users\//);
    }
  });
});
