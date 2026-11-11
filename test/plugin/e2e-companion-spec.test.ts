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

const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

describe("仕様書：E2E を組に伴わせる（6章）", () => {
  it("6章の表に repos[].companion の行があり、apps・when・command の3つが全部要るとある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const row = s.split("\n").find((l) => l.includes("`repos[].companion`"));
    expect(row, "表に repos[].companion の行がありません").toBeDefined();
    expect(row).toContain("アプリだけ");
    for (const k of ["apps", "when", "command"]) {
      expect(row, k).toContain(`\`${k}\``);
    }
    expect(s).toMatch(
      /`companion`[^\n]*`apps`・`when`・`command` が全部要る[^\n]*設定の誤り/,
    );
    expect(s).toMatch(/`command`[^\n]*`\{previewUrl:〈名前〉\}`/);
  });

  it("6章に、伴う記録の段落（置き場・キー・古い記録を消す・壊れていれば終了コード1）がある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const para = s.split("\n").find((l) => l.startsWith("**伴う記録**")) ?? "";
    expect(para, "伴う記録の段落がありません").not.toBe("");
    expect(para).toContain("orca-flow/companion/〈ID〉.json");
    for (const k of ["id", "at", "command", "apps", "name", "path"]) {
      expect(para, k).toContain(`\`${k}\``);
    }
    expect(para).toMatch(/付けない `new` は[^\n]*古い[^\n]*消す/);
    expect(para).toMatch(/壊れて[^\n]*終了コード1/);
  });

  it("伴う記録に taskBranch があり、親の JSON には入れず、組の見分けと古い記録はまたぐ依存の記録と同じ", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const para = s.split("\n").find((l) => l.startsWith("**伴う記録**")) ?? "";
    for (const w of [
      "中身は `id`・`taskBranch`（このタスクのブランチ名）・`at`",
      "`taskBranch` は子の `new` が自分のタスクのブランチ名を書き、読む関数が返す",
      "親が渡す `--companion-json` には入れない",
      "`taskBranch` のない古い記録を ID で見ることは、またぐ依存の記録と同じ",
    ])
      expect(para, w).toContain(w);
  });
});

describe("仕様書：E2E を組に伴わせる（8章）", () => {
  it("8章の表に e2e の行があり、--wait・--json・テストの指定がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = lines.find((l) => l.startsWith("| `e2e ")) ?? "";
    expect(row, "表に e2e の行がありません").not.toBe("");
    expect(row).toContain("--wait");
    expect(row).toContain("--json");
    expect(row).toContain("テストの指定");
  });

  it("8章に e2e の段落があり、流す条件・終了コード・URL を毎回記録から読むことがある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const at = lines.findIndex((l) => l.startsWith("**e2e"));
    expect(at, "e2e の段落がありません").toBeGreaterThanOrEqual(0);
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => l.startsWith("**"));
    const para = lines.slice(at, end < 0 ? undefined : at + 1 + end).join("\n");
    expect(para).toContain("{previewUrl:");
    expect(para).toMatch(/integrate-wait の行/);
    expect(para).toMatch(/preview の記録[^\n]*毎回読む/);
    expect(para).toMatch(/終了コード2/);
    expect(para).toMatch(/redactSecrets|秘密[^\n]*伏せ/);
    expect(para).toMatch(/プレビューのターミナル[^\n]*(読まず|写さない)/);
    expect(para).toContain("--wait");
    expect(para).toMatch(/24時間/);
    for (const k of ["result", "apps", "answered", "implemented", "reasons"]) {
      expect(para, k).toContain(`\`${k}\``);
    }
  });

  it("8章の e2e のそろわないときの次の手は、組のプレビューをブランチ名で打つ", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const line = lines.find((l) => l.startsWith("- そろわないとき：")) ?? "";
    expect(line, "e2e のそろわないときの箇条がありません").not.toBe("");
    expect(line).toContain("親のタブで `workspace --preview 〈ブランチ名〉`");
    expect(line).toContain(
      "〈ブランチ名〉は E2E のタスクの手元のブランチ名で、決まらなければ `〈ブランチ名〉` の字のまま出す",
    );
    expect(line).not.toContain("workspace --preview 〈ID〉");
  });

  it("8章の workspace の段落に、--companion・組の起動の見分け・companion の --json・--draft の e2e がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const text = lines.join("\n");
    expect(text).toMatch(/- `new` に伴う相手を渡す：[^\n]*--companion/);
    expect(text).toMatch(/--companion-json/);
    expect(text).toMatch(/`--companion` は子には渡さない/);
    const list = lines.find((l) => l.includes("一覧の `--json`")) ?? "";
    expect(list).toContain("`companion`");
    expect(text).toMatch(
      /組の起動の見分け[^\n]*伴う記録[^\n]*apps[^\n]*(パスが同じ|同じパス)/,
    );
    const draft = lines.find((l) => l.startsWith("- 子ごとの欄：")) ?? "";
    expect(draft).toContain("`e2e`");
    const json = lines.find((l) =>
      /^- `--json`：data は `\{dir, repos:/.test(l),
    );
    expect(json).toContain("e2e");
  });

  it("8章の workspace の段落の箇条は、--cross-depends の箇条より後にある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const cross = lines.findIndex((l) =>
      l.startsWith("- `new` にまたぐ依存を渡す："),
    );
    const comp = lines.findIndex((l) =>
      l.startsWith("- `new` に伴う相手を渡す："),
    );
    expect(cross).toBeGreaterThanOrEqual(0);
    expect(comp).toBeGreaterThan(cross);
  });

  it("8章に、組は共通を含むブランチで、プレビューでは E2E の項目があるブランチも含むとある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    expect(s).toMatch(/E2E の項目があるブランチも[^\n]*(含む|組)/);
  });

  it("共通とアプリのひとまとまりの段落の「組」の1文に、E2E の項目があるブランチが含まれる", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const line =
      s
        .split("\n")
        .find((l) => l.startsWith("**共通とアプリのひとまとまり**")) ?? "";
    const sentence =
      line.split("。").find((x) => x.includes("でいう「組」はこれ")) ?? "";
    expect(sentence).not.toBe("");
    const after = line.slice(line.indexOf("でいう「組」はこれ"));
    expect(after).toMatch(
      /^[^。]*。ただしプレビューでは共通のないブランチ（アプリが2つ以上）と E2E の項目があるブランチも含む/,
    );
  });

  it("印のアプリがブランチにないときも項目を足し土台で埋める扱いと、印を引用符で囲まない旨が仕様にある", async () => {
    const s = await read("docs/spec.md");
    expect(s).not.toMatch(/印のアプリが全部そのブランチにあるとき/);
    expect(s).toMatch(
      /コマンドの印のアプリがそのブランチになくても、それを理由に項目を足すのをやめない[^\n]*土台のアプリ/,
    );
    expect(s).toMatch(/印は引用符で囲まずに書く/);
    const sk = await read("skills/workspace/SKILL.md");
    expect(sk).toMatch(/引用符で囲まずに書く/);
    const w = await read("skills/intake/workspace.md");
    expect(w).not.toMatch(/印のアプリが全部そのブランチにあるとき/);
    expect(w).toMatch(
      /印のアプリがブランチにないとき[^\n]*それを理由に項目を足すのをやめない[^\n]*土台のアプリ/,
    );
    expect(w).toContain(
      "`--companion` には、そのブランチにある `apps` のアプリだけを渡す",
    );
    expect(w).toMatch(
      /--cross-depends`・`--branches` を付けず、`--companion` だけ/,
    );
  });
});

describe("仕様書：E2E を組に伴わせる（10.1）", () => {
  it("10.1 の intake のワークスペースの道に、伴う項目の判定・足さない理由・出す順・--companion がある", async () => {
    const text = await read("docs/spec.md");
    const s = chapter(text, 10);
    const line = s.split("\n").find((l) => l.startsWith("- 伴う項目：")) ?? "";
    expect(line, "10.1 に「伴う項目：」の箇条がありません").not.toBe("");
    expect(line).toContain("`companion`");
    expect(line).toContain("〈リポジトリ〉は変えない");
    expect(line).toContain("出す順");
    expect(line).toContain("--companion");
    expect(line).toContain("workspace --preview");
  });

  it("10.1 の run に、e2e を流して 2 なら --wait で待ち、アプリの不具合は question で聞くとある", async () => {
    const s = chapter(await read("docs/spec.md"), 10);
    const line =
      s.split("\n").find((l) => l.startsWith("- run の E2E：")) ?? "";
    expect(line, "10.1 に「run の E2E：」の箇条がありません").not.toBe("");
    expect(line).toContain("e2e");
    expect(line).toContain("--wait");
    expect(line).toContain("question");
  });
});

describe("スキルと intake の文書：E2E を組に伴わせる", () => {
  it("intake の workspace.md に、判定・足さない理由の1行・出す順で後ろ・--companion・プレビューがある", async () => {
    const t = await read("skills/intake/workspace.md");
    const all = t.split("\n");
    const at = all.findIndex((l) => l.startsWith("- 伴う項目："));
    expect(at, "「伴う項目：」の箇条がありません").toBeGreaterThanOrEqual(0);
    const rest = all.slice(at + 1);
    const len = rest.findIndex((l) => !l.startsWith("  "));
    const line = all
      .slice(at, at + 1 + (len < 0 ? rest.length : len))
      .join("\n");
    expect(line).toContain("`companion`");
    expect(line).toContain("`when`");
    expect(line).toContain("〈リポジトリ〉は変えない：〈理由〉");
    expect(line).toMatch(/出す順[^\n]*(後|あと)/);
    expect(line).toContain("--companion");
    expect(line).toContain("workspace --preview 〈ブランチ名〉 --background");
    expect(line).not.toContain("workspace --preview 〈ID〉");
    expect(line).toContain("e2e 〈ID〉");
    expect(line).toMatch(/ID の揃え/);
  });

  it("page-format.md に、変えない理由の行の形がある", async () => {
    const t = await read("skills/intake/page-format.md");
    expect(t).toContain("〈リポジトリ〉は変えない：〈理由〉");
  });

  it("run/e2e.md に e2e・--wait・落ちたらテストを直す・question で聞く場合がある。SKILL.md から指される", async () => {
    const t = await read("skills/run/e2e.md");
    expect(t).toContain("orca-flow e2e");
    expect(t).toContain("--wait");
    expect(t).toMatch(/終了コード2|2なら/);
    expect(t).toMatch(/テストを直/);
    expect(t).toMatch(/question/);
    expect(t).toMatch(/報告/);
    const skill = await read("skills/run/SKILL.md");
    expect(skill).toContain("${CLAUDE_PLUGIN_ROOT}/skills/run/e2e.md");
  });

  it("run/e2e.md で人に頼む組のプレビューは、このタスクのブランチ名で打つ", async () => {
    const t = await read("skills/run/e2e.md");
    expect(t).not.toContain("workspace --preview 〈ID〉");
    expect(t).toContain("`workspace --preview 〈ブランチ名〉`");
    expect(t).toContain("〈ブランチ名〉はこのタスクのブランチ名");
    expect(t).toContain("`git branch --show-current`");
  });

  it("workspace のスキルが、--draft の e2e のある子に companion の案を出し、人と決める", async () => {
    const t = await read("skills/workspace/SKILL.md");
    expect(t).toContain("`e2e`");
    expect(t).toContain("`companion`");
    expect(t).toMatch(/`apps`[^\n]*`when`[^\n]*`command`/);
  });

  it("書いた文書とテストに、タスクの ID と手元のパスがない", async () => {
    for (const rel of [
      "skills/intake/workspace.md",
      "skills/intake/page-format.md",
      "skills/run/e2e.md",
      "skills/workspace/SKILL.md",
      "test/plugin/e2e-companion-spec.test.ts",
    ]) {
      const t = await read(rel);
      expect(idForm.test(t), `${rel} にタスクの ID があります`).toBe(false);
      expect(homePath.test(t), `${rel} に手元のパスがあります`).toBe(false);
    }
  });
});
