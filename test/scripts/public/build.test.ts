import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMAIL,
  cleanupSandboxes,
  NAME,
  WORD_1,
  git,
  makeSandbox,
  publicTip,
  readyBox,
  runScript,
  writeRepoFiles,
  writeWords,
  configureIdentity,
  setupBox,
  SETUP_ARGS,
} from "./support.ts";

describe("build", () => {
  afterEach(cleanupSandboxes);

  it("抜くパスのない木で public にコミットを作り、main・作業ツリー・index を変えない", async () => {
    const box = await readyBox();
    await writeRepoFiles(box.repo, { "untracked.txt": "未追跡\n" });
    const mainBefore = await git(box, box.repo, "rev-parse", "main");
    const statusBefore = await git(box, box.repo, "status", "--porcelain");
    const indexBefore = await git(box, box.repo, "ls-files", "-s");

    const result = await runScript(box, ["build"]);
    expect(result.code).toBe(0);

    const tip = await publicTip(box);
    expect(tip).not.toBeNull();
    const files = (
      await git(box, box.repo, "ls-tree", "-r", "--name-only", "public")
    ).split("\n");
    expect(files).toEqual([
      "README.md",
      "scripts/public/exclude.txt",
      "src/a.txt",
    ]);
    expect(
      await git(box, box.repo, "rev-list", "--parents", "-1", "public"),
    ).toBe(tip);
    expect(await git(box, box.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(await git(box, box.repo, "status", "--porcelain")).toBe(
      statusBefore,
    );
    expect(await git(box, box.repo, "ls-files", "-s")).toBe(indexBefore);
  });

  it("作者とコミットした人が公開用で、日時が +0000 である", async () => {
    const box = await readyBox();
    const result = await runScript(box, ["build"], {
      now: new Date("2026-10-26T15:30:00Z"),
    });
    expect(result.code).toBe(0);
    const out = await git(
      box,
      box.repo,
      "log",
      "-1",
      "--date=raw",
      "--format=%an|%ae|%cn|%ce|%ad|%cd|%s",
      "public",
    );
    expect(out).toBe(
      `${NAME}|${EMAIL}|${NAME}|${EMAIL}|1793028600 +0000|1793028600 +0000|公開用の更新`,
    );
  });

  it("--message でメッセージを渡せる", async () => {
    const box = await readyBox();
    await runScript(box, ["build", "--message", "初めての公開"]);
    expect(await git(box, box.repo, "log", "-1", "--format=%s", "public")).toBe(
      "初めての公開",
    );
  });

  it("2回目は前の public を親にし、木が同じなら作らない", async () => {
    const box = await readyBox();
    await runScript(box, ["build"]);
    const first = await publicTip(box);

    const same = await runScript(box, ["build"]);
    expect(same.code).toBe(0);
    expect(await publicTip(box)).toBe(first);

    await writeRepoFiles(box.repo, { "src/b.txt": "新しい\n" });
    await git(box, box.repo, "add", "-A");
    await git(box, box.repo, "commit", "--quiet", "-m", "追加");
    const second = await runScript(box, ["build"]);
    expect(second.code).toBe(0);
    const tip = await publicTip(box);
    expect(tip).not.toBe(first);
    expect(await git(box, box.repo, "rev-parse", "public^")).toBe(first);
    expect(await git(box, box.repo, "rev-list", "--count", "public")).toBe("2");
  });

  it("別の worktree にいても main から作る", async () => {
    const box = await readyBox();
    const wt = `${box.base}/wt`;
    await git(box, box.repo, "worktree", "add", "--quiet", "-b", "task/x", wt);
    await writeRepoFiles(wt, { "only-task.txt": "タスクだけ\n" });
    await git(box, wt, "add", "-A");
    await git(box, wt, "commit", "--quiet", "-m", "タスク");
    const result = await runScript(box, ["build"], { cwd: wt });
    expect(result.code).toBe(0);
    const files = await git(
      box,
      box.repo,
      "ls-tree",
      "-r",
      "--name-only",
      "public",
    );
    expect(files).not.toContain("only-task.txt");
  });

  it("公開用の名前かメールアドレスがないと終了コード2でコミットを作らない", async () => {
    const box = await makeSandbox();
    await writeWords(box, [WORD_1]);
    await setupBox(box);
    await git(box, box.repo, "config", "--unset", "orca-flow.publicName");
    await git(box, box.repo, "config", "--unset", "orca-flow.publicEmail");
    expect((await runScript(box, ["build"])).code).toBe(2);
    await git(box, box.repo, "config", "orca-flow.publicName", NAME);
    expect((await runScript(box, ["build"])).code).toBe(2);
    expect(await publicTip(box)).toBeNull();
  });

  it("語が木に入っていると終了コード1で public を進めず、語を出力しない", async () => {
    const box = await readyBox();
    await runScript(box, ["build"]);
    const before = await publicTip(box);

    await writeRepoFiles(box.repo, {
      "src/leak.txt": `x ${WORD_1.toUpperCase()} y\n`,
    });
    await git(box, box.repo, "add", "-A");
    await git(box, box.repo, "commit", "--quiet", "-m", "漏れる");
    const result = await runScript(box, ["build"]);
    expect(result.code).toBe(1);
    expect(await publicTip(box)).toBe(before);
    expect(result.stderr).toContain("src/leak.txt");
    expect(result.stderr).toContain("1 番目の語");
    expect(result.stderr.toLowerCase()).not.toContain(WORD_1);
  });

  it("語の一覧がない・空だと終了コード2", async () => {
    const box = await makeSandbox();
    await setupBox(box);
    expect((await runScript(box, ["build"])).code).toBe(2);
    await writeWords(box, []);
    expect((await runScript(box, ["build"])).code).toBe(2);
    expect(await publicTip(box)).toBeNull();
  });

  it("使い方が違うと終了コード2", async () => {
    const box = await readyBox();
    expect((await runScript(box, ["build", "--bogus"])).code).toBe(2);
    expect((await runScript(box, ["nothing"])).code).toBe(2);
  });

  it("docs/tasks-notes.md のような境目のパスは抜かれない", async () => {
    const box = await readyBox({ "docs/tasks-notes.md": "残る\n" });
    expect((await runScript(box, ["build"])).code).toBe(0);
    const files = await git(
      box,
      box.repo,
      "ls-tree",
      "-r",
      "--name-only",
      "public",
    );
    expect(files.split("\n")).toContain("docs/tasks-notes.md");
    expect(files).not.toContain("docs/tasks/");
  });

  it("メールアドレスだけあって名前がないと終了コード2で、理由を出す", async () => {
    const box = await makeSandbox();
    await writeWords(box, [WORD_1]);
    await setupBox(box);
    await git(box, box.repo, "config", "--unset", "orca-flow.publicName");
    const result = await runScript(box, ["build"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("公開用の名前");
    expect(await publicTip(box)).toBeNull();
  });

  it("サブディレクトリから流しても、木の全部から作る", async () => {
    const box = await readyBox();
    const result = await runScript(box, ["build"], { cwd: `${box.repo}/src` });
    expect(result.code).toBe(0);
    const files = await git(
      box,
      box.repo,
      "ls-tree",
      "-r",
      "--name-only",
      "public",
    );
    expect(files.split("\n")).toEqual([
      "README.md",
      "scripts/public/exclude.txt",
      "src/a.txt",
    ]);
  });

  it("日本語の名前のファイルが多く、一覧が 64KB を超えても、パスが化けない", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 2500; i++)
      many[`many/日本語のファイル名その${String(i).padStart(5, "0")}.txt`] =
        `${i}\n`;
    const box = await readyBox(many);
    const listing = await box.runner("git", ["ls-tree", "-r", "-z", "main"], {
      cwd: box.repo,
    });
    expect(Buffer.byteLength(listing.stdout)).toBeGreaterThan(65536);
    const result = await runScript(box, ["build"]);
    expect(result.code, result.stderr).toBe(0);
    expect(await git(box, box.repo, "rev-parse", "public:many")).toBe(
      await git(box, box.repo, "rev-parse", "main:many"),
    );
  });

  it("抜くパスは作業ツリーではなく main の exclude.txt から読む", async () => {
    const box = await readyBox();
    await writeRepoFiles(box.repo, { "scripts/public/exclude.txt": "# 空\n" });
    expect((await runScript(box, ["build"])).code).toBe(0);
    const files = await git(
      box,
      box.repo,
      "ls-tree",
      "-r",
      "--name-only",
      "public",
    );
    expect(files).not.toContain("docs/");
  });

  it("main に exclude.txt がないと終了コード2", async () => {
    const box = await readyBox();
    await git(box, box.repo, "rm", "-q", "scripts/public/exclude.txt");
    await git(box, box.repo, "commit", "--quiet", "-m", "消す");
    expect((await runScript(box, ["build"])).code).toBe(2);
    expect(await publicTip(box)).toBeNull();
  });

  it("タスクのブランチで抜くパスの中を変えていても、その worktree から build できる", async () => {
    const box = await readyBox();
    const wt = `${box.base}/task-wt`;
    await git(box, box.repo, "worktree", "add", "--quiet", "-b", "task/y", wt);
    await writeRepoFiles(wt, {
      "docs/tasks/reports/R.md": "報告\n",
      "docs/tasks/T1.md": "変えた\n",
    });
    await git(box, wt, "add", "-A");
    await git(box, wt, "commit", "--quiet", "-m", "報告");
    await writeRepoFiles(wt, {
      "docs/tasks/T1.md": "作業ツリーでもっと変えた\n",
    });
    const statusBefore = await git(box, wt, "status", "--porcelain");
    const indexBefore = await git(box, wt, "ls-files", "-s");

    const result = await runScript(box, ["build"], { cwd: wt });
    expect(result.code, result.stderr).toBe(0);

    const publicFiles = await git(
      box,
      box.repo,
      "ls-tree",
      "-r",
      "--name-only",
      "public",
    );
    const mainFiles = (
      await git(box, box.repo, "ls-tree", "-r", "--name-only", "main")
    )
      .split("\n")
      .filter(
        (f) =>
          !f.startsWith("docs/tasks/") &&
          !f.startsWith("docs/public-release-audit/"),
      );
    expect(publicFiles.split("\n")).toEqual(mainFiles);
    expect(await git(box, box.repo, "rev-parse", "public:src")).toBe(
      await git(box, box.repo, "rev-parse", "main:src"),
    );
    expect(await git(box, wt, "status", "--porcelain")).toBe(statusBefore);
    expect(await git(box, wt, "ls-files", "-s")).toBe(indexBefore);
  });

  describe("フックの効きの確かめ", () => {
    async function hookFile(box: Awaited<ReturnType<typeof readyBox>>) {
      return path.join(box.repo, ".git", "hooks", "pre-push");
    }

    async function expectStopped(
      box: Awaited<ReturnType<typeof readyBox>>,
      reason: string,
    ) {
      const before = await publicTip(box);
      const result = await runScript(box, ["build"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(reason);
      expect(result.stderr).toContain("setup を流してください");
      expect(await publicTip(box)).toBe(before);
    }

    it("setup の前は終了コード2で public を作らない", async () => {
      const box = await makeSandbox();
      await writeWords(box, [WORD_1]);
      await configureIdentity(box);
      await expectStopped(box, "フックがない");
      expect(await publicTip(box)).toBeNull();
    });

    it("core.hooksPath があると終了コード2で public を作らない", async () => {
      const box = await readyBox();
      await git(box, box.repo, "config", "core.hooksPath", "other-hooks");
      await expectStopped(box, "core.hooksPath");
      expect(await publicTip(box)).toBeNull();
    });

    it("setup の書いたものでないフックだと終了コード2で public を作らない", async () => {
      const box = await readyBox();
      await writeFile(await hookFile(box), "#!/bin/sh\nexit 0\n");
      await chmod(await hookFile(box), 0o755);
      await expectStopped(box, "setup の書いたものではない");
      expect(await publicTip(box)).toBeNull();
    });

    it("フックが実行できないと終了コード2で public を作らない", async () => {
      const box = await readyBox();
      await chmod(await hookFile(box), 0o644);
      await expectStopped(box, "実行できない");
      expect(await publicTip(box)).toBeNull();
    });

    it("フックが指す main.ts がないと終了コード2で public を作らない", async () => {
      const box = await readyBox();
      const text = await readFile(await hookFile(box), "utf8");
      const missing = path.join(box.base, "no-such", "main.ts");
      await writeFile(
        await hookFile(box),
        text.replace(/^main=.*$/m, `main='${missing}'`),
      );
      await expectStopped(box, "main.ts が見つからない");
      expect(await publicTip(box)).toBeNull();
    });

    it("フックが外れると、すでにある public も進めない", async () => {
      const box = await readyBox();
      expect((await runScript(box, ["build"])).code).toBe(0);
      const before = await publicTip(box);
      await writeRepoFiles(box.repo, { "src/b.txt": "新しい\n" });
      await git(box, box.repo, "add", "-A");
      await git(box, box.repo, "commit", "--quiet", "-m", "追加");
      await rm(await hookFile(box));
      await expectStopped(box, "フックがない");
      expect(await publicTip(box)).toBe(before);
    });

    it("setup をし直すと build できる", async () => {
      const box = await readyBox();
      await rm(await hookFile(box));
      expect((await runScript(box, ["build"])).code).toBe(2);
      expect((await runScript(box, SETUP_ARGS)).code).toBe(0);
      expect((await runScript(box, ["build"])).code).toBe(0);
      expect(await publicTip(box)).not.toBeNull();
    });
  });
});
