import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

// タスクの番号の形は、自分のファイルに書かないよう実行時に組む。
const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

/** 見出し（行頭の `## 〈名前〉`）から次の `## ` の前までを返す。 */
function section(text: string, title: string): string {
  const s = text.indexOf(`\n## ${title}`);
  expect(s, `${title} の節`).toBeGreaterThanOrEqual(0);
  const e = text.indexOf("\n## ", s + 1);
  return text.slice(s, e < 0 ? undefined : e);
}

/** 先頭が `prefix` の箇条書きの行（字下げは無視）を返す。 */
function bullet(text: string, prefix: string): string {
  const l = text
    .split("\n")
    .map((x) => x.trimStart())
    .find((x) => x.startsWith(prefix));
  expect(l, `${prefix} の行`).toBeDefined();
  return l ?? "";
}

describe("intake のワークスペースの道：いつも読む印", () => {
  it("手順6の「読む」に印の子も読む文と、共通は全部いつも入れる文がある", async () => {
    const t = await read("skills/intake/workspace.md");
    const l = bullet(
      section(t, "手順6の差し替え：how と項目の書き方"),
      "- 読む：",
    );
    expect(l).toContain("alwaysRead");
    expect(l).toContain("共通は全部いつも入れる");
  });

  it("当たらずに読む子の問い・並べて流す文・読む数の一言がある", async () => {
    const t = section(
      await read("skills/intake/workspace.md"),
      "手順6の差し替え：how と項目の書き方",
    );
    expect(t).toContain("要件が当たる場所はあるか");
    expect(t).toContain("『当たらない』と理由");
    expect(t).toMatch(/並べて流す/);
    expect(t).toContain("1つのメッセージ");
    expect(t).toMatch(/要件の言葉で当たった数/);
    expect(t).toMatch(/印で足した数/);
    expect(t).toMatch(/答えを待たない/);
  });

  it("読んだが変えない・読めなかった行の形がある", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(t).toContain("〈リポジトリ〉は読んだが変えない：〈理由〉");
    expect(t).toContain("〈リポジトリ〉は読めなかった：〈理由〉");
    expect(t).toContain("項目を作らず");
  });

  it("版上げだけの項目の根拠の2つの書き方がある", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(t).toContain("how で読み、変える所はなかった");
    expect(t).toContain("how で読んでいない（要件の言葉にも印にも当たらない）");
  });

  it("版上げだけの項目の例外と、印の子の根拠の書き方がある", async () => {
    const t = section(
      await read("skills/intake/workspace.md"),
      "手順6の差し替え：how と項目の書き方",
    );
    expect(t).toContain("how で読めなかった（版上げだけ）");
    expect(bullet(t, "- 「当たらない」と出た子")).toMatch(
      /ただし、[^\n]*`users` に載るアプリは[^\n]*版上げだけの項目[^\n]*「読んだが変えない」の行には書かない/,
    );
    expect(bullet(t, "- how が落ちた・pstack がない子")).toMatch(
      /ただし、[^\n]*`users` に載るアプリは[^\n]*版上げだけの項目[^\n]*「読めなかった」の行には書かない/,
    );
  });

  it("companion の子は伴う項目の決まりで決め、読んだが変えない行に書かない", async () => {
    const t = await read("skills/intake/workspace.md");
    const l = bullet(
      section(t, "手順6の差し替え：how と項目の書き方"),
      "- E2E を伴わせる子",
    );
    expect(l).toContain("companion");
    expect(l).toContain("伴う項目");
    expect(l).toContain("読んだが変えない");
  });

  it("how の前後の比べは印で足した子を含む全部の子に効き、打ち直しは how を呼ばない", async () => {
    const t = await read("skills/intake/workspace.md");
    const l = bullet(
      section(t, "手順6の差し替え：how と項目の書き方"),
      "- how の前後で、",
    );
    expect(l).toContain("印で足した子を含む全部の子");
    expect(l).toMatch(/打ち直し[^\n]*how を呼ばない/);
  });

  it("分け方の行にはこのツールの名前を入れない", async () => {
    const f = await read("skills/intake/page-format.md");
    const w = section(f, "分け方");
    for (const l of w.split("\n")) {
      if (/読んだが変えない|読めなかった/.test(l)) {
        expect(l).not.toMatch(/orca-flow/i);
      }
    }
  });
});

describe("skills/intake/page-format.md の分け方", () => {
  it("2つの行の形があり、ワークスペースの道だけと書く", async () => {
    const w = section(await read("skills/intake/page-format.md"), "分け方");
    expect(w).toContain("〈リポジトリ〉は読んだが変えない：〈理由〉");
    expect(w).toContain("〈リポジトリ〉は読めなかった：〈理由〉");
    expect(w).toContain("ワークスペースの道だけ");
  });

  it("見出しの並びは変わらない", async () => {
    const t = await read("skills/intake/page-format.md");
    const heads = t.split("\n").filter((l) => l.startsWith("## "));
    expect(heads).toEqual([
      "## ページの置き方",
      "## 親のページの並び",
      "## タスクのページの並び",
      "## 見分けの印の行",
      "## 読み方の行",
      "## 何が変わるか",
      "## 分け方",
      "## ブランチ",
      "## 並びと図",
      "## 要点",
      "## 同時に作るタスクの間で使い合うもの",
      "## 決めてほしいこと",
      "## QA 項目",
      "## 細部（AI 向け）",
      "## 出典",
      "## 状態と ID",
      "## 依存の書き方と解き方",
      "## 親に1回だけ置くもの",
      "## 依頼のファイルに写すもの",
      "## 形の見分け",
      "## 統合の戻し",
      "## 質問のチェックの読み方",
      "## 作れないときの代わり",
    ]);
    expect(t).not.toMatch(/^#{2,} .*(読んだが変えない|読めなかった)/m);
  });
});

describe("skills/workspace/SKILL.md", () => {
  it("手順3に users のアプリへの印の案があり、手順4のキーに alwaysRead がある", async () => {
    const t = await read("skills/workspace/SKILL.md");
    const step = (n: number) =>
      t.split("\n").find((l) => l.startsWith(`${n}. `)) ?? "";
    const s3 = step(3);
    expect(s3).toContain("alwaysRead");
    expect(s3).toContain("users");
    expect(s3).toContain("e2e");
    expect(step(4)).toContain("alwaysRead");
  });
});

describe("docs/spec.md", () => {
  it("6章の表に repos[].alwaysRead の行と確かめの項がある", async () => {
    const t = await read("docs/spec.md");
    const row = t
      .split("\n")
      .find((l) => l.startsWith("| `repos[].alwaysRead`"));
    expect(row).toBeDefined();
    expect(row).toContain("任意");
    expect(row).toContain("intake");
    expect(t).toMatch(
      /- `alwaysRead` は任意[^\n]*真偽でない[^\n]*共通の `false`[^\n]*誤り/,
    );
    expect(t).toMatch(
      /1つのリポジトリの道[^\n]*alwaysRead|alwaysRead[^\n]*1つのリポジトリの道/,
    );
  });

  it("人と決めて作る欄に印を足してある", async () => {
    const t = await read("docs/spec.md");
    const l =
      t.split("\n").find((x) => x.startsWith("**ワークスペースの設定**")) ?? "";
    expect(l).toContain("alwaysRead");
  });

  it("8章の一覧の --json の行に alwaysRead（真の子だけ）がある", async () => {
    const t = await read("docs/spec.md");
    const l =
      t.split("\n").find((x) => x.startsWith("- 一覧の `--json`")) ?? "";
    expect(l).toContain("`alwaysRead`（");
    expect(l).toContain("`true` の子だけ");
  });

  it("10.1 の「- 読む：」の行に印の子・当たらずに読む問い・並べて流す・読んだが変えない行がある", async () => {
    const t = await read("docs/spec.md");
    const l = t
      .split("\n")
      .find(
        (x) => x.startsWith("- 読む：") && x.includes("共通は全部いつも入れる"),
      );
    expect(l).toBeDefined();
    expect(l).toContain("alwaysRead");
    expect(l).toContain("要件が当たる場所はあるか");
    expect(l).toContain("並べて流す");
    expect(l).toContain("読んだが変えない");
    expect(l).toContain("読めなかった");
    expect(l).toMatch(
      /ただし、[^\n]*`users` に載るアプリは[^\n]*版上げだけの項目/,
    );
  });
});

describe("足した文の決まり", () => {
  it("このテストにタスクの番号と手元のパスがない", async () => {
    const t = await read("test/plugin/intake-always-read.test.ts");
    expect(idForm.test(t)).toBe(false);
    expect(homePath.test(t)).toBe(false);
  });
});
