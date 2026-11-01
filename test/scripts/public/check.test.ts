import { symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMAIL,
  WORD_JA,
  cleanupSandboxes,
  NAME,
  WORD_1,
  WORD_2,
  git,
  makeSandbox,
  readyBox,
  runScript,
  writeRepoFiles,
  writeWords,
  configureIdentity,
  type Sandbox,
} from "./support.ts";

/** 公開用の作者で、木とメッセージを指定したコミットを作って返す */
async function commitAs(
  box: Sandbox,
  options: {
    files?: Record<string, string>;
    name?: string;
    email?: string;
    message?: string;
    keepExcluded?: boolean;
    symlinks?: Record<string, string>;
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
  if (!options.keepExcluded) {
    await git(box, wt, "rm", "-rq", "docs");
  }
  if (options.files) await writeRepoFiles(wt, options.files);
  for (const [link, target] of Object.entries(options.symlinks ?? {}))
    await symlink(target, path.join(wt, link));
  await git(box, wt, "add", "-A");
  await git(
    box,
    wt,
    "-c",
    `user.name=${options.name ?? NAME}`,
    "-c",
    `user.email=${options.email ?? EMAIL}`,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    options.message ?? "公開用",
  );
  return git(box, wt, "rev-parse", "HEAD");
}

describe("check", () => {
  afterEach(cleanupSandboxes);

  it("問題のないコミットは終了コード0", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, {});
    expect((await runScript(box, ["check", commit])).code).toBe(0);
  });

  it("既定は public", async () => {
    const box = await readyBox();
    expect((await runScript(box, ["check"])).code).toBe(2);
    await runScript(box, ["build"]);
    expect((await runScript(box, ["check"])).code).toBe(0);
  });

  it("抜くパスがあるコミットは終了コード1", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, { keepExcluded: true });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("docs/tasks");
  });

  it("語がファイルにあると終了コード1。パスと番号だけを出す（大文字小文字を区別しない）", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, {
      files: { "src/leak.txt": `a ${WORD_2.toLowerCase()} b\n` },
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/leak.txt：2 番目の語");
    expect(result.stderr.toLowerCase()).not.toContain(WORD_2.toLowerCase());
  });

  it("語がパス名にあると終了コード1", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, { files: { [`${WORD_1}.txt`]: "x\n" } });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ファイルのパスに 1 番目の語（1 件）");
    expect(result.stderr).not.toContain(WORD_1);
  });

  it("語がメッセージや作者にあると終了コード1", async () => {
    const box = await readyBox();
    const byMessage = await commitAs(box, { message: `メモ ${WORD_1}` });
    const r1 = await runScript(box, ["check", byMessage]);
    expect(r1.code).toBe(1);
    expect(r1.stderr).toContain("メッセージに 1 番目の語");
    expect(r1.stderr).not.toContain(WORD_1);

    // 作者名にも語が入っている（公開用の名前と違うので、その指摘も出る）
    const byAuthor = await commitAs(box, { name: `${NAME} ${WORD_2}` });
    const r2 = await runScript(box, ["check", byAuthor]);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain("作者の名前に 2 番目の語");
    expect(r2.stderr).not.toContain(WORD_2);
  });

  it("作者が違うコミットは終了コード1。値は出さない", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, {
      name: "Someone Else",
      email: "else@example.invalid",
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("公開用の名前と違います");
    expect(result.stderr).toContain("公開用のメールアドレスと違います");
    expect(result.stderr).not.toContain("Someone Else");
    expect(result.stderr).not.toContain("else@example.invalid");
  });

  it("語の一覧がない・空だと終了コード2", async () => {
    const box = await makeSandbox();
    await configureIdentity(box);
    expect((await runScript(box, ["check", "main"])).code).toBe(2);
    await writeWords(box, ["# だけ"]);
    expect((await runScript(box, ["check", "main"])).code).toBe(2);
  });

  it("存在しないコミットは終了コード2", async () => {
    const box = await readyBox();
    expect((await runScript(box, ["check", "no-such-ref"])).code).toBe(2);
  });

  it("コミットした人だけが公開用と違うコミットは終了コード1", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, {});
    const wt = (await git(box, box.repo, "worktree", "list", "--porcelain"))
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9))
      .find((p) => p !== box.repo.replaceAll("\\", "/"))!;
    await git(
      box,
      wt,
      "-c",
      "user.name=Other Committer",
      "-c",
      "user.email=oc@example.invalid",
      "commit",
      "--quiet",
      "--amend",
      "--no-edit",
      "--allow-empty",
    );
    const amended = await git(box, wt, "rev-parse", "HEAD");
    expect(amended).not.toBe(commit);
    const result = await runScript(box, ["check", amended]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "コミットした人の名前が公開用の名前と違います",
    );
    expect(result.stderr).not.toContain("作者の名前が");
  });

  it("サブディレクトリから流しても、木の全部を確かめる", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, {
      files: { "top-leak.txt": `${WORD_1}\n` },
    });
    const result = await runScript(box, ["check", commit], {
      cwd: `${box.repo}/src`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("top-leak.txt：1 番目の語");
  });

  it("64KB の区切り目にかかった日本語の語も見落とさない", async () => {
    const box = await readyBox();
    await writeWords(box, [WORD_JA]);
    const files: Record<string, string> = {};
    const names: string[] = [];
    for (let pad = 65520; pad <= 65540; pad++) {
      names.push(`edge/f${pad}.txt`);
      files[`edge/f${pad}.txt`] = `${"a".repeat(pad)}${WORD_JA}\n`;
    }
    const commit = await commitAs(box, { files });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    for (const name of names)
      expect(result.stderr, name).toContain(`${name}：1 番目の語`);
    expect(result.stderr).not.toContain(WORD_JA);
  });

  it("パスにも中身にも語があるとき、どの行にも語が出ない", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, {
      files: { [`${WORD_1}.txt`]: `${WORD_1} ${WORD_2}\n` },
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    const lowered = result.stderr.toLowerCase();
    expect(lowered).not.toContain(WORD_1);
    expect(lowered).not.toContain(WORD_2.toLowerCase());
    expect(result.stderr).toContain(
      "パスに語を含むファイルの中身に 1 番目の語（1 件）",
    );
    expect(result.stderr).toContain(
      "パスに語を含むファイルの中身に 2 番目の語（1 件）",
    );
  });

  it("既定の対象は同名のタグではなく public ブランチ", async () => {
    const box = await readyBox();
    await runScript(box, ["build"]);
    await git(box, box.repo, "tag", "public", "main");
    expect((await runScript(box, ["check"])).code).toBe(0);
  });

  it("語を行き先に含むシンボリックリンクで終了コード1。語もパスも出さない", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, {
      // 個人のパスの形がソースに出ないよう、実行時に組み立てる
      symlinks: {
        "innocent-link": [
          "",
          ["Us", "ers"].join(""),
          WORD_1.toUpperCase(),
          "work",
        ].join("/"),
      },
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "シンボリックリンクの行き先に 1 番目の語（1 件）",
    );
    expect(result.stderr.toLowerCase()).not.toContain(WORD_1);
    expect(result.stderr).not.toContain("innocent-link");
  });

  it("pathspec を変える環境変数があっても、パスの語を見つけて語を出さない", async () => {
    const box = await readyBox();
    const commit = await commitAs(box, {
      files: { [`${WORD_1}.txt`]: `${WORD_1}\n` },
    });
    box.env.GIT_LITERAL_PATHSPECS = "1";
    box.env.GIT_NOGLOB_PATHSPECS = "1";
    const result = await runScript(box, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ファイルのパスに 1 番目の語（1 件）");
    expect(result.stderr.toLowerCase()).not.toContain(WORD_1);
  });

  it("語の大文字小文字が混ざったパスも、元の形・小文字・大文字で見つける", async () => {
    const box = await readyBox();
    await writeWords(box, ["Ünï-Word"]);
    const commit = await commitAs(box, {
      files: { "x/ünï-word.txt": "a\n", "y/ÜNÏ-WORD.txt": "b\n" },
    });
    const result = await runScript(box, ["check", commit]);
    expect(result.stderr).toContain("ファイルのパスに 1 番目の語（2 件）");
  });
});
