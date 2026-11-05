import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";

const FILE = "docs/decisions.md";
const BASE = "# 決定の記録\n";
// 最後の行が同じ項（union が最後の行を1つにまとめる）
const same = (name: string) =>
  `\n## 2026-01-01 ${name}\n\n- 決めたこと：${name}\n- 理由：同じ\n`;
// 最後の行が違う項
const differ = (name: string) =>
  `\n## 2026-01-01 ${name}\n\n- 決めたこと：${name}\n`;

// タスクと main が、同じ見出しの項を足す（戻すと見出しが二重になるので戻せない）
const clash = (name: string) =>
  `\n## 2026-01-01 共通\n\n- 決めたこと：${name}\n- 理由：${name}\n`;

const BLANK_SUBJECT = "T12: マージで欠けた決定の記録の空行を戻す";
const FIX_SUBJECT = "T12: 取り込みで欠けた決定の記録の行を戻す";
const STOP = `main の ${FILE} が、タスクのブランチの ${FILE} の先頭と同じではありません`;

async function setup(
  entry: (name: string) => string,
  config: Record<string, unknown> = {},
  adds: { task: boolean; main: boolean } = { task: true, main: true },
) {
  const root = await makeRepo(
    {
      decisionsFile: FILE,
      appendOnlyFiles: [FILE],
      verify: ["test -f src/a.ts"],
      ...config,
    },
    { [FILE]: BASE, ".gitattributes": `${FILE} merge=union\n` },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/a.ts": "export {};\n",
    ...(adds.task ? { [FILE]: BASE + entry("タスク") } : {}),
  });
  if (adds.main) {
    await writeFiles(root, { [FILE]: BASE + entry("main") });
    await git(root, "commit", "--quiet", "-am", "main の項");
  }
  return { root, wt };
}

const counting = () => {
  const shells: string[] = [];
  const orca = fakeOrca();
  const runner: Runner = (cmd, args, opts) => {
    if (cmd === "sh") shells.push(args[1]!);
    return orca.runner(cmd, args, opts);
  };
  return { runner, shells };
};

const recordPath = (root: string) =>
  path.join(root, ".git/orca-flow/verified/T12.json");

describe("verify は決定の記録の行が消えるのを止める", () => {
  it("merge=union が項の並びを入れ替えて行が消えても、verify が取り込みの前の先頭から戻して通る", async () => {
    const { root, wt } = await setup(same);
    const before = await git(wt.path, "rev-parse", "HEAD");
    const { runner } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(0);
    expect(result.out).toContain("項の並びを戻してコミットしました");
    // 取り込みの前の先頭は祖先のまま残る（書き換えない）
    await git(wt.path, "merge-base", "--is-ancestor", before, "HEAD");
    const text = await readFile(path.join(wt.path, FILE), "utf8");
    expect(text.startsWith(BASE + same("main"))).toBe(true);
    expect(text).toContain("- 決めたこと：タスク\n- 理由：同じ\n");
    expect(existsSync(recordPath(root))).toBe(true);
  });

  it("手で rebase して行が消えたあとに verify を流しても止まる", async () => {
    const { root, wt } = await setup(same);
    // 手で rebase して、行が消えた形にする（verify は取り込まず、確かめだけで止める）
    await git(wt.path, "rebase", "main");
    const { runner, shells } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(1);
    expect(result.err).toContain(STOP);
    expect(shells).toEqual([]);
    expect(existsSync(recordPath(root))).toBe(false);
  });
});

describe("verify が自分で取り込んで行を戻せないとき", () => {
  it("main と同じ見出しの項は、警告を出して終了コード1で止まり、テストも記録もなく、取り込んだまま残る", async () => {
    const { root, wt } = await setup(clash);
    const before = await git(wt.path, "rev-parse", "HEAD");
    const { runner, shells } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(1);
    expect(result.err).toContain("警告：決定の記録の行を戻せませんでした");
    expect(result.err).toContain(
      "足す項の見出し「## 2026-01-01 共通」が main にすでにあります",
    );
    expect(result.err).toContain(STOP);
    expect(shells).toEqual([]);
    expect(existsSync(recordPath(root))).toBe(false);
    // worktree は取り込んだまま（マージのコミットで、1つ目の親が前の先頭）
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "rev-parse", "HEAD^1")).toBe(before);
    expect(await git(wt.path, "log", "--format=%s", "-1")).toBe(
      "T12: main を取り込む",
    );
  });
});

describe("verify は手で取り込んだあとも決定の記録の行を戻す", () => {
  const mergeByHand = (cwd: string) =>
    git(cwd, "merge", "main", "-m", "T12: main を取り込む");

  it("手で git merge main して行が消えても、取り込みの前の先頭から戻して通る", async () => {
    const { root, wt } = await setup(same);
    const before = await git(wt.path, "rev-parse", "HEAD");
    await mergeByHand(wt.path);
    const merged = await git(wt.path, "rev-parse", "HEAD");
    const { runner } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("項の並びを戻してコミットしました");
    // 手で取り込んだマージはそのまま残り、戻しのコミットが1つ足される
    expect(await git(wt.path, "rev-parse", "HEAD^1")).toBe(merged);
    await git(wt.path, "merge-base", "--is-ancestor", before, "HEAD");
    expect(await git(wt.path, "log", "--format=%s", "-1")).toBe(FIX_SUBJECT);
    const text = await readFile(path.join(wt.path, FILE), "utf8");
    expect(text.startsWith(BASE + same("main"))).toBe(true);
    expect(text).toContain("- 決めたこと：タスク\n- 理由：同じ\n");
    const record = JSON.parse(await readFile(recordPath(root), "utf8"));
    expect(record.head).toBe(await git(wt.path, "rev-parse", "HEAD"));
  });

  it("手で merge したあと、戻す必要がなければコミットを足さない", async () => {
    const { root, wt } = await setup(differ, {}, { task: true, main: false });
    // main は記録に触れないコミットだけ進む
    await writeFiles(root, { "other.txt": "x\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "main が進む");
    await mergeByHand(wt.path);
    const merged = await git(wt.path, "rev-parse", "HEAD");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(merged);
  });

  it.each([
    ["行を足す", "- 追記：マージのあとの行\n"],
    ["項を足す", "\n## 2026-01-02 タスク2\n\n- 決めたこと：あと\n"],
  ])(
    "手で merge したあとにタスクが記録に%sコミットがあると、戻さずに止まり、足した分も消えない",
    async (_name, added) => {
      const { root, wt } = await setup(same);
      await mergeByHand(wt.path);
      const file = path.join(wt.path, FILE);
      await writeFile(file, (await readFile(file, "utf8")) + added);
      await git(wt.path, "commit", "--quiet", "-am", "T12: あとで足す");
      const head = await git(wt.path, "rev-parse", "HEAD");
      const { runner, shells } = counting();
      const result = await runCli(["verify"], { cwd: wt.path, runner });
      expect(result.code).toBe(1);
      expect(result.err).toContain(STOP);
      expect(shells).toEqual([]);
      expect(existsSync(recordPath(root))).toBe(false);
      expect(await git(wt.path, "rev-parse", "HEAD")).toBe(head);
      expect(await git(wt.path, "status", "--porcelain")).toBe("");
      expect(await readFile(file, "utf8")).toContain(added);
    },
  );

  it("main に統合のマージ（--no-ff）があっても、手で rebase したあとは取り込みのマージとして拾わず、合わない警告も出さずに止まる", async () => {
    const { root, wt } = await setup(same);
    const sha = await git(
      root,
      "commit-tree",
      "main^{tree}",
      "-p",
      "main",
      "-m",
      "別のタスク",
    );
    await git(root, "merge", "--no-ff", sha, "-m", "統括役: T99 をマージする");
    await git(wt.path, "rebase", "main");
    const { runner, shells } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(1);
    expect(result.err).toContain(STOP);
    expect(result.err).not.toContain("戻せませんでした");
    expect(shells).toEqual([]);
    expect(existsSync(recordPath(root))).toBe(false);
  });

  it("戻せない形（main と同じ見出しの項）なら、手で merge したあとも終了コード1で止まる", async () => {
    const { root, wt } = await setup(clash);
    await mergeByHand(wt.path);
    const merged = await git(wt.path, "rev-parse", "HEAD");
    const { runner, shells } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(1);
    expect(result.err).toContain("警告：決定の記録の行を戻せませんでした");
    expect(result.err).toContain(STOP);
    expect(shells).toEqual([]);
    expect(existsSync(recordPath(root))).toBe(false);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(merged);
  });
});

describe("verify は欠けた見出しの前の空行を戻す", () => {
  it("項の並びだけが入れ替わったときは通り、記録だけのコミットが1つできる", async () => {
    const { root, wt } = await setup(differ);
    const before = await git(wt.path, "rev-parse", "HEAD");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("項の並びを戻してコミットしました");
    const log = (await git(wt.path, "log", "--format=%H %s", "main..HEAD"))
      .split("\n")
      .filter((l) => l.endsWith(FIX_SUBJECT));
    expect(log).toHaveLength(1);
    const sha = log[0]!.split(" ")[0]!;
    expect(await git(wt.path, "show", "--format=", "--name-only", sha)).toBe(
      FILE,
    );
    expect(sha).toBe(await git(wt.path, "rev-parse", "HEAD"));
    expect(before).not.toBe(sha);
    const text = await readFile(path.join(wt.path, FILE), "utf8");
    expect(await prettier.check(text, { parser: "markdown" })).toBe(true);
    expect(text).toContain("2026-01-01 main");
    expect(text).toContain("2026-01-01 タスク");
    const record = JSON.parse(await readFile(recordPath(root), "utf8"));
    expect(record.head).toBe(sha);
  });

  it("手で rebase して空行だけが欠けたあとに verify を流すと、空行を戻して記録だけのコミットが1つできる", async () => {
    const { root, wt } = await setup(differ);
    await git(wt.path, "rebase", "main");
    const rebased = await git(wt.path, "rev-parse", "HEAD");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      `${FILE} の見出しの前の空行を戻してコミットしました（${BLANK_SUBJECT}）`,
    );
    const log = (await git(wt.path, "log", "--format=%H %s", "main..HEAD"))
      .split("\n")
      .filter((l) => l.endsWith(BLANK_SUBJECT));
    expect(log).toHaveLength(1);
    const sha = log[0]!.split(" ")[0]!;
    expect(sha).toBe(await git(wt.path, "rev-parse", "HEAD"));
    expect(await git(wt.path, "rev-parse", "HEAD^")).toBe(rebased);
    // 変えたのは記録のファイルだけ
    expect(await git(wt.path, "show", "--format=", "--name-only", sha)).toBe(
      FILE,
    );
    const text = await readFile(path.join(wt.path, FILE), "utf8");
    expect(await prettier.check(text, { parser: "markdown" })).toBe(true);
    expect(text.startsWith(BASE + differ("main"))).toBe(true);
    expect(text).toContain("2026-01-01 タスク");
    const record = JSON.parse(await readFile(recordPath(root), "utf8"));
    expect(record.head).toBe(sha);
  });

  it("手で rebase したあと、空行の戻しをコミットできないと、終了コード1で止まり、記録の中身もステージも元のまま", async () => {
    const { wt } = await setup(differ);
    await git(wt.path, "rebase", "main");
    const hookDir = (
      await git(wt.path, "rev-parse", "--git-common-dir")
    ).trim();
    const hook = path.resolve(wt.path, hookDir, "hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho フック失敗 >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const rebased = await git(wt.path, "rev-parse", "HEAD");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "決定の記録の空行の戻しをコミットできませんでした（元に戻しました）",
    );
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(rebased);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "diff", "--cached", "--name-only")).toBe("");
    const text = await readFile(path.join(wt.path, FILE), "utf8");
    // rebase のあとの、空行の欠けた（くっついた）見出しの記録がそのまま残っている
    expect(text).toBe(BASE + differ("main") + differ("タスク").slice(1));
  });

  it("コミットに失敗すると、終了コード1で止まり、記録の中身もステージも元のまま", async () => {
    const { wt } = await setup(differ);
    const hookDir = (
      await git(wt.path, "rev-parse", "--git-common-dir")
    ).trim();
    const hook = path.resolve(wt.path, hookDir, "hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho フック失敗 >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "決定の記録の行の戻しをコミットできませんでした（記録のファイルを元に戻しました",
    );
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "diff", "--cached", "--name-only")).toBe("");
    const text = await readFile(path.join(wt.path, FILE), "utf8");
    // 取り込みのあとの、空行の欠けた（くっついた）見出しの記録がそのまま残っている
    expect(text).toBe(BASE + differ("タスク") + differ("main").slice(1));
  });
});

describe("verify は記録に関わらないとき今までどおり通る", () => {
  it("記録が変わらない（片方だけが足した）とき、コミットを作らない", async () => {
    const { wt } = await setup(differ, {}, { task: true, main: false });
    const before = await git(wt.path, "rev-parse", "HEAD");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(before);
  });

  it("decisionsFile が設定にないとき、行が消えても止まらずコミットも作らない", async () => {
    const { wt } = await setup(same, { decisionsFile: undefined });
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    const subjects = await git(wt.path, "log", "--format=%s", "main..HEAD");
    expect(subjects).not.toContain(BLANK_SUBJECT);
    expect(subjects).not.toContain(FIX_SUBJECT);
  });

  it("main に記録がないとき、何もしない", async () => {
    const root = await makeRepo({
      decisionsFile: FILE,
      appendOnlyFiles: [FILE],
      verify: ["test -f src/a.ts"],
    });
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "src/a.ts": "export {};\n",
      [FILE]: `${BASE}## 2026-01-01 タスク\n`,
    });
    const before = await git(wt.path, "rev-parse", "HEAD");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(before);
    const subjects = await git(wt.path, "log", "--format=%s", "main..HEAD");
    expect(subjects).not.toContain(BLANK_SUBJECT);
    expect(subjects).not.toContain(FIX_SUBJECT);
  });
});
