import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");
const lines = (text: string) => text.split("\n");

const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

const FILES = [
  "skills/intake/workspace.md",
  "skills/run/SKILL.md",
  "skills/integrate/SKILL.md",
  "skills/merge/SKILL.md",
  "agents/task-reviewer.md",
];

describe("スキル：共通を枝で取り込んで先に始める", () => {
  it("intake のワークスペースの道に、枝で始めるかを聞く行と --allow-branch-push・--branches がある", async () => {
    const t = await read("skills/intake/workspace.md");
    const at = lines(t).findIndex((l) => l.startsWith("- 枝で始める："));
    expect(at, "「- 枝で始める：」の行がありません").toBeGreaterThanOrEqual(0);
    const block = lines(t).slice(at).join("\n");
    expect(block).toMatch(/`branchCommand` のキーがあるときだけ/);
    expect(block).toMatch(/版を待つか、共通のタスクの枝で先に始めるか/);
    expect(block).toContain("人に");
    expect(block).toContain("--allow-branch-push");
    expect(block).toMatch(/--branches 〈名前〉=〈枝〉/);
    expect(block).toMatch(/通った直後に/);
    expect(block).toMatch(/`--bumps` は、同じ名前には渡さない/);
    // 版を待つ道は残る
    expect(t).toMatch(/^- 版：/m);
    expect(t).toMatch(
      /`--bumps 〈名前〉=〈版〉,…` か `--branches 〈名前〉=〈枝〉,…`/,
    );
  });

  it("run に、取り込む・取り込み直す・戻すの手順と push 〈ID〉 --branch がある", async () => {
    const t = await read("skills/run/SKILL.md");
    const at = t.indexOf("## 共通の枝を取り込むとき");
    expect(at).toBeGreaterThanOrEqual(0);
    const sec = t.slice(at, t.indexOf("## ローカルレビュー", at));
    expect(sec).toContain("cross-depends/$0.json");
    expect(sec).toMatch(/- 取り込む[^\n]*`branchCommand`[^\n]*最初のコミット/);
    expect(sec).toMatch(/- 取り込み直す[^\n]*「取り込み直す」を含む警告/);
    expect(sec).toMatch(/- 戻す[^\n]*人間に共通の版を聞き[^\n]*`bumpCommand`/);
    expect(sec).toMatch(/取り込んだままです/);
    expect(sec).toMatch(/orca-flow push \$0 --branch/);
    expect(sec).toMatch(/`orca-flow verify` が通ったあと/);
    expect(sec).toMatch(/印がなければ終了コード2/);
    expect(sec).toMatch(/範囲の外に数えない/);
    expect(sec).toMatch(/最初の区切り[^\n]*1回 `orca-flow push \$0 --branch`/);
    expect(sec).toMatch(/PR の道に入ったら、`--branch` は終了コード2/);
    expect(sec).toMatch(/`branchCommand` が0以外で終わったら/);
    expect(sec).toMatch(/git checkout -- 〈ファイル〉/);
    expect(sec).toMatch(
      /status question` で「共通の枝がまだ push されていない」/,
    );
    expect(sec).toMatch(/「まだ push していません」「印がありません」/);
    expect(sec).toMatch(/古い取り込みの警告は出なくなる/);
    // 手順の番号1〜11は変えない
    const nums = lines(t.slice(0, at))
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("merge にだけ、枝を取り込んだままで止まったときの戻し方がある（integrate にはない）", async () => {
    const m = await read("skills/merge/SKILL.md");
    expect(m).toMatch(/で取り込んだままです/);
    expect(m).toMatch(/`bumpCommand` で正式な版に上げる/);
    expect(m).toMatch(/版[^\n]*人間/);
    const i = await read("skills/integrate/SKILL.md");
    expect(i).not.toMatch(/で取り込んだままです/);
    expect(i).not.toMatch(/正式な版に戻して/);
    expect(m).toMatch(/自分では書き換えず、`--drop-depend` で外さない/);
    // 既存のまたぐ依存の扱いは残る
    expect(m).toMatch(/またぐ依存で止まったとき/);
    // おまかせの決まりの8番にも同じ語があるので、手順の箇条と逃げ道の段落の頭で確かめる
    expect(i).toMatch(
      /^ *- 2 で、標準エラーに「またぐ依存」と「マージしていません」が入る（/m,
    );
    expect(i).toMatch(
      /^ *またぐ依存の止まりを飛ばす逃げ道として `orca-flow integrate \$0 --skip-cross-depends` がある/m,
    );
  });

  it("確認役の定義に、枝のあるタスクのパッケージの定義とロックファイルの範囲の例外がある", async () => {
    const t = await read("agents/task-reviewer.md");
    expect(t).toMatch(/`repos\[\]` に `branch` があるタスク/);
    expect(t).toMatch(
      /パッケージの定義とロックファイル[^\n]*範囲外として並べない/,
    );
    expect(t).toMatch(/記録がなければ今までどおり範囲外に数える/);
    expect(t).toMatch(/^ *- 範囲：/m);
  });

  it("スキルと定義に、手元のパスと ID の形がない", async () => {
    for (const f of FILES) {
      const t = await read(f);
      expect(t, f).not.toMatch(homePath);
      for (const l of lines(t)) {
        if (
          /branchCommand|--branches|--allow-branch-push|取り込んだまま/.test(l)
        )
          expect(l, f).not.toMatch(idForm);
      }
    }
  });
});
