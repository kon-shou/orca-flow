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
  it("intake のワークスペースの道に、ひとまとまりで始める節があり、--id・--allow-branch-push・--branches・揃えの確かめがある", async () => {
    const t = await read("skills/intake/workspace.md");
    const at = lines(t).findIndex((l) =>
      l.startsWith("- ひとまとまりで始める："),
    );
    expect(
      at,
      "「- ひとまとまりで始める：」の行がありません",
    ).toBeGreaterThanOrEqual(0);
    const next = lines(t).findIndex(
      (l, i) => i > at && l.startsWith("- またぐ依存の渡し方："),
    );
    expect(next).toBeGreaterThan(at);
    const blockLines = lines(t).slice(at, next);
    const block = blockLines.join("\n");
    // 共通を始めたあとにアプリを始める順
    const pushAt = blockLines.findIndex((l) =>
      l.includes("--allow-branch-push"),
    );
    const branchesAt = blockLines.findIndex((l) =>
      l.includes("--branches 〈共通〉=〈そのブランチ名〉"),
    );
    expect(pushAt).toBeGreaterThanOrEqual(0);
    expect(branchesAt).toBeGreaterThanOrEqual(0);
    expect(pushAt).toBeLessThan(branchesAt);
    // ID は組ごとに始める直前に流し直して決める
    expect(block).toMatch(
      /最初の `new` の直前に `orca-flow workspace --json` を流し直し/,
    );
    expect(block).toMatch(/数の部分で比べ/);
    expect(block).toMatch(/「すでにあります」で止まったら[^\n]*そこで止まり/);
    expect(block).toMatch(
      /active --json` の出力の、その ID の行の `branch` から読み/,
    );
    expect(block).toContain("--id 〈ID〉");
    expect(block).toContain("--allow-branch-push");
    expect(block).toMatch(/--branches 〈共通〉=〈そのブランチ名〉/);
    expect(block).toMatch(/--cross-depends 〈共通〉:〈ID〉/);
    expect(block).toContain("workspace 〈名前〉 config --json");
    expect(block).toMatch(/idPrefix と branchPrefix が組の全部の子で同じか/);
    expect(block).toMatch(/`nextId` の最大/);
    expect(block).toMatch(/null/);
    expect(block).toMatch(/〈branchPrefix〉〈ID〉-〈slug〉/);
    expect(block).toMatch(/`branchCommand` のキーがなければ、始めずに/);
    expect(block).toMatch(/`--bumps` は渡さない/);
    expect(block).toMatch(/入ったものとして数える/);
    expect(block).toMatch(/ID のある子の ID をそのまま残りに使う/);
    expect(block).toMatch(/アプリのマージの直前に正式な版に戻す/);
  });

  it("intake のワークスペースの道に、版を待つかを人に聞く文と、--bumps を渡す文がない", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(t).not.toMatch(/版を待つか/);
    expect(t).not.toContain("枝で先に始める");
    expect(t).not.toContain("- 枝で始める：");
    for (const l of lines(t)) {
      if (l.includes("--bumps")) expect(l).toContain("渡さない");
    }
    // 版の行は残るが、聞かないと書く
    expect(t).toMatch(
      /^- 版：共通の版を先に出してアプリが待つ道は使わず、人にも聞かない/m,
    );
  });

  it("splitting.md の基準に8番があり、組ごとに分けることと、共通だけを先に分けないことがあり、1〜7番は変わらない", async () => {
    const t = await read("skills/intake/splitting.md");
    const ls = lines(t);
    const nums = ls
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const eight = ls.find((l) => l.startsWith("8. ")) ?? "";
    expect(eight).toMatch(/組/);
    expect(eight).toMatch(/組ごとに分け/);
    expect(eight).toMatch(/共通だけの項目を先に分けて出さない/);
    // 1〜7番の頭の文は今のまま
    expect(t).toContain("1. 既定は1つ。次の2〜6に当たるときだけ分け");
    expect(t).toContain(
      "2. 種類：振る舞いを変えない整理（リファクタ）は、先の別の項目にする。",
    );
    expect(t).toContain(
      "6. 互換を壊す変更は、「新しいものを足す→呼び手を移す→古いものを消す」の3つに分ける。",
    );
    expect(t).toContain("7. 依存：分け目をモジュールの公開の境界に置き");
    expect(t).toMatch(/組む相手（同じ組の項目/);
    expect(t).toMatch(/組の中では1つのリポジトリの項目は1つにする/);
    const w = await read("skills/intake/workspace.md");
    expect(w).toMatch(
      /組の中では、1つのリポジトリの項目は1つにする。同じリポジトリの項目が2つ以上入るなら、1項目にまとめるか/,
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
