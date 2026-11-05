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

describe("仕様書：共通を枝で取り込んで先に始める（6・7・8・10章）", () => {
  it("6章の設定の表に repos[].branchCommand があり、{branch} と任意・共通だけが書かれている", async () => {
    const s = chapter(await read("docs/spec.md"), 6);
    const row = s
      .split("\n")
      .find((l) => l.includes("| `repos[].branchCommand`"));
    expect(row, "表の行がありません").toBeDefined();
    expect(row).toContain("`{branch}`");
    expect(row).toMatch(/共通だけ/);
    expect(row).toMatch(/任意/);
    expect(s).toMatch(
      /`branchCommand` は任意[^\n]*`\{branch\}` がない[^\n]*空の文字列[^\n]*アプリの欄にある[^\n]*設定の誤り/,
    );
    // 既存の文（共通の3つの欄）は残る
    expect(s).toMatch(
      /`scope`・`package`・`bumpCommand` が全部要る[^\n]*アプリの欄にこの3つがあれば設定の誤り/,
    );
  });

  it("6章のまたぐ依存の記録に branch の3つのキーと version を要らなくする文がある", async () => {
    const line =
      chapter(await read("docs/spec.md"), 6)
        .split("\n")
        .find((l) => l.startsWith("**またぐ依存の記録**：")) ?? "";
    for (const key of ["branch", "branchCommand", "bumpCommand"])
      expect(line, key).toContain(`\`${key}\``);
    expect(line).toMatch(/`branch` があれば `version` は要らず/);
    expect(line).toMatch(/baseBranch と同じ形の確かめ/);
    expect(line).toContain("--branches");
    expect(line).toMatch(/同じ名前に両方を書くと誤り/);
  });

  it("6章に共通の枝の印の段落がある（置き場所・中身・消さない・消す場合・読む人）", async () => {
    const line =
      chapter(await read("docs/spec.md"), 6)
        .split("\n")
        .find((l) => l.startsWith("**共通の枝の印**：")) ?? "";
    expect(line).toContain("orca-flow/branch-push/〈ID〉.json");
    expect(line).toContain("--allow-branch-push");
    expect(line).toMatch(/push した先頭と時刻/);
    expect(line).toMatch(/作業ツリーの外/);
    expect(line).toMatch(/統合のあとも消さない/);
    expect(line).toMatch(/なしの `new` は、同じ ID の古い印を消す/);
    expect(line).toContain("push 〈ID〉 --branch");
    expect(line).toContain("verify");
  });

  it("7章3番に、枝で先に始める例外があり、既存のまたぐ依存の門の文も残る", async () => {
    const line =
      chapter(await read("docs/spec.md"), 7)
        .split("\n")
        .find((l) =>
          l.startsWith("3. **依存のあるタスクは同時に走らせない**"),
        ) ?? "";
    expect(line).toContain("枝で先に始める例外");
    expect(line).toMatch(/`branchCommand`[^。]*あれば[^。]*版を待たず/);
    expect(line).toMatch(/main には入れない/);
    expect(line).toMatch(/正式な版に戻す/);
    expect(line).toMatch(/枝の名前が残っていないこと/);
    expect(line).toMatch(/版を待つ道は残る/);
    expect(line).toMatch(/またぐ依存[^。]*門で止める/);
    expect(line).toContain("終了コード2");
  });

  it("7章7番に承認なしの push の3つ目の例外があり、既存の2つと、マージは案にしない文が残る", async () => {
    const s = chapter(await read("docs/spec.md"), 7);
    const at = s.indexOf("7. **GitHub への書き込み");
    expect(at).toBeGreaterThanOrEqual(0);
    const para = s.slice(at, s.indexOf("\n8. ", at));
    expect(para).toMatch(/マージは送りの案にせず/);
    expect(para).toContain("保留中（pending）のレビューへの書き込み");
    expect(para).toMatch(/1つ目：push の承認に含めた `pr-ready`/);
    expect(para).toMatch(/例外は3つ/);
    expect(para).toMatch(/3つ目：共通のタスクの枝の push/);
    expect(para).toMatch(/印（6章[^）]*）があるときだけ[^。]*承認なしで流す/);
    expect(para).toContain(
      "`〈branchPrefix〉〈ID〉-` で始まる自分のタスクの枝だけ",
    );
    expect(para).toMatch(
      /PR の作成・下書きを外す・返信・main・ほかの枝へは広げない/,
    );
    expect(para).toMatch(/印がなければ終了コード2/);
    expect(para).toMatch(/秘密は、送る前/);
  });

  it("7章1番に、枝のあるタスクはパッケージの定義とロックファイルの差分を範囲の外に数えないとある", async () => {
    const s = chapter(await read("docs/spec.md"), 7);
    expect(s).toMatch(/記録に `branch` のあるタスク/);
    expect(s).toMatch(
      /この種類の差分を統合と push の範囲の確かめで範囲の外に数えない/,
    );
  });

  it("8章の new に --allow-branch-push の引数と印の書き消しがある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row = lines.find((l) => l.startsWith("| `new --title ")) ?? "";
    expect(row).toContain("`--allow-branch-push`");
    expect(row).toMatch(/--allow-branch-push[^|]*印[^|]*書き[^|]*古い印を消す/);
  });

  it("8章に push 〈ID〉 --branch の行があり、印がなければ終了コード2・PR を作らないとある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const row =
      lines.find((l) => l.startsWith("| `push 〈ID〉 --branch`")) ?? "";
    expect(row).toMatch(/印がなければ終了コード2/);
    expect(row).toMatch(/git push を流さない/);
    expect(row).toMatch(/PR を作らず承認なしで push/);
    // 既存の push の行は残る
    expect(lines.some((l) => l.startsWith("| `push 〈ID〉 [--body-file"))).toBe(
      true,
    );
  });

  it("8章の verify の行に、取り込み直すの警告があり、終了コードは変えない", async () => {
    const row =
      chapter(await read("docs/spec.md"), 8)
        .split("\n")
        .find((l) => l.startsWith("| `verify`")) ?? "";
    expect(row).toMatch(/取り込み直す/);
    expect(row).toMatch(/頭12文字/);
    expect(row).toMatch(/終了コードと記録は変えない/);
  });

  it("8章の workspace の段落に、--branches の渡し方と、外れたら子を流さず終了コード1がある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const at = s.indexOf("**workspace（");
    const para = s.slice(at, s.indexOf("**共通の枝で先に始める**", at));
    expect(para).toMatch(/--branches 〈名前〉=〈枝〉/);
    expect(para).toMatch(/`--bumps` か `--branches` のどちらか1つだけ/);
    expect(para).toMatch(
      /子の CLI を流さず終了コード1：`branchCommand` のない共通への `--branches`[^。]*両方[^。]*枝の形/,
    );
    expect(para).toMatch(/`branchCommand`（共通だけ。なければキーを出さない）/);
  });

  it("8章の『共通の枝で先に始める』に、門・範囲・push・警告・枝の確かめがある", async () => {
    const s = chapter(await read("docs/spec.md"), 8);
    const at = s.indexOf("**共通の枝で先に始める**");
    expect(at).toBeGreaterThanOrEqual(0);
    const para = s.slice(at, s.indexOf("**integrate と push の勧め**", at));
    expect(para).toMatch(/「〈名前〉 を枝 〈枝〉 で取り込んだままです」/);
    expect(para).toMatch(/`bumpCommand` で正式な版に上げる/);
    expect(para).toMatch(/版の行がなくても通る/);
    expect(para).toMatch(/範囲の外に数えない/);
    expect(para).toMatch(/--force-with-lease/);
    expect(para).toMatch(/PR・下書きを外す・返信・送りの案は作らない/);
    expect(para).toMatch(/取り込み直す/);
    expect(para).toMatch(
      /baseBranch と同じ形の確かめを通ったものだけを受ける。外れたら書かずに終了コード1/,
    );
  });

  it("10.1 の複数のリポジトリの段落に、枝の行と run・integrate・merge の扱いがある", async () => {
    const s = chapter(await read("docs/spec.md"), 10);
    const at = s.indexOf("**複数のリポジトリをまたぐ要件**");
    expect(at).toBeGreaterThanOrEqual(0);
    const para = s.slice(at, s.indexOf("**画面の記録とスナップショット**", at));
    const branch = para.split("\n").find((l) => l.startsWith("- 枝：")) ?? "";
    expect(branch).toMatch(/`branchCommand`[^。]*あるときだけ/);
    expect(branch).toMatch(/版を待つか、枝で始めるか/);
    expect(branch).toContain("--allow-branch-push");
    expect(branch).toContain("--branches");
    expect(para).toMatch(
      /- run：アプリは[^\n]*`branchCommand`[^\n]*取り込み直す[^\n]*`bumpCommand`/,
    );
    expect(para).toMatch(/push 〈ID〉 --branch/);
    expect(para).toMatch(/取り込んだまま/);
    expect(para).toMatch(/- intake：[^\n]*`--branches`/);
  });

  it("8章と10章の枝の文に、実際のリポジトリの名前・手元のパス・ID の形が出ない", async () => {
    const text = await read("docs/spec.md");
    expect(text).not.toMatch(homePath);
    expect(text).not.toMatch(idForm);
    for (const l of text.split("\n")) {
      if (/branchCommand|--branches|--allow-branch-push/.test(l)) {
        expect(l).not.toMatch(homePath);
        expect(l).not.toMatch(idForm);
      }
    }
  });

  it("枝の取り込みの直し：push の記録・outbound.allow・17種の一覧・警告の置き場所・キーを出さない", async () => {
    const text = await read("docs/spec.md");
    const ch8 = chapter(text, 8);
    const row =
      ch8.split("\n").find((l) => l.startsWith("| `push 〈ID〉 --branch`")) ??
      "";
    expect(row).toMatch(/push の記録がある（PR の道に入った）/);
    expect(row).toMatch(/`outbound.allow` に `push` がない/);
    expect(row).toMatch(/時間帯は見ない/);
    const ch7 = chapter(text, 7);
    const at7 = ch7.indexOf("7. **GitHub への書き込み");
    const para = ch7.slice(at7, ch7.indexOf("\n8. ", at7));
    expect(para).toMatch(/push の記録がある（PR の道に入った）/);
    expect(para).toMatch(/`outbound.allow` に `push` がない/);
    expect(ch8).toMatch(/印の push した先頭をリモートの先頭の期待値に使う/);
    const range = ch8.split("\n").find((l) => l.startsWith("- 範囲：")) ?? "";
    expect(range).toMatch(/17種/);
    for (const f of ["poetry.lock", "npm-shrinkwrap.json"])
      expect(range, f).toContain(`\`${f}\``);
    expect(range).toMatch(/記録が壊れています/);
    expect(ch7).toMatch(/npm-shrinkwrap\.json[^\n]*poetry\.lock[^\n]*17種/);
    const gate = ch8.split("\n").find((l) => l.startsWith("- 門（")) ?? "";
    expect(gate).toMatch(/同じ1つの一覧/);
    expect(gate).not.toMatch(/版上げと同じ名前のファイル/);
    const verify =
      ch8.split("\n").find((l) => l.startsWith("| `verify`")) ?? "";
    expect(verify.indexOf("取り込み直す")).toBeLessThan(
      verify.indexOf("④ 通ったら記録を"),
    );
    expect(verify).toMatch(/枝の名前が残っている[^。]*ときに限り/);
    expect(ch8).toMatch(/共通でないリポジトリへの `--allow-branch-push`/);
    expect(text).toMatch(/`branchCommand`（共通だけ。なければキーを出さない）/);
    expect(text).not.toMatch(/`branchCommand`（共通だけ。なければ null）/);
  });

  it("印の範囲の直し：印は親から流したときだけ付く・始め方の止めの広がり・古い警告は push の記録の先頭を先に見る", async () => {
    const text = await read("docs/spec.md");
    const ch6 = chapter(text, 6);
    const ch7 = chapter(text, 7);
    const ch8 = chapter(text, 8);
    // 8章 new の行：環境変数と子での直の打ちの断り
    const row =
      ch8.split("\n").find((l) => l.startsWith("| `new --title ")) ?? "";
    expect(row).toContain("`ORCA_FLOW_FROM_WORKSPACE`");
    expect(row).toMatch(
      /環境変数 `ORCA_FLOW_FROM_WORKSPACE` が空なら終了コード1/,
    );
    const para0 = ch8.slice(ch8.indexOf("**共通の枝で先に始める**"));
    const how =
      para0.split("\n").find((l) => l.startsWith("- 印の付け方：")) ?? "";
    expect(how).toMatch(
      /`ORCA_FLOW_FROM_WORKSPACE` は親の印で、[^。]*流すときに付ける/,
    );
    expect(how).toMatch(/この変数が空なら、Orca を呼ばず[^。]*終了コード1/);
    expect(how).toMatch(
      /なしの `new` は、この変数がなくても今までどおり動き、古い印を消す/,
    );
    expect(how).toMatch(/Orca などへ渡さない/);
    // 始め方の止め
    const para = ch8.slice(ch8.indexOf("**共通の枝で先に始める**"));
    const stop =
      para.split("\n").find((l) => l.startsWith("- 始め方の止め：")) ?? "";
    expect(stop).toMatch(/共通でないリポジトリへの `--allow-branch-push`/);
    expect(stop).toMatch(
      /`branchCommand` のない共通への `--allow-branch-push`/,
    );
    expect(stop).toMatch(/子を流さず終了コード1/);
    expect(stop).toContain("`ORCA_FLOW_FROM_WORKSPACE`");
    // workspace の段落「new に枝を渡す」の止めの並びも同じに広げる
    const pass =
      ch8.split("\n").find((l) => l.startsWith("- `new` に枝を渡す：")) ?? "";
    expect(pass).toMatch(
      /子の CLI を流さず終了コード1：[^\n]*`branchCommand` のない共通への `--allow-branch-push`（`=値` の形も/,
    );
    expect(pass).toMatch(/`branchCommand` のある共通の子だけに付けられる/);
    // 古い取り込みの警告
    const warn =
      para.split("\n").find((l) => l.startsWith("- 古い取り込みの警告：")) ??
      "";
    expect(warn).toMatch(
      /push の記録[^。]*`pushedHead`[^。]*`branch` が[^。]*同じ[^。]*印の[^。]*より先/,
    );
    expect(warn).toMatch(
      /印がない・印がまだ push していない[^。]*push の記録の先頭で比べ/,
    );
    expect(warn).toMatch(/どちらもないときだけ[^。]*その旨/);
    // 6章：書く人・読む人
    const mark =
      ch6.split("\n").find((l) => l.startsWith("**共通の枝の印**：")) ?? "";
    expect(mark).toMatch(
      /親の `workspace 〈名前〉 new` から流した子の `new --allow-branch-push` が書く/,
    );
    expect(mark).toMatch(/子で直に打っても書かれない/);
    const rec =
      ch6.split("\n").find((l) => l.startsWith("**push の記録**：")) ?? "";
    expect(rec).toMatch(/アプリの `verify` の古い取り込みの警告/);
    expect(rec).toContain("`pushedHead`");
    // 7章7番の3つ目の例外の印の説明
    const at = ch7.indexOf("7. **GitHub への書き込み");
    const p7 = ch7.slice(at, ch7.indexOf("\n8. ", at));
    expect(p7).toMatch(
      /親の `workspace 〈名前〉 new` から流した子の `new --allow-branch-push` が書く/,
    );
    // 7章8番は変えない
    expect(ch7).toMatch(/\n8\. [^\n]*親は子のファイルを書かず/);
  });
});
