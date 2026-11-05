import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 13章の本文（見出しの次の行から、次の「## 」の前まで）を返す。 */
async function chapter13(): Promise<string> {
  const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## 13. "));
  expect(start, "13章の見出しが見つかりません").toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 表の行を [1列目, 2列目] に分ける。見出しと区切りの行は除く。 */
function tableRows(body: string): string[][] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .slice(2)
    .map((l) =>
      l
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
}

// 実物で確かめた行の、1列目の頭と、その行の「代わりの文」の頭。
const VERIFIED: [head: string, alt: string][] = [
  ["Orca の差分の行コメントがタスク長に届くか", "届かなければ"],
  ["背景の `orca-flow auto wait` が終わったとき", "起きなければ"],
  [
    '`--prompt "/orca-flow:spec ..."` でプラグインのスキルが動くか',
    "動かなければ",
  ],
  [
    "`orca worktree create --name` で付くブランチ名",
    "new が `git branch -m` で直す",
  ],
  ["setup の終了前にエージェントが起動しないか", "起動してしまうなら"],
  ["プラグインの担当の `effort: medium` が効くか", "効かなければ"],
  ["プラグインの担当の `model: opus` が効くか", "効かなければ"],
  [
    "プラグインを直したら、開いているタスクのタブで /reload-plugins",
    "要るなら、run の手順6",
  ],
  [
    "SessionStart のフックが Orca から起動したセッションでも動くか",
    "動かなければ",
  ],
  ["表示名（`--display-name`）を", "崩れたら"],
  ["overlap が自動でマージの順に足したとき", "つけられなければ"],
  ["`orca worktree set --pr` がカードにどう出るか", "出なければ"],
  ["`orca terminal close --terminal", "閉じられなければ"],
  ["閉じたタスク長の会話に、人が戻ってきたいとき", "困るなら"],
  ['`orca agent launch` の `--prompt "/orca-flow:respond', "動かなければ"],
  ["`orca terminal close` で閉じたあと、`orca agent launch`", "立たなければ"],
  ["PR の更新の時刻が、CI の終わりで変わるか", "変わるなら"],
  ["precheck が0以外で終わったとき", "作られてしまうなら"],
  ["2票目の `claude -p`", "動かないなら"],
  ["`gh pr merge` の先頭の照らし（`--match-head-commit`）", "止まらないなら"],
  ["マージの方式（merge・squash・rebase）を", "選べないなら"],
  ["保留中（pending）のレビューの GraphQL", "動かなければ"],
  ["Orca がコードのないフォルダをタブで開けるか", "親の置き場所を決め直す"],
  ["3つの bot（", "読めなければ"],
  [
    "本文なしで作った保留中のレビューを、`submitPullRequestReview` に本文（`body`）を渡して本投稿",
    "載らなければ",
  ],
];

describe("13章：まだ確かめていないこと", () => {
  it("intake の新しいタブの確かめていない行が2列で2つある（代わりはどちらも --here）", async () => {
    const rows = tableRows(await chapter13());
    for (const head of [
      "ワークスペースのフォルダで `agent launch` が会話を立てるか",
      "本体のタブで Notion の MCP が使えるか",
    ]) {
      const hit = rows.filter((r) => r[0]?.startsWith(head));
      expect(hit, head).toHaveLength(1);
      expect(hit[0]).toHaveLength(2);
      expect(hit[0]?.[1]).toContain("--here");
    }
  });

  it("表のすべての行が2列である", async () => {
    const rows = tableRows(await chapter13());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r, `2列でない行：${r[0]?.slice(0, 30)}`).toHaveLength(2);
    }
  });

  it("確かめた行は13章にちょうど1つあり、結果・日付と版・代わりの文がこの順にある", async () => {
    const rows = tableRows(await chapter13());
    expect(VERIFIED).toHaveLength(25);
    for (const [head, alt] of VERIFIED) {
      const hit = rows.filter((r) => r[0]?.startsWith(head));
      expect(hit, `13章の行の数：${head}`).toHaveLength(1);
      const right = hit[0]?.[1] ?? "";
      expect(right, `結果の語と「：」で始まらない：${head}`).toMatch(
        /^[^（。|]+：/,
      );
      const date = right.search(/\d{4}-\d{2}-\d{2}/);
      expect(date, `日付がない：${head}`).toBeGreaterThanOrEqual(0);
      expect(right, `版の数がない：${head}`).toMatch(/\d+\.\d+\.\d+/);
      const altAt = right.indexOf(alt);
      expect(altAt, `代わりの文が残っていない：${head}`).toBeGreaterThanOrEqual(
        0,
      );
      expect(date, `日付が代わりの文より後ろにある：${head}`).toBeLessThan(
        altAt,
      );
    }
  });

  it("手元のパスと github.com/ の URL がない", async () => {
    const body = await chapter13();
    expect(body).not.toContain("/home/");
    expect(body).not.toMatch(/\/Users\//);
    expect(body).not.toContain("github.com/");
  });
});

describe("13章：WSL の形の確かめていない行", () => {
  it("Windows の Orca が WSL の形を流して回が成功するかの行が2列で1つある", async () => {
    const rows = tableRows(await chapter13());
    const hit = rows.filter((r) => r[0]?.includes("wsl.exe"));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toHaveLength(2);
    expect(hit[0]?.[0]).toContain("Windows の Orca");
    expect(hit[0]?.[1]).toContain("pr-watch install");
  });
});
