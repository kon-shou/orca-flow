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

  it("orca-flow で始まるインラインのコードは workspace と pstack だけで、子のサブコマンドは許す4つ", async () => {
    const t = await read("skills/intake/workspace.md");
    const spans = [...t.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
    const cmds = spans.filter((s) => /^orca-flow\s/.test(s));
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c, c).toMatch(/^orca-flow (workspace|pstack)\b/);
    }
    const sub = [...t.matchAll(/workspace 〈名前〉 ([^\s`〈]+)/g)].map(
      (m) => m[1] as string,
    );
    expect(sub.length).toBeGreaterThan(0);
    for (const s of sub) {
      expect(["config", "active", "merged", "new"], s).toContain(s);
    }
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

  it("順の行が 共通の項目 → 共通の版を出す → アプリの版上げ → アプリの項目 の並びである", async () => {
    const t = await read("skills/intake/workspace.md");
    const l = lines(t).find((x) => x.startsWith("- 順："));
    expect(l).toBeDefined();
    const a = l?.indexOf("共通の項目") ?? -1;
    const b = l?.indexOf("共通の版を出す") ?? -1;
    const c = l?.indexOf("アプリの版上げ") ?? -1;
    const d = l?.indexOf("アプリの項目") ?? -1;
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
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

  it("依存の欄は同じリポジトリの依存も 〈名前〉:〈ID〉 で書く", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(has(t, "同じリポジトリの依存も", "〈名前〉:〈ID〉")).toBe(true);
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
