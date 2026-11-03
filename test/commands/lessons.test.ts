import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const lesson = (heading: string, over: Record<string, string> = {}) => {
  const f = {
    決まり: "入力は境界で確かめる",
    理由: "内側で壊れると原因が遠い",
    見分け方: "検証なしで値を渡している",
    観点: "正しさ",
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
  const common = path.join(root, ".git");
  const file = path.join(common, "orca-flow", "lessons.md");
  const cli = (...argv: string[]) =>
    runCli(["lessons", ...argv], { cwd: root, runner: fakeOrca().runner });
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

describe("lessons", () => {
  it("ファイルがないとき「教訓はありません」で0", async () => {
    const { cli } = await setup();
    const r = await cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain("教訓はありません");
  });

  it("--path は共通ディレクトリの下の絶対パスを出す", async () => {
    const { cli, file, root } = await setup();
    const r = await cli("--path");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(file);
    expect(path.isAbsolute(r.out.trim())).toBe(true);
    // worktree からでも同じ
    await git(
      root,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "x",
      path.join(path.dirname(root), "wt"),
    );
    const r2 = await runCli(["lessons", "--path"], {
      cwd: path.join(path.dirname(root), "wt"),
      runner: fakeOrca().runner,
    });
    expect(r2.out.trim()).toBe(file);
  });

  it("add した項を番号つきで出す", async () => {
    const { cli, draft } = await setup();
    expect((await cli("add", await draft(lesson("境界で確かめる")))).code).toBe(
      0,
    );
    const r = await cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain("1. 境界で確かめる");
    expect(r.out).toContain("- 決まり：入力は境界で確かめる");
  });

  it.each(["決まり", "理由", "見分け方", "観点"])(
    "add は %s がない項を断り、ファイルを変えない",
    async (name) => {
      const { cli, draft, file } = await setup();
      const r = await cli("add", await draft(lesson("見出し", { [name]: "" })));
      expect(r.code).toBe(1);
      expect(r.err).toContain(name);
      expect(await exists(file)).toBe(false);
    },
  );

  it("add は見出しがない項を断る", async () => {
    const { cli, draft, file } = await setup();
    const r = await cli(
      "add",
      await draft("- 決まり：a\n- 理由：b\n- 見分け方：c\n- 観点：d\n"),
    );
    expect(r.code).toBe(1);
    expect(await exists(file)).toBe(false);
  });

  it("add は ID の形を含む項を断り、既存のファイルを変えない", async () => {
    const { cli, draft, file } = await setup();
    await cli("add", await draft(lesson("一つ目"), "a.md"));
    const before = await readFile(file, "utf8");
    const r = await cli(
      "add",
      await draft(lesson("二つ目", { 理由: "T12 で起きた" }), "b.md"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("T12");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("add は手元の絶対パスを含む項を断る", async () => {
    const { cli, draft, file, root } = await setup();
    for (const bad of [
      "/home/someone/work/a.ts を直した",
      `${root} の中`,
      "C:\\Users\\me\\a.ts",
    ]) {
      const r = await cli(
        "add",
        await draft(lesson("見出し", { 見分け方: bad })),
      );
      expect(r.code).toBe(1);
    }
    expect(await exists(file)).toBe(false);
    // 相対パスや /orca-flow:new は通る
    const ok = await cli(
      "add",
      await draft(
        lesson("見出し", { 見分け方: "src/lib/a.ts や /orca-flow:new" }),
      ),
    );
    expect(ok.code).toBe(0);
  });

  it("add は /dev/null や API のパスのような手元でないパスを通す", async () => {
    const { cli, draft, file } = await setup();
    const r = await cli(
      "add",
      await draft(
        lesson("見出し", {
          見分け方: "cmd 2>/dev/null、/api/home/:id、/v1/messages、/etc/hosts",
        }),
      ),
    );
    expect(r.code).toBe(0);
    expect(await readFile(file, "utf8")).toContain("2>/dev/null");
  });

  it("add は /home/someone/x を含む項を断る", async () => {
    const { cli, draft, file } = await setup();
    const r = await cli(
      "add",
      await draft(lesson("見出し", { 見分け方: "cmd /home/someone/x を見る" })),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("/home/someone/x");
    expect(await exists(file)).toBe(false);
  });

  it("add は idPrefix が Q のリポジトリで Q911・Q911a を断り、T12 は通す", async () => {
    const root = await makeRepo({ idPrefix: "Q" });
    const file = path.join(root, ".git", "orca-flow", "lessons.md");
    const run = (...argv: string[]) =>
      runCli(["lessons", ...argv], { cwd: root, runner: fakeOrca().runner });
    const put = async (text: string, name: string) => {
      const p = path.join(path.dirname(root), name);
      await writeFile(p, text);
      return p;
    };
    for (const bad of ["Q911 で起きた", "Q911a で起きた"]) {
      const r = await run(
        "add",
        await put(lesson("見出し", { 理由: bad }), "bad.md"),
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("Q911");
    }
    expect(await exists(file)).toBe(false);
    const ok = await run(
      "add",
      await put(lesson("見出し", { 理由: "T12 は別の形" }), "ok.md"),
    );
    expect(ok.code).toBe(0);
  });

  it("200行以下のとき警告を出さない", async () => {
    const { cli, draft } = await setup();
    const r = await cli("add", await draft(lesson("小さい")));
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("足したあとちょうど200行なら警告なし、201行なら警告して0", async () => {
    const { cli, draft, file } = await setup();
    // lesson() は5行。足すと 5 + 1（空行）+ 既存の行数
    const padded = (n: number) =>
      `## 既存\n- 決まり：a\n- 理由：b\n- 見分け方：c\n- 観点：d\n${Array.from({ length: n }, (_, i) => `  補足${i}`).join("\n")}\n`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(file), { recursive: true });
    // 既存 = 5 + n 行、足す 5 行、間の空行 1 → 11 + n
    await writeFile(file, padded(189));
    const exact = await cli("add", await draft(lesson("新1"), "n1.md"));
    expect(exact.code).toBe(0);
    expect((await readFile(file, "utf8")).trimEnd().split("\n").length).toBe(
      200,
    );
    expect(exact.err).toBe("");
    await writeFile(file, padded(190));
    const over = await cli("add", await draft(lesson("新2"), "n2.md"));
    expect(over.code).toBe(0);
    expect((await readFile(file, "utf8")).trimEnd().split("\n").length).toBe(
      201,
    );
    expect(over.err).toContain("警告");
  });

  it("200行を越えるとき、足したうえで警告して0で終わる", async () => {
    const { cli, draft, file } = await setup();
    const big = `${lesson("大きい")}\n${Array.from({ length: 200 }, (_, i) => `  補足${i}`).join("\n")}\n`;
    const r = await cli("add", await draft(big));
    expect(r.code).toBe(0);
    expect(r.err).toContain("警告");
    expect(r.err).toContain("200");
    expect(await readFile(file, "utf8")).toContain("## 大きい");
  });

  it("別々のプロセスで add を10件同時に流しても全部入る", async () => {
    const { draft, file, root } = await setup();
    const bin = path.resolve(import.meta.dirname, "../../bin/orca-flow");
    const names = Array.from({ length: 10 }, (_, i) => `同時${i}`);
    const results = await Promise.all(
      names.map(async (h) =>
        testRunner(bin, ["lessons", "add", await draft(lesson(h), `${h}.md`)], {
          cwd: root,
        }),
      ),
    );
    for (const r of results) expect(r.stderr).toBe("");
    for (const r of results) expect(r.code).toBe(0);
    const text = await readFile(file, "utf8");
    for (const h of names) expect(text).toContain(`## ${h}\n`);
    expect(await exists(file.replace("lessons.md", "lessons.lock"))).toBe(
      false,
    );
  }, 60_000);

  it("remove は指した項だけを消す", async () => {
    const { cli, draft, file } = await setup();
    for (const h of ["甲", "乙", "丙"])
      await cli("add", await draft(lesson(h), `${h}.md`));
    const r = await cli("remove", "2");
    expect(r.code).toBe(0);
    const text = await readFile(file, "utf8");
    expect(text).toContain("## 甲");
    expect(text).not.toContain("## 乙");
    expect(text).toContain("## 丙");
    expect((await cli("remove", "3")).code).toBe(1);
    expect((await cli("remove", "x")).code).toBe(1);
    expect(await readFile(file, "utf8")).toBe(text);
  });

  describe("remove --heading", () => {
    const seed = async () => {
      const t = await setup();
      for (const h of ["甲", "乙", "丙"])
        await t.cli("add", await t.draft(lesson(h), `${h}.md`));
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

    it("前後の空白を除いて比べ、--heading=値 の形も読む", async () => {
      const { cli, file } = await seed();
      expect((await cli("remove", "1", "--heading", "  甲 ")).code).toBe(0);
      expect((await cli("remove", "1", "--heading=乙")).code).toBe(0);
      expect(await readFile(file, "utf8")).not.toContain("## 乙");
    });

    it("見出しが違えば1で、ファイルは1バイトも変わらず、今の見出しと渡した見出しの番号が文に入る", async () => {
      const { cli, file } = await seed();
      const before = await readFile(file);
      const r = await cli("remove", "1", "--heading", "丙");
      expect(r.code).toBe(1);
      expect(r.err).toContain("甲");
      expect(r.err).toContain("3");
      expect(await readFile(file)).toEqual(before);
      const none = await cli("remove", "1", "--heading", "丁");
      expect(none.code).toBe(1);
      expect(none.err).toContain("甲");
      expect(none.err).toContain("ない");
      expect(await readFile(file)).toEqual(before);
    });

    it("部分一致では消さない", async () => {
      const { cli, file } = await seed();
      const before = await readFile(file);
      expect((await cli("remove", "1", "--heading", "甲甲")).code).toBe(1);
      expect(await readFile(file)).toEqual(before);
    });

    it("番号がずれたあとの古い番号と見出しでは、関係のない項を消さず1", async () => {
      const { cli, file } = await seed();
      expect((await cli("remove", "1")).code).toBe(0);
      const before = await readFile(file);
      const r = await cli("remove", "2", "--heading", "乙");
      expect(r.code).toBe(1);
      expect(r.err).toContain("丙");
      expect(r.err).toContain("1");
      expect(await readFile(file)).toEqual(before);
    });

    it("範囲の外の番号は見出しがあっても1で変えない", async () => {
      const { cli, file } = await seed();
      const before = await readFile(file);
      expect((await cli("remove", "9", "--heading", "甲")).code).toBe(1);
      expect(await readFile(file)).toEqual(before);
    });

    it("値がない・remove 以外と使ったときは1でファイルを変えない", async () => {
      const { cli, file, draft } = await seed();
      const before = await readFile(file);
      for (const argv of [
        ["remove", "1", "--heading"],
        ["--heading", "甲"],
        ["--path", "--heading", "甲"],
        ["add", await draft(lesson("丁"), "丁.md"), "--heading", "丁"],
      ]) {
        const r = await cli(...argv);
        expect(r.code, argv.join(" ")).toBe(1);
      }
      expect(await readFile(file)).toEqual(before);
    });
  });
});
