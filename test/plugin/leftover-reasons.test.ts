import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const SCOPE =
  "`.claude/` の下（CLAUDE.md を除く）・`.orca-flow/` の下・`orca.yaml`・`package.json`（ファイル全体）・`.worktreeinclude`";
const OLD_SCOPE = "`package.json` の scripts";
const SIX = [
  "範囲の外",
  "設計で範囲の外",
  "前からある",
  "2回で直らない",
  "直しのあとに見つけた",
  "確かめきれない",
];
const SIX_JOINED = SIX.join("・");

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 手順 n の行と、その下のインデントされた行をまとめる。 */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  const out = [lines[start] as string];
  for (const l of lines.slice(start + 1)) {
    if (/^\s+\S/.test(l) || l.trim() === "") out.push(l);
    else break;
  }
  return out.join("\n");
}

/** ブロックの中の、頭が prefix の箇条の行（インデントは問わない）。 */
function bulletLine(block: string, prefix: string): string {
  const line = block.split("\n").find((l) => l.trim().startsWith(prefix));
  expect(line, `${prefix} の箇条が見つかりません`).toBeDefined();
  return line ?? "";
}

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」が見つかりません`).toContain(w);
}

/** 6つの言葉をこの順に取り出す。 */
function sixWords(line: string): string[] {
  const m = line.match(/範囲の外・.*?確かめきれない/);
  expect(m, "6つの言葉の並びが見つかりません").not.toBeNull();
  return (m?.[0] ?? "").split("・");
}

/** 見た目の幅。prettier と同じく、東アジアの全角の文字だけを2と数える（①や→のような幅の決まらない文字は1）。 */
function width(s: string): number {
  let w = 0;
  for (const ch of s)
    w +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(
        ch,
      )
        ? 2
        : 1;
  return w;
}

const specLines = async () => (await read("docs/spec.md")).split("\n");

describe("残った理由：run の手順6（混ぜるもの）", () => {
  const mixBullet = async () =>
    bulletLine(
      stepBlock(await read("skills/run/SKILL.md"), 6),
      "- 混ぜるもの：",
    );

  it("確かで直したほうがよい・前からあるでない・書き込んでよい場所の中のものを、直させるものと一緒に担当に戻す", async () => {
    const b = await mixBullet();
    expectAll(b, [
      "「確か」とした",
      "直したほうがよい",
      "「前からある」問題でなく",
      "書き込んでよい場所の中",
      "直させるものと一緒に",
    ]);
  });

  it("混ぜたものは「前の回の直させるもの」に「混ぜた」の印で書き出し、最初の形の分だけで、やり直しで新しく出たものは混ぜない", async () => {
    const b = await mixBullet();
    expectAll(b, [
      "「混ぜた」の印",
      "前の回の直させるもの",
      "最初の形",
      "やり直しで新しく出た直したほうがよいは混ぜない",
    ]);
  });

  it("混ぜたものは2回の枠を共有し、2回で直らなければ「2回で直らない」で報告し、統合の前の question では聞かない", async () => {
    const b = await mixBullet();
    expectAll(b, [
      "2回の枠を共有し、",
      "「2回で直らない」",
      "統合の前の question では聞かない",
    ]);
  });

  it("light のときは混ぜず、設計で範囲の外のものは混ぜない", async () => {
    const b = await mixBullet();
    expect(b).toContain(
      "`light`（検証役なし）のときとローカルレビューの道は変えず、混ぜない",
    );
    expect(b).toMatch(/設計で範囲の外[^。]*で書く/);
    expect(b).toMatch(/直すと設計書の作るものを越えるものは混ぜず/);
  });

  it("run が混ぜたものを覚え、やり直しが返したものにも印を保つ", async () => {
    const b = await mixBullet();
    expectAll(b, ["run が覚えて", "印を保って"]);
  });

  it("「（混ぜたものを除く）」が手順6に2か所以上あり、混ぜたものもないときだけ直しに入らない", async () => {
    const s6 = stepBlock(await read("skills/run/SKILL.md"), 6);
    expect(s6.split("（混ぜたものを除く）").length - 1).toBeGreaterThanOrEqual(
      2,
    );
    expectAll(s6, ["混ぜるものもなく", "混ぜたものもない"]);
  });
});

describe("残った理由：残った理由の6つの言葉", () => {
  it("run の手順8の「残った理由：」の箇条に、6つの言葉がこの順に並ぶ", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    const line = bulletLine(s8, "- 残った理由：");
    expect(sixWords(line)).toEqual(SIX);
    expect(line).toContain(SIX_JOINED);
  });

  it("docs/spec.md の「人間に決めてほしいこと」の箇条にも同じ並びがあり、run と同じ", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    const run = sixWords(bulletLine(s8, "- 残った理由："));
    const spec = (await specLines()).find((l) =>
      l.startsWith("- 「人間に決めてほしいこと」"),
    );
    expect(spec, "spec の「人間に決めてほしいこと」の箇条").toBeDefined();
    expect(sixWords(spec ?? "")).toEqual(run);
    expect(sixWords(spec ?? "")).toEqual(SIX);
  });

  it("spec で「混ぜるもの：」の箇条が「人間に決めてほしいこと」の箇条より前にある", async () => {
    const lines = await specLines();
    const mix = lines.findIndex((l) => l.startsWith("- 混ぜるもの："));
    const human = lines.findIndex((l) =>
      l.startsWith("- 「人間に決めてほしいこと」"),
    );
    expect(mix, "- 混ぜるもの：").toBeGreaterThanOrEqual(0);
    expect(human, "- 「人間に決めてほしいこと」").toBeGreaterThanOrEqual(0);
    expect(mix).toBeLessThan(human);
  });
});

describe("残った理由：run の手順8と手順11", () => {
  it("手順8に、理由ごとの件数・直したほうがよい（混ぜた）・ふだん「このままにする」がある", async () => {
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    expectAll(s8, [
      "理由ごとの件数",
      "直したほうがよい（混ぜた）",
      "ふだん「このままにする」",
      "「人間に決めてほしいこと」には残さない",
    ]);
  });

  it("手順11の行に「残った理由」がある", async () => {
    const lines = (await read("skills/run/SKILL.md")).split("\n");
    const line = lines.find((l) => /^11\. /.test(l));
    expect(line, "手順11が見つかりません").toBeDefined();
    expect(line).toContain("推奨に残った理由を添え");
  });
});

describe("残った理由：integrate の手順4", () => {
  it("一覧の並びに残った理由があり、理由のない古い項目は統括役がつけて添える", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    expectAll(s4, [
      "一覧（番号・見出し・残った理由・起きること・推奨と理由）",
      "統括役がつけた",
    ]);
  });

  it("「後続のタスクにする」の箇条は、タスク名を「〈ID〉 の残り」としない", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    expect(bulletLine(s4, "- 「後続のタスクにする」")).toContain(
      "「〈ID〉 の残り」としない",
    );
  });

  it("大事な共有のファイルの箇条は、変える・差分を見せる・「入れる」なら verify・コミットの順で、「入れる」の前に verify を流さない", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- 大事な共有のファイル");
    expectAll(line, [
      "変える → 差分を見せる → 「入れる」なら verify → コミット",
      "「入れる」の前に verify を流さない",
    ]);
  });

  it("new が worktree を作ったあとの失敗は、new の出力の案内を前置きとコマンドのない形も含めてそのまま写す", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const line = bulletLine(s4, "- new が worktree を作ったあとに失敗したとき");
    expectAll(line, [
      "new の出力の案内をそのまま",
      "「先にタスク長を止めてから」の前置き",
      "コマンドのない形",
      "（出力に残っているものか片付けの案内が出ているとき）",
    ]);
  });
});

describe("残った理由：spec の手順4（後続のタスクの1行）", () => {
  it("要点の「目的」の下に、前のタスクで直さなかった理由・出どころ・連なりを書く箇条がある（同じ1行）", async () => {
    const s4 = stepBlock(await read("skills/spec/SKILL.md"), 4);
    const line = s4
      .split("\n")
      .find((l) => l.includes("前のタスクで直さなかった理由："));
    expect(line, "「前のタスクで直さなかった理由：」の箇条").toBeDefined();
    expectAll(line ?? "", [
      "「目的」のすぐ下",
      "出どころ（〈ID〉の報告の〈番号〉）",
      "連なり",
      "T28 → T32",
    ]);
    expect(sixWords(line ?? "")).toEqual(SIX);
  });
});

describe("残った理由：範囲の文は3か所で同じ", () => {
  it("integrate の手順4・run の手順8・docs/spec.md に新しい範囲の文があり、古い文・ロックファイル・pnpm-workspace.yaml がない", async () => {
    const s4 = stepBlock(await read("skills/integrate/SKILL.md"), 4);
    const s8 = stepBlock(await read("skills/run/SKILL.md"), 8);
    const spec = await read("docs/spec.md");
    const places: [string, string][] = [
      ["integrate の手順4", s4],
      ["run の手順8", s8],
      ["docs/spec.md", spec],
    ];
    for (const [name, text] of places) {
      expect(text, `${name}に新しい範囲の文`).toContain(SCOPE);
      expect(text, `${name}に古い範囲の文`).not.toContain(OLD_SCOPE);
      for (const line of text.split("\n").filter((l) => l.includes(SCOPE))) {
        for (const w of [
          "pnpm-lock.yaml",
          "package-lock.json",
          "yarn.lock",
          "pnpm-workspace.yaml",
        ]) {
          expect(line, `${name}の範囲の文に ${w}`).not.toContain(w);
        }
      }
    }
  });
});

describe("残った理由：docs/spec.md", () => {
  it("10.1 の spec の行に「前のタスクで直さなかった理由」、integrate の行に「残った理由」と「「〈ID〉 の残り」としない」がある", async () => {
    const lines = await specLines();
    const specRow = lines.find((l) => l.startsWith("| `/orca-flow:spec "));
    const intRow = lines.find((l) => l.startsWith("| `/orca-flow:integrate "));
    expect(specRow, "spec の行").toBeDefined();
    expect(intRow, "integrate の行").toBeDefined();
    expect(specRow).toContain("前のタスクで直さなかった理由");
    expectAll(intRow ?? "", [
      "残った理由",
      "「〈ID〉 の残り」としない",
      "「入れる」のあとに verify",
      "new の出力の案内をそのまま",
    ]);
  });

  it("12章の7に「残った理由」・差分を見てから verify・中身で名づけることがある", async () => {
    const line = (await specLines()).find((l) => /^7\. \*\*統合\*\*/.test(l));
    expect(line, "12章の7").toBeDefined();
    expect(line).toContain("残った理由");
    expect(line).toContain("「入れる」と答えてから verify");
    expect(line).toContain("中身で名づけ");
  });

  it("9.1 の「要点」は4行の箇条に「前のタスクで直さなかった理由：」がある", async () => {
    const line = (await specLines()).find((l) =>
      l.startsWith("- 「要点」は4行"),
    );
    expect(line, "「要点」は4行の箇条").toBeDefined();
    expect(line).toContain("前のタスクで直さなかった理由：");
  });

  it("10.1 の表は run の行がいちばん長く（run の行に埋めの空白がない）、区切りの行は run の行の各列の幅と同じ", async () => {
    const lines = await specLines();
    const run = lines.find((l) => l.startsWith("| `/orca-flow:run "));
    expect(run, "run の行").toBeDefined();
    // prettier は各列を最長のセルに合わせて埋める。run の行に埋めがなければ run の3列目が最長。
    expect(run, "run の行の最後が埋めの空白").not.toMatch(/ {2}\|$/);
    const runIdx = lines.indexOf(run as string);
    const sep = lines.slice(runIdx).find((l) => l.startsWith("| ---"));
    const sepAbove = lines
      .slice(0, runIdx)
      .reverse()
      .find((l) => l.startsWith("| ---"));
    const sepLine = sepAbove ?? sep;
    expect(sepLine, "区切りの行").toBeDefined();
    const dashes = (sepLine as string)
      .slice(2, -2)
      .split(" | ")
      .map((c) => c.length);
    expect(dashes).toHaveLength(3);
    // 1・2列目は main の 10.1 の区切りの行の値。3列目は run の行の3列目の幅。
    const cells = (run as string).slice(2, -2).split(" | ");
    expect(cells).toHaveLength(3);
    expect(dashes[0]).toBe(50);
    expect(dashes[1]).toBe(33);
    expect(dashes[2]).toBe(width((cells[2] as string).trimEnd()));
  });
});
