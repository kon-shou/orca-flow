import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { requireConfig } from "../../src/config.ts";
import { finishMergedTask } from "../../src/lib/finish.ts";
import type { CommandContext } from "../../src/types.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { claudeScreen, fakeOrca } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";

const NOW = new Date("2026-02-03T04:05:06.000Z");

async function cli(argv: string[], cwd: string, runner: Runner) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd,
    runner,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => NOW,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function common(root: string) {
  return git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
}

async function entries(root: string, id: string) {
  const text = await readFile(
    path.join(await common(root), "orca-flow", "stages", `${id}.jsonl`),
    "utf8",
  );
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("status が段を記録する", () => {
  it("すべての状態で、状態・一言・時刻・コマンドの1行が足される", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    const states: [string, string | null][] = [
      ["designing", "設計書を書く"],
      ["spec-review", null],
      ["working", "確認とコードレビュー中"],
      ["question", "API の形"],
      ["integrate-wait", null],
      ["integrated", null],
    ];
    for (const [state, note] of states) {
      const r = await cli(
        ["status", state, ...(note ? ["--note", note] : [])],
        wt.path,
        orca.runner,
      );
      expect(r.code).toBe(0);
    }
    const rows = await entries(root, "T12");
    expect(rows).toEqual(
      states.map(([state, note]) => ({
        at: NOW.toISOString(),
        state,
        note,
        command: "status",
      })),
    );
  });

  it("Orca のカードの更新が失敗しても足される", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    orca.unavailable = true;
    const r = await cli(["status", "working"], wt.path, orca.runner);
    expect(r.code).toBe(0);
    expect(r.err).toContain("カードを更新できませんでした");
    expect(await entries(root, "T12")).toHaveLength(1);
  });

  it("記録のファイルが書けないとき、警告を出して終了コード0", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    // stages の場所をファイルにして、ディレクトリを作れなくする
    const dir = path.join(await common(root), "orca-flow");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "stages"), "x");
    const r = await cli(["status", "working"], wt.path, fakeOrca().runner);
    expect(r.code).toBe(0);
    expect(r.err).toContain("段の記録を書けませんでした");
  });
});

describe("new・approve・統合の仕上げが段を記録する", () => {
  it("new が designing の行を足す", async () => {
    const root = await makeRepo();
    const orca = fakeOrca();
    const r = await cli(
      ["new", "--title", "a", "--slug", "a"],
      root,
      orca.runner,
    );
    expect(r.code).toBe(0);
    expect(await entries(root, "T01")).toEqual([
      {
        at: NOW.toISOString(),
        state: "designing",
        note: null,
        command: "new",
      },
    ]);
  });

  it("approve が working の行を足す", async () => {
    const root = await makeRepo(
      { progress: { file: "docs/progress.md" } },
      {
        "docs/progress.md": PROGRESS.replace(
          "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
          "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 設計中 | task/T12-shop | |\n",
        ),
      },
    );
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
    });
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      title: "会話",
      agentIdentity: "claude",
      screen: claudeScreen(),
    });
    const r = await cli(["approve", "T12"], root, orca.runner);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(await entries(root, "T12")).toEqual([
      {
        at: NOW.toISOString(),
        state: "working",
        note: null,
        command: "approve",
      },
    ]);
  });

  it("integrate のマージが integrated の行を足す", async () => {
    const root = await makeRepo(
      {
        integrateVerify: "before-merge",
        verify: ["test -f src/shop/a.ts"],
      },
      {},
    );
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
    });
    await writeFiles(wt.path, {
      "src/shop/a.ts": "export const a = 1;\n",
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
    const orca = fakeOrca();
    const r = await cli(
      ["integrate", "T12", "--verify-here"],
      root,
      orca.runner,
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(await entries(root, "T12")).toEqual([
      {
        at: NOW.toISOString(),
        state: "integrated",
        note: null,
        command: "integrate",
      },
    ]);
  });
});

describe("差分のない integrate が integrated の行を足す", () => {
  it("記録を無視するリポジトリで docs だけのタスクを統合する", async () => {
    const root = await makeRepo(
      { integrateVerify: "before-merge" },
      { ".gitignore": "docs/tasks/\ndocs/progress.md\n" },
    );
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["docs/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    const r = await cli(
      ["integrate", "T12", "--json"],
      root,
      fakeOrca().runner,
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).merged).toBe(false);
    expect(await entries(root, "T12")).toEqual([
      {
        at: NOW.toISOString(),
        state: "integrated",
        note: null,
        command: "integrate",
      },
    ]);
  });
});

/** origin つきで、PR が GitHub でマージされた状態を作る */
async function mergedOnGithub() {
  const root = await makeRepo({ integrateVerify: "before-merge" }, {});
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
  });
  await writeFiles(wt.path, { "src/shop/a.ts": "export const a = 1;\n" });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  const origin = path.join(await tempDir("orca-flow-origin-"), "origin.git");
  await git(
    path.dirname(origin),
    "init",
    "--quiet",
    "--bare",
    "-b",
    "main",
    origin,
  );
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "--quiet", "origin", "main");
  await git(wt.path, "push", "--quiet", "origin", wt.branch);
  const clone = path.join(await tempDir("orca-flow-clone-"), "c");
  await git(path.dirname(clone), "clone", "--quiet", origin, clone);
  await git(clone, "config", "user.name", "GH");
  await git(clone, "config", "user.email", "gh@example.com");
  await git(
    clone,
    "merge",
    "--quiet",
    "--no-ff",
    "-m",
    "Merge PR",
    `origin/${wt.branch}`,
  );
  await git(clone, "push", "--quiet", "origin", "main");
  return { root, wt };
}

const finishCtx = (root: string, runner: Runner): CommandContext => ({
  argv: [],
  cwd: root,
  json: false,
  runner,
  env: {},
  stdout: () => {},
  stderr: () => {},
  now: () => NOW,
});

describe("PR の道の後始末（finishMergedTask）が段を記録する", () => {
  it("done のあと integrated の行が足される", async () => {
    const { root, wt } = await mergedOnGithub();
    const result = await finishMergedTask(
      finishCtx(root, fakeOrca().runner),
      await requireConfig(root),
      root,
      { id: "T12", branch: wt.branch, path: wt.path },
    );
    expect(result.kind).toBe("done");
    expect(existsSync(wt.path)).toBe(false);
    expect(await entries(root, "T12")).toEqual([
      {
        at: NOW.toISOString(),
        state: "integrated",
        note: null,
        command: "integrate",
      },
    ]);
  });

  it("止まったときは行を足さない", async () => {
    const { root, wt } = await mergedOnGithub();
    await writeFiles(root, { "README.md": "汚した\n" });
    const result = await finishMergedTask(
      finishCtx(root, fakeOrca().runner),
      await requireConfig(root),
      root,
      { id: "T12", branch: wt.branch, path: wt.path },
    );
    expect(result).toMatchObject({ kind: "stopped", reason: "dirty" });
    expect(
      existsSync(
        path.join(await common(root), "orca-flow", "stages", "T12.jsonl"),
      ),
    ).toBe(false);
  });
});
