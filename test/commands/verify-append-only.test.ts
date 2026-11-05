import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";

const FILE = "docs/log.md";
const BASE = "a\n";
const SUBJECT = `T12: 取り込みで変わった${FILE}の行の並びを戻す`;
const ORDER_WARN = `警告：main の ${FILE} が、タスクのブランチの ${FILE} の先頭と同じではありません`;
const CANNOT = `警告：${FILE} の行の並びを戻せませんでした`;

async function setup(taskText: string, mainText: string) {
  const root = await makeRepo(
    { appendOnlyFiles: [FILE], verify: ["test -f src/a.ts"] },
    { [FILE]: BASE, ".gitattributes": `${FILE} merge=union\n` },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/a.ts": "export {};\n",
    [FILE]: taskText,
  });
  await writeFiles(root, { [FILE]: mainText });
  await git(root, "commit", "--quiet", "-am", "main の行");
  return { root, wt };
}

const verify = (wt: { path: string }) =>
  runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner });
const recordPath = (root: string) =>
  path.join(root, ".git/orca-flow/verified/T12.json");
const subjects = async (cwd: string) =>
  (await git(cwd, "log", "--format=%s", "-20")).split("\n");

describe("verify は決定の記録でない追記だけのファイルの並びを戻す", () => {
  it("両側が末尾に足すと、main の行のあとにタスクの行が並び、件名どおりのコミットが1つできて記録が残る", async () => {
    const { root, wt } = await setup("a\nt1\n", "a\nm1\n");
    const result = await verify(wt);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`${FILE} の行の並びを戻してコミットしました`);
    expect(result.err).not.toContain("警告");
    expect(await readFile(path.join(wt.path, FILE), "utf8")).toBe(
      "a\nm1\nt1\n",
    );
    expect((await subjects(wt.path)).filter((s) => s === SUBJECT)).toHaveLength(
      1,
    );
    expect(await git(wt.path, "show", "--name-only", "--format=", "HEAD")).toBe(
      FILE,
    );
    expect(existsSync(recordPath(root))).toBe(true);
  });

  it("手で git merge main したあとに verify しても、同じに戻る", async () => {
    const { root, wt } = await setup("a\nt1\n", "a\nm1\n");
    await git(wt.path, "merge", "--no-edit", "main");
    const result = await verify(wt);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(wt.path, FILE), "utf8")).toBe(
      "a\nm1\nt1\n",
    );
    expect(await subjects(wt.path)).toContain(SUBJECT);
    expect(existsSync(recordPath(root))).toBe(true);
  });

  it("手で取り込んだあとにファイルを変えたコミットがあれば戻さず、並びの警告を出して終了コード0", async () => {
    const { root, wt } = await setup("a\nt1\n", "a\nm1\n");
    await git(wt.path, "merge", "--no-edit", "main");
    await writeFiles(wt.path, { [FILE]: "a\nt1\nm1\nt2\n" });
    await git(wt.path, "commit", "--quiet", "-am", "T12: 足す");
    const result = await verify(wt);
    expect(result.code).toBe(0);
    expect(await subjects(wt.path)).not.toContain(SUBJECT);
    expect(await readFile(path.join(wt.path, FILE), "utf8")).toBe(
      "a\nt1\nm1\nt2\n",
    );
    expect(result.err).toContain(ORDER_WARN);
    expect(result.err).not.toContain(CANNOT);
    expect(existsSync(recordPath(root))).toBe(true);
  });

  it("両側が同じ行を足したときは戻さず、戻せない警告と並びの警告を出して終了コード0で記録が残る", async () => {
    const { root, wt } = await setup("a\nx\ny\n", "a\nm1\nx\n");
    const result = await verify(wt);
    expect(result.code).toBe(0);
    expect(result.err).toContain(CANNOT);
    expect(result.err).toContain("「x」");
    expect(result.err).toContain(ORDER_WARN);
    expect(await subjects(wt.path)).not.toContain(SUBJECT);
    expect(existsSync(recordPath(root))).toBe(true);
  });
});

const DEC = "docs/decisions.md";
const DEC_SUBJECT = `T12: 取り込みで変わった${DEC}の行の並びを戻す`;

async function setupBoth(
  taskText: string,
  mainText: string,
  extra: Record<string, string> = {},
) {
  const root = await makeRepo(
    {
      appendOnlyFiles: [DEC, FILE],
      decisionsFile: DEC,
      verify: ["test -f src/a.ts"],
    },
    {
      [FILE]: BASE,
      [DEC]: "# 決定\n",
      ".gitattributes": `${FILE} merge=union\n${DEC} merge=union\n`,
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/a.ts": "export {};\n",
    [FILE]: taskText,
    ...extra,
  });
  await writeFiles(root, { [FILE]: mainText });
  await git(root, "commit", "--quiet", "-am", "main の行");
  return { root, wt };
}

describe("決定の記録とほかの追記だけのファイルを両方設定したとき", () => {
  it("手で git merge main したあとに足した行は、戻しで消えず、並びの警告が出て終了コード0", async () => {
    const { wt } = await setupBoth("a\nt1\n", "a\nm1\n");
    await git(wt.path, "merge", "--no-edit", "main");
    await writeFiles(wt.path, { [FILE]: "a\nt1\nm1\nt2\n" });
    await git(wt.path, "commit", "--quiet", "-am", "T12: 足す");
    const result = await verify(wt);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(wt.path, FILE), "utf8")).toBe(
      "a\nt1\nm1\nt2\n",
    );
    expect(await subjects(wt.path)).not.toContain(SUBJECT);
    expect(result.err).toContain(ORDER_WARN);
  });

  it("自分で取り込んだときは、ほかのファイルだけ戻り、決定の記録に戻しのコミットは出ない", async () => {
    const { wt } = await setupBoth("a\nt1\n", "a\nm1\n");
    const result = await verify(wt);
    expect(result.code).toBe(0);
    const list = await subjects(wt.path);
    expect(list).toContain(SUBJECT);
    expect(list).not.toContain(DEC_SUBJECT);
  });
});

describe("verify のそのほかの道", () => {
  it("戻しのコミットに失敗すると、終了コード1で止まり、中身は取り込んだあとのままでステージは空", async () => {
    const { wt } = await setup("a\nt1\n", "a\nm1\n");
    const hookDir = (
      await git(wt.path, "rev-parse", "--git-common-dir")
    ).trim();
    const hook = path.resolve(wt.path, hookDir, "hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho フック失敗 >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const result = await verify(wt);
    expect(result.code).toBe(1);
    expect(result.err).toContain("行の並びの戻しをコミットできませんでした");
    expect(await git(wt.path, "diff", "--cached", "--name-only")).toBe("");
    // union で取り込んだあとの、タスクの行が先の中身がそのまま残っている
    expect(await readFile(path.join(wt.path, FILE), "utf8")).toBe(
      "a\nt1\nm1\n",
    );
  });

  it("main にない追記だけのファイルをタスクが作っても、並びの警告は出ない", async () => {
    const root = await makeRepo(
      { appendOnlyFiles: [FILE, "docs/new.md"], verify: ["test -f src/a.ts"] },
      { [FILE]: BASE },
    );
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "src/a.ts": "export {};\n",
      "docs/new.md": "x\n",
    });
    const result = await verify(wt);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("docs/new.md");
  });
});
