import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 判断事項の7項目と、受け持つ観点（正しさは受け持たない） */
const JUDGMENT: [string, string[]][] = [
  ["正しさ", []],
  ["セキュリティ", ["依存の追加と更新", "セキュリティに関わる変更"]],
  ["設計", ["設計の選択"]],
  ["テスト", ["テストの削除や無効化"]],
  ["運用と互換性", ["マイグレーション", "公開 API の変更", "データの消失"]],
];
const ALL_ITEMS = JUDGMENT.flatMap(([, items]) => items);

/**
 * 観点の手順の要約値（sha256）。
 * 観点の手順を変えたら、レビュー役の定義の `観点の定義の版：` を上げ、この値を更新する。
 */
const PROCEDURE_SHA256 =
  "377fae4b7fade7aa50a051a3c7e21eabfc01c0349bccedec8a6c5bb3e8224dd3";

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** `## 見出し` から次の `## ` の前まで */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##+ /.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

/** 手順の行（`〈数〉. ` で始まる行）から、次の手順の行の前まで */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}がありません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (l, i) => i > start && new RegExp(`^${n + 1}\\. `).test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function lineStarting(text: string, re: RegExp): string {
  const line = text.split("\n").find((l) => re.test(l));
  expect(line, `行が見つかりません：${re}`).toBeDefined();
  return line as string;
}

/** 観点の手順の範囲：「3. 渡された観点で探す」の行から「5.」の行の前まで（手順3と4） */
function perspectiveProcedure(reviewer: string): string {
  const lines = reviewer.split("\n");
  const start = lines.findIndex((l) => l.startsWith("3. 渡された観点で探す"));
  const end = lines.findIndex((l, i) => i > start && /^5\. /.test(l));
  expect(start, "手順3が見つかりません").toBeGreaterThanOrEqual(0);
  expect(end, "手順5が見つかりません").toBeGreaterThan(start);
  return lines
    .slice(start, end)
    .map((l) => l.trimEnd())
    .join("\n");
}

describe("レビュー役の定義：判断事項", () => {
  it("7項目の名前が、受け持つ観点の行に入っている（正しさの行には入っていない）", async () => {
    const body = await read("agents/code-reviewer.md");
    for (const [name, items] of JUDGMENT) {
      const line = lineStarting(body, new RegExp(`^\\s*- ${name}：`));
      for (const item of items)
        expect(line, `${name}：${item}`).toContain(item);
      const others = ALL_ITEMS.filter((i) => !items.includes(i));
      for (const item of others) {
        // 「依存」は観点の一言にも使うので、7項目の名前そのもので見る
        expect(line, `${name}の行に${item}は入らない`).not.toContain(item);
      }
    }
    const correctness = lineStarting(body, /^\s*- 正しさ：/);
    for (const item of ALL_ITEMS) expect(correctness).not.toContain(item);
  });

  it("7項目が全部あり、項目ごとに1つの観点だけが受け持つ", async () => {
    const body = await read("agents/code-reviewer.md");
    for (const item of ALL_ITEMS) {
      const owners = JUDGMENT.filter(([name]) => {
        const line = lineStarting(body, new RegExp(`^\\s*- ${name}：`));
        return line.includes(item);
      });
      expect(owners.length, item).toBe(1);
    }
    expect(ALL_ITEMS.length).toBe(7);
  });

  it("印の文字と、承認済みの選択・前からあるものを外す決まりがある", async () => {
    const body = await read("agents/code-reviewer.md");
    expect(body).toContain("`判断事項：〈項目の名前〉`");
    const line = lineStarting(body, /^\s*- 外すもの：/);
    expect(line).toContain("「作るもの」");
    expect(line).toContain("「設計の経緯」");
    expect(line).toContain("承認された選択");
    expect(line).toContain("「前からある」");
    expect(line).toContain("印をつけない");
    const mark = lineStarting(body, /^\s*- 印：/);
    expect(mark).toContain("重さとは別");
    expect(mark).toContain("「起きること」の頭");
    expect(mark).toContain("JSON");
  });
});

describe("観点の定義の版", () => {
  it("`観点の定義の版：` の行が1つだけある", async () => {
    const body = await read("agents/code-reviewer.md");
    const lines = body
      .split("\n")
      .filter((l) => l.includes("観点の定義の版："));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^観点の定義の版：\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  });

  it("観点の手順の要約値が合う（変えたら版を上げ、値を更新する）", async () => {
    const body = await read("agents/code-reviewer.md");
    const version = lineStarting(body, /^観点の定義の版：/);
    const actual = createHash("sha256")
      .update(perspectiveProcedure(body))
      .digest("hex");
    expect(
      actual,
      [
        "観点の手順（agents/code-reviewer.md の「3.」から「5.」の前まで）が変わりました。",
        `観点の手順を変えたら、観点の定義の版を上げ（今は「${version}」）、`,
        `このテストの PROCEDURE_SHA256 を ${actual} に更新してください。`,
        "PR オーケストレーターが写しの版で古さに気づくためです。",
      ].join("\n"),
    ).toBe(PROCEDURE_SHA256);
  });
});

describe("検証役の定義", () => {
  it("やり直しの形の節に、判断事項の印の決まりがある", async () => {
    const body = await read("agents/review-verifier.md");
    const line = lineStarting(body, /^7\. やり直しの形/);
    expect(line).toContain("判断事項：〈項目の名前〉");
    expect(line).toContain("判断事項の7項目");
    expect(line).toContain("「起きること」の頭");
    expect(line).toContain("承認された選択");
    expect(line).toContain("「前からある」");
    expect(line).toContain("決めてほしいこと");
    expect(line).toContain("欠陥にはつけず");
  });

  it("7項目の名前と受け持つ観点が、この定義だけでも分かる", async () => {
    const body = await read("agents/review-verifier.md");
    const line = lineStarting(body, /^7\. やり直しの形/);
    for (const [name, items] of JUDGMENT) {
      if (items.length === 0) continue;
      expect(line, name).toContain(`${name}＝${items.join("・")}`);
    }
    for (const item of ALL_ITEMS) expect(line, item).toContain(item);
    expect(line).toContain("正しさは受け持たない");
  });
});

describe("承認された答えと欠陥の分け", () => {
  it("外すものに、決めてほしいことで承認された答えがあり、欠陥には印をつけない", async () => {
    const reviewer = await read("agents/code-reviewer.md");
    const skip = lineStarting(reviewer, /^\s*- 外すもの：/);
    expect(skip).toContain("要点の「決めてほしいこと」で承認された答え");
    expect(skip).toContain("人が直した指示");
    const defect = lineStarting(reviewer, /^\s*- 欠陥との分け：/);
    expect(defect).toContain("欠陥（壊れる・穴がある）には印をつけず");
    expect(defect).toContain("2つの指摘に分ける");
    const skill = lineStarting(
      await read("skills/review/SKILL.md"),
      /^判断事項：表の7項目/,
    );
    expect(skill).toContain("要点の「決めてほしいこと」で承認された答え");
    const spec = await read("docs/spec.md");
    const at = spec.indexOf("**レビューの観点の決まり**");
    const rule = spec.slice(at, spec.indexOf("### 10.3 "));
    expect(rule).toContain("要点の「決めてほしいこと」で承認された答え");
    expect(rule).toContain("欠陥（壊れる・穴がある）には印をつけず");
    expect(rule).toContain(
      "ローカルレビュー（reviewBackend: local）では、今は印のついた指摘も直させるものに入る",
    );
  });
});

describe("review のスキル", () => {
  it("観点の表に受け持つ判断事項があり、正しさは受け持たない", async () => {
    const body = await read("skills/review/SKILL.md");
    expect(lineStarting(body, /^\| 観点 /)).toContain("受け持つ判断事項");
    for (const [name, items] of JUDGMENT) {
      const row = lineStarting(body, new RegExp(`^\\|\\s*${name}\\s*\\|`));
      for (const item of items) expect(row, `${name}：${item}`).toContain(item);
      if (items.length === 0) {
        for (const item of ALL_ITEMS) expect(row).not.toContain(item);
      }
    }
  });

  it("印のついた指摘を検証役に渡さず「判断事項」の群で返すと書いてある", async () => {
    const body = await read("skills/review/SKILL.md");
    const para = lineStarting(body, /^判断事項：表の7項目/);
    expect(para).toContain("重さによらず検証役に渡さず");
    expect(para).toContain("「判断事項」の群で返す");
    expect(para).toContain(
      "直させるもの・混ぜるもの・タスク長が確かめるものには入れない",
    );
    expect(stepBlock(body, 5)).toContain("印のついた指摘は渡さない");
  });

  it("返す群の一覧に「判断事項」があり、light・文書だけ・テストだけでも同じに扱う", async () => {
    const body = await read("skills/review/SKILL.md");
    const step9 = stepBlock(body, 9);
    expect(step9).toMatch(/^ {3}- 判断事項：/m);
    const line = lineStarting(step9, /^ {3}- 判断事項：/);
    expect(line).toContain("検証役に渡さず");
    expect(line).toContain("上の「判断事項」の段落");
    expect(lineStarting(body, /^判断事項：表の7項目/)).toContain(
      "light・文書だけ・テストだけでも同じに扱う",
    );
    expect(step9).toContain("次の5つ");
  });

  it("前の回の「戻した判断事項」は群に移さず、直っていなければ直させるものに残す", async () => {
    const body = await read("skills/review/SKILL.md");
    for (const n of [2, 7, 8]) {
      expect(stepBlock(body, n), `手順${n}`).toContain("戻した判断事項");
    }
    expect(stepBlock(body, 8)).toContain("直させるものに残す");
  });

  it("手順4で印のついた指摘を先に群へ分ける", async () => {
    const step4 = stepBlock(await read("skills/review/SKILL.md"), 4);
    expect(step4).toContain("「判断事項」の群に分け");
  });
});

describe("run のスキルの手順6", () => {
  it("判断事項を根拠を開いて確かめ、統合の前に人が決めるものに入れ、3つの答えがある", async () => {
    const step6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = lineStarting(step6, /^\s*- review の「判断事項」の群/);
    expect(line).toContain("根拠のファイルと行");
    expect(line).toContain("本当なら");
    expect(line).toContain("統合の前に人が決めるもの");
    expect(line).toContain("本当でなければ");
    expect(line).toContain("「コードレビュー」の節");
    expect(line).toContain("「人間に決めてほしいこと」には印つきで残す");
    expect(line).toContain("このままにする");
    expect(line).toContain("戻す");
    expect(line).toContain("後続のタスクにする");
    expect(line).toContain("直しと同じに担当へ戻す");
    const decide = lineStarting(step6, /^\s*- 統合の前に人が決めるもの：/);
    expect(decide).toContain("review の「判断事項」で本当だったもの");
  });

  it("「戻す」の流れ：戻した判断事項の印で書き出し、直ったものは「直す」と同じく残さない", async () => {
    const run = await read("skills/run/SKILL.md");
    const step6 = stepBlock(run, 6);
    const back = lineStarting(step6, /^\s*- 人が「直す」と選んだとき/);
    expect(back).toContain("「戻した判断事項」の印");
    expect(back).toContain("「判断事項」の群に移さず");
    expect(back).toContain("直っていなければ直させるものに残す");
    expect(back).toContain("「直す」でも「戻す」でも");
    expect(back).toContain("「人間に決めてほしいこと」には残さない");
    expect(lineStarting(step6, /^\s*- 統合の前に人が決めるもの：/)).toContain(
      "「戻す」で直ったものも「直す」で直ったものと同じく",
    );
    expect(lineStarting(step6, /^\s*- review の「判断事項」の群/)).toContain(
      "「戻す」で直ったものは、「直す」で直ったものと同じく残さない",
    );
    expect(stepBlock(run, 8)).toContain(
      "「戻す」で直ったものも「直す」で直ったものと同じく",
    );
  });
});

describe("docs/spec.md：レビューの観点の決まり", () => {
  async function rule(): Promise<string> {
    const spec = await read("docs/spec.md");
    const at = spec.indexOf("**レビューの観点の決まり**");
    expect(at).toBeGreaterThan(-1);
    const end = spec.indexOf("### 10.3 ");
    expect(end).toBeGreaterThan(at);
    return spec.slice(at, end);
  }

  it("10.2 の終わり（10.3 の前）にある", async () => {
    const spec = await read("docs/spec.md");
    expect(spec.indexOf("### 10.2 ")).toBeLessThan(
      spec.indexOf("**レビューの観点の決まり**"),
    );
    await rule();
  });

  it("5観点と受け持ち・照らせるもの・分け方・Bash・ほかのリポジトリ・版が書いてある", async () => {
    const text = await rule();
    for (const item of ALL_ITEMS) expect(text, item).toContain(item);
    expect(text).toContain("正しさは受け持たない");
    expect(text).toContain("設計書があれば");
    expect(text).toContain("確認役");
    expect(text).toContain("PR の本文を他人のデータ");
    expect(text).toContain("観点ごとに5つ並べる");
    expect(text).toContain("Bash を渡さない");
    expect(text).toContain("PR オーケストレーターだけの追加");
    expect(text).toContain("`観点の定義の版：〈日付〉`");
    expect(text).toContain("要約値");
  });

  it("8章の報告の形が run と合っている（判断事項・戻すで直ったものを残さない）", async () => {
    const spec = await read("docs/spec.md");
    const reason = lineStarting(
      spec,
      /^- 「人間に決めてほしいこと」：人が選ぶもの/,
    );
    expect(reason).toContain("残った理由（判断事項・");
    const before = lineStarting(spec, /^- 統合の前に人が決めるもの（/);
    expect(before).toContain("判断事項で本当だったもの");
    expect(before).toContain(
      "「このままにする」「戻す」「後続のタスクにする」",
    );
    expect(before).toContain("「戻す」で直ったものも同じく除く");
    const para = lineStarting(spec, /^review は、`判断事項：〈項目の名前〉`/);
    expect(para).toContain(
      "「戻す」で直ったものは、「直す」で直ったものと同じく残さない",
    );
    expect(para).toContain("「戻した判断事項」の印");
  });

  it("手元のパスを書かない", async () => {
    const text = await rule();
    expect(text).not.toMatch(/\/(home|Users)\//);
    expect(text).not.toContain("skills/pr-agent");
  });

  it("3章・10.1 の review と run の続きの段落・10.2 のレビュー役と検証役が合っている", async () => {
    const spec = await read("docs/spec.md");
    const chapter3 = spec.slice(spec.indexOf("## 3. "), spec.indexOf("## 4. "));
    expect(chapter3).toContain("判断事項の7項目");
    const para = lineStarting(spec, /^review は、`判断事項：〈項目の名前〉`/);
    expect(para).toContain("「判断事項」の群で返す");
    expect(para).toContain("light・文書だけ・テストだけ");
    expect(para).toContain("根拠のファイルと行を開いて確かめ");
    expect(para).toContain("「統合の前に人が決めるもの」");
    expect(para).toContain("「このままにする」「戻す」「後続のタスクにする」");
    expect(spec.indexOf(para)).toBeGreaterThan(spec.indexOf("### 10.1 "));
    expect(spec.indexOf(para)).toBeLessThan(spec.indexOf("### 10.2 "));
    const sec = section(spec, /^### 10\.2 /);
    expect(sec).toContain("`判断事項：〈項目の名前〉`");
    expect(sec).toContain("観点の定義の版");
  });
});

describe("戻した判断事項を run が確かめる（review が確かめない形）", () => {
  it("仕様10.2のレビュー役の項目5が、レビューの観点の決まりとそろっている", async () => {
    const spec = await read("docs/spec.md");
    const sec = section(spec, /^### 10\.2 /);
    const item = lineStarting(sec, /^5\. 1つの指摘に/);
    expect(item).toContain("「作るもの」「設計の経緯」");
    expect(item).toContain("承認された選択");
    expect(item).toContain("要点の「決めてほしいこと」で承認された答え");
    expect(item).toContain("「前からある」");
    expect(item).toContain("欠陥（壊れる・穴がある）には印をつけず");
    expect(item).toContain("重さをつけて出し");
    expect(item).toContain("2つの指摘に分ける");
    // 承認された答えを外さない古い一覧が残っていない
    expect(item).not.toContain(
      "承認された選択と「前からある」ものにはつけない",
    );
  });

  it("run の手順6が、文書だけ・light・off で戻した判断事項を根拠を開いて確かめる", async () => {
    const step6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = lineStarting(step6, /^\s*- 戻した判断事項の確かめ：/);
    expect(line).toContain("文書だけ・`light`・`off`");
    expect(line).toContain("review が確かめない形");
    expect(line).toContain("根拠のファイルと行を開いて");
    expect(line).toContain("戻ったか");
    expect(line).toContain("戻っていなければ担当に戻し");
    expect(line).toContain("直しのやり直しの2回の枠");
    expect(line).toContain("2回で直らなければ");
    expect(line).toContain("もう一度 `orca-flow status question` で聞く");
    expect(line).toContain("人が「戻す」を選んだ");
    expect(line).toContain("タスク長が確かめた");
    expect(line).toContain("`full` は検証役が確かめる");
    // 「戻す」を選んだときの箇条からも、この確かめを指す
    const chosen = lineStarting(step6, /^\s*- 人が「直す」と選んだとき/);
    expect(chosen).toContain(
      "「戻した判断事項」は、文書だけ・`light`・`off` では、上の「戻した判断事項の確かめ」のとおりタスク長が確かめる",
    );
  });

  it("review のスキルが、文書だけと light のやり直しで戻した判断事項を run が確かめると書いている", async () => {
    const review = await read("skills/review/SKILL.md");
    const docsOnly = lineStarting(review, /^やり直しの形（文書だけ）：/);
    expect(docsOnly).toContain("「戻した判断事項」");
    expect(docsOnly).toContain("run が確かめる");
    const light = lineStarting(review, /^- `light`：/);
    expect(light).toContain("「戻した判断事項」");
    expect(light).toContain("run が確かめる");
  });

  it("仕様10.1の review と run の続きの段落に、文書だけ・light・off で run が確かめると書いている", async () => {
    const spec = await read("docs/spec.md");
    const para = lineStarting(spec, /^review は、`判断事項：〈項目の名前〉`/);
    expect(para).toContain("文書だけ・light・off");
    expect(para).toContain("run が");
    expect(para).toContain("戻ったかを確かめ");
  });
});
