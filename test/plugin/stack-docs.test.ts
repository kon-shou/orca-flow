import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

/** 「## 〈番号〉. 」の見出しから、次の「## 」の前まで */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しがありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 「### 〈番号〉 」の見出しから、次の「### 」か「## 」の前まで */
function subsection(text: string, no: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`### ${no} `));
  expect(start, `${no} の見出しがありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##+ /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** head で始まる行から、空行の前まで（箇条の続きを含む） */
function paragraph(text: string, head: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(head));
  expect(at, `段落がありません：${head}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const l of lines.slice(at)) {
    if (l.trim() === "" && out.length > 0) {
      // 頭の行のすぐ後ろの空行のあとに箇条が続く形も拾う
      const next = lines[at + out.length + 1] ?? "";
      if (out.length === 1 && next.startsWith("- ")) {
        out.push(l);
        continue;
      }
      break;
    }
    out.push(l);
  }
  return out.join("\n");
}

/** 番号つきの基準の1つ（次の番号の行の前まで） */
function criterion(text: string, n: number): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${n}. `));
  expect(at, `基準${n}がありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || l.startsWith("## "));
  return lines.slice(at, at + 1 + (end < 0 ? rest.length : end)).join("\n");
}

/** 見出し行から、次の同じ高さ以上の見出しの前まで */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === heading);
  expect(at, `見出しがありません：${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+) /.exec(l);
    return m !== null && (m[1] as string).length <= level;
  });
  return lines.slice(at, at + 1 + (end < 0 ? rest.length : end)).join("\n");
}

const SPLIT = "skills/intake/splitting.md";

describe("splitting.md：乗せる", () => {
  it("基準の番号は1〜8のまま", async () => {
    const nums = (await read(SPLIT))
      .split("\n")
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => Number(l.split(".")[0]));
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("基準5が、同じリポジトリの前の項目の枝に後ろを乗せてよいと書き、フラグで閉じていない要件でも許す", async () => {
    const c = criterion(await read(SPLIT), 5);
    expect(c).not.toContain("前の項目のブランチの上に次を始める形は作らない");
    const line = c.split("\n").find((l) => l.startsWith("   - 乗せる：")) ?? "";
    expectAll(line, [
      "同じリポジトリ",
      "前の項目のブランチの上に後ろを始めてよい",
      "`orca-flow new --stack-on`",
      "フラグで閉じていない要件でも乗せてよい",
      "前の統合のあとにしか入らない",
      "リポジトリをまたぐ依存には乗せない",
      "乗せる先は1つだけ",
    ]);
  });

  it("基準7が「乗せる」の意味を「積む」「並べる」と並べて書く", async () => {
    const c = criterion(await read(SPLIT), 7);
    expectAll(c, [
      "「積む」は前の項目の統合を待つこと",
      "「乗せる」は前の項目の枝の上で後ろを始め、統合は前のあとにすること",
    ]);
  });
});

describe("仕様書：乗せる", () => {
  it("6章に乗せる記録の段落がある（置き場・中身・土台・消し方）", async () => {
    const line = paragraph(
      chapter(await read("docs/spec.md"), 6),
      "**乗せる記録**：",
    );
    expectAll(line, [
      "`〈git の共通ディレクトリ〉/orca-flow/stack/〈ID〉.json`",
      "`new --stack-on 〈ID〉`",
      "乗せた先の ID と枝・書いた時刻",
      "同じリポジトリの前のタスク1つだけ",
      "乗せた先の枝",
      "終了コード2",
      "`depends 〈ID〉 --base`",
      "`depends 〈ID〉 --unstack`",
    ]);
  });

  it("7章3番の段落に乗せたタスクの例外があり、見出しは変わらない", async () => {
    const line =
      chapter(await read("docs/spec.md"), 7)
        .split("\n")
        .find((l) =>
          l.startsWith("3. **依存のあるタスクは同時に走らせない**"),
        ) ?? "";
    expectAll(line, [
      "**乗せたタスク**",
      "`new --stack-on 〈前の ID〉`",
      "前の枝の上で前と並行に",
      "統合とマージは前が先",
      "前の枝を通して受け取る",
    ]);
  });

  it("7章3番の段落に、すでに外した言い方は入らない", async () => {
    const line =
      chapter(await read("docs/spec.md"), 7)
        .split("\n")
        .find((l) =>
          l.startsWith("3. **依存のあるタスクは同時に走らせない**"),
        ) ?? "";
    expect(line).not.toBe("");
    expect(line).not.toContain("枝で先に始める例外");
    expect(line).not.toMatch(/統合の前に同じブランチで正式な版に戻す/);
    expect(line).not.toMatch(/今の版を待つ道は残る/);
  });

  it("8章の new の行に --stack-on、depends の段落に --base と --unstack がある", async () => {
    const ch = chapter(await read("docs/spec.md"), 8);
    const newRow =
      ch.split("\n").find((l) => l.startsWith("| `new --title")) ?? "";
    expect(newRow).toContain("`--stack-on 〈ID〉`");
    const dep = paragraph(ch, "**depends（依存の記録を見る・足す）**：");
    expectAll(dep, [
      "`depends 〈ID〉 --base`",
      "土台を1行で出す",
      "`depends 〈ID〉 --unstack`",
      "統括役の場所",
      "タスクの worktree では終了コード2",
    ]);
  });

  it("8章に乗せる段落があり、new・取り込み・速い道・止まり・知らせ・またぐ依存・CI・共通を書く", async () => {
    const p = paragraph(
      chapter(await read("docs/spec.md"), 8),
      "**乗せる（`new --stack-on`）**：",
    );
    expectAll(p, [
      "乗せた先の枝を土台に worktree を作る",
      "その鎖の末尾に足す",
      "渡せる ID は1つ",
      "統合済み・作業中でない・自分・形の外れの ID",
      "終了コード1で worktree も記録も作らない",
      "verify と approve",
      "baseBranch の代わりに土台を取り込む",
      "rebase-review の指紋・risk の差分・review-local の既定の範囲",
      "integrate の速い道に使わない",
      "`--skip-order` を付けても終了コード2",
      "前の枝が進んだ",
      "前の設計書が出直した",
      "送れなくても警告だけ",
      "ほかのリポジトリのタスクには乗せられない",
      "同じブランチ（同じ ID と slug）に置く",
      "導入先の CI で前の枝を読める形にする",
      "共通の枝を向く定義を受け継ぐ",
      "版上げは前で行い、後ろは前か main の取り込みで受け取る",
    ]);
  });

  it("8章の verify・approve・push の行が、乗せる段落を指す", async () => {
    const ch = chapter(await read("docs/spec.md"), 8);
    for (const head of [
      "| `verify`",
      "| `approve 〈ID〉",
      "| `push 〈ID〉 [--body-file",
    ]) {
      const row = ch.split("\n").find((l) => l.startsWith(head)) ?? "";
      expect(row, head).toContain("下の『乗せる』");
    }
  });

  it("10.1 に乗せたタスクのスキルの扱いがある", async () => {
    const p = paragraph(
      subsection(await read("docs/spec.md"), "10.1"),
      "**乗せたタスク**（8章『乗せる』）のスキルの扱い：",
    );
    expectAll(p, [
      "- run",
      "- review",
      "- spec",
      "`orca-flow depends 〈ID〉 --base`",
      "差分の範囲・取り込み・祖先の確かめ",
      "「前からある」",
      "乗せた先の設計書と枝を読む",
    ]);
  });
});

describe("スキルと担当の定義：乗せる", () => {
  it("run が土台の読み替えと2つの知らせの扱いを書く", async () => {
    const s = section(
      await read("skills/run/SKILL.md"),
      "## 乗せたタスク（前のタスクの枝の上で始めたとき）",
    );
    expectAll(s, [
      "`orca-flow depends $0 --base`",
      "差分の範囲・取り込み・祖先の確かめ",
      "〈土台〉",
      "「前の枝が進んだ」",
      "「前の設計書が出直した」",
      "乗せた先が入った知らせなら main を取り込み",
      "ほかの ID が入った知らせなら取り込まない",
      "`orca-flow depends $0 --unstack`",
    ]);
  });

  it("review が土台の読み替えを書き、レビュー役と検証役に土台を渡す", async () => {
    const s = section(await read("skills/review/SKILL.md"), "## 乗せたタスク");
    expectAll(s, [
      "`orca-flow depends $0 --base`",
      "差分の範囲・取り込み・祖先の確かめ",
      "土台",
      "「前からある」",
      "`.orca-flow/review.md`",
    ]);
  });

  it("spec が乗せた先の設計書と枝を読み、2つの知らせを扱う", async () => {
    const s = section(
      await read("skills/spec/SKILL.md"),
      "## 乗せたタスク（前のタスクの枝の上で始めたとき）",
    );
    expectAll(s, [
      "`orca-flow depends $0 --base`",
      "乗せた先の設計書と枝を読む",
      "「前の枝が進んだ」",
      "「前の設計書が出直した」",
      "乗せた先が入った知らせなら main を取り込み",
      "ほかの ID が入った知らせなら取り込まない",
    ]);
  });

  it("stage-verifier が土台の読み替えを書く", async () => {
    const t = await read("agents/stage-verifier.md");
    expectAll(t, [
      "`orca-flow depends 〈ID〉 --base`",
      "差分の範囲・取り込み・祖先の確かめ",
      "渡された土台で「前からある」を見分ける",
    ]);
  });

  it("code-reviewer と review-verifier が、渡された土台で「前からある」を見分ける", async () => {
    for (const f of ["agents/code-reviewer.md", "agents/review-verifier.md"]) {
      const t = await read(f);
      expect(t, f).toContain("渡された土台で「前からある」を見分ける");
      expect(t, f).toContain("乗せた先の変更");
    }
  });
});

/** 「。」で区切った文のうち、words を全部含むもの */
function sentencesWith(text: string, words: string[]): string[] {
  return text.split(/。|\n/).filter((s) => words.every((w) => s.includes(w)));
}

const RUN_STACK = "## 乗せたタスク（前のタスクの枝の上で始めたとき）";

describe("乗せたタスク：直しの確かめ", () => {
  it("run と 10.1 が、追記だけの確かめを土台と比べると書き、baseBranch のままとは書かない", async () => {
    const run = section(await read("skills/run/SKILL.md"), RUN_STACK);
    const s101 = paragraph(
      subsection(await read("docs/spec.md"), "10.1"),
      "**乗せたタスク**（8章『乗せる』）のスキルの扱い：",
    );
    expectAll(run, [
      "追記だけの確かめ",
      "手順7",
      "`cmp`",
      "〈土台〉と比べる",
      "`git show 〈土台〉:〈decisionsFile〉`",
      "`.orca-flow/review.md` を読む所だけは baseBranch のまま",
    ]);
    expectAll(s101, [
      "追記だけの確かめ",
      "土台と比べる",
      "`.orca-flow/review.md` を読む所だけは baseBranch のまま",
    ]);
    for (const [name, text] of [
      ["run", run],
      ["10.1", s101],
    ] as const) {
      for (const word of ["追記だけ", "決定の記録"])
        expect(
          sentencesWith(text, [word, "baseBranch のまま"]),
          `${name}：${word}`,
        ).toEqual([]);
    }
  });

  it("main の知らせを取り込まないのは、土台を流し直して baseBranch でない間だけ", async () => {
    const run = section(await read("skills/run/SKILL.md"), RUN_STACK);
    const spec = section(await read("skills/spec/SKILL.md"), RUN_STACK);
    const s101 = paragraph(
      subsection(await read("docs/spec.md"), "10.1"),
      "**乗せたタスク**（8章『乗せる』）のスキルの扱い：",
    );
    for (const [name, text, cmd] of [
      [
        "run",
        run,
        "`orca-flow depends $0 --base` を流し直し、〈土台〉が baseBranch でない間だけ",
      ],
      [
        "spec",
        spec,
        "`orca-flow depends $0 --base` を流し直し、〈土台〉が baseBranch でない間だけ",
      ],
      [
        "10.1",
        s101,
        "`orca-flow depends 〈ID〉 --base` を流し直し、土台が baseBranch でない間だけ",
      ],
    ] as const) {
      const line =
        text
          .split("\n")
          .find((l) => l.includes("main に 〈ID〉 が入りました")) ?? "";
      expect(line, name).toContain(cmd);
      expect(line, name).toContain("baseBranch に戻ったら");
      expect(line, name).toContain("「統括役から知らせが来たら」のとおり");
    }
  });

  it("8章の乗せる段落が、乗せた先の枝に含まれる間はマージ済みにしない見分けを書き、早くコミットする避け方を書かない", async () => {
    const p = paragraph(
      chapter(await read("docs/spec.md"), 8),
      "**乗せる（`new --stack-on`）**：",
    );
    const line =
      p
        .split("\n")
        .find((l) => l.startsWith("- 自分のコミットがないうちの見分け：")) ??
      "";
    expectAll(line, [
      "自分のコミットがないうち",
      "`--no-ff`",
      "main の祖先",
      "乗せる記録のあるタスク",
      "乗せた先の枝（記録の枝）の祖先である間は、main の祖先でもマージ済みにしない",
      "作業中の一覧に残り",
      "統合は枝を消さない",
      "乗せた先の枝が手元になければ、今までどおり main の祖先かで見分ける",
      "乗せる記録が読めない・壊れているときは、止めずにマージ済みにしない",
    ]);
    expect(p).not.toContain("早く自分のコミットを1つ作る");
    expect(p).not.toContain("設計書を早めにコミットする");
    expect(p).not.toContain("作業中の一覧から外れる");
  });

  it("spec の乗せたタスクの節が、早くコミットする項を持たず、ほかの項は残る", async () => {
    const spec = section(await read("skills/spec/SKILL.md"), RUN_STACK);
    expect(spec).not.toContain("早くコミットする");
    expect(spec).not.toContain("設計書を早めにコミットする");
    expect(spec).not.toContain("作業中の一覧から外れる");
    for (const head of [
      "- 見分け：",
      "- 設計：",
      "- 読み替え：",
      "- 知らせ（「統括役から知らせが来たら」に足す）：",
    ])
      expect(
        spec.split("\n").some((l) => l.startsWith(head)),
        head,
      ).toBe(true);
  });

  it("8章の乗せる段落の integrate と push の項が、push --branch は乗せた先が入る前でも止めないと書く", async () => {
    const p = paragraph(
      chapter(await read("docs/spec.md"), 8),
      "**乗せる（`new --stack-on`）**：",
    );
    const line =
      p.split("\n").find((l) => l.startsWith("- integrate と push：")) ?? "";
    expectAll(line, [
      "`--skip-order` を付けても終了コード2で止める",
      "`push 〈ID〉 --branch`",
      "乗せた先が入る前でも止めない",
      "共通の枝を早く出すため",
    ]);
  });

  it("8章：integrate の止まりが乗せる段落を指し、--skip-order は乗せた先が入る前の止まりを飛ばさない", async () => {
    const ch = chapter(await read("docs/spec.md"), 8);
    const line =
      ch.split("\n").find((l) => l.startsWith("- integrate（続き）：")) ?? "";
    expectAll(line, [
      "`--skip-order` は3つとも飛ばす",
      "乗せた先が入る前の止まりは飛ばさない",
      "上の『乗せる』",
    ]);
  });

  it("8章の乗せる段落が、approve の2回目の取り込みをしないことを書く", async () => {
    const p = paragraph(
      chapter(await read("docs/spec.md"), 8),
      "**乗せる（`new --stack-on`）**：",
    );
    expect(p).toContain(
      "approve は、乗せている間は進捗表をコミットしたあとの2回目の main の取り込みをしない",
    );
  });

  it("--unstack の断りと、消したあとの案内を仕様書と run に書く", async () => {
    const ch = chapter(await read("docs/spec.md"), 8);
    const dep = paragraph(ch, "**depends（依存の記録を見る・足す）**：");
    const line =
      dep
        .split("\n")
        .find((l) => l.startsWith("- `depends 〈ID〉 --unstack`")) ?? "";
    const run = section(await read("skills/run/SKILL.md"), RUN_STACK);
    const gone =
      run.split("\n").find((l) => l.startsWith("- 乗せた先がない：")) ?? "";
    for (const [name, text] of [
      ["8章", line],
      ["run", gone],
    ] as const) {
      expectAll(text, [
        "乗せた先がまだ作業中なら終了コード2",
        "乗せた先のコミット",
        "外すか、自分の変更として扱うかを決める",
        "`orca-flow order --remove`",
        "--drop-depend`",
      ]);
      expect(text, name).not.toBe("");
    }
  });

  it("後ろへの知らせの説明に乗せた先の枝の名前を書かず、土台は --base で読む", async () => {
    const p = paragraph(
      chapter(await read("docs/spec.md"), 8),
      "**乗せる（`new --stack-on`）**：",
    );
    const line =
      p.split("\n").find((l) => l.startsWith("- 後ろへの知らせ：")) ?? "";
    expectAll(line, [
      "「前の枝が進んだ」",
      "「前の設計書が出直した」",
      "乗せた先の枝の名前は入れない",
      "`depends 〈ID〉 --base`",
    ]);
  });
});
