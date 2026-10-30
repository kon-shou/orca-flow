import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../../src/config.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

function lineMatching(text: string, re: RegExp): string | undefined {
  return text.split("\n").find((line) => re.test(line));
}

function stepLine(text: string, n: number): string | undefined {
  return lineMatching(text, new RegExp(`^${n}\\. `));
}

/** `〈数〉. ` で始まる手順の行から、次の手順の行の前までを返す。 */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}がありません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (l, i) => i > start && new RegExp(`^${n + 1}\\. `).test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 「統合待ち」を含む最初の行から、次の「- 」の行の前までを返す。 */
function waitingBlock(text: string): string {
  const s = section(text, /^## 統括役から知らせが来たら/);
  const lines = s.split("\n");
  const start = lines.findIndex((l) => /統合待ち/.test(l));
  expect(start, "統合待ちの扱いが見つかりません").toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^- /.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `git status` の探し方。`git` と `status` の間に `-c 〈設定〉` が入っても当たる。 */
const GIT_STATUS = "git (?:-c [^ `]+ )*status";

/** `before` + `git status` + `after` に当たる正規表現。 */
function gitStatus(before: string, after: string): RegExp {
  return new RegExp(escapeRe(before) + GIT_STATUS + escapeRe(after));
}

/** `git status` + `after` が最初に出る位置（なければ -1）。 */
function gitStatusAt(text: string, after: string): number {
  return text.search(gitStatus("", after));
}

/** 元の文と、`git status` を `git -c core.quotePath=false status` に置き換えた文。 */
function quotePathVariants(text: string): Array<[string, string]> {
  const replaced = text.replaceAll(
    "git status",
    "git -c core.quotePath=false status",
  );
  return [
    ["元の文", text],
    ["quotePath=false の文", replaced],
  ];
}

/** 手順10の例外の文：条件の始まり（パスが `"` で始まる）から次の「。」まで。 */
function skillException(step: string): string {
  const start = step.indexOf('パスが `"` で始まる');
  expect(start, "手順10に例外の文がありません").toBeGreaterThanOrEqual(0);
  const end = step.indexOf("。", start);
  expect(end, "例外の文の終わり（。）がありません").toBeGreaterThan(start);
  return step.slice(start, end + 1);
}

/** 仕様⑧の例外の文：条件の始まり（追跡中のファイルがまた出たとき）から⑧のかっこの終わりまで。 */
function specException(part: string): string {
  const start = part.indexOf("追跡中のファイルがまた出たとき");
  expect(start, "⑧に例外の文がありません").toBeGreaterThanOrEqual(0);
  const close = part.indexOf("）、空なら", start);
  expect(close, "⑧のかっこの終わりがありません").toBeGreaterThan(start);
  return part.slice(start, close + 1);
}

/** 例外の文が、4つの条件と「消さずに」の question を持ち、元に戻して進・消して進を持たない。 */
function expectExceptionSentence(sentence: string, question: string) {
  expect(sentence).toContain('`"` で始まる');
  expect(sentence).toContain("`'` を含む");
  expect(sentence).toContain("追跡中のファイル");
  expect(sentence).toContain("消してよいか分からない");
  expect(sentence).toContain(question);
  expect(sentence).not.toContain("元に戻して進");
  expect(sentence).not.toContain("消して進");
}

/** 手順10・仕様⑧の「また出たか」の確かめ以降の言葉の順。 */
function expectRepeatOrder(part: string) {
  const words = [
    "--untracked-files=all",
    "`??` の行",
    "1つずつ",
    "rm -- '〈パス〉'",
    "フォルダごと消さない",
    "`.gitignore`",
  ];
  const at = words.map((w) => part.indexOf(w));
  words.forEach((w, i) => {
    expect(at[i], `${w} がありません`).toBeGreaterThanOrEqual(0);
  });
  for (let i = 1; i < at.length; i++) {
    expect(at[i] ?? 0, `順序が合いません：${words[i]}`).toBeGreaterThan(
      at[i - 1] ?? 0,
    );
  }
}

/** 消しすぎの文と古い文がない。 */
function expectNoOverkill(text: string) {
  expect(text).not.toContain("rm -r");
  expect(text).not.toContain("git clean");
  expect(text).not.toContain("みなし、消して進み");
  expect(text).not.toContain("また出たら消して進み");
}

/** 手順5の「それ以外」の行。 */
function exitOne(text: string): string {
  const lines = stepBlock(text, 5).split("\n");
  const start = lines.findIndex((l) => /^\s*- それ以外/.test(l));
  expect(start, "それ以外の行が見つかりません").toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^\s*- [0-3]/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** 10.1 の run と review の行。 */
async function specRows() {
  const s = section(await read("docs/spec.md"), /^## 10\. /);
  return {
    run: lineMatching(s, /^\| `\/orca-flow:run /) ?? "",
    review: lineMatching(s, /^\| `\/orca-flow:review /) ?? "",
  };
}

/** 10.1 の run の行の⑧（「⑧ 」から「⑨ 」の前まで）。 */
function step8Of(run: string): string {
  const at = run.indexOf("⑧ ");
  expect(at, "⑧がありません").toBeGreaterThanOrEqual(0);
  const end = run.indexOf("⑨ ", at);
  expect(end, "⑨がありません").toBeGreaterThan(at);
  return run.slice(at, end);
}

/** 10.1 の run の行を、quotePath の置き換えをして⑧を取り出す。 */
function specStep8Variants(run: string): Array<[string, string]> {
  return quotePathVariants(run).map(([label, t]) => [label, step8Of(t)]);
}

describe("skills/review/SKILL.md の codeReview", () => {
  it("codeReview を読み、off ならレビュー役も検証役も起動せずに返す", async () => {
    const text = await read("skills/review/SKILL.md");
    const step = stepLine(text, 1) ?? "";
    expect(step).toContain("codeReview");
    const line = lineMatching(section(text, /^## codeReview/), /^\s*- `off`/);
    expect(line, "off の行が見つかりません").toBeDefined();
    expect(line).toContain("レビュー役も検証役も起動せず");
    expect(line).toContain("止めている");
    expect(line).toContain("返");
  });

  it("light ならしきい値によらずレビュー役を1つだけ起動し、検証役を起動せず、指摘を「たぶん」として報告に回す", async () => {
    const text = await read("skills/review/SKILL.md");
    const line = lineMatching(text, /^\s*- `light`/);
    expect(line, "light の行が見つかりません").toBeDefined();
    expect(line).toContain("しきい値によらず");
    expect(line).toContain("レビュー役を1つだけ");
    expect(line).toContain("検証役を起動せず");
    expect(line).toContain("「たぶん」");
    expect(line).toContain("報告に書くもの");
    expect(line).toContain("軽くする設定（codeReview: light）で検証役なし");
  });

  it("手順1の行に、off なら返して終わることと、light でやり直しの形なら何も起動せずに返して終わることがある", async () => {
    const text = await read("skills/review/SKILL.md");
    const step = stepLine(text, 1) ?? "";
    const off = step.indexOf("`off`");
    const light = step.indexOf("`light`");
    expect(off, "手順1に off がありません").toBeGreaterThanOrEqual(0);
    expect(light, "手順1に light がありません").toBeGreaterThan(off);
    expect(step.slice(off, light)).toContain("返して終わる");
    const idCheck = step.indexOf("ID（$0）");
    expect(idCheck, "手順1に ID（$0）がありません").toBeGreaterThan(light);
    const lightPart = step.slice(light, idCheck);
    expect(lightPart).toContain("やり直しの形");
    expect(lightPart).toContain("何も起動せず");
    expect(lightPart).toContain("返して終わる");
    // ほかの確かめ（ID の確かめ）より前
    expect(light).toBeLessThan(idCheck);
  });

  it("手順3の行に light ならレビュー役を1つだけ、手順4の行に light なら検証役を起動しない", async () => {
    const text = await read("skills/review/SKILL.md");
    const s3 = stepLine(text, 3) ?? "";
    expect(s3).toContain("`light`");
    expect(s3.slice(s3.indexOf("`light`"))).toContain("レビュー役を1つだけ");
    const s4 = stepLine(text, 4) ?? "";
    expect(s4).toContain("`light`");
    expect(s4.slice(s4.indexOf("`light`"))).toContain("検証役を起動せず");
  });

  it("やり直しの形で呼ばれても設定に従う", async () => {
    const text = await read("skills/review/SKILL.md");
    expect(text).toMatch(/やり直しの形で呼ばれても/);
  });
});

describe("skills/run/SKILL.md の codeReview", () => {
  it("手順1で codeReview を読む", async () => {
    const text = await read("skills/run/SKILL.md");
    expect(stepLine(text, 1)).toContain("codeReview");
  });

  it("手順6に、off なら review を呼ばず確認役だけを起動し、off・light ではやり直しの review を呼ばない", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 6);
    const off = lineMatching(block, /`off`.*review を呼ばず/);
    expect(off, "off の行が見つかりません").toBeDefined();
    expect(off).toContain("確認役だけ");
    const redo = lineMatching(block, /`off`・`light`/);
    expect(redo, "off・light の行が見つかりません").toBeDefined();
    expect(redo).toContain("やり直しの review を呼ばない");
  });

  it("手順6の行で、「`off` でなければ」が /orca-flow:review より前にある", async () => {
    const step = stepLine(await read("skills/run/SKILL.md"), 6) ?? "";
    const off = step.indexOf("`off` でなければ");
    const review = step.indexOf("/orca-flow:review");
    expect(off).toBeGreaterThanOrEqual(0);
    expect(review).toBeGreaterThan(off);
  });

  it("手順6の中の light の行に、最初の1回だけ review を呼ぶとある", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = lineMatching(block, /^\s*- codeReview が `light`/);
    expect(line, "light の行が見つかりません").toBeDefined();
    expect(line).toContain("最初の1回だけ");
    expect(line).toContain("review を呼ぶ");
  });

  it("手順6に、直しのコミットの数を覚え、やり直しの review の直前に HEAD~〈数〉 から〈直す前のコミット〉を求め直す", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = lineMatching(block, /git rev-parse HEAD~〈数〉/);
    expect(line, "求め直す行が見つかりません").toBeDefined();
    expect(line).toContain("求め直");
    expect(line).toContain("〈直す前のコミット〉");
    expect(line).toContain("HEAD~〈数〉");
    expect(line).toContain("やり直しの review の直前");
    expect(line).toContain("〈直す前のコミット〉..HEAD");
    // 記号のまま渡さず、rev-parse が出した名前にする
    expect(line).toMatch(
      /git rev-parse HEAD~〈数〉` が出したコミットの名前を〈直す前のコミット〉/,
    );
    expect(line).toContain("記号のまま");
    // 直しのコミットの数を覚える行
    const count = lineMatching(
      block,
      /git diff --name-only 〈直す前のコミット〉\.\.HEAD/,
    );
    expect(count, "数を覚える行が見つかりません").toBeDefined();
    expect(count).toContain("直しのコミットの数");
    const remember = (count ?? "").indexOf("直しのコミットの数");
    const rebase = (count ?? "").indexOf("rebase より前");
    expect(rebase, "rebase より前に数えるとありません").toBeGreaterThan(
      remember,
    );
    expect(count).toContain("直し終わったらすぐ");
    expect(count).toMatch(/担当のものもタスク長のものも全部足す/);
    // 古い順の数番目を取る書き方を残さない
    expect(block).not.toContain("rev-list --reverse");
    expect(block).not.toContain("sed -n");
    expect(block).not.toContain("古い順");
    expect(block).not.toMatch(/〈baseBranch〉\.\.〈直す前のコミット〉/);
  });

  it("手順5の終了コード1の扱いに、担当に戻すのは2回まで、時間切れはすぐ question", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 5);
    const line = lineMatching(block, /^\s*- 1/);
    expect(line, "終了コード1の行が見つかりません").toBeDefined();
    expect(block).toContain("担当に戻すのは2回まで");
    expect(block).toContain("時間内に終わりませんでした");
    const timeout = lineMatching(block, /時間切れ/);
    expect(timeout).toContain("すぐ");
    expect(timeout).toContain("orca-flow status question");
    expect(timeout).toContain("担当に戻さ");
    expect(block).toContain("数え直す");
  });

  it("手順5の終了コード1の行に、通算で数えること、3回目で question、時間切れはすぐ question", async () => {
    const lines = stepBlock(await read("skills/run/SKILL.md"), 5).split("\n");
    const start = lines.findIndex((l) => /^\s*- 1/.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && /^\s*- [023]/.test(l));
    const block = lines.slice(start, end < 0 ? undefined : end).join("\n");
    expect(block).toContain("落ちたコマンドごと");
    expect(block).toContain("通算");
    expect(block).toContain("通っても数え直さない");
    expect(block).toContain("担当に戻すのは2回まで");
    expect(block).toMatch(
      /3回目に落ちたら、担当に戻さず `orca-flow status question`/,
    );
    expect(block).not.toContain("3回続けて");
    expect(block).toMatch(/時間切れ.*すぐ `orca-flow status question`/);
    expect(block).toContain("統括役から直しの指示が来たときだけ");
  });

  it("間にほかのコマンドが落ちても通算で数え、3回目の question のあとも数え直さない", async () => {
    const line = exitOne(await read("skills/run/SKILL.md"));
    expect(line).toContain(
      "（間にほかのコマンドが落ちても、通っても数え直さない）",
    );
    const third = line.indexOf("3回目に落ちたら");
    const after = line.indexOf(
      "その question に人間が答えて続けるときも数え直さず",
    );
    expect(third).toBeGreaterThanOrEqual(0);
    expect(after).toBeGreaterThan(third);
    expect(line.slice(after)).toContain(
      "次に落ちたらまた `orca-flow status question`",
    );
    expect(line.slice(after)).toContain("人間が毎回決められる");
    // 統括役の直しの指示のときだけ数え直す、は残る
    expect(line.indexOf("統括役から直しの指示が来たときだけ")).toBeGreaterThan(
      after,
    );
  });

  it("時間切れは下の回数に数えず、すぐ question にする", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 5);
    const timeout = lineMatching(block, /時間切れ（/) ?? "";
    expect(timeout).toContain("すぐ `orca-flow status question`");
    expect(timeout).toContain("時間切れは下の回数に数えない");
  });
});

describe("skills/run/SKILL.md の直しの指示", () => {
  it("「直しの指示が来たら」の行に、codeReview の読み直しと、終了コード1の回数と light の最初の1回の数え直しがある", async () => {
    const s = section(
      await read("skills/run/SKILL.md"),
      /^## 統括役から知らせが来たら/,
    );
    const line = lineMatching(s, /^- 直しの指示が来たら/);
    expect(line, "直しの指示の行が見つかりません").toBeDefined();
    expect(line).toContain("codeReview を読み直");
    expect(line).toContain("終了コード1の回数");
    expect(line).toContain("数え直す");
    expect(line).toContain("`light` の「最初の1回」");
  });

  it("`light` の「最初の1回」も数え直しが続けてあり、review を1回呼ぶ", async () => {
    const s = section(
      await read("skills/run/SKILL.md"),
      /^## 統括役から知らせが来たら/,
    );
    const line = lineMatching(s, /^- 直しの指示が来たら/) ?? "";
    expect(line).toContain("`light` の「最初の1回」も数え直し");
    expect(line).toContain("手順6で review を1回呼ぶ");
  });

  it("codeReview の読み直しが、手順5の verify が通ったあと（main を取り込んだあと）にある", async () => {
    const s = section(
      await read("skills/run/SKILL.md"),
      /^## 統括役から知らせが来たら/,
    );
    const line = lineMatching(s, /^- 直しの指示が来たら/) ?? "";
    const verify = line.indexOf("手順5の `orca-flow verify` が通ったあと");
    const reread = line.indexOf("codeReview を読み直");
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(reread).toBeGreaterThan(verify);
    expect(line).toContain("main を取り込んだあと");
    expect(line).toContain("main の設定の変更を拾うため");
    // 回数の数え直しより前
    expect(reread).toBeLessThan(line.indexOf("ここで数え直す"));
  });
});

describe("ローカルレビュー（reviewBackend: local）", () => {
  it("review スキルは local のとき review-local を1回呼ぶ", async () => {
    const text = await read("skills/review/SKILL.md");
    expect(text).toContain("reviewBackend");
    expect(text).toContain("review-local");
    expect(text).toContain("1回");
  });

  it("run スキルは段の周回と段末の Opus 裁定を持つ", async () => {
    const text = await read("skills/run/SKILL.md");
    expect(text).toContain("## ローカルレビュー（reviewBackend: local）");
    expect(text).toContain("stageLimits[0]");
    expect(text).toContain("stageLimits[1]");
    expect(text).toContain("orca-flow:stage-verifier");
    expect(text).toContain("review-ledger record-fix");
    expect(text).toContain("review-ledger record-opus");
    expect(text).toContain("review-ledger record-finding");
    expect(text).toContain("fixed_intentional");
  });

  it("6章に reviewBackend と localReview の行がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 6\. /);
    expect(lineMatching(s, /^\| reviewBackend/)).toContain("local");
    expect(lineMatching(s, /^\| localReview/)).toContain("10.3");
    expect(s).toContain("stageLimits");
  });
});

describe("skills/run/SKILL.md の統合待ち", () => {
  it("status working --note が verify より前、git status --porcelain が verify と integrate-wait の間", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const block = waitingBlock(text);
      const working = block.indexOf("orca-flow status working --note");
      const verify = block.indexOf("orca-flow verify");
      const porcelain = gitStatusAt(block, " --porcelain");
      const wait = block.indexOf("orca-flow status integrate-wait");
      expect(working, label).toBeGreaterThanOrEqual(0);
      expect(verify, label).toBeGreaterThan(working);
      expect(porcelain, label).toBeGreaterThan(verify);
      expect(wait, label).toBeGreaterThan(porcelain);
    }
  });

  it("終了コードが0以外（3を含む）なら直さずに status question にする", async () => {
    const block = waitingBlock(await read("skills/run/SKILL.md"));
    expect(block).toContain("0以外");
    const nonZero = lineMatching(block, /0以外/);
    expect(nonZero).toContain("1・2・3");
    expect(block).toContain("直さずに `orca-flow status question`");
    expect(block).toMatch(/3でも自分で rebase しない/);
  });

  it("手順10で git status --porcelain が verify と integrate-wait の間にある", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const step = stepLine(text, 10) ?? "";
      const verify = step.indexOf("orca-flow verify");
      const porcelain = gitStatusAt(step, " --porcelain");
      const wait = step.indexOf("orca-flow status integrate-wait");
      expect(verify, label).toBeGreaterThanOrEqual(0);
      expect(porcelain, label).toBeGreaterThan(verify);
      expect(wait, label).toBeGreaterThan(porcelain);
    }
  });
});

describe("skills/run/SKILL.md の手順10の片づけ", () => {
  it("quotePath の置き換えが、git status を git -c core.quotePath=false status に変える", async () => {
    // 本物の手順10は統括役が quotePath を入れるので、決まった見本で確かめる
    const sample = "通ったら `git status --porcelain` が空かを確かめる";
    const [orig, replaced] = quotePathVariants(sample);
    expect(orig?.[1]).toBe(sample);
    expect(replaced?.[1]).toContain(
      "git -c core.quotePath=false status --porcelain",
    );
    expect(replaced?.[1]).not.toContain("git status");
  });

  it("コミットせずに片づけたら verify を流し直さず porcelain だけ見直し、また出たファイルは .gitignore を頼む", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const step = stepLine(text, 10) ?? "";
      expect(step, label).toMatch(
        /コミットせずに片づけた.*verify を流し直さず/,
      );
      expect(step, label).toMatch(gitStatus("", " --porcelain"));
      expect(step, label).toMatch(
        /コミットしたときだけ `orca-flow verify` を流し直す/,
      );
      expect(step, label).toMatch(/また出た/);
      expect(step, label).toContain("`.gitignore` に足してほしい");
      expect(step, label).toContain("手順11");
      expect(step, label).toContain("消さずに `orca-flow status question`");
    }
  });

  it("verify を流し直さず git status --porcelain だけ見直すと続けて書いてある", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const step = stepLine(text, 10) ?? "";
      expect(step, label).toMatch(
        gitStatus("verify を流し直さず `", " --porcelain` だけ見直す"),
      );
    }
  });

  it("また出たファイルは --untracked-files=all の ?? の行だけを1つずつ rm -- で消し、フォルダごと消さず、.gitignore を頼む", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const step = stepLine(text, 10) ?? "";
      const again = step.indexOf("前に片づけたファイルがまた出たかは");
      expect(
        again,
        `${label}：また出たかの確かめがありません`,
      ).toBeGreaterThanOrEqual(0);
      const part = step.slice(again);
      expect(part, label).toMatch(
        gitStatus("`", " --porcelain --untracked-files=all`"),
      );
      expect(part, label).toContain(
        "`??` の行（追跡外のファイル）だけを、1つずつ `rm -- '〈パス〉'` で消して進み",
      );
      expect(part, label).toContain("フォルダごと消さない");
      expect(part, label).toContain("手順11の伝え方に");
      expect(part, label).toContain("`.gitignore` に足してほしい");
      // 順序：確かめ → 消す → フォルダごと消さない → .gitignore
      expectRepeatOrder(part);
    }
  });

  it("追跡中のファイル、\" で始まるか ' を含むパスは、元に戻さず消さずに status question にする", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const step = stepLine(text, 10) ?? "";
      const rm = step.indexOf("フォルダごと消さない");
      expect(rm, label).toBeGreaterThanOrEqual(0);
      const q = step.indexOf('パスが `"` で始まる');
      expect(q, `${label}：パスの例外がありません`).toBeGreaterThan(rm);
      const part = step.slice(q);
      expect(part, label).toContain('`"` で始まる');
      expect(part, label).toContain("`'` を含む");
      expect(part, label).toContain(
        "`??` 以外の行（追跡中のファイル）がまた出たとき",
      );
      expect(part, label).toContain(
        "元に戻さず、消さずに `orca-flow status question`",
      );
      // 例外の文は integrate-wait より前
      expect(part.indexOf("status question"), label).toBeLessThan(
        part.indexOf("orca-flow status integrate-wait"),
      );
    }
  });

  it("例外の文が1文で切り出され、4つの条件と「消さずに」の question があり、元に戻して進・消して進がない", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const sentence = skillException(stepLine(text, 10) ?? "");
      // 1文：終わりの「。」のほかに「。」がない
      expect(sentence.indexOf("。"), label).toBe(sentence.length - 1);
      expectExceptionSentence(sentence, "消さずに `orca-flow status question`");
    }
  });

  it("前に片づけたファイルが verify のあとにまた出たら、が rm -- '〈パス〉' より前にある", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const step = stepLine(text, 10) ?? "";
      const cond = step.indexOf(
        "前に片づけたファイルが verify のあとにまた出たら",
      );
      const rm = step.indexOf("rm -- '〈パス〉'");
      expect(
        cond,
        `${label}：rm の条件の文がありません`,
      ).toBeGreaterThanOrEqual(0);
      expect(rm, label).toBeGreaterThan(cond);
      // 条件の文の終わり（みなす。）の直後が rm の文で、あいだに別の文や条件を挟まない
      expect(step.slice(cond, rm), label).toMatch(
        /^[^。]*。`\?\?` の行（追跡外のファイル）だけを、1つずつ `$/,
      );
    }
  });

  it("手順10の行全体に「元に戻して進」がない（例外の文の外に足しても落ちる）", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      expect(stepLine(text, 10) ?? "", label).not.toContain("元に戻して進");
    }
  });

  it("rm -r・git clean・古い文（みなし、消して進み）がない", async () => {
    for (const [label, text] of quotePathVariants(
      await read("skills/run/SKILL.md"),
    )) {
      const step = stepLine(text, 10) ?? "";
      expect(step, label).toContain("rm -- '〈パス〉'");
      expectNoOverkill(step);
    }
  });
});

describe("docs/spec.md の codeReview", () => {
  it("3章の表の下に、codeReview で止めたり軽くしたりできると書いてある", async () => {
    const s = section(await read("docs/spec.md"), /^## 3\. /);
    expect(s).toContain("codeReview");
  });

  it("6章に codeReview の行と full・light・off がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 6\. /);
    const row = lineMatching(s, /^\| codeReview/);
    expect(row, "codeReview の行が見つかりません").toBeDefined();
    for (const v of ["full", "light", "off"]) expect(row).toContain(v);
    expect(row).toContain('"full"');
  });

  it("10.1 の run と review の行に codeReview がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 10\. /);
    expect(lineMatching(s, /^\| `\/orca-flow:run /)).toContain("codeReview");
    expect(lineMatching(s, /^\| `\/orca-flow:review /)).toContain("codeReview");
  });

  it("12章に「未読の印」がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 12\. /);
    const line = lineMatching(s, /^7\. /);
    expect(line, "12章の7の行が見つかりません").toBeDefined();
    expect(line).toContain("未読の印");
    expect(line).toContain("実装中");
  });

  it("10.1 の review の行で、codeReview の off が ID の確かめより前にある", async () => {
    const s = section(await read("docs/spec.md"), /^## 10\. /);
    const row = lineMatching(s, /^\| `\/orca-flow:review /) ?? "";
    const off = row.indexOf("`off`");
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeLessThan(row.indexOf("ID が"));
  });

  it("10.1 の run の行に、HEAD~ と、片づけで verify を流し直さない決まりがある", async () => {
    const s = section(await read("docs/spec.md"), /^## 10\. /);
    const row = lineMatching(s, /^\| `\/orca-flow:run /) ?? "";
    expect(row).toContain("HEAD~");
    expect(row).toContain("直しのコミットの数");
    expect(row).not.toContain("古い順");
    expect(row).toMatch(/コミットせずに片づけ.*verify を流し直さ/);
    expect(row).toContain("通算");
    expect(row).toContain("codeReview を読み直");
  });

  it("10.1 の review の行で、light でやり直しの形なら返して終わることが「ID が」より前にある", async () => {
    const { review } = await specRows();
    const light = review.indexOf("`light` でやり直しの形なら");
    expect(light, "light のやり直しの文がありません").toBeGreaterThanOrEqual(0);
    const part = review.slice(light, review.indexOf("ID が"));
    expect(part).toContain("何も起動せず");
    expect(part).toContain("やり直しの確かめはしない");
    expect(part).toContain("返して終わる");
    expect(light).toBeGreaterThan(review.indexOf("`off`"));
  });

  it("run の行の④に、3回目のあとも数え直さないことと、時間切れを数えないことと、light の最初の1回の数え直しがある", async () => {
    const { run } = await specRows();
    expect(run).toContain(
      "3回目に落ちたら `status question`。その question に人間が答えて続けるときも数え直さず、次に落ちたらまた `status question`",
    );
    expect(run).toContain(
      "時間切れ（30分）は回数に数えず、戻さずすぐ `status question`",
    );
    expect(run).toContain(
      "この回数と④の終了コード1の回数と `light` の最初の1回を数え直し",
    );
  });

  it("run の行の⑤に、担当に戻す前・片づける前の HEAD がある", async () => {
    const { run } = await specRows();
    expect(run).toContain("担当に戻す前・片づける前の HEAD を覚え");
  });

  it("run の行の⑧に、--untracked-files=all の ?? の行だけを1つずつ消し、フォルダごと消さず、.gitignore を頼み、例外は status question", async () => {
    const { run } = await specRows();
    for (const [label, part] of specStep8Variants(run)) {
      expect(part, label).toMatch(
        gitStatus("`", " --porcelain --untracked-files=all` で見て"),
      );
      expect(part, label).toContain(
        "`??` の行（追跡外のファイル）だけを1つずつ `rm -- '〈パス〉'` で消して進み",
      );
      expect(part, label).toContain("フォルダごと消さない");
      expect(part, label).toContain(
        "⑨の伝え方で `.gitignore` に足してほしいと頼む",
      );
      expect(part, label).toContain(
        "追跡中のファイルがまた出たとき、`\"` で始まるか `'` を含むパス",
      );
      expect(part, label).toContain("元に戻さず消さずに `status question`");
    }
  });

  it("run の行の⑧で、git status --porcelain が空かの確かめが、空なら integrate-wait より前にある", async () => {
    const { run } = await specRows();
    for (const [label, part] of specStep8Variants(run)) {
      const porcelain = gitStatusAt(part, " --porcelain");
      expect(porcelain, label).toBeGreaterThanOrEqual(0);
      expect(
        part.indexOf("orca-flow status integrate-wait"),
        label,
      ).toBeGreaterThan(porcelain);
    }
  });

  it("run の行の⑧の言葉の順が、--untracked-files=all・?? の行・1つずつ・rm --・フォルダごと消さない・.gitignore", async () => {
    const { run } = await specRows();
    for (const [label, part] of specStep8Variants(run)) {
      const again = part.indexOf("前に片づけたファイルがまた出たかは");
      expect(
        again,
        `${label}：また出たかの確かめがありません`,
      ).toBeGreaterThanOrEqual(0);
      expectRepeatOrder(part.slice(again));
    }
  });

  it("run の行の⑧の例外の文が1文で切り出され、4つの条件と「消さずに」の question があり、元に戻して進・消して進がない", async () => {
    const { run } = await specRows();
    for (const [label, part] of specStep8Variants(run)) {
      const sentence = specException(part);
      expect(sentence.startsWith("追跡中のファイルがまた出たとき"), label).toBe(
        true,
      );
      expect(sentence.endsWith("`status question`）"), label).toBe(true);
      expect(sentence, label).not.toContain("。");
      expectExceptionSentence(sentence, "消さずに `status question`");
    }
  });

  it("run の行の⑧で、前に片づけたファイルがまた出たかは、が rm -- '〈パス〉' より前にある", async () => {
    const { run } = await specRows();
    for (const [label, part] of specStep8Variants(run)) {
      const cond = part.indexOf("前に片づけたファイルがまた出たかは");
      const rm = part.indexOf("rm -- '〈パス〉'");
      expect(
        cond,
        `${label}：rm の条件の文がありません`,
      ).toBeGreaterThanOrEqual(0);
      expect(rm, label).toBeGreaterThan(cond);
      // 条件の文の終わりより前に「。」がなく、rm の文は条件の直後から続く
      expect(part.slice(cond, rm), label).toMatch(
        /^[^。]*）、`\?\?` の行（追跡外のファイル）だけを1つずつ `$/,
      );
    }
  });

  it("run の行の⑧全体に「元に戻して進」がない（例外の文の外に足しても落ちる）", async () => {
    const { run } = await specRows();
    for (const [label, part] of specStep8Variants(run)) {
      expect(part, label).not.toContain("元に戻して進");
    }
  });

  it("run の行の⑧に、rm -r・git clean・古い文（また出たら消して進み）がない", async () => {
    const { run } = await specRows();
    for (const [label, part] of specStep8Variants(run)) {
      expect(part, label).toContain("rm -- '〈パス〉'");
      expectNoOverkill(part);
    }
  });

  it("run の行で、直しの指示のときの codeReview の読み直しが ④ の verify が通ったあとにある", async () => {
    const { run } = await specRows();
    const verify = run.indexOf(
      "④の verify が通ったあと（main を取り込んだあと）",
    );
    const reread = run.indexOf("codeReview を読み直");
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(reread).toBeGreaterThan(verify);
  });
});

describe("templates/config.json", () => {
  it('"codeReview": "full" があり、parseConfig で読むと DEFAULT_CONFIG と同じ', async () => {
    const text = await read("templates/config.json");
    expect(text).toContain('"codeReview": "full"');
    expect(parseConfig(JSON.parse(text))).toEqual(DEFAULT_CONFIG);
  });
});
