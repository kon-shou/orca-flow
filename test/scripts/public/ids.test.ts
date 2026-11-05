import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseList } from "../../../scripts/public/common.ts";
import { idPattern } from "../../../scripts/public/ids.ts";
import {
  EMAIL,
  NAME,
  WORD_1,
  WORD_2,
  WORD_JA,
  writeWords,
  git,
  publicTip,
  readyBox,
  runScript,
  writeRepoFiles,
  type Sandbox,
} from "./support.ts";

/** このリポジトリの idPrefix。公開の木に ID の形を書かないよう、数字とは実行時に組む */
const REAL = "P";
const real = (n: string) => `${REAL}${n}`;
const CONFIG = ".orca-flow/config.json";
const configOf = (idPrefix: string) => ({
  [CONFIG]: `${JSON.stringify({ idPrefix })}\n`,
});

/** このリポジトリと同じ idPrefix（P）を main の config に置いた箱 */
const ready = (files: Record<string, string> = {}) =>
  readyBox({ ...configOf(REAL), ...files });

/** 公開用の作者で、抜くパスのない木とメッセージを指定したコミットを作って返す */
async function publicCommit(
  box: Sandbox,
  options: {
    files?: Record<string, string>;
    links?: Record<string, string>;
    message?: string;
  },
): Promise<string> {
  const wt = `${box.base}/work-${Math.random().toString(36).slice(2)}`;
  await git(
    box,
    box.repo,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    wt,
    "main",
  );
  await git(box, wt, "rm", "-rq", "docs");
  if (options.files) await writeRepoFiles(wt, options.files);
  for (const [file, target] of Object.entries(options.links ?? {})) {
    await mkdir(path.dirname(path.join(wt, file)), { recursive: true });
    await symlink(target, path.join(wt, file));
  }
  await git(box, wt, "add", "-A");
  await git(
    box,
    wt,
    "-c",
    `user.name=${NAME}`,
    "-c",
    `user.email=${EMAIL}`,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    options.message ?? "公開用",
  );
  return git(box, wt, "rev-parse", "HEAD");
}

describe("ID の形の確かめ", () => {
  it("中身に ID の形があると、終了コード1でファイルと行と当たった語を出す", async () => {
    const box = await ready({
      "src/memo.txt": `一行目\n二行目 ${real("12")} の話\n`,
    });
    const commit = await publicCommit(box, {});
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`src/memo.txt：2：${real("12")}`);
  });

  it("パスに ID の形があるファイルも、終了コード1", async () => {
    const box = await ready({ [`src/${real("7")}-memo.txt`]: "中身\n" });
    const commit = await publicCommit(box, {});
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`src/${real("7")}-memo.txt`);
  });

  it("メッセージに ID の形があるコミットも、終了コード1", async () => {
    const box = await ready();
    const commit = await publicCommit(box, {
      message: `${real("5")}: 直した`,
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`メッセージに ID の形：${real("5")}`);
  });

  it("バイナリの中身は見ない", async () => {
    const box = await ready({ "src/blob.bin": `\0 ${real("12")} \0\n` });
    const commit = await publicCommit(box, {});
    expect((await runScript(box, ["check", commit])).code).toBe(0);
  });

  it("1行に ID の形が2つあれば、両方を出す", async () => {
    const box = await ready({
      "src/line.txt": `${real("12")} ${real("13")}\n${real("14")},${real("15")}\n`,
    });
    const result = await runScript(box, ["check", await publicCommit(box, {})]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`1：${real("12")}、${real("13")}`);
    expect(result.stderr).toContain(`2：${real("14")}、${real("15")}`);
  });

  it("git の設定で色が always でも、見逃さない", async () => {
    const box = await ready({ "src/memo.txt": `${real("12")}\n` });
    const commit = await publicCommit(box, {});
    Object.assign(box.env, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "color.ui",
      GIT_CONFIG_VALUE_0: "always",
      GIT_CONFIG_KEY_1: "color.grep",
      GIT_CONFIG_VALUE_1: "always",
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`src/memo.txt：1：${real("12")}`);
  });

  it("シンボリックリンクの行き先の ID の形も見る", async () => {
    const box = await ready();
    const commit = await publicCommit(box, {
      links: { "src/link": `../notes/${real("12")}-memo` },
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`src/link：${real("12")}`);
  });

  it(".gitattributes で binary 扱いの文字のファイルも見る。NUL を含むファイルは見ない", async () => {
    const box = await ready({
      ".gitattributes": "*.txt binary\n*.dat -diff\n",
      "src/memo.txt": `${real("12")}\n`,
      "src/memo.dat": `${real("13")}\n`,
    });
    const result = await runScript(box, ["check", await publicCommit(box, {})]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`src/memo.txt：1：${real("12")}`);
    expect(result.stderr).toContain(`src/memo.dat：1：${real("13")}`);
    const bin = await ready({
      ".gitattributes": "*.txt binary\n",
      "src/nul.txt": `\0 ${real("12")}\n`,
    });
    expect(
      (await runScript(bin, ["check", await publicCommit(bin, {})])).code,
    ).toBe(0);
  });

  it("ASCII でない文字を含むパスのファイルの中身・リンクの当たりも見る", async () => {
    const box = await ready({ 'd/メモ "x".txt': `${real("12")}\n` });
    const commit = await publicCommit(box, {
      links: { "d/リンク": `${real("14")}` },
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`d/メモ "x".txt：1：${real("12")}`);
    expect(result.stderr).toContain(`d/リンク：${real("14")}`);
  });

  describe("パスに語の一覧の語を含むファイル", () => {
    const expectHidden = (stderr: string, count: number) => {
      expect(stderr).not.toContain(WORD_1);
      expect(stderr).not.toContain(WORD_2);
      expect(stderr).toContain(
        `パスに語を含むファイルに ID の形（${count} 件）`,
      );
    };

    it("パスの当たりは語を出さず、件数だけ", async () => {
      const box = await ready({
        [`src/${WORD_1}-${real("12")}.txt`]: "中身\n",
      });
      const result = await runScript(box, [
        "check",
        await publicCommit(box, {}),
      ]);
      expect(result.code).toBe(1);
      expectHidden(result.stderr, 1);
    });

    it("ASCII でない語を含むパスの当たりも、語を出さず件数だけ", async () => {
      const box = await ready({
        [`src/${WORD_JA}-${real("12")}.txt`]: `${real("13")}\n`,
      });
      await writeWords(box, [WORD_JA]);
      const commit = await publicCommit(box, {
        links: { [`src/${WORD_JA}-link`]: `${real("14")}` },
      });
      const result = await runScript(box, ["check", commit]);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain(WORD_JA);
      expect(result.stderr).toContain(
        "パスに語を含むファイルに ID の形（3 件）",
      );
    });

    it("中身とシンボリックリンクの当たりも件数だけ", async () => {
      const box = await ready({
        [`src/${WORD_2}.txt`]: `${real("12")}\n${real("13")}\n`,
      });
      const commit = await publicCommit(box, {
        links: { [`src/${WORD_1}-link`]: `${real("14")}` },
      });
      const result = await runScript(box, ["check", commit]);
      expect(result.code).toBe(1);
      expectHidden(result.stderr, 3);
    });
  });

  describe("当たりの決まり", () => {
    const lines: Array<[string, boolean]> = [
      [`x${real("12")}`, false],
      [`${real("12")}X`, false],
      ["HTTP2", false],
      [`/${real("96")}Sfx`, false],
      [`${real("12")}ab`, false],
      [real("12"), true],
      [`${real("12")}a`, true],
      [`（${real("12")}）`, true],
      [`${real("12")}-名前`, true],
      [`前 ${real("3")}、後`, true],
      [`${real("0")}`, true],
      [`/${real("3")}+`, true],
      [`${REAL}x`, false],
      [`${REAL.toLowerCase()}12`, false],
    ];
    for (const [text, hit] of lines) {
      it(`${text} は${hit ? "当たる" : "当たらない"}`, async () => {
        const box = await ready({ "src/line.txt": `${text}\n` });
        const commit = await publicCommit(box, {});
        const result = await runScript(box, ["check", commit]);
        expect(result.code, result.stderr).toBe(hit ? 1 : 0);
      });
    }
  });

  describe("idPrefix", () => {
    it("main の config の idPrefix が Q なら、Q12 は当たり、このリポジトリの ID の形は当たらない", async () => {
      const hitBox = await readyBox({
        ...configOf("Q"),
        "src/line.txt": "Q12\n",
      });
      expect(
        (await runScript(hitBox, ["check", await publicCommit(hitBox, {})]))
          .code,
      ).toBe(1);
      const missBox = await readyBox({
        ...configOf("Q"),
        "src/line.txt": `${real("12")}\n`,
      });
      expect(
        (await runScript(missBox, ["check", await publicCommit(missBox, {})]))
          .code,
      ).toBe(0);
    });

    it("config がなければ T で当たる", async () => {
      const box = await readyBox({ "src/line.txt": "T12\n" });
      const commit = await publicCommit(box, {});
      expect((await runScript(box, ["check", commit])).code).toBe(1);
      const other = await readyBox({ "src/line.txt": `${real("12")}\n` });
      expect(
        (await runScript(other, ["check", await publicCommit(other, {})])).code,
      ).toBe(0);
    });

    it("作業ツリーではなく main の config を読む", async () => {
      const box = await readyBox({ "src/line.txt": "Q12\n" });
      await writeRepoFiles(box.repo, configOf("Q"));
      const commit = await publicCommit(box, {});
      expect((await runScript(box, ["check", commit])).code).toBe(0);
    });

    it("config が壊れていれば終了コード2", async () => {
      for (const text of [
        "{ 壊れ",
        '{"idPrefix":""}',
        '{"idPrefix":1}',
        "[]",
      ]) {
        const box = await readyBox({ [CONFIG]: `${text}\n` });
        const commit = await publicCommit(box, {});
        const result = await runScript(box, ["check", commit]);
        expect(result.code, text).toBe(2);
        expect(result.stderr).toContain(CONFIG);
      }
    });

    it("記号の idPrefix も文字として扱う", () => {
      // 設定では「.」を idPrefix に書けなくなったので、ID の形の関数を直接確かめる
      const pattern = idPattern("a.b");
      expect("axb1 a.b2".match(pattern)).toEqual(["a.b2"]);
    });

    it("設定の idPrefix が形から外れていれば、読めずに終了コード2で止まる", async () => {
      const box = await readyBox({
        ...configOf("a.b"),
        "src/line.txt": "axb1 a.b2\n",
      });
      const result = await runScript(box, [
        "check",
        await publicCommit(box, {}),
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("idPrefix");
    });
  });

  describe("build と pre-push", () => {
    it("build は当たると終了コード1で、public を作らず進めない", async () => {
      const box = await ready({ "src/memo.txt": `${real("12")}\n` });
      const result = await runScript(box, ["build"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`src/memo.txt：1：${real("12")}`);
      expect(await publicTip(box)).toBeNull();

      // 直したあとは進む。そのあとの当たりでは、前の public のまま
      await writeRepoFiles(box.repo, { "src/memo.txt": "直した\n" });
      await git(box, box.repo, "commit", "--quiet", "-am", "直す");
      expect((await runScript(box, ["build"])).code).toBe(0);
      const tip = await publicTip(box);
      await writeRepoFiles(box.repo, { "src/memo.txt": `${real("9")}\n` });
      await git(box, box.repo, "commit", "--quiet", "-am", "戻す");
      expect((await runScript(box, ["build"])).code).toBe(1);
      expect(await publicTip(box)).toBe(tip);
    });

    it("pre-push は送る範囲のコミットに当たれば止める", async () => {
      const box = await ready();
      expect((await runScript(box, ["build"])).code).toBe(0);
      const clean = await publicTip(box);
      const bad = await publicCommit(box, {
        message: `${real("5")}: 直した`,
      });
      const zero = "0".repeat(40);
      const stdin = (sha: string, remote: string) =>
        `refs/heads/public ${sha} refs/heads/main ${remote}\n`;
      const stopped = await runScript(box, ["pre-push"], {
        stdin: stdin(bad, zero),
      });
      expect(stopped.code).toBe(1);
      expect(stopped.stderr).toContain("ID の形");
      const ok = await runScript(box, ["pre-push"], {
        stdin: stdin(clean ?? "", zero),
      });
      expect(ok.code, ok.stderr).toBe(0);
    });
  });
});

describe("本物の exclude.txt", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const excludeFile = path.join(root, "scripts/public/exclude.txt");

  async function excludes(): Promise<string[]> {
    const text = await readFile(excludeFile, "utf8");
    return parseList(text).map((l) => l.replace(/\/+$/, ""));
  }

  it("環境ごとの記録と道具の3つのパスがある", async () => {
    const list = await excludes();
    for (const entry of [
      "docs/subagent-structure",
      "scripts/review-eval",
      "test/scripts/review-eval",
    ])
      expect(list).toContain(entry);
  });

  it("公開の木のファイルは、抜くパスの中のファイルを import しない", async () => {
    const list = await excludes();
    const inside = (file: string) =>
      list.some((e) => file === e || file.startsWith(`${e}/`));
    // git に頼らず（ZIP・git archive の木でも動くように）fs をたどる
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(path.join(root, dir), {
        withFileTypes: true,
      })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) await walk(rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    await walk("");
    const kept = files.filter(
      (f) => !inside(f) && /\.(?:ts|js|mjs|cjs)$/.test(f),
    );
    expect(kept.length).toBeGreaterThan(0);
    const spec =
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g;
    const offenders: string[] = [];
    let found = 0;
    for (const file of kept) {
      const text = await readFile(path.join(root, file), "utf8");
      for (const m of text.matchAll(spec)) {
        found += 1;
        const target = path
          .normalize(path.join(path.dirname(file), m[1] ?? ""))
          .split(path.sep)
          .join("/");
        if (inside(target)) offenders.push(`${file} → ${target}`);
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
