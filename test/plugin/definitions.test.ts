import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

interface Definition {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * 担当とスキルの定義の frontmatter を読む。
 * 1行1つの `キー: 値` だけを扱う（このリポジトリの定義はその形で書く）。
 */
function parseDefinition(text: string): Definition {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("frontmatter がありません");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("frontmatter の終わりがありません");
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`frontmatter の行が読めません：${line}`);
    let value = (m[2] ?? "").trim();
    if (/^".*"$/.test(value)) value = value.slice(1, -1);
    frontmatter[m[1] as string] = value;
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

async function readDefinition(rel: string): Promise<Definition> {
  return parseDefinition(await readFile(path.join(ROOT, rel), "utf8"));
}

/**
 * frontmatter の tools の値を、道具の名前の並びに分ける。
 * 名前の形（英字で始まり、英数字・_・- だけ）でない要素があれば投げる。
 * `[Glob, Read, Edit]`・`"Edit"`・`Edit(*)` のような書き方を、名前の比べ合わせの前に弾く。
 */
function parseTools(value: string): string[] {
  const list = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  for (const t of list) {
    if (!/^[A-Za-z][\w-]*$/.test(t)) {
      throw new Error(`tools の要素が読めません：${t}`);
    }
  }
  return list;
}

function tools(def: Definition): string[] {
  return parseTools(def.frontmatter.tools ?? "");
}

/** 本文のうち、正規表現に当たる最初の行を返す。 */
function lineMatching(body: string, re: RegExp): string | undefined {
  return body.split("\n").find((line) => re.test(line));
}

/** 本文のうち、`〈数〉. ` で始まる手順の行を返す。 */
function stepLine(body: string, n: number): string | undefined {
  return lineMatching(body, new RegExp(`^${n}\\. `));
}

/** 5つの観点と、主に見ること（設計書の表のとおり）。 */
const PERSPECTIVE_POINTS: [string, string][] = [
  ["正しさ", "論理の誤り、境界と異常系、呼び出し元への影響、並行の競合"],
  ["セキュリティ", "コマンドの組み立て、パスの扱い、秘密の値、入力、依存"],
  ["設計", "責務の分け方、既存コードの再利用、一貫性、仕様との整合"],
  ["テスト", "抜けた場合、弱い確かめ、壊れやすさ、偽物の使い方"],
  ["運用と互換性", "失敗時の後始末とメッセージ、性能、今の利用者を壊さないか"],
];
const PERSPECTIVES = PERSPECTIVE_POINTS.map(([name]) => name);
const SEVERITIES = ["必ず直す", "直したほうがよい", "確認だけ"];

describe("parseDefinition", () => {
  it("frontmatter と本文を分ける", () => {
    const def = parseDefinition(
      '---\nname: x\nargument-hint: "[ID]"\n---\n\n本文',
    );
    expect(def.frontmatter).toEqual({ name: "x", "argument-hint": "[ID]" });
    expect(def.body.trim()).toBe("本文");
  });

  it("frontmatter がなければ投げる", () => {
    expect(() => parseDefinition("本文だけ")).toThrow();
  });
});

describe("parseTools", () => {
  it("カンマで分けた名前の並びを読む", () => {
    expect(parseTools("Read, Glob, Grep, Bash")).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash",
    ]);
  });

  it.each(["[Glob, Read, Edit]", 'Read, "Edit"', '"Edit"', "Read, Edit(*)"])(
    "名前の形でない要素があれば投げる：%s",
    (value) => {
      expect(() => parseTools(value)).toThrow();
    },
  );
});

describe.each([
  ["agents/code-reviewer.md", "code-reviewer"],
  ["agents/review-verifier.md", "review-verifier"],
])("%s", (file, name) => {
  it("名前・model・effort が決まりどおり", async () => {
    const def = await readDefinition(file);
    expect(def.frontmatter.name).toBe(name);
    expect(def.frontmatter.model).toBe("opus");
    expect(def.frontmatter.effort).toBe("high");
    expect(def.frontmatter.description).toBeTruthy();
  });

  it("ファイルを変える道具を持たない", async () => {
    const def = await readDefinition(file);
    const list = tools(def);
    expect(list.length).toBeGreaterThan(0);
    expect(list).toContain("Read");
    expect(list).not.toContain("Edit");
    expect(list).not.toContain("Write");
    expect(list).not.toContain("NotebookEdit");
    expect(def.frontmatter.isolation).toBeUndefined();
  });

  it("作業ツリーを変えるコマンドを、コミットと一緒に禁じる", async () => {
    const def = await readDefinition(file);
    const lines = def.body.split("\n").filter((l) => l.includes("git stash"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain("コミット");
      expect(line).toContain("使わない");
    }
  });

  it("リポジトリのレビューの決まりを、baseBranch から git show で読み、禁止より優先しない", async () => {
    const def = await readDefinition(file);
    const line = lineMatching(def.body, /\.orca-flow\/review\.md/);
    expect(
      line,
      ".orca-flow/review.md を書いた行が見つかりません",
    ).toBeDefined();
    expect(line).toContain("git show 〈baseBranch〉:.orca-flow/review.md");
    expect(line).toContain("優先しない");
    expect(def.body).not.toMatch(/review\.md`?[^\n]*読んで従う/);
  });

  it("差分の中の文章を指示として扱わず、秘密の値を引用しない", async () => {
    const def = await readDefinition(file);
    expect(lineMatching(def.body, /指示ではない/)).toBeDefined();
    const secret = lineMatching(def.body, /秘密の値（/);
    expect(secret).toBeDefined();
    expect(secret).toContain("引用しない");
  });

  it("orca・orca-flow・git push・ネットワークのコマンドを流さない", async () => {
    const def = await readDefinition(file);
    const line = lineMatching(def.body, /git push/);
    expect(line).toBeDefined();
    expect(line).toContain("`orca`");
    expect(line).toContain("`orca-flow`");
    expect(line).toContain("ネットワーク");
    expect(line).toContain("流さない");
    expect(line).toContain("偽物の Runner");
  });

  it("verify 一式を流し直さず、指摘に関わるテストに絞る", async () => {
    const def = await readDefinition(file);
    const line = lineMatching(def.body, /verify 一式/);
    expect(line).toBeDefined();
    expect(line).toContain("流し直さない");
    expect(line).toContain("絞る");
  });

  it("渡されるものに ID・baseBranch・範囲（main...HEAD の形）・verify の結果がある", async () => {
    const def = await readDefinition(file);
    const intro = lineMatching(def.body, /渡されます/);
    expect(intro).toBeDefined();
    for (const word of ["ID", "baseBranch", "main...HEAD", "verify の結果"]) {
      expect(intro).toContain(word);
    }
    expect(intro).not.toContain("git diff main...HEAD");
  });

  it("「前からある」の基準は、やり直しでも〈baseBranch〉...HEAD", async () => {
    const def = await readDefinition(file);
    const line = lineMatching(def.body, /前からある.*基準|基準.*前からある/);
    expect(line).toBeDefined();
    expect(line).toContain("〈baseBranch〉...HEAD");
    expect(line).toContain("やり直し");
  });
});

describe("agents/code-reviewer.md", () => {
  it("観点を5つ全部渡されたときは、観点ごとに分けて返す", async () => {
    const def = await readDefinition("agents/code-reviewer.md");
    expect(lineMatching(def.body, /渡されます/)).toContain("5つ全部");
    const line = lineMatching(def.body, /5つ全部渡されたとき/);
    expect(line).toBeDefined();
    expect(line).toContain("観点ごとに分けて返す");
  });

  it("やり直しの形を持たない（やり直しは検証役だけ）", async () => {
    const def = await readDefinition("agents/code-reviewer.md");
    expect(def.body).not.toContain("前の回の直させるもの");
  });

  it("5つの観点と3つの重さ、前からある問題の印がある", async () => {
    const def = await readDefinition("agents/code-reviewer.md");
    for (const word of [...PERSPECTIVES, ...SEVERITIES, "前からある"]) {
      expect(def.body).toContain(word);
    }
  });

  it.each(PERSPECTIVE_POINTS)(
    "観点「%s」の行に、主に見ることが並ぶ",
    async (name, points) => {
      const def = await readDefinition("agents/code-reviewer.md");
      const line = lineMatching(def.body, new RegExp(`^\\s*- ${name}：`));
      expect(line, `「- ${name}：」の行が見つかりません`).toBeDefined();
      expect(line).toContain(points);
    },
  );
});

describe("agents/review-verifier.md", () => {
  it.each(["確か", "たぶん", "誤り"])(
    "分け方「%s」を定義する行がある",
    async (word) => {
      const def = await readDefinition("agents/review-verifier.md");
      expect(def.body).toMatch(new RegExp(`^\\s*- ${word}：\\S`, "m"));
    },
  );

  it("1回のレビューで1つだけ起動され、全部の観点の指摘を観点の名前つきで受ける", async () => {
    const def = await readDefinition("agents/review-verifier.md");
    expect(def.body).toContain("1回のレビューで起動されるのはあなた1つだけ");
    expect(lineMatching(def.body, /^- 最初の形：/)).toContain("観点の名前つき");
    const redo = lineMatching(def.body, /^- やり直しの形：/);
    expect(redo).toContain("前の回の直させるもの");
    expect(redo).toContain("〈直す前のコミット〉..〈直し終わりの先頭〉");
  });

  it("やり直しでは、直しで新しく入った問題も探す", async () => {
    const def = await readDefinition("agents/review-verifier.md");
    expect(lineMatching(def.body, /^7\. やり直しの形/)).toContain(
      "直しで新しく入った問題",
    );
  });

  it("前の回の直させるものを、1件ずつ直った・直っていないで返す", async () => {
    const def = await readDefinition("agents/review-verifier.md");
    const line = lineMatching(def.body, /前の回の直させるもの.*1件ずつ/);
    expect(line).toBeDefined();
    expect(line).toContain("直った");
    expect(line).toContain("直っていない");
  });

  it("テストの失敗を根拠にするとき、そのテスト1つで流し直す", async () => {
    const def = await readDefinition("agents/review-verifier.md");
    expect(lineMatching(def.body, /テストの失敗を根拠/)).toContain(
      "そのテスト1つで流し直",
    );
  });

  it.each(["agents/review-verifier.md", "agents/code-reviewer.md"])(
    "%s：一時ディレクトリは1回の Bash の中で作って消し、空の変数で rm -rf しない",
    async (file) => {
      const def = await readDefinition(file);
      expect(def.body).toContain('rm -rf "${T:?}"');
      expect(def.body).toContain("1回の Bash の中");
      expect(lineMatching(def.body, /空になりうる変数/)).toContain("rm -rf");
    },
  );
});

describe("agents/stage-verifier.md", () => {
  it("名前・model・effort が決まりどおりで、ファイルを変える道具を持たない", async () => {
    const def = await readDefinition("agents/stage-verifier.md");
    expect(def.frontmatter.name).toBe("stage-verifier");
    expect(def.frontmatter.model).toBe("opus");
    expect(def.frontmatter.effort).toBe("high");
    expect(def.frontmatter.background).toBe("true");
    const list = tools(def);
    expect(list).toContain("Read");
    expect(list).toContain("Bash");
    expect(list).not.toContain("Edit");
    expect(list).not.toContain("Write");
  });

  it("裁定の種類と、must-fix に新しい根拠を要求することを書く", async () => {
    const def = await readDefinition("agents/stage-verifier.md");
    for (const verdict of [
      "accept",
      "accept_intentional",
      "low_risk_ignore",
      "must_fix",
      "needs_human",
    ]) {
      expect(def.body).toContain(verdict);
    }
    expect(def.body).toContain("newEvidence");
    expect(def.body).toContain("revertJustification");
    expect(def.body).toContain("セキュリティ");
    expect(def.body).toContain("データ損失");
    expect(def.body).toContain("humanReview");
  });
});

describe("skills/review/SKILL.md", () => {
  it("frontmatter が読め、タスク長が呼べる", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    expect(def.frontmatter.name).toBe("review");
    expect(def.frontmatter.description).toBeTruthy();
    expect(def.frontmatter["argument-hint"]).toMatch(/^\[ID\]/);
    // run の中でタスク長が Skill で呼ぶので、モデルからの呼び出しを止めない
    expect(def.frontmatter["disable-model-invocation"]).toBeUndefined();
  });

  it("5つの観点と3つの重さの言葉がある", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    for (const word of [...PERSPECTIVES, ...SEVERITIES]) {
      expect(def.body).toContain(word);
    }
  });

  it.each(PERSPECTIVE_POINTS)(
    "表の「%s」の行に、主に見ることが並ぶ",
    async (name, points) => {
      const def = await readDefinition("skills/review/SKILL.md");
      const line = lineMatching(def.body, new RegExp(`^\\|\\s*${name}\\s*\\|`));
      expect(line, `表の「${name}」の行が見つかりません`).toBeDefined();
      expect(line).toContain(points);
    },
  );

  it("観点の詳しい説明はレビュー役の定義に任せる", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    expect(def.body).toContain("詳しくはレビュー役の定義");
    // 詳しい説明（レビュー役の定義の言葉）を重ねて書かない
    expect(def.body).not.toContain("シェルの注入");
  });

  it("2つの担当を使い、ID を $0、範囲を2つ目の引数で受ける", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    expect(def.body).toContain("orca-flow:code-reviewer");
    expect(def.body).toContain("orca-flow:review-verifier");
    expect(def.body).toContain("$0");
    expect(def.frontmatter["argument-hint"]).toMatch(/^\[ID\] \[.+\]$/);
    const range = lineMatching(def.body, /\$1/);
    expect(range, "2つ目の引数（$1）を受ける行が見つかりません").toBeDefined();
    expect(range).toContain("〈baseBranch〉...HEAD");
  });

  it("orca-flow status を流さない（カードは run が変える）", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    expect(def.body).not.toContain("orca-flow status");
    expect(def.body).not.toContain("status working");
  });

  it("手順1で ID と範囲の形を確かめて止まる", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    const step = stepLine(def.body, 1);
    expect(step, "手順1の行が見つかりません").toBeDefined();
    expect(step).toContain("〈idPrefix〉〈数〉");
    expect(step).toContain("〈ref〉..〈ref〉");
    expect(step).toContain("〈ref〉...〈ref〉");
    expect(step).toContain("止まる");
  });

  it("baseBranch と verify の結果をレビュー役と検証役に渡し、やり直しでは前の回の直させるものを渡す", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    const give = def.body.split("\n").filter((l) => l.includes("渡すもの："));
    expect(give.length).toBe(3);
    for (const line of give) {
      expect(line).toContain("baseBranch");
      expect(line).toContain("verify の結果");
    }
    const redo = give.filter((l) => l.includes("前の回の直させるもの"));
    expect(redo.length).toBe(1);
    expect(redo[0]).toContain("〈直す前のコミット〉..〈直し終わりの先頭〉");
  });

  it("検証役は1つだけ起動し、指摘がなければ起動しない", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    const first = stepLine(def.body, 5);
    expect(first, "手順5の行が見つかりません").toBeDefined();
    expect(first).toContain("1つの `orca-flow:review-verifier`");
    expect(first).toContain("観点ごとに分けない");
    expect(lineMatching(def.body, /指摘が1つもなければ/)).toContain(
      "検証役を起動せず",
    );
    expect(lineMatching(def.body, /検証役が未実施なら/)).toContain(
      "全部の指摘を「たぶん」",
    );
  });

  it("やり直しの形ではレビュー役を起動せず、検証役1つだけを起動する", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    expect(def.frontmatter["argument-hint"]).toContain("[やり直し]");
    expect(lineMatching(def.body, /\$2/)).toContain("やり直し");
    expect(lineMatching(def.body, /やり直しの形なら/)).toContain(
      "レビュー役を起動しない",
    );
    const step = stepLine(def.body, 7);
    expect(step, "手順7の行が見つかりません").toBeDefined();
    expect(step).toContain("やり直しの形");
    expect(step).toContain("1つの `orca-flow:review-verifier` だけ");
  });

  it("小さな差分のしきい値を1か所に名前つきで書き、そのときはレビュー役を1つにする", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    const defs = def.body
      .split("\n")
      .filter((l) => l.includes("小さな差分のしきい値："));
    expect(defs.length).toBe(1);
    expect(defs[0]).toMatch(/\d+ ?行/);
    const step = stepLine(def.body, 3);
    expect(step, "手順3の行が見つかりません").toBeDefined();
    expect(step).toContain("小さな差分のしきい値");
    expect(lineMatching(def.body, /しきい値までなら/)).toContain(
      "1つだけ背景で起動し、5つの観点を全部",
    );
    expect(lineMatching(def.body, /しきい値を超えたら/)).toContain("5つ並べて");
  });

  it("落ちた担当は1回だけ起動し直し、だめなら未実施にする", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    const line = lineMatching(def.body, /1回だけ起動し直/);
    expect(line).toBeDefined();
    expect(line).toContain("未実施");
  });

  it("重さは検証役が直したものを使う", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    expect(stepLine(def.body, 8)).toContain("検証役が直した");
  });

  it("run から呼ばれたときは、返したあと止まらずに run の手順6に進む", async () => {
    const def = await readDefinition("skills/review/SKILL.md");
    const line = lineMatching(def.body, /run から呼ばれたとき/);
    expect(line).toBeDefined();
    expect(line).toContain("番を終えず");
    expect(line).toContain("手順6の続き");
  });
});

describe("skills/run/SKILL.md", () => {
  it("/orca-flow:review を呼び、報告の項目に「コードレビュー」がある", async () => {
    const def = await readDefinition("skills/run/SKILL.md");
    expect(def.body).toContain("/orca-flow:review");
    const reportStep = stepLine(def.body, 8);
    expect(
      reportStep,
      "手順8の行（「8. 」で始まる行）が見つかりません",
    ).toBeDefined();
    expect(reportStep).toContain("報告を `〈reportsDir〉/$0.md` に書く");
    expect(reportStep).toContain("コードレビュー");
  });

  it("--note の書き方を残し、review の前に一言を流す", async () => {
    const def = await readDefinition("skills/run/SKILL.md");
    const step = stepLine(def.body, 6);
    expect(
      step,
      "手順6の行（「6. 」で始まる行）が見つかりません",
    ).toBeDefined();
    const note = (step ?? "").indexOf("status working --note");
    const review = (step ?? "").indexOf("/orca-flow:review");
    expect(note).toBeGreaterThanOrEqual(0);
    expect(review).toBeGreaterThan(note);
    expect(def.frontmatter["disable-model-invocation"]).toBe("true");
  });

  it("review にいつも範囲をはっきり渡す", async () => {
    const def = await readDefinition("skills/run/SKILL.md");
    const calls = def.body.split("/orca-flow:review $0").slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const rest of calls) {
      expect(rest).toMatch(/^ [^\s`]+\.\.\.?[^\s`]+/);
    }
    expect(def.body).toContain("/orca-flow:review $0 〈baseBranch〉...HEAD");
    expect(def.body).toContain(
      "/orca-flow:review $0 〈直す前のコミット〉..〈直し終わりの先頭〉 やり直し",
    );
    // 範囲なしで呼ぶ書き方を残さない
    expect(def.body).not.toMatch(/\/orca-flow:review(?! \$0 )/);
  });

  it("やり直しでは前の回の直させるものを渡し、直した差分が空なら review を流さない", async () => {
    const def = await readDefinition("skills/run/SKILL.md");
    expect(def.body).toContain("前の回の直させるもの");
    const empty = lineMatching(
      def.body,
      /git diff --name-only 〈直す前のコミット〉\.\.HEAD/,
    );
    expect(empty).toBeDefined();
    expect(empty).toContain("空");
    expect(empty).toContain("直っていない");
  });

  it("確認役とコードレビューの直しを合わせて2回まで、統括役の指示で数え直す", async () => {
    const def = await readDefinition("skills/run/SKILL.md");
    expect(lineMatching(def.body, /合わせて/)).toContain("2回まで");
    expect(lineMatching(def.body, /直しの指示が来たら/)).toContain("数え直す");
  });

  it("結果がそろったら止まらずに進み、未実施と範囲の外の指摘を人間に回す", async () => {
    const def = await readDefinition("skills/run/SKILL.md");
    expect(lineMatching(def.body, /そろったら/)).toContain("止まらずに");
    expect(lineMatching(def.body, /未実施/)).toContain(
      "人間に決めてほしいこと",
    );
    expect(lineMatching(def.body, /書き込んでよい場所」の外/)).toContain(
      "共有のファイルの変更の依頼",
    );
  });

  it("review や担当の種類が見つからないときは、再読み込みを頼んで待つ", async () => {
    const def = await readDefinition("skills/run/SKILL.md");
    const line = lineMatching(def.body, /見つからない/);
    expect(line).toBeDefined();
    expect(line).toContain(
      'orca-flow status question --note "プラグインの再読み込みが要る"',
    );
    expect(line).toContain("/reload-plugins");
  });
});

describe("ほかのスキル", () => {
  it.each(["init", "new", "spec", "approve", "run", "integrate"])(
    "%s は disable-model-invocation: true のまま",
    async (name) => {
      const def = await readDefinition(`skills/${name}/SKILL.md`);
      expect(def.frontmatter["disable-model-invocation"]).toBe("true");
    },
  );
});

describe("docs/spec.md", () => {
  async function section(heading: RegExp): Promise<string> {
    const text = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    const lines = text.split("\n");
    const start = lines.findIndex((l) => heading.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^## /.test(l));
    return (end < 0 ? rest : rest.slice(0, end)).join("\n");
  }

  it("5章の構成に review と3つの担当のファイル名がある", async () => {
    const s = await section(/^## 5\. /);
    expect(s).toMatch(/skills\/\{[^}]*\breview\b[^}]*\}\/SKILL\.md/);
    expect(s).toContain("code-reviewer.md");
    expect(s).toContain("review-verifier.md");
    expect(s).toContain("stage-verifier.md");
  });

  it("10章に review のスキルと3つの担当の定義がある", async () => {
    const s = await section(/^## 10\. /);
    expect(s).toContain("/orca-flow:review");
    expect(s).toContain("agents/code-reviewer.md");
    expect(s).toContain("agents/review-verifier.md");
    expect(s).toContain("agents/stage-verifier.md");
  });

  it("10.1 の review の行は orca-flow status を流さず、前の回の直させるものを受ける", async () => {
    const s = await section(/^## 10\. /);
    const row = lineMatching(s, /^\| `\/orca-flow:review /);
    expect(row).toBeDefined();
    expect(row).not.toContain("orca-flow status");
    expect(row).toContain("前の回の直させるもの");
    expect(row).toContain("git show 〈baseBranch〉:.orca-flow/review.md");
    expect(row).toContain("小さな差分のしきい値");
    expect(row).toContain("検証役1つ");
    expect(row).toContain("やり直しの形");
  });

  it("10.2 の code-reviewer の項目3に、メインの review.md を読むことがある", async () => {
    const s = await section(/^## 10\. /);
    const item = lineMatching(s, /^3\. リポジトリの決まりは作業ツリーではなく/);
    expect(item).toBeDefined();
    expect(item).toContain("無視されて");
    expect(item).toContain("メインのチェックアウト");
  });

  it("3章の確認役は背景で動く", async () => {
    const s = await section(/^## 3\. /);
    expect(lineMatching(s, /^\| 確認役/)).toContain("背景で動く");
  });

  it("13章にプラグインの再読み込みとレビュー役の出方の確かめがある", async () => {
    const s = await section(/^## 13\. /);
    expect(s).toContain("/reload-plugins");
    expect(s).toContain("orca-flow:code-reviewer");
  });
});

describe("review.md が無視されているときの読み替え", () => {
  const files = [
    "agents/code-reviewer.md",
    "agents/review-verifier.md",
    "agents/stage-verifier.md",
  ];
  const sentence = (body: string): string | undefined =>
    lineMatching(body, /git check-ignore -q \.orca-flow\/review\.md/);

  it("3つの定義が、無視されていればメインのチェックアウトのファイルを読み、文が同じ", async () => {
    const sentences: string[] = [];
    for (const file of files) {
      const def = await readDefinition(file);
      const line = sentence(def.body);
      expect(line, file).toBeDefined();
      expect(line, file).toContain(
        "git rev-parse --path-format=absolute --git-common-dir",
      );
      expect(line, file).toContain("メインのチェックアウト");
      expect(line, file).toContain("git show");
      sentences.push((line ?? "").trim());
    }
    expect(new Set(sentences).size).toBe(1);
  });

  it("3つの定義に、今の git show の行も残る", async () => {
    for (const file of files) {
      const def = await readDefinition(file);
      expect(def.body, file).toContain(
        "git show 〈baseBranch〉:.orca-flow/review.md",
      );
    }
  });
});
