import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { main } from "../../src/cli.ts";
import {
  branchPushFileAt,
  writeBranchPushMarkAt,
} from "../../src/lib/branch-push.ts";
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
import { writePushRecord } from "../../src/lib/finish.ts";
import { testRunner } from "../helpers/runner.ts";

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

/** git push と gh だけ記録して成功させ、ほかは偽の Orca と本物の git */
function harness(options: { pushCode?: number } = {}) {
  const orca = fakeOrca();
  const pushes: string[][] = [];
  const ghCalls: string[][] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "git" && args[0] === "push") {
      pushes.push([...args]);
      return {
        code: options.pushCode ?? 0,
        stdout: "",
        stderr: options.pushCode ? "rejected" : "",
        timedOut: false,
      };
    }
    if (cmd === "gh") {
      ghCalls.push([...args]);
      return { code: 0, stdout: "[]", stderr: "", timedOut: false };
    }
    return orca.runner(cmd, args, opts);
  };
  return { orca, pushes, ghCalls, runner };
}

async function commonOf(root: string): Promise<string> {
  return (
    await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();
}

async function setup() {
  const root = await makeRepo();
  const wt = await addTaskWorktree(root, "T05", "core-kit", {
    "a.txt": "a\n",
  });
  return { root, wt, common: await commonOf(root) };
}

const FROM = "ORCA_FLOW_FROM_WORKSPACE";

/** 環境変数を指定して cli を動かす（runCli は環境変数を渡せない） */
async function runWithEnv(
  argv: string[],
  options: { cwd: string; runner: Runner; env: NodeJS.ProcessEnv },
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd: options.cwd,
    runner: options.runner,
    env: options.env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("new --allow-branch-push", () => {
  it("印の記録ができ、なしで流すと同じ ID の古い印が消える", async () => {
    const root = await makeRepo();
    const common = await commonOf(root);
    const h = harness();
    const file = branchPushFileAt(common, "T01");
    const first = await runWithEnv(
      ["new", "--title", "a", "--slug", "core-kit", "--allow-branch-push"],
      { cwd: root, runner: h.runner, env: { ...process.env, [FROM]: "1" } },
    );
    expect(first.code).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      id: "T01",
      branch: "task/T01-core-kit",
    });
    expect(h.pushes).toEqual([]);

    // 古い印が残ったまま、同じ ID を印なしで始めると消える
    await writeBranchPushMarkAt(common, "T01", "task/T01-old", new Date());
    await git(
      root,
      "worktree",
      "remove",
      "--force",
      (await git(root, "worktree", "list", "--porcelain"))
        .split("\n")
        .find((l) => l.includes("T01"))!
        .replace("worktree ", "")
        .trim(),
    );
    await git(root, "branch", "-D", "task/T01-core-kit");
    // --allow-branch-push なしの new は、環境変数がなくても動き、古い印を消す
    const envless = { ...process.env };
    delete envless[FROM];
    const second = await runWithEnv(
      ["new", "--title", "a", "--slug", "core-kit", "--id", "T01"],
      { cwd: root, runner: h.runner, env: envless },
    );
    expect(second.code).toBe(0);
    await expect(stat(file)).rejects.toThrow();
  });

  it("環境変数なし・空では終了コード1で、Orca を呼ばず、印も worktree も作らない", async () => {
    for (const value of [undefined, ""]) {
      const root = await makeRepo();
      const common = await commonOf(root);
      const h = harness();
      const env = { ...process.env };
      if (value === undefined) delete env[FROM];
      else env[FROM] = value;
      const before = await git(root, "worktree", "list", "--porcelain");
      const r = await runWithEnv(
        ["new", "--title", "a", "--slug", "core-kit", "--allow-branch-push"],
        { cwd: root, runner: h.runner, env },
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("--allow-branch-push");
      expect(h.orca.calls).toEqual([]);
      await expect(stat(branchPushFileAt(common, "T01"))).rejects.toThrow();
      expect(await git(root, "worktree", "list", "--porcelain")).toBe(before);
    }
  });

  it("子の new が外のコマンドを呼ぶ環境に ORCA_FLOW_FROM_WORKSPACE が入らない", async () => {
    const root = await makeRepo();
    const h = harness();
    const seen: (NodeJS.ProcessEnv | undefined)[] = [];
    const runner: Runner = async (cmd, args, opts) => {
      seen.push(opts?.env);
      return h.runner(cmd, args, opts);
    };
    const r = await runWithEnv(
      ["new", "--title", "a", "--slug", "core-kit", "--allow-branch-push"],
      { cwd: root, runner, env: { ...process.env, [FROM]: "1" } },
    );
    expect(r.code).toBe(0);
    expect(h.orca.calls.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const env of seen) {
      expect(env).toBeDefined();
      expect(env![FROM]).toBeUndefined();
    }
  });
});

describe("push --branch", () => {
  it("印がなければ終了コード2で git push を流さない", async () => {
    const { wt } = await setup();
    const h = harness();
    const result = await runCli(["push", "T05", "--branch"], {
      cwd: wt.path,
      runner: h.runner,
    });
    expect(result.code).toBe(2);
    expect(h.pushes).toEqual([]);
    expect(h.ghCalls).toEqual([]);
  });

  it("印があれば自分の枝だけを push し、PR も案も作らない（worktree と統括役の両方から）", async () => {
    const { root, wt, common } = await setup();
    await writeBranchPushMarkAt(common, "T05", wt.branch, new Date());
    const head = (await git(wt.path, "rev-parse", "HEAD")).trim();
    for (const cwd of [wt.path, root]) {
      const h = harness();
      const result = await runCli(["push", "T05", "--branch", "--json"], {
        cwd,
        runner: h.runner,
      });
      expect(result.code).toBe(0);
      expect(h.pushes).toHaveLength(1);
      const args = h.pushes[0]!;
      expect(args.at(-1)).toBe(`${head}:refs/heads/${wt.branch}`);
      expect(args.some((a) => a.startsWith("--force-with-lease"))).toBe(
        cwd === root,
      );
      expect(args).not.toContain("main");
      expect(h.ghCalls).toEqual([]);
      await expect(
        readdir(path.join(common, "orca-flow", "outbox")),
      ).rejects.toThrow();
    }
  });

  it("2回目は前の先頭を --force-with-lease の期待値に渡し、印の先頭と時刻を書き直す", async () => {
    const { wt, common } = await setup();
    await writeBranchPushMarkAt(common, "T05", wt.branch, new Date());
    const h = harness();
    const t1 = new Date("2026-11-04T01:00:00Z");
    const t2 = new Date("2026-11-04T02:00:00Z");
    const first = (await git(wt.path, "rev-parse", "HEAD")).trim();
    await runPush(wt.path, h, t1);
    expect(h.pushes[0]!.some((a) => a.startsWith("--force-with-lease"))).toBe(
      false,
    );
    expect(await readMark(common)).toMatchObject({
      pushedHead: first,
      pushedAt: t1.toISOString(),
    });

    await git(wt.path, "commit", "--quiet", "--allow-empty", "-m", "next");
    const second = (await git(wt.path, "rev-parse", "HEAD")).trim();
    await runPush(wt.path, h, t2);
    expect(h.pushes[1]).toContain(
      `--force-with-lease=refs/heads/${wt.branch}:${first}`,
    );
    expect(h.pushes[1]!.at(-1)).toBe(`${second}:refs/heads/${wt.branch}`);
    expect(await readMark(common)).toMatchObject({
      pushedHead: second,
      pushedAt: t2.toISOString(),
    });
  });

  it("印のないほかのタスクの枝は push しない", async () => {
    const { root, wt, common } = await setup();
    await addTaskWorktree(root, "T06", "other", { "b.txt": "b\n" });
    await writeBranchPushMarkAt(common, "T05", wt.branch, new Date());
    const h = harness();
    const result = await runCli(["push", "T06", "--branch"], {
      cwd: root,
      runner: h.runner,
    });
    expect(result.code).toBe(2);
    expect(h.pushes).toEqual([]);
  });
});

describe("push --branch の止まり方", () => {
  it("手元の push の記録があれば PR の道なので、終了コード2で git push を流さない", async () => {
    const { wt, common } = await setup();
    await writeBranchPushMarkAt(common, "T05", wt.branch, new Date());
    const head = (await git(wt.path, "rev-parse", "HEAD")).trim();
    await writePushRecord(testRunner, wt.path, "T05", {
      id: "T05",
      branch: wt.branch,
      base: "main",
      pushedHead: head,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: { number: 7, url: "https://github.com/o/r/pull/7" },
    });
    const h = harness();
    const result = await runCli(["push", "T05", "--branch"], {
      cwd: wt.path,
      runner: h.runner,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("/orca-flow:push");
    expect(h.pushes).toEqual([]);
  });

  it("outbound.allow に push がなければ終了コード2で送らない", async () => {
    const root = await makeRepo({ outbound: { allow: ["pr-create"] } });
    const wt = await addTaskWorktree(root, "T05", "core-kit", {
      "a.txt": "a\n",
    });
    await writeBranchPushMarkAt(
      await commonOf(root),
      "T05",
      wt.branch,
      new Date(),
    );
    const h = harness();
    const result = await runCli(["push", "T05", "--branch"], {
      cwd: wt.path,
      runner: h.runner,
    });
    expect(result.code).toBe(2);
    expect(h.pushes).toEqual([]);
  });

  it("git push が失敗したら0以外で終わり、印の先頭と時刻は前のまま", async () => {
    const { wt, common } = await setup();
    await writeBranchPushMarkAt(common, "T05", wt.branch, new Date());
    const ok = harness();
    await runPush(wt.path, ok, new Date("2026-11-04T01:00:00Z"));
    const before = await readMark(common);
    await git(wt.path, "commit", "--quiet", "--allow-empty", "-m", "next");
    const bad = harness({ pushCode: 1 });
    const result = await runCli(["push", "T05", "--branch"], {
      cwd: wt.path,
      runner: bad.runner,
    });
    expect(result.code).not.toBe(0);
    expect(bad.pushes).toHaveLength(1);
    expect(await readMark(common)).toEqual(before);
  });
});

describe("PR の道（push 〈ID〉）と枝の印", () => {
  async function prSetup(withRecord: boolean) {
    const dep = await makeRepo({}, {});
    void dep;
    const root = await makeRepo(
      {
        integrateVerify: "before-merge",
        progress: { file: "docs/progress.md" },
        verify: ["test -f src/shop/a.ts"],
        verifySkipPaths: ["composer.json", "composer.lock"],
      },
      {
        "docs/progress.md": PROGRESS.replace(
          "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
          "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 作業中 | task/T12-shop | |\n",
        ),
      },
    );
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
    });
    await writeFiles(wt.path, {
      "src/shop/a.ts": "export const a = 1;\n",
      "docs/tasks/reports/T12.md": "# 報告\n",
      "composer.json": "{}\n",
      "composer.lock": "{}\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
    if (withRecord) {
      const common = await commonOf(root);
      const dir = path.join(common, "orca-flow", "cross-depends");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "T12.json"),
        JSON.stringify({
          id: "T12",
          at: "2026-11-04T00:00:00.000Z",
          repos: [
            {
              name: "core-kit",
              path: dep,
              package: "acme/core-kit",
              branch: "task/S5-core-kit",
              branchCommand:
                "composer require acme/core-kit:dev-task/S5-core-kit",
              bumpCommand: "composer require acme/core-kit:^1.4",
              ids: ["S5"],
            },
          ],
        }),
      );
    }
    const verify = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(verify.code, verify.err).toBe(0);
    return { root, wt, common: await commonOf(root) };
  }

  it("記録に branch があれば composer.json・composer.lock を範囲の外に数えず、--branch で送った先頭を期待値に案へ渡す", async () => {
    const { root, wt, common } = await prSetup(true);
    // 今の先頭の祖先でない先頭（rebase 前の先頭にあたる）を、--branch で送った先頭として印に書く
    const old = (
      await git(wt.path, "commit-tree", "HEAD^{tree}", "-m", "old")
    ).trim();
    await writeBranchPushMarkAt(common, "T12", wt.branch, new Date());
    const markFile = branchPushFileAt(common, "T12");
    const mark = JSON.parse(await readFile(markFile, "utf8"));
    await writeFile(
      markFile,
      JSON.stringify({ ...mark, pushedHead: old, pushedAt: "x" }),
    );
    const h = harness();
    const bodyFile = path.join(path.dirname(root), "body.md");
    await writeFile(bodyFile, "## 概要\n本文\n");
    const result = await runCli(
      ["push", "T12", "--json", "--body-file", bodyFile],
      { cwd: root, runner: h.runner },
    );
    expect(result.err).not.toContain("外のファイル");
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(old);
    expect(h.pushes).toEqual([]);
  });

  it("記録がないタスクは composer.json が範囲の外で終了コード1", async () => {
    const { root } = await prSetup(false);
    const h = harness();
    const result = await runCli(["push", "T12"], {
      cwd: root,
      runner: h.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("- composer.json");
    expect(h.pushes).toEqual([]);
  });
});

async function readMark(common: string) {
  return JSON.parse(await readFile(branchPushFileAt(common, "T05"), "utf8"));
}

async function runPush(cwd: string, h: ReturnType<typeof harness>, now: Date) {
  const out: string[] = [];
  const code = await main(["push", "T05", "--branch"], {
    cwd,
    runner: h.runner,
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    now: () => now,
  });
  expect(code, out.join("\n")).toBe(0);
}
