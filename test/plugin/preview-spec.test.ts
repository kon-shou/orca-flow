import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function specLines(): Promise<string[]> {
  return (await readFile(path.join(ROOT, "docs/spec.md"), "utf8")).split("\n");
}

/** 「## 」の見出しで始まる章の本文（次の「## 」の前まで）。 */
function chapter(lines: string[], prefix: string): string[] {
  const start = lines.findIndex((l) => l.startsWith(prefix));
  expect(start, `${prefix} が見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return end < 0 ? rest : rest.slice(0, end);
}

function cells(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

describe("spec.md：preview", () => {
  it("6章の設定の表に preview の行があり、既定は null で、説明の段落がある", async () => {
    const ch = chapter(await specLines(), "## 6. ");
    const rows = ch.filter((l) => /^\| preview /.test(l));
    expect(rows).toHaveLength(1);
    const c = cells(rows[0] ?? "");
    expect(c).toHaveLength(3);
    expect(c[1]).toBe("`null`");
    for (const key of ["up", "down", "url", "timeoutSeconds"]) {
      expect(c[2]).toContain(`"${key}"`);
    }
    const para = ch.find((l) => l.startsWith("**preview**："));
    expect(para).toBeDefined();
    expect(para).toContain("300");
    const record = ch.find((l) => l.startsWith("**preview の記録**："));
    expect(record).toContain("orca-flow/preview/〈ID〉.json");
  });

  it("8章の表に preview の行があり、説明の節に起動のスクリプトに求めることがある", async () => {
    const ch = chapter(await specLines(), "## 8. ");
    const rows = ch.filter((l) => l.startsWith("| `preview "));
    expect(rows).toHaveLength(1);
    expect(cells(rows[0] ?? "")).toHaveLength(3);
    expect(rows[0]).toContain("--stop");
    const text = ch.join("\n");
    const from = text.indexOf("**preview（");
    const to = text.indexOf("**outbox と send**");
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const sec = text.slice(from, to);
    expect(sec).toContain("**起動のスクリプトに求めること**");
    expect(sec).toContain("ORCA_FLOW_URL=");
    expect(sec).toContain("ブランチ名");
    expect(sec).toContain("ロックファイル");
    expect(sec).toContain("worktree の中で流れる");
    expect(sec).toContain("Laravel");
    expect(sec).toContain("Vite");
    expect(sec).toContain("docker compose");
    expect(sec).toContain(
      'COMPOSE_PROJECT_NAME="app-$slug" docker compose down',
    );
    expect(sec).toContain("終了コード2");
    expect(sec).toContain("終了コード1");
    expect(sec).toContain("標準出力・標準エラー");
  });

  it("8章の preview の行に --restart・--after-setup・--no-open があり、節に組の起動・setup の終わりの待ち・立て直しがある", async () => {
    const ch = chapter(await specLines(), "## 8. ");
    const row = ch.find((l) => l.startsWith("| `preview ")) ?? "";
    for (const f of ["--restart", "--after-setup", "--no-open"]) {
      expect(row, f).toContain(f);
    }
    const text = ch.join("\n");
    const sec = text.slice(
      text.indexOf("**preview（"),
      text.indexOf("**outbox と send**"),
    );
    expect(sec).toMatch(
      /- 組の起動：[^\n]*`workspace --preview 〈ブランチ名〉`/,
    );
    expect(sec).toMatch(
      /- setup の終わりの待ち：[^\n]*`status`[^\n]*30分[^\n]*終了コード1/,
    );
    expect(sec).toMatch(/- 立て直し：[^\n]*`--restart`[^\n]*タブは開かない/);
    expect(sec).toMatch(/設定が `null` か記録がなければ[^\n]*終了コード0/);
    expect(sec).toContain("`--no-open`");
  });

  it("12章に使い方の項がある", async () => {
    const ch = chapter(await specLines(), "## 12. ");
    const item = ch.find((l) => /^\d+\. \*\*アプリの動きを見る\*\*/.test(l));
    expect(item).toBeDefined();
    expect(item).toContain("orca-flow preview 〈ID〉");
    expect(item).toContain("--stop");
  });

  it("13章に組のタブの確かめていない行が1つ（2列）あり、代わりを書いている", async () => {
    const ch = chapter(await specLines(), "## 13. ");
    const rows = ch.filter((l) => l.startsWith("|")).map(cells);
    const hit = rows.filter((r) =>
      r[0]?.startsWith(
        "git でないワークスペースのフォルダの worktree に Orca のタブを開けるか",
      ),
    );
    expect(hit).toHaveLength(1);
    expect(hit[0]).toHaveLength(2);
    expect(hit[0]?.[1]).toContain("確かめていない");
    expect(hit[0]?.[1]).toContain("各アプリの worktree に開く");
  });

  it("13章に確かめていない行が2つ（2列）あり、どちらも代わりを書いている", async () => {
    const ch = chapter(await specLines(), "## 13. ");
    const rows = ch.filter((l) => l.startsWith("|")).map(cells);
    for (const head of [
      "起動を送ったターミナルの出力を、`orca terminal read`",
      "導入先の起動のスクリプトが、Orca の worktree の置き場所で動くか",
    ]) {
      const hit = rows.filter((r) => r[0]?.startsWith(head));
      expect(hit, head).toHaveLength(1);
      expect(hit[0]).toHaveLength(2);
      expect(hit[0]?.[1]).toContain("確かめていない");
      expect(hit[0]?.[1]).toMatch(/読めなければ|動かなければ/);
    }
  });

  it("追加した文に手元のパスがない", async () => {
    const text = (await specLines()).join("\n");
    const from = text.indexOf("**preview（");
    const to = text.indexOf("**outbox と send**");
    const sec = text.slice(from, to);
    expect(sec).not.toContain("/home/");
    expect(sec).not.toMatch(/\/Users\//);
  });

  it("立て直しは記録があれば行い、背景の子とログの場所を書く", async () => {
    const text = (await specLines()).join("\n");
    expect(text).toContain("--restart-now");
    expect(text).toContain("orca-flow/preview-restart/〈ID〉.log");
    expect(text).toContain("起動の記録があれば立て直");
    expect(text).not.toContain("動いていれば立て直");
  });
});
