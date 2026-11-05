import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/cli.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const choice = (heading: string, over: Record<string, string> = {}) => {
  const f = {
    選んだこと: "日付は ISO 形式で出す",
    理由: "並べ替えが楽になる",
    効く所: "一覧の画面と書き出し",
    出どころ: "2026-01-02 架空の仕様のページ",
    ...over,
  };
  return [
    `## ${heading}`,
    ...Object.entries(f).map(([k, v]) => (v === "" ? null : `- ${k}：${v}`)),
  ]
    .filter((l) => l !== null)
    .join("\n");
};

async function setup() {
  const root = await makeRepo();
  const file = path.join(root, ".git", "orca-flow", "choices.md");
  const cli = (...argv: string[]) =>
    runCli(["choices", ...argv], { cwd: root, runner: fakeOrca().runner });
  const draft = async (text: string, name = "draft.md") => {
    const p = path.join(path.dirname(root), name);
    await writeFile(p, text);
    return p;
  };
  return { root, file, cli, draft };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("choices", () => {
  it("COMMANDS に choices があり、使い方に行が出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("choices");
    const { root } = await setup();
    const r = await runCli(["--help"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(r.out + r.err).toContain("choices [--path]");
  });

  it("ファイルがないとき「人の選択はありません」で0", async () => {
    const { cli } = await setup();
    const r = await cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain("人の選択はありません");
  });

  it("--path は共通ディレクトリの下の orca-flow/choices.md を出す", async () => {
    const { cli, file } = await setup();
    const r = await cli("--path");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(file);
  });

  it("add した項を番号つきで出す", async () => {
    const { cli, draft } = await setup();
    expect((await cli("add", await draft(choice("日付の形")))).code).toBe(0);
    const r = await cli();
    expect(r.out).toContain("1. 日付の形");
    expect(r.out).toContain("- 選んだこと：日付は ISO 形式で出す");
  });

  it.each(["選んだこと", "理由", "効く所", "出どころ"])(
    "add は %s がない項を断り、ファイルを変えない",
    async (name) => {
      const { cli, draft, file } = await setup();
      const r = await cli("add", await draft(choice("見出し", { [name]: "" })));
      expect(r.code).toBe(1);
      expect(r.err).toContain(name);
      expect(await exists(file)).toBe(false);
    },
  );

  it.each([
    ["見出しがない", "- 選んだこと：a\n"],
    ["2項", `${choice("甲")}\n\n${choice("乙")}\n`],
    ["見出しの前に文がある", `前置き\n\n${choice("甲")}\n`],
  ])("add は %s下書きを断り、ファイルを作らない", async (_n, text) => {
    const { cli, draft, file } = await setup();
    const r = await cli("add", await draft(text));
    expect(r.code).toBe(1);
    expect(await exists(file)).toBe(false);
  });

  it.each(["https://www.notion.so/abc", "notion.com/x"])(
    "add は Notion の URL（%s）を含む項を断る",
    async (url) => {
      const { cli, draft, file } = await setup();
      const r = await cli(
        "add",
        await draft(choice("見出し", { 出どころ: `2026-01-02 ${url}` })),
      );
      expect(r.code).toBe(1);
      expect(await exists(file)).toBe(false);
    },
  );

  it("同じ見出しで同じ中身なら足さずに0、中身が違えば足さずに1", async () => {
    const { cli, draft, file } = await setup();
    await cli("add", await draft(choice("甲"), "a.md"));
    const before = await readFile(file);
    const same = await cli("add", await draft(choice("甲"), "b.md"));
    expect(same.code).toBe(0);
    expect(await readFile(file)).toEqual(before);
    const diff = await cli(
      "add",
      await draft(choice("甲", { 理由: "別の理由" }), "c.md"),
    );
    expect(diff.code).toBe(1);
    expect(diff.err).toContain("甲");
    expect(diff.err).toContain(
      "違う見出しで足してから古い項を remove --heading で消して",
    );
    expect(await readFile(file)).toEqual(before);
  });

  it("200行を越えるとき、足したうえで警告して0。ちょうど200行は警告なし", async () => {
    const { cli, draft, file } = await setup();
    const big = `${choice("大きい")}\n${Array.from({ length: 200 }, (_, i) => `  補足${i}`).join("\n")}\n`;
    const r = await cli("add", await draft(big));
    expect(r.code).toBe(0);
    expect(r.err).toContain("警告");
    expect(await readFile(file, "utf8")).toContain("## 大きい");
    const ok = await setup();
    const small = `${choice("ちょうど")}\n${Array.from({ length: 195 }, (_, i) => `  補足${i}`).join("\n")}\n`;
    const r2 = await ok.cli("add", await ok.draft(small));
    expect((await readFile(ok.file, "utf8")).trimEnd().split("\n").length).toBe(
      200,
    );
    expect(r2.err).toBe("");
  });

  it("別々のプロセスで add を10件同時に流しても全部入る", async () => {
    const { draft, file, root } = await setup();
    const bin = path.resolve(import.meta.dirname, "../../bin/orca-flow");
    const names = Array.from({ length: 10 }, (_, i) => `同時${i}`);
    const results = await Promise.all(
      names.map(async (h) =>
        testRunner(bin, ["choices", "add", await draft(choice(h), `${h}.md`)], {
          cwd: root,
        }),
      ),
    );
    for (const r of results) expect(r.stderr).toBe("");
    for (const r of results) expect(r.code).toBe(0);
    const text = await readFile(file, "utf8");
    for (const h of names) expect(text).toContain(`## ${h}\n`);
    expect(await exists(file.replace("choices.md", "choices.lock"))).toBe(
      false,
    );
  }, 60_000);

  describe("remove --heading", () => {
    const seed = async () => {
      const t = await setup();
      for (const h of ["甲", "乙", "丙"])
        await t.cli("add", await t.draft(choice(h), `${h}.md`));
      return t;
    };

    it("見出しが合えばその項だけを消して0", async () => {
      const { cli, file } = await seed();
      const r = await cli("remove", "2", "--heading", "乙");
      expect(r.code).toBe(0);
      const text = await readFile(file, "utf8");
      expect(text).toContain("## 甲");
      expect(text).not.toContain("## 乙");
      expect(text).toContain("## 丙");
    });

    it("見出しが違えば1でファイルを変えず、今の番号が文に入る", async () => {
      const { cli, file } = await seed();
      const before = await readFile(file);
      const r = await cli("remove", "1", "--heading", "丙");
      expect(r.code).toBe(1);
      expect(r.err).toContain("甲");
      expect(r.err).toContain("今の番号：3 番");
      expect(await readFile(file)).toEqual(before);
    });

    it("前後の空白を除いて比べ、--heading=値 の形も読む", async () => {
      const { cli, file } = await seed();
      expect((await cli("remove", "1", "--heading", "  甲 ")).code).toBe(0);
      expect((await cli("remove", "1", "--heading=乙")).code).toBe(0);
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("## 甲");
      expect(text).not.toContain("## 乙");
      expect(text).toContain("## 丙");
    });

    it("部分一致では消さない", async () => {
      const t = await setup();
      await t.cli("add", await t.draft(choice("甲乙"), "x.md"));
      const before = await readFile(t.file);
      const r = await t.cli("remove", "1", "--heading", "甲");
      expect(r.code).toBe(1);
      expect(await readFile(t.file)).toEqual(before);
    });

    it("範囲の外・見出しなし・番号が数字でないときは1で変えない", async () => {
      const { cli, file } = await seed();
      const before = await readFile(file);
      for (const argv of [
        ["remove", "9", "--heading", "甲"],
        ["remove", "1"],
        ["remove", "x", "--heading", "甲"],
        ["--heading", "甲"],
      ])
        expect((await cli(...argv)).code, argv.join(" ")).toBe(1);
      expect(await readFile(file)).toEqual(before);
    });
  });
});
