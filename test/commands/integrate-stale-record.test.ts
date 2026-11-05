import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

async function setup(config: Record<string, unknown> = {}) {
  const fullConfig = {
    integrateVerify: "before-merge",
    progress: { file: "docs/progress.md" },
    verifySkipPaths: ["notes/"],
    verify: ["test -f src/shop/a.ts"],
    maxActiveTasks: 2,
    ...config,
  };
  const root = await makeRepo(fullConfig, {
    "docs/progress.md": PROGRESS.replace(
      "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
      "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 作業中 | task/T12-shop | |\n",
    ),
    "notes/n.md": "n\n",
    "shared.txt": "base\n",
  });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", {
      allowed: ["src/shop/", "shared.txt", "notes/"],
    }),
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  const verify = await runCli(["verify"], {
    cwd: wt.path,
    runner: fakeOrca().runner,
  });
  expect(verify.code).toBe(0);
  return { root, wt };
}

const commitMain = async (
  root: string,
  files: Record<string, string>,
  message = "main が進む",
) => {
  await writeFiles(root, files);
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const run = async (root: string, wtPath: string, args: string[] = []) => {
  const orca = fakeOrca();
  orca.terminals.push({
    handle: "term_t12",
    worktreePath: wtPath,
    title: "claude",
    agentIdentity: "claude",
  });
  const shells: string[] = [];
  const runner: Runner = (cmd, a, opts) => {
    if (cmd === "sh") shells.push(a.join(" "));
    return orca.runner(cmd, a, opts);
  };
  const result = await runCli(
    ["integrate", "T12", "--keep-worktree", ...args],
    {
      cwd: root,
      runner,
    },
  );
  return { result, orca, shells };
};

describe("integrate：記録のあとに main が動いた", () => {
  const readConfig = async (root: string) =>
    JSON.parse(
      await readFile(path.join(root, ".orca-flow/config.json"), "utf8"),
    );

  const expectMerged = async (
    root: string,
    wtPath: string,
    changed: string,
    mainSha: string,
  ) => {
    const before = await git(wtPath, "rev-parse", "HEAD");
    const { result, shells } = await run(root, wtPath, ["--json"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(shells).toEqual([]);
    const data = JSON.parse(result.out);
    expect(data.verifyRoute).toBe("record");
    expect(data.mainChangedFiles).toEqual([changed]);
    expect(await git(root, "log", "--format=%s", "-2")).toContain(
      "統括役: T12 をマージする",
    );
    // merge されて main の変更を含む
    expect(
      await git(wtPath, "merge-base", "--is-ancestor", mainSha, "HEAD").catch(
        () => "ng",
      ),
    ).toBe("");
    // 書き換えていない：取り込む前のタスクの先頭が今の先頭の祖先のまま
    expect(
      await git(wtPath, "merge-base", "--is-ancestor", before, "HEAD").catch(
        () => "ng",
      ),
    ).toBe("");
  };

  it(".orca-flow/config.json の maxActiveTasks だけなら、テストを流さずに main を取り込んでマージする", async () => {
    const { root, wt } = await setup();
    const current = await readConfig(root);
    const sha = await commitMain(root, {
      ".orca-flow/config.json": JSON.stringify(
        { ...current, maxActiveTasks: 5 },
        null,
        2,
      ),
    });
    await expectMerged(root, wt.path, ".orca-flow/config.json", sha);
  });

  it("進捗表のファイルだけなら、テストを流さずにマージする", async () => {
    const { root, wt } = await setup();
    const table = await readFile(path.join(root, "docs/progress.md"), "utf8");
    const sha = await commitMain(root, {
      "docs/progress.md": table.replace("表のうしろの文。", "別の文。"),
    });
    await expectMerged(root, wt.path, "docs/progress.md", sha);
  });

  it("verifySkipPaths の中のファイルだけなら、テストを流さずにマージする", async () => {
    const { root, wt } = await setup();
    const sha = await commitMain(root, { "notes/new.md": "x\n" });
    await expectMerged(root, wt.path, "notes/new.md", sha);
  });

  it("標準出力に記録の時刻と main で変わったファイルが出る", async () => {
    const { root, wt } = await setup();
    const record = JSON.parse(
      await readFile(
        path.join(root, ".git/orca-flow/verified/T12.json"),
        "utf8",
      ),
    );
    await commitMain(root, { "notes/new.md": "x\n" });
    const { result } = await run(root, wt.path);
    expect(result.out).toContain(
      `${record.at} に T12 のコンソールで通った記録を使います`,
    );
    expect(result.out).toContain("notes/new.md");
  });

  it("テストに関係するファイルが変わったら、終了コード2でそのファイルを添え、何もしない", async () => {
    const { root, wt } = await setup();
    await commitMain(root, { "notes/new.md": "x\n", "other.txt": "x\n" });
    const before = await git(root, "rev-parse", "HEAD");
    const { result, orca, shells } = await run(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("orca-flow verify");
    expect(result.err).toContain("main が動きました");
    expect(result.err).toContain("other.txt");
    expect(result.err).not.toContain("notes/new.md");
    expect(shells).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
  });

  it("main で verify のコマンドを変えたら、終了コード2で「コマンドが変わりました」", async () => {
    const { root, wt } = await setup();
    const current = await readConfig(root);
    await commitMain(root, {
      ".orca-flow/config.json": JSON.stringify({
        ...current,
        verify: ["true"],
      }),
    });
    const { result, shells } = await run(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("コマンドが変わりました");
    expect(result.err).toContain("orca-flow verify");
    expect(shells).toEqual([]);
  });

  it("取り込みが競合したら、終了コード2で worktree と main は元のまま、やり直しを送る", async () => {
    const { root, wt } = await setup();
    await writeFile(path.join(wt.path, "shared.txt"), "task\n");
    // 記録を取り直してからタスクの変更を足す（shared.txt は設計書の範囲）
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: shared");
    const verify = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(verify.code).toBe(0);
    // shared.txt を「テストに関係しない場所」にするため、verifySkipPaths に入れる
    const current = await readConfig(root);
    await commitMain(root, {
      ".orca-flow/config.json": JSON.stringify({
        ...current,
        verifySkipPaths: ["notes/", "shared.txt"],
      }),
      "shared.txt": "main\n",
    });
    // 設定が変わると commands は同じだが、タスクの差分は skip の中だけではない
    const mainBefore = await git(root, "rev-parse", "HEAD");
    const taskBefore = await git(wt.path, "rev-parse", "HEAD");
    const { result, orca, shells } = await run(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("orca-flow verify");
    expect(result.err).toContain("競合");
    expect(shells).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(taskBefore);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    const sends = orca.callsOf("terminal", "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![5]).toContain("orca-flow verify");
    const sent = String(sends[0]![5]);
    expect(sent).not.toContain("\n");
    expect(sent).not.toContain("shared.txt");
    expect(result.err).toContain("shared.txt");
  });

  it("main で移動したファイルは、移動元も調べて関係ありとする", async () => {
    const { root, wt } = await setup();
    await git(root, "mv", "shared.txt", "notes/shared.txt");
    await git(root, "commit", "--quiet", "-m", "移動");
    const { result, shells } = await run(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("main が動きました");
    expect(result.err).toContain("shared.txt");
    expect(shells).toEqual([]);
  });

  it("仕様の8章 integrate の行に、テストに関係しない場所だけ main が動いたときの扱いがある", async () => {
    const spec = await readFile(
      path.join(import.meta.dirname, "../../docs/spec.md"),
      "utf8",
    );
    const line = spec
      .split("\n")
      .find((l) => l.includes("| `integrate 〈ID〉"));
    expect(line).toBeDefined();
    for (const word of [
      "テストに関係しない",
      "--no-renames",
      "git merge 〈baseBranch〉",
      "mainChangedFiles",
    ])
      expect(line).toContain(word);
  });

  it("記録の base が今の main の祖先でなければ、終了コード2", async () => {
    const { root, wt } = await setup();
    const file = path.join(root, ".git/orca-flow/verified/T12.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    await commitMain(root, { "notes/x.md": "x\n" });
    // main を書き換えた状態：記録の base を、main にない別のコミットにする
    await git(root, "checkout", "--quiet", "--detach", "HEAD~1");
    await commitMain(root, { "notes/y.md": "y\n" }, "別の履歴");
    record.base = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "--quiet", "main");
    await writeFile(file, JSON.stringify(record));
    const { result, shells } = await run(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("orca-flow verify");
    expect(result.err).toContain("祖先ではありません");
    expect(shells).toEqual([]);
  });

  it("記録の base のコミットが見つからなければ、終了コード2で「見つかりません」", async () => {
    const { root, wt } = await setup();
    const file = path.join(root, ".git/orca-flow/verified/T12.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    await commitMain(root, { "notes/x.md": "x\n" });
    record.base = "0123456789abcdef0123456789abcdef01234567";
    await writeFile(file, JSON.stringify(record));
    const before = await git(root, "rev-parse", "HEAD");
    const { result, shells } = await run(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("orca-flow verify");
    expect(result.err).toContain("記録の main のコミットが見つかりません");
    expect(shells).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });
});
