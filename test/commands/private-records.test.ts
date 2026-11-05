import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

const progressWith = (row: string) =>
  PROGRESS.replace(
    "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
    `| T01 | 雛形   | —    | 統合済み | main         |      |\n${row}\n`,
  );

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

const IGNORE = "docs/tasks/\ndocs/progress.md\n";

/** 記録（設計書・報告・進捗表）が無視されたリポジトリ。設計書と報告は worktree にコミットされていない */
async function setup(prechanges?: string[], config: object = {}) {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      progress: { file: "docs/progress.md" },
      verify: ["test -f src/shop/a.ts"],
      ...config,
    },
    { ".gitignore": IGNORE },
  );
  await writeFiles(root, {
    "docs/progress.md": progressWith(
      "| T12 | 買い物 | — | 設計中 | task/T12-shop | |",
    ),
  });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/shop/a.ts": "export const a = 1;\n",
  });
  await writeFiles(wt.path, {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"], prechanges }),
    "docs/tasks/reports/T12.md": "# 報告\n",
  });
  return { root, wt };
}

describe("無視された記録: approve", () => {
  it("コミットしていない設計書を worktree から読み、進捗表は書き換えるだけでコミットしない", async () => {
    const { root, wt } = await setup();
    const before = await git(root, "rev-list", "--count", "main");
    const orca = fakeOrca();
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(
      await readFile(path.join(root, "docs/progress.md"), "utf8"),
    ).toContain("作業中");
    expect(await git(root, "rev-list", "--count", "main")).toBe(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(JSON.stringify(result)).not.toContain("コミットされていません");
    // 設計書は worktree のファイルのまま（コミットされていない）
    expect(await git(wt.path, "ls-files", "docs/tasks")).toBe("");
  });

  it("事前変更があれば終了コード2で止まり、--prechanges-done で進む", async () => {
    const { root } = await setup(["main に設定を足す"]);
    const stop = await runCli(["approve", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(stop.code).toBe(2);
    const go = await runCli(["approve", "T12", "--prechanges-done"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(go.code).toBe(0);
  });

  it("設計書がなければ「ありません」で終了コード1", async () => {
    const { root, wt } = await setup();
    await import("node:fs/promises").then((fs) =>
      fs.rm(path.join(wt.path, "docs/tasks/T12.md")),
    );
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("がありません");
    expect(result.err).not.toContain("コミットされていません");
  });
});

describe("無視された記録: integrate", () => {
  it("マージの前に設計書と報告をメインの作業ツリーへ写し、worktree を消しても残る", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    const result = await runCli(
      ["integrate", "T12", "--verify-here", "--json"],
      {
        cwd: root,
        runner: orca.runner,
      },
    );
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(wt.path)).toBe(false);
    expect(
      await readFile(path.join(root, "docs/tasks/T12.md"), "utf8"),
    ).toContain("タスク T12");
    expect(
      await readFile(path.join(root, "docs/tasks/reports/T12.md"), "utf8"),
    ).toBe("# 報告\n");
    expect(existsSync(path.join(root, "src/shop/a.ts"))).toBe(true);
    // 進捗表はコミットされない
    expect(await git(root, "log", "--format=%s", "-1")).toBe(
      "統括役: T12 をマージする",
    );
    const row = (await readFile(path.join(root, "docs/progress.md"), "utf8"))
      .split("\n")
      .find((line) => line.startsWith("| T12 |"));
    expect(row).toContain("| 統合済み |");
    expect(JSON.parse(result.out).progressCommitted).toBe(false);
  });

  it("統合で写した設計書から、次の ID が数えられる", async () => {
    const { root } = await setup();
    const done = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(done.code).toBe(0);
    const next = await runCli(
      ["new", "--title", "次", "--slug", "next", "--json"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(next.code).toBe(0);
    expect(JSON.parse(next.out).id).toBe("T13");
  });

  it("差分がない（記録しか変えない）タスクは、記録を写して片づけ、マージしない", async () => {
    const root = await makeRepo(
      {
        integrateVerify: "after-merge",
        progress: { file: "docs/progress.md" },
      },
      { ".gitignore": IGNORE },
    );
    await writeFiles(root, {
      "docs/progress.md": progressWith(
        "| T12 | 買い物 | — | 設計中 | task/T12-shop | |",
      ),
    });
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["docs/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    const head = await git(root, "rev-parse", "main");
    const result = await runCli(["integrate", "T12", "--json"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out);
    expect(data.merged).toBe(false);
    expect(data.worktreeRemoved).toBe(true);
    expect(await git(root, "rev-parse", "main")).toBe(head);
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(path.join(root, "docs/tasks/T12.md"))).toBe(true);
    const row = (await readFile(path.join(root, "docs/progress.md"), "utf8"))
      .split("\n")
      .find((line) => line.startsWith("| T12 |"));
    expect(row).toContain("| 統合済み |");
  });

  it("差分がないときの終了メッセージは、マージしなかったことを言う", async () => {
    const root = await makeRepo(
      { integrateVerify: "before-merge" },
      {
        ".gitignore": IGNORE,
      },
    );
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["docs/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    const result = await runCli(["integrate", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("差分がないのでマージしませんでした");
  });

  it("タスクのブランチで追跡されている記録が、メインでは無視されるなら終了コード1で止まる", async () => {
    const root = await makeRepo(
      { integrateVerify: "before-merge", verify: ["true"] },
      { ".gitignore": IGNORE },
    );
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
      "src/shop/a.ts": "export const a = 1;\n",
    });
    await git(wt.path, "add", "-f", "docs/tasks/T12.md");
    await git(wt.path, "add", "src/shop/a.ts");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("git rm --cached docs/tasks/T12.md");
    expect(await git(root, "log", "--format=%s", "-1")).toBe("init");
    expect(existsSync(wt.path)).toBe(true);
  });

  it("追跡中の記録で止まったあと、案内どおりに merge・追跡の取りやめ・コミットをすれば次の integrate が通る", async () => {
    const root = await makeRepo({
      integrateVerify: "before-merge",
      verify: ["true"],
    });
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
      "src/shop/a.ts": "export const a = 1;\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
    // あとから main に .gitignore が入る（タスクの worktree の .gitignore は古いまま）
    await writeFiles(root, { ".gitignore": IGNORE });
    await git(root, "add", ".gitignore");
    await git(root, "commit", "--quiet", "-m", "ignore");

    const first = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(first.code).toBe(1);
    expect(first.err).toContain("git merge main");
    expect(first.err).toContain("git rm --cached docs/tasks/T12.md");
    expect(first.err.indexOf("git merge main")).toBeLessThan(
      first.err.indexOf("git rm --cached"),
    );

    await git(wt.path, "rebase", "main");
    await git(
      wt.path,
      "rm",
      "--cached",
      "docs/tasks/T12.md",
      "docs/tasks/reports/T12.md",
    );
    await git(wt.path, "commit", "--quiet", "-m", "T12: 記録の追跡をやめる");

    const second = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(second.err).not.toContain("未コミットの変更");
    expect(second.code).toBe(0);
    expect(existsSync(path.join(root, "src/shop/a.ts"))).toBe(true);
  });

  it("差分がないタスクを --keep-worktree で統合すると、記録を写さず終了コード1で止まり何も変えない", async () => {
    const root = await makeRepo(
      {
        integrateVerify: "after-merge",
        progress: { file: "docs/progress.md" },
      },
      { ".gitignore": IGNORE },
    );
    await writeFiles(root, {
      "docs/progress.md": progressWith(
        "| T12 | 買い物 | — | 設計中 | task/T12-shop | |",
      ),
    });
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["docs/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    const progressBefore = await readFile(
      path.join(root, "docs/progress.md"),
      "utf8",
    );
    const orca = fakeOrca();
    const result = await runCli(["integrate", "T12", "--keep-worktree"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("--keep-worktree");
    expect(existsSync(path.join(root, "docs/tasks/T12.md"))).toBe(false);
    expect(existsSync(path.join(root, "docs/tasks/reports/T12.md"))).toBe(
      false,
    );
    expect(await readFile(path.join(root, "docs/progress.md"), "utf8")).toBe(
      progressBefore,
    );
    // カードも worktree も Orca に触らない
    expect(orca.calls).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
    expect(await git(root, "log", "--format=%s", "-1")).toBe("init");
    const flagless = await runCli(["integrate", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(flagless.code).toBe(0);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("報告がどこにもなければ終了コード1でマージしない", async () => {
    const { root, wt } = await setup();
    await import("node:fs/promises").then((fs) =>
      fs.rm(path.join(wt.path, "docs/tasks/reports/T12.md")),
    );
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("がありません");
    expect(await git(root, "log", "--format=%s", "-1")).toBe("init");
    expect(existsSync(wt.path)).toBe(true);
  });

  it("写す先に書けないときは終了コード1でマージも worktree の削除もしない", async () => {
    const { root, wt } = await setup();
    await mkdir(path.join(root, "docs/tasks"), { recursive: true });
    await chmod(path.join(root, "docs/tasks"), 0o500);
    try {
      const result = await runCli(["integrate", "T12", "--verify-here"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("写せませんでした");
      expect(await git(root, "log", "--format=%s", "-1")).toBe("init");
      expect(existsSync(wt.path)).toBe(true);
    } finally {
      await chmod(path.join(root, "docs/tasks"), 0o700);
    }
  });
});

describe("無視された記録: overlap・active", () => {
  it("ほかのタスクの無視された設計書を worktree から読み、重なりを見つける", async () => {
    const root = await makeRepo(
      { autoOrderOnOverlap: false },
      { ".gitignore": IGNORE },
    );
    const a = await addTaskWorktree(root, "T01", "a");
    const b = await addTaskWorktree(root, "T02", "b");
    await writeFiles(a.path, {
      "docs/tasks/T01.md": specDoc("T01", { allowed: ["src/shared/"] }),
    });
    await writeFiles(b.path, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["src/shared/x.ts"] }),
    });
    const result = await runCli(["overlap", "T02"], {
      cwd: b.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("T01");
    const active = await runCli(["active", "--json"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    const rows = JSON.parse(active.out);
    expect(rows[0].allowed).toEqual(["src/shared"]);
  });
});

describe("無視された記録: new", () => {
  it("進捗表を書き換え、コミットは増えない", async () => {
    const root = await makeRepo(
      { progress: { file: "docs/progress.md" } },
      { ".gitignore": IGNORE },
    );
    await writeFiles(root, { "docs/progress.md": PROGRESS });
    const before = await git(root, "rev-list", "--count", "main");
    const orca = fakeOrca();
    const result = await runCli(
      ["new", "--title", "買い物", "--slug", "shop", "--id", "T12"],
      { cwd: root, runner: orca.runner },
    );
    expect(result.code).toBe(0);
    expect(
      await readFile(path.join(root, "docs/progress.md"), "utf8"),
    ).toContain("T12");
    expect(await git(root, "rev-list", "--count", "main")).toBe(before);
  });
});

describe("無視された記録: status", () => {
  it("spec-review で設計書を、integrate-wait で報告を、--focus なしで開く", async () => {
    const { wt } = await setup();
    for (const [state, file] of [
      ["spec-review", "docs/tasks/T12.md"],
      ["integrate-wait", "docs/tasks/reports/T12.md"],
    ] as const) {
      const orca = fakeOrca();
      const result = await runCli(["status", state], {
        cwd: wt.path,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      expect(orca.callsOf("file", "open")).toEqual([
        ["file", "open", file, "--worktree", `path:${wt.path}`],
      ]);
    }
  });

  it("開けなくても警告だけで終了コード0", async () => {
    const { wt } = await setup();
    const orca = fakeOrca();
    orca.fileOpenFails = true;
    const result = await runCli(["status", "spec-review"], {
      cwd: wt.path,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("開けませんでした");
    expect(orca.callsOf("worktree", "set")).toHaveLength(1);
  });

  it("無視されていなければ開かず、ほかの状態でも開かない", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    await runCli(["status", "spec-review"], {
      cwd: wt.path,
      runner: orca.runner,
    });
    const ignored = await setup();
    const other = fakeOrca();
    await runCli(["status", "working"], {
      cwd: ignored.wt.path,
      runner: other.runner,
    });
    expect(orca.callsOf("file")).toEqual([]);
    expect(other.callsOf("file")).toEqual([]);
  });
});

describe("カード更新に失敗したとき", () => {
  it("status はタブを開こうとしない", async () => {
    const { wt } = await setup();
    const orca = fakeOrca();
    orca.unavailable = true;
    const result = await runCli(["status", "spec-review"], {
      cwd: wt.path,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(orca.callsOf("file")).toEqual([]);
  });
});

describe("移る途中（行はあるが記録が追跡中）", () => {
  it("行のない古いブランチの、コミットしていない設計書では approve が「コミットされていません」で止まる", async () => {
    const root = await makeRepo({});
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(root, { ".gitignore": IGNORE });
    await git(root, "add", ".gitignore");
    await git(root, "commit", "--quiet", "-m", "ignore");
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
    });
    const result = await runCli(["approve", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("コミットされていません");
  });

  it("追跡中の進捗表は approve でコミットされる", async () => {
    const root = await makeRepo(
      { progress: { file: "docs/progress.md" } },
      {
        "docs/progress.md": progressWith(
          "| T12 | 買い物 | — | 設計中 | task/T12-shop | |",
        ),
        ".gitignore": IGNORE,
      },
    );
    await git(root, "add", "-f", "docs/progress.md");
    await git(root, "commit", "--quiet", "-m", "track");
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "src/a.ts": "x\n",
    });
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
    });
    const result = await runCli(["approve", "T12", "--json"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).progressCommitted).toBe(true);
    expect(await git(root, "log", "--format=%s", "-1")).toContain(
      "T12 の設計を承認する",
    );
  });

  it("追跡中の進捗表は new でコミットされる", async () => {
    const root = await makeRepo(
      { progress: { file: "docs/progress.md" } },
      { "docs/progress.md": PROGRESS, ".gitignore": IGNORE },
    );
    await git(root, "add", "-f", "docs/progress.md");
    await git(root, "commit", "--quiet", "-m", "track");
    const result = await runCli(
      ["new", "--title", "買い物", "--slug", "shop", "--id", "T12"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(result.code).toBe(0);
    expect(await git(root, "log", "--format=%s", "-1")).toContain(
      "T12 を始める",
    );
  });
});
