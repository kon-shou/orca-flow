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

const FIX_SUBJECT = "T12: マージで欠けた決定の記録の空行を戻す";
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
  it("rebase で行が消えると、終了コード1で止まり、テストは流れず記録も残らない", async () => {
    const { root, wt } = await setup(same);
    const { runner, shells } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(1);
    expect(result.err).toContain(STOP);
    expect(result.err).toContain(
      "行を戻し、自分の項を末尾に足し直してコミットしてから、orca-flow verify をやり直してください",
    );
    expect(shells).toEqual([]);
    expect(existsSync(recordPath(root))).toBe(false);
  });

  it("手で rebase して行が消えたあとに verify を流しても止まる", async () => {
    const { root, wt } = await setup(same);
    await git(wt.path, "rebase", "main");
    const { runner, shells } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(1);
    expect(result.err).toContain(STOP);
    expect(shells).toEqual([]);
    expect(existsSync(recordPath(root))).toBe(false);
  });
});

describe("verify は欠けた見出しの前の空行を戻す", () => {
  it("空行だけが欠けたときは通り、記録だけのコミットが1つできる", async () => {
    const { root, wt } = await setup(differ);
    const before = await git(wt.path, "rev-parse", "HEAD");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("空行を戻してコミットしました");
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
      "決定の記録の空行の戻しをコミットできませんでした（元に戻しました）",
    );
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "diff", "--cached", "--name-only")).toBe("");
    const text = await readFile(path.join(wt.path, FILE), "utf8");
    // rebase のあとの、空行の欠けた（くっついた）見出しの記録がそのまま残っている
    expect(text).toBe(BASE + differ("main") + differ("タスク").slice(1));
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
    expect(
      await git(wt.path, "log", "--format=%s", "main..HEAD"),
    ).not.toContain("空行を戻す");
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
    expect(
      await git(wt.path, "log", "--format=%s", "main..HEAD"),
    ).not.toContain("空行を戻す");
  });
});
