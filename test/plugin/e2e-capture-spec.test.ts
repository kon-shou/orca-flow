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

describe("仕様書：E2E の録画（6章）", () => {
  it("companion の行と段落に capture（command・output）の決まりがある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const bullet =
      s.split("\n").find((l) => l.startsWith("- 録画の設定")) ?? "";
    expect(bullet, "録画の設定の箇条がありません").not.toBe("");
    for (const w of ["`command`", "`output`", "絶対パス", "設定の誤り"]) {
      expect(bullet, w).toContain(w);
    }
  });

  it("前の画面の記録の段落に、置き場とキーがある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const paras = s
      .split("\n")
      .filter((l) => l.startsWith("**前の画面の記録**"));
    expect(paras).toHaveLength(1);
    const para = paras[0] ?? "";
    expect(para).toContain("orca-flow/preview-base/〈ID〉.json");
    for (const k of [
      "id",
      "worktree",
      "taskWorktree",
      "terminal",
      "commit",
      "url",
      "at",
    ]) {
      expect(para, k).toContain(`\`${k}\``);
    }
    expect(para).toContain("記録が壊れている");
  });

  it("録画の置き場の段落に、置き場・名前・git で追わないことがある", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const paras = s.split("\n").filter((l) => l.startsWith("**録画の置き場**"));
    expect(paras).toHaveLength(1);
    const para = paras[0] ?? "";
    expect(para).toContain("orca-flow/e2e-captures/〈ID〉/");
    expect(para).toContain("〈流れ〉-before.〈拡張子〉");
    expect(para).toContain("〈流れ〉-after.〈拡張子〉");
    expect(para).toContain("git では追わず");
  });
});

describe("仕様書：E2E の録画（8章）", () => {
  it("表の preview・e2e・workspace --preview の行に --base と録画の旗がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = (p: string) => lines.find((l) => l.startsWith(p)) ?? "";
    expect(row("| `preview ")).toContain("--base");
    expect(row("| `workspace --preview ")).toContain("--base");
    const e2e = row("| `e2e ");
    for (const w of ["--capture", "--capture-clear", "--base"]) {
      expect(e2e, w).toContain(w);
    }
  });

  it("e2e の段落に、--capture の前提・拾い方・結果・--capture-clear・--wait --base・--json のキーがある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    for (const w of [
      "- `--capture 〈流れ〉",
      "英小文字・数字・`-` の40文字まで",
      "ちょうど1つ",
      "10,000,000 バイト",
      "前後とも置かず終了コード1",
      "- `--capture-clear`",
      "- `--wait --base`",
      "`baseUrl`",
      "`baseAnswered`",
    ]) {
      expect(s, w).toContain(w);
    }
  });

  it("preview --base の段落に、作業ツリー・setup・固定の url で2・同じ URL で1・--stop がある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const lines = s.split("\n");
    const i = lines.findIndex((l) => l.startsWith("- `--base`："));
    expect(i, "preview の --base の箇条がありません").toBeGreaterThanOrEqual(0);
    const block = lines.slice(i, i + 7).join("\n");
    for (const w of [
      "merge-base",
      "切り離し",
      ".orca-flow/setup.sh",
      "固定",
      "終了コード2",
      "終了コード1",
      "`--stop`",
    ]) {
      expect(block, w).toContain(w);
    }
  });

  it("workspace の組の起動に --base の箇条があり、統合の仕上げが前の画面と置き場を片づける", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    expect(s).toContain(
      "- 前の画面の組の起動：`workspace --preview 〈ブランチ名〉 --base",
    );
    expect(s).toContain("preview 〈ID〉 --base --no-open --json");
    const pre =
      s.split("\n").find((l) => l.startsWith("  - 前提：伴う記録に")) ?? "";
    expect(pre).toContain(
      "親のタブで `workspace --preview 〈ブランチ名〉 --base`",
    );
    expect(pre).not.toContain("workspace --preview 〈ID〉");
    const fin = s.split("\n").find((l) => l.startsWith("- 統合の仕上げ")) ?? "";
    expect(fin).toContain("前の画面");
    expect(fin).toContain("e2e-captures/〈ID〉/");
    expect(fin).toContain("警告だけ");
  });
});

describe("仕様書：E2E の録画（10.1 と13章）", () => {
  it("10.1 に E2E の録画の段落がちょうど1つあり、画面の記録の段落と別にある", async () => {
    const text = await read("docs/spec.md");
    const lines = text.split("\n");
    const hits = lines.filter((l) => l.startsWith("**E2E の録画**"));
    expect(hits).toHaveLength(1);
    const para = hits[0] ?? "";
    for (const w of [
      "skills/run/e2e-capture.md",
      "`--capture-clear`",
      "`--capture`",
      "`--wait --base`",
      "`--base --stop`",
      "秘密",
      "1〜3本",
      "e2e-captures/〈ID〉/",
    ]) {
      expect(para, w).toContain(w);
    }
    const screen = lines.find((l) =>
      l.startsWith("**画面の記録とスナップショット**"),
    );
    expect(screen).toBeDefined();
    expect(screen).not.toContain("E2E の録画");
    expect(lines.indexOf(para)).toBeGreaterThan(lines.indexOf(screen ?? ""));
  });

  it("13章に、前の作業ツリーで別のポートで動くかの行が2列である", async () => {
    const s = chapter(await read("docs/spec.md"), 13);
    const rows = s
      .split("\n")
      .filter((l) => l.startsWith("| 前の作業ツリーで"));
    expect(rows).toHaveLength(1);
    const cells = (rows[0] ?? "")
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain("別のポート");
  });

  it("足した段落と行に、タスクの ID と手元のパスがない", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const mine = lines.filter(
      (l) =>
        l.includes("録画") ||
        l.includes("前の画面") ||
        l.includes("前の作業ツリー"),
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const l of mine) {
      expect(l).not.toMatch(idForm);
      expect(l).not.toMatch(homePath);
    }
  });
});

describe("スキル：E2E の録画", () => {
  it("e2e-capture.md に、録る時期・流れの選び方・各コマンド・秘密の流れを録らないことがある", async () => {
    const s = await read("skills/run/e2e-capture.md");
    for (const w of [
      "## 録る時期",
      "## 流れの選び方",
      "1〜3本",
      "--capture-clear",
      "--capture 〈流れ〉",
      "--wait --base",
      "--base --stop",
      "workspace --preview 〈ブランチ名〉 --base",
      "workspace --preview 〈ブランチ名〉 --base --stop",
      "〈ブランチ名〉はこのタスクのブランチ名",
      "`git branch --show-current`",
      "秘密の流れは録らない",
      "1行",
      "頭は英小文字か数字で",
      "capture がありません",
    ]) {
      expect(s, w).toContain(w);
    }
    expect(s).not.toContain("--json");
    expect(s).not.toContain("workspace --preview 〈ID〉");
    expect(s).not.toMatch(idForm);
    expect(s).not.toMatch(homePath);
  });

  it("8章に、前の画面の組の --stop と置き場の外の記録の扱いがある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const group =
      s.split("\n").find((l) => l.startsWith("- 前の画面の組の起動")) ?? "";
    for (const w of [
      "preview 〈ID〉 --base --stop --json",
      "飛ばした",
      "前の画面がありません",
    ]) {
      expect(group, w).toContain(w);
    }
    const rec = s.split("\n").find((l) => l.includes("置き場の形")) ?? "";
    for (const w of [
      "orca-flow/preview-base/〈リポジトリごとの16桁〉/〈ID〉",
      "止めるコマンドも作業ツリーの削除もせず",
      "警告",
      "記録とターミナルだけ",
      "統合の仕上げ",
      "`preview-base`",
    ]) {
      expect(rec, w).toContain(w);
    }
  });

  it("e2e.md が e2e-capture.md を読む1行を持つ", async () => {
    const s = await read("skills/run/e2e.md");
    expect(
      s.split("\n").filter((l) => l.includes("skills/run/e2e-capture.md")),
    ).toHaveLength(1);
  });

  it("workspace のスキルが capture の案と、Playwright・Cypress の形を出す", async () => {
    const s = await read("skills/workspace/SKILL.md");
    for (const w of [
      "`capture`",
      "`output`",
      "Playwright",
      "--config video=true",
    ]) {
      expect(s, w).toContain(w);
    }
  });
});
