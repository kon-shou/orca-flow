import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";

const FILE = "docs/decisions.md";
const BASE = "# 決定の記録\n";
const VERIFY = "test -f src/a.ts";
const LIGHT = "test -s docs/decisions.md";
const entry = (name: string) =>
  `\n## 2026-01-01 ${name}\n\n- 決めたこと：${name}\n`;

async function setup(
  pathVerify: unknown[] = [{ paths: [FILE], commands: [LIGHT] }],
  appendOnlyFiles: string[] = [FILE],
) {
  const root = await makeRepo(
    { appendOnlyFiles, verify: [VERIFY], pathVerify },
    Object.fromEntries(appendOnlyFiles.map((f) => [f, BASE])),
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/a.ts": "export {};\n",
  });
  return { root, wt };
}

const counting = (failOn: string | null = null) => {
  const shells: string[] = [];
  const orca = fakeOrca();
  const runner: Runner = (cmd, args, opts) => {
    if (cmd === "sh") {
      shells.push(args[1]!);
      if (args[1] === failOn)
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "落ちた",
          timedOut: false,
        });
    }
    return orca.runner(cmd, args, opts);
  };
  return { runner, shells };
};

const verify = (cwd: string, failOn: string | null = null) => {
  const c = counting(failOn);
  return runCli(["verify"], { cwd, runner: c.runner }).then((result) => ({
    result,
    shells: c.shells,
  }));
};

const commit = async (cwd: string, files: Record<string, string>) => {
  await writeFiles(cwd, files);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "--quiet", "-m", "T12: 足す");
};

const recordPath = (root: string) =>
  path.join(root, ".git/orca-flow/verified/T12.json");
const readJson = async (root: string) =>
  JSON.parse(await readFile(recordPath(root), "utf8"));

describe("verify の記録の引き継ぎ", () => {
  it("決定の記録だけのコミットなら、設定のコマンドを流さず当たる pathVerify だけを流して引き継ぐ", async () => {
    const { root, wt } = await setup();
    const first = await verify(wt.path);
    expect(first.shells).toEqual([VERIFY]);
    const full = await readJson(root);
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    const { result, shells } = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(shells).toEqual([LIGHT]);
    expect(result.out).toContain("引き継ぎ");
    expect(result.out).toContain(FILE);
    expect(result.out).toContain(full.at);
    const record = await readJson(root);
    expect(record.head).toBe(await git(wt.path, "rev-parse", "HEAD"));
    expect(record.base).toBe(await git(root, "rev-parse", "main"));
    expect(record.commands).toEqual([VERIFY, LIGHT]);
    expect(record.carried).toEqual({
      fullHead: full.head,
      fullAt: full.at,
      files: [FILE],
    });
  });

  it("当たる pathVerify がなければ何も流さず、組み込みの確かめだけと出す", async () => {
    const { root, wt } = await setup([]);
    await verify(wt.path);
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    const { result, shells } = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(shells).toEqual([]);
    expect(result.out).toContain("組み込みの確かめだけ");
    expect((await readJson(root)).carried.files).toEqual([FILE]);
  });

  it("--json の data に引き継ぎの中身が入る", async () => {
    const { wt } = await setup();
    await verify(wt.path);
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    const c = counting();
    const result = await runCli(["verify", "--json"], {
      cwd: wt.path,
      runner: c.runner,
    });
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out);
    expect(data.carried.files).toEqual([FILE]);
    expect(data.carried.fullAt).toBeTruthy();
    expect(data.carriedRun).toEqual([LIGHT]);
    expect(c.shells).toEqual([LIGHT]);
  });

  it("日本語の名前のファイルでも引き継げる", async () => {
    const JP = "docs/決定.md";
    const jpLight = "test -s docs/決定.md";
    const { root, wt } = await setup(
      [{ paths: [JP], commands: [jpLight] }],
      [JP],
    );
    await verify(wt.path);
    await commit(wt.path, { [JP]: BASE + entry("a") });
    const { result, shells } = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(shells).toEqual([jpLight]);
    expect((await readJson(root)).carried.files).toEqual([JP]);
  });

  it("追記だけでないファイルも変えたコミットがあると、全部のコマンドを流す", async () => {
    const { root, wt } = await setup();
    await verify(wt.path);
    await commit(wt.path, { [FILE]: BASE + entry("a"), "src/b.ts": "b\n" });
    const { result, shells } = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(shells).toEqual([VERIFY, LIGHT]);
    expect((await readJson(root)).carried).toBeUndefined();
  });

  it("記録がなければ全部のコマンドを流す", async () => {
    const { wt } = await setup();
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    const { shells } = await verify(wt.path);
    expect(shells).toEqual([VERIFY, LIGHT]);
  });

  it("記録の先頭が今の先頭の祖先でなければ全部のコマンドを流す", async () => {
    const { wt } = await setup();
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    await verify(wt.path);
    await writeFiles(wt.path, { [FILE]: BASE + entry("a") + entry("b") });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "--amend", "-m", "T12: 直す");
    const { shells } = await verify(wt.path);
    expect(shells).toEqual([VERIFY, LIGHT]);
  });

  it("記録の先頭と今の先頭が同じなら全部のコマンドを流す", async () => {
    const { wt } = await setup();
    await verify(wt.path);
    const { shells } = await verify(wt.path);
    expect(shells).toEqual([VERIFY]);
  });

  it("流すコマンドの外でコマンドが変わっていたら全部のコマンドを流す", async () => {
    const { root, wt } = await setup();
    await verify(wt.path);
    const record = await readJson(root);
    record.commands = ["test -f README.md"];
    await writeFile(recordPath(root), JSON.stringify(record));
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    const { shells } = await verify(wt.path);
    expect(shells).toEqual([VERIFY, LIGHT]);
  });

  it("main にコードの変更が入ってから取り込むと、全部のコマンドを流す", async () => {
    const { root, wt } = await setup();
    await verify(wt.path);
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    await commit(root, { "other.ts": "x\n" });
    const { result, shells } = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(shells).toEqual([VERIFY, LIGHT]);
  });

  it("引き継ぎで流すコマンドが落ちると終了コード1で、記録が残らない", async () => {
    const { root, wt } = await setup();
    await verify(wt.path);
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    const { result } = await verify(wt.path, LIGHT);
    expect(result.code).toBe(1);
    expect(result.err).toContain("落ちた");
    expect(existsSync(recordPath(root))).toBe(false);
  });

  it("引き継いだ記録からもう一度引き継ぐと、最初に全部を流した時点を保ち、当たる pathVerify をまた流す", async () => {
    const { root, wt } = await setup();
    await verify(wt.path);
    const full = await readJson(root);
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    await verify(wt.path);
    await commit(wt.path, { [FILE]: BASE + entry("a") + entry("b") });
    const { shells } = await verify(wt.path);
    expect(shells).toEqual([LIGHT]);
    const record = await readJson(root);
    expect(record.carried.fullHead).toBe(full.head);
    expect(record.carried.fullAt).toBe(full.at);
    expect(record.head).toBe(await git(wt.path, "rev-parse", "HEAD"));
  });

  it("重ねて引き継ぐと、引き継いだファイルが和集合になる", async () => {
    const FILE2 = "docs/other.md";
    const { root, wt } = await setup(
      [{ paths: [FILE, FILE2], commands: [LIGHT] }],
      [FILE, FILE2],
    );
    await verify(wt.path);
    await commit(wt.path, { [FILE]: BASE + entry("a") });
    await verify(wt.path);
    await commit(wt.path, { [FILE2]: BASE + entry("b") });
    const { shells } = await verify(wt.path);
    expect(shells).toEqual([LIGHT]);
    expect((await readJson(root)).carried.files).toEqual([FILE, FILE2]);
  });
});
