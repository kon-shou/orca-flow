import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localPathRules } from "../../../scripts/public/local.ts";
import {
  EXCLUDE_TEXT,
  git,
  makeSandbox,
  runScript,
  writeRepoFiles,
  writeWords,
  type Sandbox,
} from "./support.ts";

/** このリポジトリの ID の形と重ならない idPrefix（Q）。数字とは実行時に組む */
const id = (n: string) => `${"Q"}${n}`;
/** このリポジトリの idPrefix（P）。公開の木に ID の形を書かないよう組む */
const own = (n: string) => `${"P"}${n}`;
const CONFIG = ".orca-flow/config.json";
const configOf = (idPrefix: string) => ({
  [CONFIG]: `${JSON.stringify({ idPrefix })}\n`,
});
/** Mac のホームの頭の形。文字のまま書かない */
const macHead = `/${"Us"}${"ers"}/`;
const FAKE_HOME = `/srv/${"fake"}-home/${"owner"}`;
/** ASCII でない大文字を含むホーム */
const WIDE_HOME = `/srv/${"fake"}/${"Ö"}${"laf"}`;

async function box(files: Record<string, string> = {}): Promise<Sandbox> {
  const sandbox = await makeSandbox({ ...configOf("Q"), ...files });
  sandbox.env["HOME"] = FAKE_HOME;
  return sandbox;
}

const local = (sandbox: Sandbox) => runScript(sandbox, ["local"]);

async function snapshot(sandbox: Sandbox) {
  const at = (...args: string[]) => git(sandbox, sandbox.repo, ...args);
  return {
    head: await at("rev-parse", "HEAD"),
    index: await at("ls-files", "-s"),
    status: await at("status", "--porcelain=v1", "-uall"),
    branches: await at("branch", "--list"),
    files: await readFile(path.join(sandbox.repo, "src/a.txt"), "utf8"),
  };
}

describe("local：ID の形", () => {
  it("追跡中のファイルの中身にあると、終了コード1でファイル・行・当たった語を出す", async () => {
    const b = await box();
    await writeRepoFiles(b.repo, {
      "src/a.txt": `1行目\n詳細は ${id("12")} へ\n`,
    });
    await git(b, b.repo, "add", "-A");
    await git(b, b.repo, "commit", "--quiet", "-m", "追加");
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`src/a.txt：2：${id("12")}`);
  });

  it("追跡中のファイルのパスにあると当たる", async () => {
    const b = await box({ [`docs/${id("7")}-memo.md`]: "中身\n" });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`docs/${id("7")}-memo.md`);
  });

  it("シンボリックリンクの行き先にあると当たる", async () => {
    const b = await box();
    await symlink(`target-${id("5")}`, path.join(b.repo, "link"));
    await git(b, b.repo, "add", "link");
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`link：${id("5")}`);
  });

  it("抜くパスの中にあるだけなら 0", async () => {
    const b = await box({ "docs/tasks/T1.md": `${id("12")}\n` });
    const result = await local(b);
    expect(result.stderr).not.toContain(id("12"));
    expect(result.code).toBe(0);
  });

  it("コミットしていない追跡中のファイルの変更も拾う", async () => {
    const b = await box();
    await writeFile(path.join(b.repo, "src/a.txt"), `変更 ${id("3")}\n`);
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`src/a.txt：1：${id("3")}`);
  });

  it("コミット済みの ID の形を作業ツリーで直したら当たらない", async () => {
    const b = await box({ "src/b.txt": `${id("4")}\n` });
    await writeRepoFiles(b.repo, { "src/b.txt": "きれい\n" });
    const result = await local(b);
    expect(result.code).toBe(0);
  });

  it("追跡外のファイルは拾わない", async () => {
    const b = await box();
    await writeRepoFiles(b.repo, { "src/new.txt": `${id("12")}\n` });
    const result = await local(b);
    expect(result.code).toBe(0);
  });

  it("idPrefix は作業ツリーの設定から読む", async () => {
    const b = await box({
      "src/a.txt": `${id("12")} と ${own("12")}\n`,
    });
    const first = await local(b);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain(id("12"));
    expect(first.stderr).not.toContain(own("12"));

    await writeRepoFiles(b.repo, configOf("P"));
    const second = await local(b);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(own("12"));
    expect(second.stderr).not.toContain(id("12"));
  });
});

describe("local：語の一覧", () => {
  it("ないか空なら、語は確かめず、ID の形と手元のパスだけで決める", async () => {
    const b = await box({ "src/a.txt": "secret-word-1\n" });
    const none = await local(b);
    expect(none.code).toBe(0);
    expect(none.stderr).toContain("語は確かめていません");
    await writeWords(b, []);
    expect((await local(b)).code).toBe(0);
  });

  it("あれば何番目の語かを出し、語そのものは出さない", async () => {
    const b = await box({ "src/a.txt": "ひとつ secret-word-2 ふたつ\n" });
    await writeWords(b, ["other-word", "secret-word-2"]);
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("2 番目の語");
    expect(result.stderr).not.toContain("secret-word-2");
  });
});

describe("local：手元のパス", () => {
  it("Mac のホームの頭の形に当たり、パスの文字は出さない", async () => {
    const b = await box({ "src/a.txt": `path=${macHead}someone/x\n` });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/a.txt：手元のパス");
    expect(result.stderr).not.toContain(macHead);
    expect(result.stderr).not.toContain("someone");
  });

  it("大文字小文字を区別せず、リンクの行き先も見る", async () => {
    const b = await box({ "src/a.txt": `x ${macHead.toUpperCase()}y\n` });
    await symlink(`${macHead.toUpperCase()}x`, path.join(b.repo, "link"));
    await git(b, b.repo, "add", "link");
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/a.txt：手元のパス");
    expect(result.stderr).toContain("シンボリックリンクの行き先に手元のパス");
    expect(result.stderr).not.toContain(macHead.toUpperCase());
  });

  it("ファイルのパスの先頭が頭の形（相対なので先頭の / は無し）なら、パスで当たり、その文字は出さない", async () => {
    const b = await box({
      [`${macHead.toUpperCase().slice(1)}x.md`]: "a\n",
    });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ファイルのパスに手元のパス（1 件）");
    expect(result.stderr).not.toContain(macHead.toUpperCase().slice(1));
    expect(result.stderr.toLowerCase()).not.toContain(
      macHead.toLowerCase().slice(1),
    );
  });

  it("API のパスや URL・別の名前の中の users は当たらず、行頭・引用符・空白・= ・: ・file:/// のあとの形は当たる", async () => {
    const users = macHead.slice(0, -1);
    const clean = [
      "/api" + users + "/1",
      "https://api.github.com" + users + "/x",
      "src" + users + "/x.txt",
      "a-" + users + "/x",
    ];
    for (const text of clean) {
      const b = await box({ "src/a.txt": `${text}\n` });
      expect((await local(b)).code, text).toBe(0);
    }
    const dirty = [
      `${macHead}x`,
      `"${macHead}x"`,
      `cd ${macHead}x`,
      `HOME=${macHead}x`,
      `at:${macHead}x`,
      `file://${macHead}x`,
      `${macHead.toUpperCase()}x`,
    ];
    for (const text of dirty) {
      const b = await box({ "src/a.txt": `${text}\n` });
      expect((await local(b)).code, text).toBe(1);
    }
  });

  it("流した人のホームのディレクトリに当たり、その文字は出さない", async () => {
    const b = await box({
      "src/a.txt": `cd ${FAKE_HOME.toUpperCase()}/work\n`,
      [`src/${"owner"}.txt`]: "x\n",
      "src/c.txt": `${FAKE_HOME}\n`,
    });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/a.txt：手元のパス");
    expect(result.stderr).not.toContain(FAKE_HOME);
    expect(result.stderr.toLowerCase()).not.toContain(FAKE_HOME.toLowerCase());
    expect(result.stderr).not.toContain("fake-home");
  });

  it("パスにホームのディレクトリを含むファイルのパスは出さない", async () => {
    const b = await box({ [`src${FAKE_HOME}/m.txt`]: `${FAKE_HOME}\n` });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("手元のパス");
    expect(result.stderr).not.toContain("fake-home");
    expect(result.stderr).not.toContain("owner");
  });

  it("偽の値の /home/someone/ は当たらない", async () => {
    const b = await box({ "src/a.txt": "/home/someone/project\n" });
    const result = await local(b);
    expect(result.code).toBe(0);
  });

  it("HOME の後ろに区切りがなければ当たらない（偽の値の頭の部分だけのとき）", async () => {
    const b = await box({
      "src/a.txt": `${FAKE_HOME}x\n${FAKE_HOME}2/y\n${FAKE_HOME}-z\n`,
      "src/b.txt": `ok ${FAKE_HOME}/y; ${FAKE_HOME}\n`,
    });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("src/a.txt");
    expect(result.stderr).toContain("src/b.txt：手元のパス");
    const link = await box();
    await symlink(`${FAKE_HOME}x`, path.join(link.repo, "link"));
    await git(link, link.repo, "add", "link");
    expect((await local(link)).code).toBe(0);
  });

  it("HOME のすぐ後ろが文の終わりの . なら当たり、. のあとに名前が続くなら当たらない", async () => {
    const b = await box({
      "src/a.txt": `notes are in ${FAKE_HOME}.\n`,
      "src/b.txt": `see ${FAKE_HOME}... later\n`,
      "src/c.txt": `${FAKE_HOME}.x/y\n`,
    });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/a.txt：手元のパス");
    expect(result.stderr).toContain("src/b.txt：手元のパス");
    expect(result.stderr).not.toContain("src/c.txt");
  });

  it("ASCII でない大文字を含むホームも、中身の大文字小文字違いで当たる", async () => {
    const b = await box({
      "src/a.txt": `${WIDE_HOME.toLowerCase()}/x\n`,
      "src/b.txt": `${WIDE_HOME.toUpperCase()}/x\n`,
      "src/c.txt": `${WIDE_HOME}/x\n`,
    });
    b.env["HOME"] = WIDE_HOME;
    const result = await local(b);
    expect(result.code).toBe(1);
    for (const f of ["a", "b", "c"])
      expect(result.stderr).toContain(`src/${f}.txt：手元のパス`);
    expect(result.stderr.toLowerCase()).not.toContain("fake");
  });

  it("パスに語の一覧の語を含むファイルの中身に手元のパスがあっても、語は出さない", async () => {
    const b = await box({
      "src/secret-word-3.txt": `${macHead}x\n`,
    });
    await writeWords(b, ["secret-word-3"]);
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("手元のパス");
    expect(result.stderr).toContain("1 番目の語");
    expect(result.stderr.toLowerCase()).not.toContain("secret-word-3");
  });

  it("パスにホームのディレクトリを含むファイルの中の ID の形・語でも、パスは出さない", async () => {
    const b = await box({
      [`src${FAKE_HOME}/m.txt`]: `${id("8")} secret-word-4\n`,
    });
    await writeWords(b, ["secret-word-4"]);
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("パスに手元のパスを含むファイルに ID の形");
    expect(result.stderr).toContain("1 番目の語");
    expect(result.stderr).not.toContain("fake-home");
    expect(result.stderr).not.toContain("owner");
    expect(result.stderr).not.toContain("m.txt");
  });

  it("HOME がないか浅い（ルートの1段）なら、ホームの規則は飛ばす", async () => {
    const count = (env: NodeJS.ProcessEnv) =>
      localPathRules(env).literals.length;
    expect(count({})).toBe(1);
    expect(count({ HOME: "/" })).toBe(1);
    expect(count({ HOME: "/root" })).toBe(1);
    expect(count({ HOME: "/root/" })).toBe(1);
    expect(count({ HOME: "relative/dir" })).toBe(1);
    expect(count({ HOME: "/home/someone/" })).toBe(2);

    const b = await box({ "src/a.txt": "/root/work\n" });
    b.env["HOME"] = "/root";
    expect((await local(b)).code).toBe(0);
    delete b.env["HOME"];
    expect((await local(b)).code).toBe(0);
  });
});

describe("local：作業ツリーを変えない", () => {
  it("作業ツリー・本物の index・HEAD・ブランチが変わらず、GIT_INDEX_FILE に左右されない", async () => {
    const b = await box();
    await writeFile(path.join(b.repo, "src/a.txt"), `変更 ${id("3")}\n`);
    await writeRepoFiles(b.repo, { "untracked.txt": "x\n" });
    await git(b, b.repo, "add", "untracked.txt");
    const before = await snapshot(b);
    b.env["GIT_INDEX_FILE"] = path.join(b.base, "other-index");
    b.env["GIT_DIR"] = path.join(b.base, "no-such-dir");
    const result = await local(b);
    delete b.env["GIT_INDEX_FILE"];
    delete b.env["GIT_DIR"];
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(id("3"));
    expect(await snapshot(b)).toEqual(before);
  });

  it("サブディレクトリから流しても、リポジトリ全体を確かめる", async () => {
    const b = await box({ "src/a.txt": `${id("9")}\n` });
    const result = await runScript(b, ["local"], {
      cwd: path.join(b.repo, "src"),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`src/a.txt：1：${id("9")}`);
  });

  it("本物の index から消した（rm・rm --cached・mv）パスは、HEAD の中身でも当たらない", async () => {
    const b = await box({
      "src/x1.txt": `${id("21")}\n`,
      "src/x2.txt": `${id("22")}\n`,
      "src/x3.txt": `${id("23")}\n`,
    });
    await git(b, b.repo, "rm", "--quiet", "src/x1.txt");
    await git(b, b.repo, "rm", "--quiet", "--cached", "src/x2.txt");
    await git(b, b.repo, "mv", "src/x3.txt", "src/y3.txt");
    await writeFile(path.join(b.repo, "src/y3.txt"), "きれい\n");
    const result = await local(b);
    expect(result.code).toBe(0);
  });

  it("作業ツリーの抜くパスの一覧だけ（コミットしない）を変えると、それを読む", async () => {
    const b = await box({ "src/skip.txt": `${id("31")}\n` });
    expect((await local(b)).code).toBe(1);
    await writeFile(
      path.join(b.repo, "scripts/public/exclude.txt"),
      `${EXCLUDE_TEXT}src/skip.txt\n`,
    );
    expect((await local(b)).code).toBe(0);
  });

  it("コミット済みの ID の形のファイルを作業ツリーで消す（ステージしない）と当たらない", async () => {
    const b = await box({ "src/gone.txt": `${id("41")}\n` });
    await rm(path.join(b.repo, "src/gone.txt"));
    expect((await local(b)).code).toBe(0);
  });

  it("余計な引数は使い方の誤り（終了コード2）", async () => {
    const b = await box();
    expect((await runScript(b, ["local", "x"])).code).toBe(2);
  });
});
