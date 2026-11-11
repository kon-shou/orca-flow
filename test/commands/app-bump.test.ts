import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeCrossDepends } from "../../src/lib/cross-depends.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import { runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const BRANCH = "task/T05-lib";

const appBump = (cwd: string, args: string[]) =>
  runCli(["app-bump", ...args], { cwd, runner: testRunner });

async function setup() {
  const origin = await tempDir("orca-flow-origin-");
  await git(origin, "init", "--bare", "--quiet", "-b", "main");
  const common = await makeRepo();
  await git(common, "remote", "add", "origin", origin);
  await git(common, "push", "--quiet", "origin", "main");
  const pushedHead = await git(common, "rev-parse", "HEAD");
  await writeFiles(common, { "feature.txt": "x\n" });
  await git(common, "add", "-A");
  await git(common, "commit", "--quiet", "-m", "GitHub のマージ");
  const mergeCommit = await git(common, "rev-parse", "HEAD");
  await git(common, "push", "--quiet", "origin", "main");
  await git(origin, "tag", "v1.2.0", mergeCommit);
  await writePushRecord(testRunner, common, "T05", {
    id: "T05",
    branch: BRANCH,
    base: "main",
    pushedHead,
    pushedAt: "2026-11-03T00:00:00Z",
    pr: null,
    mergeCommit,
  });
  const app = await makeRepo();
  const task = await addTaskWorktree(app, "T01", "x", {
    "composer.json": `{"require":{"acme/core-kit":"dev-${BRANCH}"}}\n`,
    "composer.lock": `{"reference":"${pushedHead}","version":"dev-${BRANCH}"}\n`,
  });
  return { common, app, task };
}

const record = (app: string, common: string) =>
  writeCrossDepends(testRunner, app, "T01", [
    {
      name: "core-kit",
      path: common,
      package: "acme/core-kit",
      branch: BRANCH,
      branchCommand: "composer require acme/core-kit:dev-{branch}",
      bumpCommand: "composer require acme/core-kit:^1",
      ids: ["T05"],
    },
  ]);

/** 記録のディレクトリの下のファイルの並びと中身（なければ空） */
async function recordFiles(dir: string): Promise<[string, string][]> {
  const entries = await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  const out: [string, string][] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    out.push([path.relative(dir, file), await readFile(file, "utf8")]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

describe("app-bump", () => {
  it("記録がなければ「記録なし」で終了コード0", async () => {
    const { app } = await setup();
    const r = await appBump(app, ["T01"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("記録なし");
    const j = await appBump(app, ["T01", "--json"]);
    expect(JSON.parse(j.out)).toMatchObject({ record: false, items: [] });
  });

  it("壊れた記録は終了コード1", async () => {
    const { app } = await setup();
    const dir = await git(
      app,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    await writeFiles(dir, { "orca-flow/cross-depends/T01.json": "{" });
    const r = await appBump(app, ["T01"]);
    expect(r.code).toBe(1);
  });

  it("--json は要素ごとの判定と版を出す。統括役の場所からもタスクの worktree からも同じ", async () => {
    const { app, common, task } = await setup();
    await record(app, common);
    for (const cwd of [app, task.path]) {
      const r = await appBump(cwd, ["T01", "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({
        id: "T01",
        branch: task.branch,
        record: true,
        items: [
          {
            name: "core-kit",
            branch: BRANCH,
            verdict: "bump",
            version: "1.2.0",
            key: "bump:core-kit:1.2.0",
          },
        ],
      });
    }
    const text = await appBump(app, ["T01"]);
    expect(text.out).toContain("版を上げる 1.2.0");
  });

  it("何も書かない（タスクの worktree・統括役の場所・記録が変わらない）", async () => {
    const { app, common, task } = await setup();
    await record(app, common);
    const dir = await git(
      app,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const commonDir = await git(
      common,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    expect(await recordFiles(path.join(dir, "orca-flow"))).not.toEqual([]);
    expect(await recordFiles(path.join(commonDir, "orca-flow"))).not.toEqual(
      [],
    );
    const snapshot = async () =>
      [
        await git(app, "status", "--porcelain"),
        await git(task.path, "status", "--porcelain"),
        await git(app, "for-each-ref", "--format=%(refname) %(objectname)"),
        await git(common, "status", "--porcelain"),
        await git(
          common,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/heads",
        ),
        await git(common, "rev-parse", "HEAD"),
        JSON.stringify(await recordFiles(path.join(dir, "orca-flow"))),
        JSON.stringify(await recordFiles(path.join(commonDir, "orca-flow"))),
      ].join("\n--\n");
    const before = await snapshot();
    await appBump(app, ["T01", "--json"]);
    expect(await snapshot()).toBe(before);
  });

  it("引数の誤り・作業中でない ID は終了コード1", async () => {
    const { app } = await setup();
    expect((await appBump(app, [])).code).toBe(1);
    expect((await appBump(app, ["T01", "T02"])).code).toBe(1);
    expect((await appBump(app, ["X1"])).code).toBe(1);
    expect((await appBump(app, ["T77"])).code).toBe(1);
  });
});
