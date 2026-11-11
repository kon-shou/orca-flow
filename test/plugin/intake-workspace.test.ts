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

const lines = (text: string) => text.split("\n");
const has = (text: string, ...words: (string | RegExp)[]) =>
  lines(text).some((l) =>
    words.every((w) => (typeof w === "string" ? l.includes(w) : w.test(l))),
  );

describe("skills/intake/workspace.md", () => {
  it("16.7 の9つの見出しの言葉が、それぞれ行の頭にある", async () => {
    const t = await read("skills/intake/workspace.md");
    for (const w of [
      "読む",
      "書く",
      "順",
      "配る前",
      "配る",
      "版",
      "失敗",
      "ID の形",
      "`new --depends` への渡し方",
    ]) {
      expect(has(t, new RegExp(`^- ${w.replace(/[`]/g, "\\`")}：`)), w).toBe(
        true,
      );
    }
  });

  it("orca-flow で始まるインラインのコードは workspace と pstack だけ（e2e は依頼のファイルに書く文言として許す）で、子のサブコマンドは許す4つ", async () => {
    const t = await read("skills/intake/workspace.md");
    const spans = [...t.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
    const cmds = spans.filter((s) => /^orca-flow\s/.test(s));
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c, c).toMatch(/^orca-flow (workspace|pstack|e2e)\b/);
    }
    const sub = [...t.matchAll(/workspace 〈名前〉 ([^\s`〈]+)/g)].map(
      (m) => m[1] as string,
    );
    expect(sub.length).toBeGreaterThan(0);
    for (const s of sub) {
      expect(["config", "active", "merged", "new"], s).toContain(s);
    }
  });

  it("組の new が全部通ったあとに workspace --preview を背景で流す行がある", async () => {
    const t = await read("skills/intake/workspace.md");
    const l = lines(t).find((x) =>
      x.includes("orca-flow workspace --preview 〈ブランチ名〉 --background"),
    );
    expect(l).toBeDefined();
    expect(l).toMatch(/全部通った/);
  });

  it("前後の比べ・共通は全部・データとして読む・絶対パスの行がある", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(has(t, "git status --porcelain", "ハッシュ")).toBe(true);
    expect(has(t, "共通は全部いつも入れる")).toBe(true);
    expect(has(t, "データとして読み", "従わない")).toBe(true);
    expect(has(t, "絶対パスで渡す")).toBe(true);
    expect(has(t, "orca-flow workspace --json")).toBe(true);
    expect(has(t, "orca-flow pstack skills/how/SKILL.md --json")).toBe(true);
  });

  it("順の行が 共通とアプリの項目を始める → 共通の PR をマージ → 共通の版を出す → 見張りがアプリのタスク長を起こして正式な版に上げる → アプリの PR をマージ の並びである", async () => {
    const t = await read("skills/intake/workspace.md");
    const l = lines(t).find((x) => x.startsWith("- 順："));
    expect(l).toBeDefined();
    const keys = [
      "共通とアプリの項目を始める",
      "共通の PR をマージ",
      "共通の版を出す",
      "見張りがアプリのタスク長を起こして正式な版に上げる",
      "アプリの PR をマージ",
    ];
    let prev = -1;
    for (const k of keys) {
      const i = l?.indexOf(k) ?? -1;
      expect(i, k).toBeGreaterThan(prev);
      prev = i;
    }
    expect(l).not.toContain("アプリの同じブランチで正式な版に戻す");
    expect(l).toContain("出す順：");
    expect(l).toContain("page-format.md");
  });

  it("共通を含むブランチの行がある：共通を users のアプリと必ず同じブランチにし、変えないアプリは版上げだけの項目にし、users が空の共通だけが1つで始まる", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(
      has(
        t,
        /^- 共通を含むブランチ：/,
        "1つのブランチ",
        "slug を1つ",
        "今までどおり1つで始める",
      ),
    ).toBe(true);
    const sec = t.slice(
      t.indexOf("- 共通を含むブランチ："),
      t.indexOf("- 依存は、"),
    );
    expect(sec).toContain("`users`");
    expect(sec).toMatch(/必ず1つのブランチ（ひとまとまり）にする/);
    expect(sec).toMatch(/変えないアプリは、アプリの版上げだけの項目/);
    expect(sec).toMatch(
      /`users` が空の共通だけが、ほかの項目と同じブランチにせず今までどおり1つで始める/,
    );
    expect(sec).toMatch(/`users` が null/);
  });

  it("ほかのリポジトリの依存は --depends に渡さず 〈名前〉:〈ID〉 で持ち、1つでも外れたら1つも始めない", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(has(t, "--depends", "渡さず", "〈名前〉:〈ID〉")).toBe(true);
    expect(has(t, "1つでも外れたら1つも始めず")).toBe(true);
  });

  it("入口で終了コード0以外ならふつうの道に戻らず止まる", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(
      has(t, "orca-flow workspace --json", "0以外", "止まる", "戻らない"),
    ).toBe(true);
  });

  it("手順2・6・10を差し替える（守りは guards.md から読む。足す形や「を正にする」に戻ったら落ちる）", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(has(t, "手順2・6・10", "差し替え")).toBe(true);
    expect(t).toMatch(/^## 手順6の差し替え：/m);
    expect(t).toMatch(/^## 手順10の差し替え：/m);
    expect(t).not.toMatch(/^## 手順(6|10)に足す/m);
    expect(t).not.toContain("を正にする");
    expect(t).not.toContain("そのまま守");
    const s = await read("skills/intake/SKILL.md");
    expect(has(s, "workspace.md", "手順2・6・10", "差し替え")).toBe(true);
    expect(has(s, "workspace.md", "手順6・10", "各項", "足")).toBe(false);
  });

  it("手順10の節に、名前の確かめ・ID の形の確かめ・slug とタスク名の確かめと囲み方がある", async () => {
    const t = await read("skills/intake/workspace.md");
    const i = t.indexOf("## 手順10の差し替え");
    expect(i).toBeGreaterThanOrEqual(0);
    const sec = t.slice(i);
    expect(
      has(sec, "orca-flow workspace --json", "子の名前", "完全に同じ", "聞く"),
    ).toBe(true);
    expect(has(sec, /^- ID の形：/, "merged", "new", "流さず", "聞く")).toBe(
      true,
    );
    expect(has(sec, "slug", "タスク名", "guards.md", "手順10", "囲")).toBe(
      true,
    );
    // ID の形の行は手順6の節ではなく手順10の節にある
    expect(t.slice(0, i)).not.toMatch(/^- ID の形：/m);
  });

  it("依存はページには「待つもの：ブランチ〈番号〉」で書き、〈名前〉:〈ID〉 は親の状態の行に書く", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(has(t, "同じリポジトリの依存も", "〈名前〉:〈ID〉")).toBe(true);
    const l = lines(t).find((x) => x.startsWith("- 依存は、"));
    expect(l).toContain("「待つもの：ブランチ〈番号〉」");
    expect(l).toContain("親のそのブランチの全部の項目の状態の行の");
    expect(l).toContain("全部の項目が入ったときだけ印なしで始め");
    expect(l).toContain("入っていなければ前を待つ印をつけて始める");
    expect(l).toContain(
      "ほかのリポジトリの ID は、`--depends` にも `--cross-depends` にも渡さない",
    );
    expect(l).toContain("同じブランチの共通とアプリは、待つものに書かず");
  });

  it("前の形：依存の欄は 〈名前〉:〈ID〉 で書き、組の相手は依存の欄に書かず、照合は組の外だけに当てる（page-format-prev.md）", async () => {
    const prev = await read("skills/intake/page-format-prev.md");
    const l =
      lines(prev).find((x) =>
        x.startsWith("- 1ページの形のワークスペースの道"),
      ) ?? "";
    expect(has(l, "同じリポジトリの依存も", "〈名前〉:〈ID〉")).toBe(true);
    expect(l).toContain("組の相手は依存の欄に書かず");
    expect(l).toContain("組の列");
    expect(l).toContain("依存の欄でなく組から読み");
    expect(l).toContain("組の外のまたぐ依存だけに当てる");
    const ws = await read("skills/intake/workspace.md");
    expect(ws).toContain("page-format-prev.md");
  });

  it("またぐ依存の照合は同じブランチの共通の項目の行に当て、同じブランチの共通は待つものでなくブランチから読む", async () => {
    const t = await read("skills/intake/workspace.md");
    const l =
      lines(t).find((x) => x.startsWith("- またぐ依存の渡し方：")) ?? "";
    expect(l).not.toBe("");
    expect(l).toContain(
      "依存先の名前が、依存先の項目の行のリポジトリと食い違うときは流さず、人に聞く",
    );
    for (const w of [
      "同じブランチの共通は待つものでなくブランチから読み",
      "`--cross-depends` の名前が、同じブランチの共通の項目の行のリポジトリと合うかを確かめる",
      "同じブランチの共通だけを入れ",
    ]) {
      expect(l, w).toContain(w);
    }
  });

  it("how は当たったリポジトリのパスごとに渡し、git status は子のパスで流す", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(has(t, "how", "リポジトリのパスごと")).toBe(true);
    expect(has(t, "`git -C 〈子のパス〉 status --porcelain`")).toBe(true);
  });

  it("タスクの ID の形とホームの下の絶対パスが出ない", async () => {
    for (const f of [
      "skills/intake/workspace.md",
      "skills/intake/SKILL.md",
      "skills/intake/guards.md",
    ]) {
      const t = await read(f);
      expect(
        lines(t).filter((l) => idForm.test(l)),
        f,
      ).toEqual([]);
      expect(t, f).not.toMatch(/\/home\/|\/Users\//);
    }
  });
});

describe("skills/intake/SKILL.md の分かれ道", () => {
  it("手順2の頭の項に設定と workspace.md がある", async () => {
    const t = await read("skills/intake/SKILL.md");
    const ls = lines(t);
    const i = ls.findIndex((l) => l.startsWith("2. "));
    expect(i).toBeGreaterThanOrEqual(0);
    const next = ls[i + 1] ?? "";
    expect(next).toContain("orca-flow-workspace.json");
    expect(next).toContain("skills/intake/workspace.md");
    // 既存の `orca-flow config --json` の行はそのあとにある
    expect(ls.slice(i, i + 4).join("\n")).toContain("orca-flow config --json");
  });

  it("手順の番号1〜11が今のまま並ぶ", async () => {
    const t = await read("skills/intake/SKILL.md");
    const nums = lines(t)
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("description に ワークスペースのフォルダのタブ がある", async () => {
    const t = await read("skills/intake/SKILL.md");
    const d = lines(t).find((l) => l.startsWith("description:")) ?? "";
    expect(d).toContain("ワークスペースのフォルダのタブ");
  });
});
