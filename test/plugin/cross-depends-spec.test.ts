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

describe("仕様書：またぐ依存の記録と門（6・7・8・10章）", () => {
  it("6章の依存の記録のすぐ後ろに、またぐ依存の記録の段落がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 6).split("\n");
    const at = lines.findIndex((l) => l.startsWith("**依存の記録**："));
    expect(at).toBeGreaterThanOrEqual(0);
    const next = lines.slice(at + 1).find((l) => l.trim() !== "");
    expect(next).toBeDefined();
    expect(next).toMatch(/^\*\*またぐ依存の記録\*\*：/);
  });

  it("またぐ依存の記録の段落に、置き場所・形・書く人・消す人・壊れたときの止まり方がある", async () => {
    const line =
      chapter(await read("docs/spec.md"), 6)
        .split("\n")
        .find((l) => l.startsWith("**またぐ依存の記録**：")) ?? "";
    expect(line).toContain("orca-flow/cross-depends/〈ID〉.json");
    for (const key of ["repos", "name", "path", "package", "version", "ids"])
      expect(line, `${key} がありません`).toContain(`\`${key}\``);
    expect(line).toContain("--cross-depends-json");
    expect(line).toContain("--drop-depend");
    expect(line).toMatch(/壊れ[^。]*依存なしとみなさず[^。]*終了コード1/);
    expect(line).toMatch(/子は親の設定を読まず/);
  });

  it("またぐ依存の記録に taskBranch があり、組の見分けでの比べと古い記録の読み方がある", async () => {
    const line =
      chapter(await read("docs/spec.md"), 6)
        .split("\n")
        .find((l) => l.startsWith("**またぐ依存の記録**：")) ?? "";
    for (const w of [
      "中身は `id`・`taskBranch`（このタスクのブランチ名）・`at`",
      "`taskBranch` は子の `new` が自分のタスクのブランチ名を書き、読む関数が返す",
      "`repos` の `branch` は取り込む共通の枝で、別のもの",
      "親が渡す `--cross-depends-json` には入れない",
      "`taskBranch` が組のブランチ名と違えば組の外、同じなら組にする",
      "`taskBranch` のない古い記録は今までどおり ID で見る",
    ])
      expect(line, w).toContain(w);
  });

  it("7章3番に、またぐ依存を子の integrate と merge の門で止めるとある", async () => {
    const line =
      chapter(await read("docs/spec.md"), 7)
        .split("\n")
        .find((l) =>
          l.startsWith("3. **依存のあるタスクは同時に走らせない**"),
        ) ?? "";
    expect(line).toMatch(/またぐ依存/);
    expect(line).toMatch(/integrate[^。]*merge[^。]*門/);
    expect(line).toMatch(/baseBranch に入/);
    expect(line).toMatch(/版上げ/);
    expect(line).toContain("終了コード2");
  });

  it("8章の new に --cross-depends-json の引数と、形が外れたら終了コード1の文がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = lines.find((l) => l.startsWith("| `new --title ")) ?? "";
    expect(row).toContain("--cross-depends-json");
    const text = lines.join("\n");
    expect(text).toMatch(
      /--cross-depends-json[^\n]*形[^\n]*外れ[^\n]*終了コード1/,
    );
    expect(text).toMatch(/--cross-depends-json[^\n]*古い[^\n]*消す/);
  });

  it("8章の workspace に、new の --cross-depends と --bumps の解き方と確かめがある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const para =
      lines.find((l) =>
        l.startsWith("**workspace（ワークスペースの設定と子への道）**"),
      ) ?? "";
    expect(para).not.toBe("");
    const at = lines.indexOf(para);
    const block = lines.slice(at, at + 12).join("\n");
    expect(block).toContain("--cross-depends 〈名前〉:〈ID〉");
    expect(block).toContain("--bumps 〈名前〉=〈版〉");
    expect(block).toContain("--cross-depends-json");
    expect(block).toMatch(/役割が共通/);
    expect(block).toContain("終了コード1");
    expect(block).toMatch(/子には渡さない/);
  });

  it("8章の integrate に --skip-cross-depends と、止まる文・マージしない旨がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = lines.find((l) => l.startsWith("| `integrate ")) ?? "";
    expect(row).toContain("--skip-cross-depends");
    const text = lines.join("\n");
    expect(text).toMatch(/--skip-cross-depends[^\n]*警告：/);
    expect(text).toMatch(/またぐ依存[^\n]*範囲の確認のあと/);
    expect(text).toMatch(/またぐ依存[^\n]*マージしていません/);
  });

  it("8章の merge に --drop-depend 〈名前〉:〈ID〉 と、確かめの「またぐ依存」の行がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = lines.find((l) => l.startsWith("| `merge ")) ?? "";
    expect(row).toContain("--drop-depend");
    expect(row).toContain("〈名前〉:〈ID〉");
    const check = lines.find((l) => l.startsWith("| またぐ依存"));
    expect(check, "確かめの表に「またぐ依存」の行がありません").toBeDefined();
    expect(check).toContain("--drop-depend 〈名前〉:〈ID〉");
    expect(check).toMatch(/\|\s*2\s*\|\s*$/);
    const text = lines.join("\n");
    expect(text).toMatch(/PR でマージされていません/);
    expect(text).toMatch(/版上げ[^\n]*タスクのブランチにありません/);
  });

  it("版上げの見分けに、パッケージ名の境目の決まりがある", async () => {
    const text = chapter(await read("docs/spec.md"), 8);
    const line =
      text.split("\n").find((l) => l.startsWith("**またぐ依存の門**")) ?? "";
    expect(line).toMatch(/パッケージ名の前後[^。]*英数字[^。]*当てない/);
    for (const ch of ["`-`", "`_`", "`.`", "`/`", "`@`"])
      expect(line).toContain(ch);
    expect(line).toContain("`@acme/core-kit`");
  });

  it("merge の確かめに、マージされるコミットで探すことと「OK（記録なし）」がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = lines.find((l) => l.startsWith("| またぐ依存")) ?? "";
    expect(row).toMatch(
      /マージされるコミット[^|]*--head[^|]*承認した先頭[^|]*push した先頭/,
    );
    expect(row).toContain("OK（記録なし）");
    expect(lines.join("\n")).toMatch(
      /- merge の確かめ[^\n]*マージされるコミット[^\n]*OK（記録なし）/,
    );
  });

  it("確認役の直し：3章に共通とアプリの言葉があり、13章は3章を指し、7章8番に余分な空白がない", async () => {
    const spec = await read("docs/spec.md");
    const three = chapter(spec, 3);
    expect(three).toMatch(/共通同士は依存しない/);
    expect(three).toMatch(/サーバーとクライアントを持つモノレポでもよい/);
    expect(chapter(spec, 13)).toContain(
      "3章の親・子・ワークスペースのフォルダの言葉",
    );
    expect(chapter(spec, 7)).not.toMatch(/。 要件のページ/);
  });

  it("10.1 に、またぐ依存の門のスキルの扱い（intake・integrate・merge）がある", async () => {
    const ten = chapter(await read("docs/spec.md"), 10).split("\n");
    const at = ten.findIndex((l) =>
      l.startsWith("**またぐ依存の門**（8章）のスキルの扱い"),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    const block = ten.slice(at, at + 5).join("\n");
    expect(block).toMatch(/- intake：[^\n]*--cross-depends[^\n]*--bumps/);
    expect(block).toMatch(/- integrate：[^\n]*--skip-cross-depends/);
    expect(block).toMatch(/- merge：[^\n]*--drop-depend 〈名前〉:〈ID〉/);
  });

  it("追加した文にタスクの番号の形と、ホームの下の絶対パスが出ない", async () => {
    const spec = await read("docs/spec.md");
    const lines = [6, 7, 8, 10].flatMap((n) => chapter(spec, n).split("\n"));
    expect(lines.filter((l) => idForm.test(l))).toEqual([]);
    expect(lines.filter((l) => homePath.test(l))).toEqual([]);
  });
});

describe("仕様書：またぐ依存は PR のマージだけを数える", () => {
  it("7章3番：merge は PR のマージを数え、integrate は記録があれば止め、共通があれば PR の道だけとある", async () => {
    const line =
      chapter(await read("docs/spec.md"), 7)
        .split("\n")
        .find((l) =>
          l.startsWith("3. **依存のあるタスクは同時に走らせない**"),
        ) ?? "";
    expect(line).toMatch(/PR でマージされ/);
    expect(line).toMatch(/件名の行は数えない/);
    expect(line).toMatch(/integrate[^。]*またぐ依存の記録[^。]*終了コード2/);
    expect(line).toMatch(/共通[^。]*PR の道[^。]*integrate は使わない/);
  });

  it("8章のまたぐ依存の段落：依存先の確かめは流さず、PR の道を案内し、件名の行を数えない", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const at = lines.findIndex((l) => l.startsWith("**またぐ依存の門**"));
    expect(at).toBeGreaterThanOrEqual(0);
    const block = lines.slice(at, at + 6).join("\n");
    expect(block).toMatch(/マージしていません/);
    expect(block).toContain("/orca-flow:push 〈ID〉");
    expect(block).toMatch(/--skip-cross-depends[^\n]*警告：/);
    expect(block).toMatch(/PR でマージされていません/);
    expect(block).toContain("integrate で入れたものは数えない");
    expect(block).toMatch(/push の記録[^。]*マージのコミット[^。]*祖先/);
  });

  it("8章の確かめの「またぐ依存」の行：依存先の PR のマージのコミットだけを数える", async () => {
    const row =
      chapter(await read("docs/spec.md"), 8)
        .split("\n")
        .find((l) => l.startsWith("| またぐ依存")) ?? "";
    expect(row).toMatch(/PR でマージ/);
    expect(row).toMatch(/push の記録[^|]*マージのコミット[^|]*祖先/);
    expect(row).toMatch(/件名の行[^|]*数えない/);
    expect(row).toContain("/orca-flow:push");
    expect(row).toContain("OK（記録なし）");
  });

  it("10.1 のスキルの扱い：integrate は PR の道へ、merge は「PR でマージされていません」", async () => {
    const ten = chapter(await read("docs/spec.md"), 10).split("\n");
    const at = ten.findIndex((l) =>
      l.startsWith("**またぐ依存の門**（8章）のスキルの扱い"),
    );
    const block = ten.slice(at, at + 5).join("\n");
    expect(block).toMatch(/- integrate：[^\n]*\/orca-flow:push/);
    expect(block).toMatch(/- merge：[^\n]*PR でマージされていません/);
  });

  it("12章：共通がある構成では、共通もアプリも PR の道で入れ、integrate は使わない", async () => {
    const twelve = chapter(await read("docs/spec.md"), 12);
    const line =
      twelve
        .split("\n")
        .find((l) => l.startsWith("**複数のリポジトリをまたぐ要件**")) ?? "";
    expect(line).toMatch(/共通もアプリも PR の道/);
    expect(line).toMatch(/integrate は使わない/);
  });

  it("integrate のスキル：記録があれば PR の道（/orca-flow:push）へ案内し、人の頼みなしに --skip-cross-depends を使わない", async () => {
    const lines = (await read("skills/integrate/SKILL.md")).split("\n");
    const at = lines.findIndex(
      (l) => l.includes("またぐ依存") && l.includes("マージしていません"),
    );
    const block = lines.slice(at, at + 8).join("\n");
    expect(block).toContain("/orca-flow:push");
    expect(block).toMatch(/PR の道/);
    expect(block).toMatch(/orca-flow tell[^\n]*送らない/);
  });

  it("merge のスキル：「PR でマージされていません」の扱い（integrate で入れたもの・push の案内）がある", async () => {
    const text = await read("skills/merge/SKILL.md");
    const line =
      text.split("\n").find((l) => l.includes("PR でマージされていません")) ??
      "";
    expect(line).not.toBe("");
    expect(line).toContain("integrate で入れたものは数えない");
    expect(line).toContain("/orca-flow:push");
    expect(line).toContain("自分では外さない");
  });

  it("merge のスキル：外れは1つの箇条で、(i) は PR の道に戻せず人が確かめて --drop-depend、(ii)(iii) の次の手がある", async () => {
    const lines = (await read("skills/merge/SKILL.md")).split("\n");
    const hits = lines.filter((l) => l.includes("PR でマージされていません"));
    expect(hits).toHaveLength(1);
    const line = hits[0];
    expect(line).toContain("PR の道には戻せない");
    expect(line).toMatch(
      /GitHub に入ったと確かめた[^。]*--drop-depend 〈名前〉:〈ID〉/,
    );
    expect(line).toMatch(
      /GitHub でマージ済みなら[^。]*\/orca-flow:push 〈ID〉/,
    );
    expect(line).toContain("origin に合わせる");
    expect(line).toContain("記録が壊れています");
    expect(lines.join("\n")).not.toContain("依存先を先に入れるか");
  });

  it("8章の外れの文の段落：(i)〜(v) の場合ごとの添え方がある", async () => {
    const line =
      chapter(await read("docs/spec.md"), 8)
        .split("\n")
        .find((l) => l.startsWith("- merge でまたぐ依存が外れたときの文")) ??
      "";
    expect(line).toContain("PR の道には戻せない");
    expect(line).toMatch(/\(i\)[^(]*--drop-depend/);
    expect(line).toMatch(/\(ii\)[^(]*\/orca-flow:push 〈ID〉/);
    expect(line).toMatch(/\(iii\)[^(]*origin に合わせる/);
    expect(line).toMatch(/\(iv\)[^(]*PR にして/);
    expect(line).toMatch(/\(v\)/);
  });

  it("8章の枝の確かめの行：merge の確かめで、integrate は記録があれば確かめずに止まる", async () => {
    const line =
      chapter(await read("docs/spec.md"), 8)
        .split("\n")
        .find((l) => l.includes("正式な版の正しさは verify に任せる")) ?? "";
    expect(line).toContain(
      "integrate はまたぐ依存の記録があれば確かめを流さず止まる",
    );
    expect(line).toContain("PR でマージされたかの確かめは同じ");
    expect(line).not.toContain("今のまま");
  });
});

describe("スキル：またぐ依存", () => {
  it("intake のワークスペースの道に --cross-depends と --bumps を渡す行がある", async () => {
    const lines = (await read("skills/intake/workspace.md")).split("\n");
    const hit = lines.find(
      (l) =>
        l.startsWith("- ") &&
        l.includes("--cross-depends 〈名前〉:〈ID〉,…") &&
        l.includes("--bumps 〈名前〉=〈版〉,…"),
    );
    expect(hit, "渡す行がありません").toBeDefined();
    expect(hit).toContain("workspace 〈名前〉 new");
  });

  it("intake の道は、またぐ依存を --depends に渡さない決まりを保つ", async () => {
    const text = await read("skills/intake/workspace.md");
    expect(text).toContain("`--depends` に渡さず");
  });

  it("integrate のスキルに、門で止まったときの扱いと、--skip-cross-depends は人間が頼んだときだけとある", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const lines = text.split("\n");
    const stop = lines.find(
      (l) => l.includes("またぐ依存") && l.includes("マージしていません"),
    );
    expect(stop, "止まったときの扱いがありません").toBeDefined();
    expect(stop).toMatch(/^ {3}- 2 で/);
    const skip = lines.find((l) =>
      l.includes("orca-flow integrate $0 --skip-cross-depends"),
    );
    expect(skip).toBeDefined();
    expect(skip).toContain("人間が頼んだときだけ");
  });

  it("integrate のスキルに、またぐ依存の止まりの次の手（記録を外す案内・壊れた記録）がある", async () => {
    const lines = (await read("skills/integrate/SKILL.md")).split("\n");
    const at = lines.findIndex(
      (l) => l.includes("またぐ依存") && l.includes("マージしていません"),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    const stop = lines
      .slice(at, at + 6)
      .filter((l, i) => i === 0 || l.startsWith("     - "))
      .join("\n");
    expect(stop).toContain("--drop-depend 〈名前〉:〈ID〉");
    expect(stop).toMatch(/記録は自分で直さない/);
    expect(stop).toContain("記録が壊れています");
  });

  it("merge のスキルに、門で止まったときの扱いと --drop-depend 〈名前〉:〈ID〉 がある", async () => {
    const text = await read("skills/merge/SKILL.md");
    const lines = text.split("\n");
    const stop = lines.find((l) => l.includes("またぐ依存で止まったとき"));
    expect(stop).toBeDefined();
    expect(stop).toContain("--drop-depend 〈名前〉:〈ID〉");
    expect(stop).toMatch(/自分では外さない/);
    expect(text).toMatch(/--drop-depend` は人間が選んだときだけ/);
  });

  it("三つのスキルにタスクの番号の形と、ホームの下の絶対パスが出ない", async () => {
    for (const f of [
      "skills/intake/workspace.md",
      "skills/integrate/SKILL.md",
      "skills/merge/SKILL.md",
    ]) {
      const lines = (await read(f)).split("\n");
      expect(
        lines.filter((l) => idForm.test(l)),
        f,
      ).toEqual([]);
      expect(
        lines.filter((l) => homePath.test(l)),
        f,
      ).toEqual([]);
    }
  });
});
