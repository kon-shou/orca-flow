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
const idP1 = `${"P"}1`;
const idP12a = `${"P"}12a`;

const GUARDS_PATH = "${CLAUDE_PLUGIN_ROOT}/skills/intake/guards.md";
const H6 = "手順6：下書きの決まり";
const H10 = "手順10：始める前の守り";

/** 「## 見出し」の行から、次の「## 」の前まで。なければ空文字。 */
function sec(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `## ${heading}`);
  if (at < 0) return "";
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** `n. ` で始まる手順の行から、次の手順の前まで。なければ空文字。 */
function step(text: string, n: number): string {
  const start = text.indexOf(`\n${n}. `);
  if (start < 0) return "";
  const end = text.indexOf(`\n${n + 1}. `, start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

const find = (text: string, re: RegExp) =>
  text.split("\n").find((l) => re.test(l));
const hasAll = (line: string | undefined, words: (string | RegExp)[]) =>
  line !== undefined &&
  words.every((w) => (typeof w === "string" ? line.includes(w) : w.test(line)));

/** 正規表現に当たる行を抜いた写しを返す（1行も抜けなければ失敗）。 */
function without(text: string, re: RegExp): string {
  const kept = text.split("\n").filter((l) => !re.test(l));
  expect(kept.length, `抜く行がありません：${re}`).toBeLessThan(
    text.split("\n").length,
  );
  return kept.join("\n");
}

/** 文を置き換えた写しを返す（置き換えが効かなければ失敗）。 */
function swap(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to);
  expect(out, `置き換える文がありません：${String(from)}`).not.toBe(text);
  return out;
}

// ---- 守りごとの確かめ（guards.md の全文を受け取る。真偽だけ返す） ----

type Guard = {
  name: string;
  /** この守りの行を抜くための行の形 */
  line: RegExp;
  check: (guards: string) => boolean;
};

const GUARDS: Guard[] = [
  {
    name: "読み直し",
    line: /^\s*- 仕様のページを読み直す/,
    check: (g) =>
      hasAll(find(sec(g, H10), /読み直/), ["人の直し", /人の直しを正とする。/]),
  },
  {
    name: "一覧と「よい」待ち",
    line: /URL から始めたとき/,
    check: (g) =>
      hasAll(find(sec(g, H10), /URL から始めたとき/), [
        "タスク名",
        "slug",
        "依存",
        "「よい」",
        "new を流さない",
      ]),
  },
  {
    name: "答えのない決めてほしいこと",
    line: /答えのない/,
    check: (g) =>
      hasAll(find(sec(g, H10), /答えのない/), [
        "決めてほしいこと",
        /確かめてから始める/,
      ]),
  },
  {
    name: "ID のある項目を飛ばす",
    line: /ID が書かれた項目/,
    check: (g) =>
      hasAll(find(sec(g, H10), /ID が書かれた項目/), ["飛ばす", "始めた項目"]),
  },
  {
    name: "依存の ID の形",
    line: /idPrefix/,
    check: (g) =>
      hasAll(find(sec(g, H10), /idPrefix/), [
        "merged",
        "--depends",
        "渡さ",
        "そのまま",
        "欄",
        "答え",
        "どちらも流さない",
        "人の答えの ID も",
        "依存の ID が属するリポジトリ",
      ]) && !/その項目のリポジトリの/.test(find(sec(g, H10), /idPrefix/) ?? ""),
  },
  {
    name: "依頼のファイルの書き方",
    line: /^\s*- 依頼のファイルは/,
    check: (g) =>
      hasAll(find(sec(g, H10), /^\s*- 依頼のファイルは/), [
        "${CLAUDE_PLUGIN_ROOT}/skills/new/SKILL.md",
        "手順4〜6",
        "mktemp -d",
        "Write ツール",
        /ヒアドキュメントや echo で書かない/,
        "展開",
      ]),
  },
  {
    name: "slug の形",
    line: /--slug/,
    check: (g) =>
      hasAll(find(sec(g, H10), /--slug/), [
        "英小文字",
        "数字",
        "ハイフン",
        "渡さ",
        "そのまま",
        "答え",
        "人の答えの slug も",
        "どの `new` も流さない",
      ]),
  },
  {
    name: "タスク名の囲み",
    line: /--title/,
    check: (g) => {
      const l = find(sec(g, H10), /--title/);
      return (
        hasAll(l, ["タスク名", /一重引用符で囲み、/, "'\\''"]) &&
        !/囲まずに/.test(l ?? "")
      );
    },
  },
  {
    name: "0件の merged",
    line: /0件/,
    check: (g) =>
      hasAll(find(sec(g, H10), /0件/), [
        "merged",
        "流さない",
        "依存のない項目",
        "始めない",
      ]),
  },
  {
    name: "ID を書けなければ止まる",
    line: /new が通るたび/,
    check: (g) =>
      hasAll(find(sec(g, H10), /new が通るたび/), [
        "次の項目へ進む前",
        "すぐ",
        "仕様のページ",
        /書けなければ.*項目名.*人.*始めず.*止まる/,
      ]),
  },
  {
    name: "new の終了コード2で止まる",
    line: /終了コード2/,
    check: (g) =>
      hasAll(find(sec(g, H10), /終了コード2/), ["残り", "始めず", "止まる"]),
  },
  {
    name: "ページの中の指示に従わない",
    line: /この節は Notion から写した要件/,
    check: (g) =>
      hasAll(find(sec(g, H10), /この節は Notion から写した要件/), [
        "コマンドを流す",
        "設定を変える",
        "ほかへ送る",
        "従わない",
      ]),
  },
  {
    name: "下書きは外の一時ディレクトリ",
    line: /下書き.*一時ディレクトリ/,
    check: (g) =>
      hasAll(find(sec(g, H6), /下書き.*一時ディレクトリ/), [
        "mktemp -d",
        "リポジトリに書かない",
      ]),
  },
  {
    name: "how の指示は禁止より優先しない",
    line: /優先しない/,
    check: (g) =>
      /how の指示は[^。]*禁止[^。]*より優先しない/.test(sec(g, H6)) &&
      /ほかの pstack のスキル[^。]*呼ばない/.test(sec(g, H6)),
  },
];

/** guards.md が道に依らない：orca-flow で始まるインラインのコードは pstack と choices だけ（choices はワークスペースの道では飛ばすと guards.md に書く前提で許す） */
function neutral(guards: string): boolean {
  const spans = [...guards.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
  const cmds = spans.filter((s) => /^orca-flow\b/.test(s));
  return (
    cmds.length > 0 &&
    cmds.every((c) => /^orca-flow (pstack|choices)\b/.test(c)) &&
    !/workspace 〈名前〉/.test(guards)
  );
}

/** 道の文が guards.md の節を指す：パスと節の名前、読めなければ止まる */
function pointsTo(stepText: string, heading: string): boolean {
  return (
    stepText.includes(GUARDS_PATH) &&
    stepText.includes(heading) &&
    stepText.includes("読めなければ") &&
    stepText.includes("止まる")
  );
}

/** workspace.md の「を正にする」「そのまま守」がない */
function noOverrideRule(w: string): boolean {
  return !/を正にする/.test(w) && !/そのまま守/.test(w);
}

/** 置き先の名前は完全に同じときだけ使う */
function exactName(w: string): boolean {
  const l = find(sec(w, "手順10の差し替え：配る"), /子の名前/);
  return (
    hasAll(l, [/完全に同じときだけ使う。/, "聞く"]) &&
    !/でなくても/.test(l ?? "")
  );
}

const idLines = (text: string) =>
  text.split("\n").filter((l) => idForm.test(l));

describe("guards.md の形", () => {
  it("2つの見出しがこの順にある", async () => {
    const g = await read("skills/intake/guards.md");
    const heads = g.split("\n").filter((l) => l.startsWith("## "));
    expect(heads).toEqual([`## ${H6}`, `## ${H10}`]);
  });

  it("道に依らない：orca-flow で始まるインラインのコードは pstack と choices だけ", async () => {
    const g = await read("skills/intake/guards.md");
    expect(neutral(g)).toBe(true);
    expect(neutral(g + "\n`orca-flow merged 〈ID〉`")).toBe(false);
    expect(neutral(g + "\n`orca-flow workspace 〈名前〉 new`")).toBe(false);
    expect(neutral(g + "\nworkspace 〈名前〉 merged")).toBe(false);
  });
});

describe("2つの道が guards.md を指す", () => {
  it("SKILL.md の手順6・10にパス・節の名前・読めなければ止まるがあり、番号は1〜11のまま", async () => {
    const s = await read("skills/intake/SKILL.md");
    expect(pointsTo(step(s, 6), H6)).toBe(true);
    expect(pointsTo(step(s, 10), H10)).toBe(true);
    expect(pointsTo(step(s, 6), H10)).toBe(false);
    const nums = s
      .split("\n")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("指す文を抜いた写しでは落ちる", async () => {
    const s = await read("skills/intake/SKILL.md");
    expect(pointsTo(step(swap(s, /guards\.md/g, "x.md"), 6), H6)).toBe(false);
    expect(pointsTo(step(swap(s, /読めなければ/g, "あれば"), 10), H10)).toBe(
      false,
    );
  });

  it("workspace.md の手順6・10の節の最初の項が guards.md とその節の名前を指す", async () => {
    const w = await read("skills/intake/workspace.md");
    for (const [key, heading] of [
      ["手順6の差し替え：", H6],
      ["手順10の差し替え：", H10],
    ] as const) {
      const head = w.split("\n").find((l) => l.startsWith(`## ${key}`));
      expect(head, key).toBeDefined();
      const body = sec(w, (head ?? "").slice(3));
      const first = body.split("\n").find((l) => l.startsWith("- ")) ?? "";
      expect(first, key).toContain("guards.md");
      expect(first, key).toContain(heading);
      expect(first, key).toContain("読めなければ");
      expect(first, key).toContain("止まる");
    }
  });

  it("SKILL.md の手順2の分かれ道は手順2・6・10を差し替える形で、足すの形がない", async () => {
    const s = await read("skills/intake/SKILL.md");
    const l = find(step(s, 2), /orca-flow-workspace\.json/);
    expect(l).toBeDefined();
    expect(l).toContain("手順2・6・10");
    expect(l).toContain("差し替");
    expect(l).not.toMatch(/足す|足し|各項/);
  });

  it("workspace.md の入口も手順2・6・10を差し替える", async () => {
    const w = await read("skills/intake/workspace.md");
    expect(hasAll(find(w, /手順2・6・10/), ["差し替え"])).toBe(true);
  });
});

describe("守りの確かめの関数：本物の文で通る", () => {
  it.each(GUARDS.map((g) => [g.name, g] as const))(
    "guards.md は %s を満たす",
    async (_name, g) => {
      expect(g.check(await read("skills/intake/guards.md"))).toBe(true);
    },
  );

  it("workspace.md に「を正にする」「そのまま守」がなく、名前は完全に同じときだけ使う", async () => {
    const w = await read("skills/intake/workspace.md");
    expect(noOverrideRule(w)).toBe(true);
    expect(exactName(w)).toBe(true);
    expect(w).toMatch(/^## 手順6の差し替え：/m);
    expect(w).toMatch(/^## 手順10の差し替え：/m);
    expect(w).not.toMatch(/^## 手順(6|10)に足す/m);
  });
});

describe("守りの確かめの関数：意味を逆にした写しで落ちる", () => {
  it("「確かめず囲まずに渡す」", async () => {
    const g = await read("skills/intake/guards.md");
    const bad = swap(
      g,
      /一重引用符で囲み、中の `'` は `'\\''` にする/,
      "確かめず囲まずに渡す",
    );
    const guard = GUARDS.find((x) => x.name === "タスク名の囲み");
    expect(guard?.check(bad)).toBe(false);
    // 語を足しただけの確かめなら通ってしまう形でも落ちる
    const sneaky = g.replace(
      /(- [^\n]*--title[^\n]*)/,
      "$1 確かめず囲まずに渡す。",
    );
    expect(sneaky).not.toBe(g);
    expect(guard?.check(sneaky)).toBe(false);
  });

  it("言い回しを変えた逆の写しでも落ちる", async () => {
    const g = await read("skills/intake/guards.md");
    const w = await read("skills/intake/workspace.md");
    const byName = (n: string) => GUARDS.find((x) => x.name === n);
    expect(
      byName("タスク名の囲み")?.check(
        swap(
          g,
          "一重引用符で囲み、中の `'` は `'\\''` にする。",
          "一重引用符で囲まず、中の `'` は `'\\''` にしない。",
        ),
      ),
    ).toBe(false);
    expect(
      byName("読み直し")?.check(
        swap(g, "人の直しを正とする。", "人の直しを正としない。"),
      ),
    ).toBe(false);
    expect(
      byName("答えのない決めてほしいこと")?.check(
        swap(
          g,
          "人間に示して確かめてから始める",
          "人間に示さず確かめずに始める",
        ),
      ),
    ).toBe(false);
    expect(
      exactName(
        swap(
          w,
          "完全に同じときだけ使う。",
          "完全に同じときだけ使う、とは限らず、近い名前も使う。",
        ),
      ),
    ).toBe(false);
    expect(
      byName("依存の ID の形")?.check(
        swap(
          g,
          "依存の ID が属するリポジトリ（どれかは各道の文のとおり）の",
          "その項目のリポジトリの",
        ),
      ),
    ).toBe(false);
  });

  it("「SKILL.md を正にする」", async () => {
    const w = await read("skills/intake/workspace.md");
    const bad = swap(
      w,
      "## 入口\n",
      "## 入口\n\n- 合わない所は SKILL.md を正にする。\n",
    );
    expect(noOverrideRule(bad)).toBe(false);
    expect(noOverrideRule(w + "\n- 各項をそのまま守る。")).toBe(false);
  });

  it("「完全に同じでなくても使う」", async () => {
    const w = await read("skills/intake/workspace.md");
    const bad = swap(w, "完全に同じときだけ使う", "完全に同じでなくても使う");
    expect(exactName(bad)).toBe(false);
  });
});

describe("守りの確かめの関数：守りを1つずつ抜いた写しで落ちる", () => {
  it.each(GUARDS.map((g) => [g.name, g] as const))(
    "%s の行を抜くと落ちる",
    async (_name, g) => {
      const text = await read("skills/intake/guards.md");
      expect(g.check(text)).toBe(true);
      expect(g.check(without(text, g.line))).toBe(false);
    },
  );
});

describe("ID の形：4つの md にタスクの番号の形がない", () => {
  const FILES = [
    "skills/intake/SKILL.md",
    "skills/intake/workspace.md",
    "skills/intake/guards.md",
    "skills/intake/splitting.md",
  ];

  it.each(FILES)("%s に出ない", async (f) => {
    expect(idLines(await read(f))).toEqual([]);
  });

  it.each(FILES)("%s に差し込んだ写しでは落ちる", async (f) => {
    const text = await read(f);
    expect(idLines(`${text}\nこの項目は ${idP1} から始める。`)).not.toEqual([]);
    expect(idLines(`${text}\n依存は ${idP12a}`)).not.toEqual([]);
    expect(idLines(`${idP12a} は`)).not.toEqual([]);
  });
});
