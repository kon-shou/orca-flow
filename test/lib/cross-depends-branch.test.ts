import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  checkCrossDepends,
  isBranchName,
  parseCrossDependsJson,
  readCrossDepends,
  resolveCrossDependsArgs,
  writeCrossDepends,
  type CrossDependsRepo,
} from "../../src/lib/cross-depends.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import { FlowError } from "../../src/types.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const branchRepo = (
  over: Partial<CrossDependsRepo> = {},
): CrossDependsRepo => ({
  name: "core-kit",
  path: "/tmp/core-kit-main",
  package: "acme/core-kit",
  branch: "task/K01-fix",
  branchCommand: "composer require acme/core-kit:dev-task/K01-fix",
  bumpCommand: "composer require acme/core-kit:^1",
  ids: ["K01"],
  ...over,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof FlowError ? e.code : -1;
  }
  return 0;
};

describe("記録の枝", () => {
  it("branch のある repos は version なしで書いて読み直せる", async () => {
    const root = await makeRepo();
    await writeCrossDepends(
      testRunner,
      root,
      "T01",
      [branchRepo()],
      new Date(0),
    );
    const read = await readCrossDepends(testRunner, root, "T01");
    expect(read?.repos).toEqual([branchRepo()]);
  });

  it("枝の形の外れ・branchCommand の欠け・version も branch もないものは FlowError(1)", () => {
    for (const bad of [
      branchRepo({ branch: "-x" }),
      branchRepo({ branch: "a b" }),
      branchRepo({ branch: "a/" }),
      branchRepo({ branch: "a..b" }),
      branchRepo({ branchCommand: undefined }),
      branchRepo({ branchCommand: "" }),
      branchRepo({ bumpCommand: undefined }),
      branchRepo({ bumpCommand: "" }),
      branchRepo({ branch: undefined, branchCommand: undefined }),
      branchRepo({ branch: undefined, version: "1.0.0" }),
    ]) {
      expect(() => parseCrossDependsJson(JSON.stringify([bad]))).toThrow(
        FlowError,
      );
    }
    expect(parseCrossDependsJson(JSON.stringify([branchRepo()]))).toEqual([
      branchRepo(),
    ]);
  });

  it("壊れた記録は読むとき FlowError(1)", async () => {
    const root = await makeRepo();
    await writeCrossDepends(testRunner, root, "T01", [branchRepo()]);
    const common = await git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      `${common}/orca-flow/cross-depends/T01.json`,
      JSON.stringify({
        id: "T01",
        at: "x",
        repos: [branchRepo({ branchCommand: undefined })],
      }),
    );
    expect(await code(readCrossDepends(testRunner, root, "T01"))).toBe(1);
  });

  it("isBranchName は baseBranch と同じ形", () => {
    expect(isBranchName("task/K01-fix")).toBe(true);
    expect(isBranchName("v1.2_x")).toBe(true);
    for (const b of [
      "",
      "-a",
      "/a",
      ".a",
      "a/",
      "a.",
      "a//b",
      "a/.b",
      "a;b",
      "a$(x)",
      "x.lock",
    ])
      expect(isBranchName(b)).toBe(false);
  });
});

describe("親の渡し方の --branches", () => {
  const repos = [
    {
      name: "core-kit",
      path: "/p/core-kit",
      role: "common" as const,
      package: "acme/core-kit",
      bumpCommand: "composer require acme/core-kit:^1",
      branchCommand: "composer require acme/core-kit:dev-{branch}",
    },
    {
      name: "plain-kit",
      path: "/p/plain-kit",
      role: "common" as const,
      package: "acme/plain-kit",
      bumpCommand: "composer require acme/plain-kit:^1",
    },
    { name: "shop-app", path: "/p/shop-app", role: "app" as const },
  ];
  const resolve = (dep: string, bumps?: string, branches?: string) =>
    resolveCrossDependsArgs(repos, "shop-app", dep, bumps, branches);

  it("branchCommand の {branch} を置き換えた記録の JSON にする", () => {
    const json = resolve(
      "core-kit:K01,plain-kit:Q01",
      "plain-kit=2.0.0",
      "core-kit=task/K01-fix",
    );
    expect(JSON.parse(json!)).toEqual([
      {
        name: "core-kit",
        path: "/p/core-kit",
        package: "acme/core-kit",
        branch: "task/K01-fix",
        branchCommand: "composer require acme/core-kit:dev-task/K01-fix",
        bumpCommand: "composer require acme/core-kit:^1",
        ids: ["K01"],
      },
      {
        name: "plain-kit",
        path: "/p/plain-kit",
        package: "acme/plain-kit",
        version: "2.0.0",
        ids: ["Q01"],
      },
    ]);
  });

  it("branchCommand のない共通・同じ名前の両方・枝の形の外れ・依存のない枝は FlowError(1)", () => {
    const fails = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof FlowError ? e.code : -1;
      }
      return 0;
    };
    expect(
      fails(() => resolve("plain-kit:Q01", undefined, "plain-kit=x")),
    ).toBe(1);
    expect(
      fails(() => resolve("core-kit:K01", "core-kit=1.0.0", "core-kit=x")),
    ).toBe(1);
    expect(
      fails(() => resolve("core-kit:K01", undefined, "core-kit=a;b")),
    ).toBe(1);
    expect(fails(() => resolve("core-kit:K01", undefined, "core-kit=-x"))).toBe(
      1,
    );
    expect(fails(() => resolve("core-kit:K01", undefined, "core-kit"))).toBe(1);
    expect(fails(() => resolve("core-kit:K01"))).toBe(1);
    expect(fails(() => resolve("", undefined, "core-kit=x"))).toBe(1);
  });

  it("置き換えで $& などの特別な並びが効かない", () => {
    const json = resolveCrossDependsArgs(
      [{ ...repos[0]!, branchCommand: "x {branch} {branch}" }, repos[2]!],
      "shop-app",
      "core-kit:K01",
      undefined,
      "core-kit=a.b",
    );
    expect(JSON.parse(json!)[0].branchCommand).toBe("x a.b a.b");
  });
});

describe("門の枝の確かめ", () => {
  async function makeCore() {
    const lib = await makeRepo({ idPrefix: "K", baseBranch: "main" });
    await writeFiles(lib, { "x.txt": "x\n" });
    await git(lib, "add", "-A");
    await git(lib, "commit", "--quiet", "-m", "統括役: K01 をマージする");
    // 依存先は PR でマージされた形（push の記録のマージのコミット）で入れる
    await writePushRecord(testRunner, lib, "K01", {
      id: "K01",
      branch: "task/K01-x",
      base: "main",
      pushedHead: "0".repeat(40),
      pushedAt: "2026-11-04T00:00:00Z",
      pr: { number: 3, url: "https://example.invalid/pull/3" },
      mergeCommit: await git(lib, "rev-parse", "HEAD"),
    });
    return await realpath(lib);
  }
  async function makeApp(files: Record<string, string>) {
    const app = await makeRepo({ idPrefix: "T" });
    const task = await addTaskWorktree(app, "T01", "x", files);
    return { app, ...task };
  }
  const gate = (app: string, branch: string) =>
    checkCrossDepends(testRunner, app, branch, "T01");

  it("枝の名前が定義かロックファイルに残っていれば外れの文（戻し方つき）", async () => {
    const lib = await makeCore();
    const cases: Record<string, string>[] = [
      {
        "composer.json": '{"require": {"acme/core-kit": "dev-task/K01-fix"}}\n',
      },
      { "sub/composer.lock": '"version": "dev-task/K01-fix",\n' },
      { "pnpm-lock.yaml": "  version: github:acme/core-kit#task/K01-fix\n" },
      { "poetry.lock": 'reference = "task/K01-fix"\n' },
      { "pnpm-workspace.yaml": "overrides:\n  core-kit: task/K01-fix\n" },
    ];
    for (const files of cases) {
      const { app, branch } = await makeApp(files);
      await writeCrossDepends(testRunner, app, "T01", [
        branchRepo({ path: lib }),
      ]);
      const lines = await gate(app, branch);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        "core-kit を枝 task/K01-fix で取り込んだままです",
      );
      expect(lines[0]).toContain("composer require acme/core-kit:^1");
    }
  });

  it("消えていれば版の行がなくても通る。より長い名前の一部は当てない", async () => {
    const lib = await makeCore();
    const { app, branch } = await makeApp({
      "composer.json": '{"require": {"acme/core-kit": "^1.4"}}\n',
      "composer.lock": '"x": "dev-task/K01-fix-2", "y": "task/K01-fix/more"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [
      branchRepo({ path: lib }),
    ]);
    expect(await gate(app, branch)).toEqual([]);
  });

  it("作業ツリーだけの残り（コミット前）は見ない。コミット済みの先頭を見る", async () => {
    const lib = await makeCore();
    const { app, branch, path: wt } = await makeApp({});
    await writeFiles(wt, { "composer.json": '"dev-task/K01-fix"\n' });
    await writeCrossDepends(testRunner, app, "T01", [
      branchRepo({ path: lib }),
    ]);
    expect(await gate(app, branch)).toEqual([]);
  });

  it("git grep が 1 以外で失敗したら、確かめられない外れにする（残っていないとは扱わない）", async () => {
    const lib = await makeCore();
    const { app, branch } = await makeApp({});
    await writeCrossDepends(testRunner, app, "T01", [
      branchRepo({ path: lib }),
    ]);
    const failing: Runner = async (cmd, args, opts) =>
      cmd === "git" && args[0] === "grep" && args.includes(branch)
        ? { code: 128, stdout: "", stderr: "fatal", timedOut: false }
        : testRunner(cmd, args, opts);
    const lines = await checkCrossDepends(failing, app, branch, "T01");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "core-kit の枝 task/K01-fix が残っていないかを確かめられません",
    );
  });

  it("依存先が入っていなければ今までどおり外れる", async () => {
    const lib = await makeRepo({ idPrefix: "K", baseBranch: "main" });
    const { app, branch } = await makeApp({});
    await writeCrossDepends(testRunner, app, "T01", [
      branchRepo({ path: await realpath(lib) }),
    ]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "core-kit:K01 が core-kit で PR でマージされていません",
    );
  });
});
