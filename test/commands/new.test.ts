import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
  VERIFY_WINDOW_MS,
} from "../../src/commands/new.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, PROGRESS } from "../helpers/repo.ts";
import { makeTmpDir } from "../helpers/tmp/index.ts";

const withProgress = {
  progress: { file: "docs/progress.md" },
};

// 確かめの待ち時間はテストでは短くする（main は process.env を使う）
beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

/** worktree create のあとに after を流す偽の Orca */
function afterCreate(
  orca: ReturnType<typeof fakeOrca>,
  after: (root: string, wt: string, branch: string) => Promise<void>,
) {
  const inner: Runner = orca.runner;
  orca.runner = async (cmd, args, opts) => {
    const result = await inner(cmd, args, opts);
    if (cmd === "orca" && args[0] === "worktree" && args[1] === "create") {
      const name = args[args.indexOf("--name") + 1]!;
      const repo = args[args.indexOf("--repo") + 1]!.replace(/^path:/, "");
      await after(repo, path.join(path.dirname(repo), name), name);
    }
    return result;
  };
}

/** 出力の片付けのコマンド（行頭が空白2つ＋git）を、メインのチェックアウトで sh に流す */
async function runCleanup(err: string, cwd: string): Promise<string[]> {
  const lines = err
    .split("\n")
    .filter((l) => /^ {2}git /.test(l))
    .map((l) => l.slice(2));
  // 途中の行が落ちたらそこで止めて失敗にする
  await promisify(execFile)("sh", ["-c", `set -e\n${lines.join("\n")}`], {
    cwd,
  });
  return lines;
}

/** 偽の Orca の worktree create の結果から branch を取り除く（Orca がブランチを返さない場合） */
function withoutBranch(orca: ReturnType<typeof fakeOrca>) {
  const inner: Runner = orca.runner;
  orca.runner = async (cmd, args, opts) => {
    const result = await inner(cmd, args, opts);
    if (cmd === "orca" && args[0] === "worktree" && args[1] === "create") {
      const json = JSON.parse(result.stdout);
      delete json.result.worktree.branch;
      return { ...result, stdout: JSON.stringify(json) };
    }
    return result;
  };
}

const TASK_LEAD_NOTE = "タスク長";

describe("new", () => {
  it("待ち時間の既定は15秒", () => {
    expect(VERIFY_WINDOW_MS).toBe(15_000);
  });

  it("--request-file の中身が worktree create の時点で共通ディレクトリにある", async () => {
    const root = await makeRepo();
    const dir = await makeTmpDir("req-");
    const file = path.join(dir, "r.md");
    const text = "全文\n\"引用\" と 'x'\n\n三行目\n";
    await writeFile(file, text);
    const orca = fakeOrca();
    let seen: string | null = null;
    const inner = orca.runner;
    orca.runner = async (cmd, args, opts) => {
      if (cmd === "orca" && args[0] === "worktree" && args[1] === "create") {
        const common = await git(
          root,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        seen = await readFile(
          path.join(common, "orca-flow/requests/T01.md"),
          "utf8",
        ).catch(() => null);
      }
      return inner(cmd, args, opts);
    };
    const result = await runCli(
      ["new", "--title", "a", "--slug", "a", "--request-file", file],
      { cwd: root, runner: orca.runner },
    );
    await rm(dir, { recursive: true, force: true });
    expect(result.code).toBe(0);
    expect(seen).toBe(text);
    expect(result.out).not.toContain("三行目");
  });

  it("--request-file なしは依頼のファイルを書かない", async () => {
    const root = await makeRepo();
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    await expect(
      stat(path.join(root, ".git/orca-flow/requests")),
    ).rejects.toThrow();
  });

  for (const [label, content] of [
    ["ない", null],
    ["空", "  \n"],
  ] as const) {
    it(`--request-file のファイルが${label}なら終了コード1で何もしない`, async () => {
      const root = await makeRepo(withProgress, {
        "docs/progress.md": PROGRESS,
      });
      const before = await git(root, "rev-parse", "HEAD");
      const dir = await makeTmpDir("req-");
      const file = path.join(dir, "r.md");
      if (content !== null) await writeFile(file, content);
      const orca = fakeOrca();
      const result = await runCli(
        ["new", "--title", "a", "--slug", "a", "--request-file", file],
        { cwd: root, runner: orca.runner },
      );
      await rm(dir, { recursive: true, force: true });
      expect(result.code).toBe(1);
      expect(orca.calls).toEqual([]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
      expect(await git(root, "status", "--porcelain")).toBe("");
      await expect(
        stat(path.join(root, ".git/orca-flow/requests")),
      ).rejects.toThrow();
    });
  }

  const vanish: [
    string,
    (root: string, wt: string, b: string) => Promise<void>,
  ][] = [
    [
      "worktree とブランチ",
      async (root, wt, b) => {
        await git(root, "worktree", "remove", "--force", wt);
        await git(root, "branch", "-D", `task/${b}`);
      },
    ],
    [
      "ブランチだけ",
      async (root, wt, b) => {
        await git(wt, "switch", "--detach", "--quiet");
        await git(root, "branch", "-D", `task/${b}`);
      },
    ],
    [
      "worktree のフォルダだけ",
      async (_root, wt) => {
        await rm(wt, { recursive: true, force: true });
      },
    ],
  ];
  for (const [label, after] of vanish) {
    it(`作成の直後に${label}が消えたら終了コード1で、進捗表を書かない`, async () => {
      const root = await makeRepo(withProgress, {
        "docs/progress.md": PROGRESS,
      });
      const before = await git(root, "rev-parse", "HEAD");
      const orca = fakeOrca();
      orca.branchFor = (n) => `task/${n}`;
      afterCreate(orca, after);
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain(`${path.dirname(root)}${path.sep}T02-a`);
      expect(result.err).toContain("Orca/logs");
      expect(result.err).toContain("/orca-flow:new");
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
      expect(await git(root, "status", "--porcelain")).toBe("");
      expect(await readFile(path.join(root, "docs/progress.md"), "utf8")).toBe(
        PROGRESS,
      );
    });
  }

  it("作成のあと2回目の git worktree list の直前に消えても終了コード1で、進捗表を書かない", async () => {
    const root = await makeRepo(withProgress, {
      "docs/progress.md": PROGRESS,
    });
    const before = await git(root, "rev-parse", "HEAD");
    const orca = fakeOrca();
    orca.branchFor = (n) => `task/${n}`;
    const inner = orca.runner;
    let created = false;
    let lists = 0;
    orca.runner = async (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list") {
        if (created && ++lists === 2) {
          const wt = path.join(path.dirname(root), "T02-a");
          await git(root, "worktree", "remove", "--force", wt);
          await git(root, "branch", "-D", "task/T02-a");
        }
      }
      const result = await inner(cmd, args, opts);
      if (cmd === "orca" && args[0] === "worktree" && args[1] === "create")
        created = true;
      return result;
    };
    // 1回目の確かめが済んでも待ち時間が残るよう、長くとる（消えた時点で終わる）
    const saved = process.env[VERIFY_WINDOW_ENV];
    process.env[VERIFY_WINDOW_ENV] = "40000";
    let result;
    const startedAt = Date.now();
    try {
      result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
    } finally {
      process.env[VERIFY_WINDOW_ENV] = saved;
    }
    // 待ち時間（40秒）を使い切らず、消えた時点で終わる。混んだマシンでも落ちないよう、判定は30秒と広くとる
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(lists).toBeGreaterThanOrEqual(2);
    expect(result.code).toBe(1);
    expect(result.err).toContain("消えました");
    expect(result.err).toContain(`${path.dirname(root)}${path.sep}T02-a`);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await readFile(path.join(root, "docs/progress.md"), "utf8")).toBe(
      PROGRESS,
    );
  });

  describe("消えたときのメッセージ", () => {
    const cases: [
      string,
      (root: string, wt: string, b: string) => Promise<void>,
      (err: string, wt: string) => void,
    ][] = [
      [
        "worktree とブランチ",
        vanish[0]![1],
        (err) => {
          expect(err).toContain(
            "欠けたもの：worktree のフォルダ、git worktree list の行、ブランチ task/T02-a\n",
          );
          expect(err).not.toContain("残っているもの");
          expect(err).not.toContain("git worktree prune");
          expect(err).not.toContain("git worktree remove");
          expect(err).not.toContain("git branch -D");
        },
      ],
      [
        "ブランチだけ",
        vanish[1]![1],
        (err, wt) => {
          expect(err).toContain("欠けたもの：ブランチ task/T02-a\n");
          expect(err).toContain(
            "\n  残っているもの：git worktree list の行、worktree のフォルダ\n",
          );
          expect(err).toContain(`git worktree remove --force ${wt}`);
          expect(err).not.toContain("git worktree prune");
          expect(err).not.toContain("git branch -D");
        },
      ],
      [
        "フォルダだけ",
        vanish[2]![1],
        (err) => {
          expect(err).toContain("欠けたもの：worktree のフォルダ\n");
          expect(err).toContain(
            "\n  残っているもの：git worktree list の行、ブランチ task/T02-a\n",
          );
          expect(err).not.toContain("git worktree remove");
          const prune = err.indexOf("git worktree prune");
          const del = err.indexOf("git branch -D task/T02-a");
          expect(prune).toBeGreaterThan(-1);
          expect(del).toBeGreaterThan(prune);
        },
      ],
    ];
    for (const [label, after, check] of cases) {
      it(`${label}が消えたときの欠けたもの・残っているもの・片付け`, async () => {
        const root = await makeRepo(withProgress, {
          "docs/progress.md": PROGRESS,
        });
        const orca = fakeOrca();
        orca.branchFor = (n) => `task/${n}`;
        afterCreate(orca, after);
        const result = await runCli(["new", "--title", "a", "--slug", "a"], {
          cwd: root,
          runner: orca.runner,
        });
        expect(result.code).toBe(1);
        expect(result.err).toContain("消えました");
        check(result.err, path.join(path.dirname(root), "T02-a"));
      });
    }
  });

  it("名前直しの git branch -m が失敗し、worktree が残っていれば、git のエラーを出して消えましたとは言わない", async () => {
    const root = await makeRepo();
    const orca = fakeOrca(); // ブランチ名が task/ なしなので名前直しが走る
    afterCreate(orca, async (r) => {
      await git(r, "branch", "task/T01-a");
    });
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).not.toContain("消えました");
    expect(result.err).toContain("git branch -m");
    expect(result.err).toMatch(/already exists|既に存在|すでに/i);
  });

  it("同じ ID の古い依頼のファイルは --request-file なしだと worktree create の前に消える", async () => {
    const root = await makeRepo();
    const common = await git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const stale = path.join(common, "orca-flow/requests/T01.md");
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, "古い依頼");
    const orca = fakeOrca();
    let seen: boolean | null = null;
    const inner = orca.runner;
    orca.runner = async (cmd, args, opts) => {
      if (cmd === "orca" && args[0] === "worktree" && args[1] === "create")
        seen = await stat(stale).then(
          () => true,
          () => false,
        );
      return inner(cmd, args, opts);
    };
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(seen).toBe(false);
  });

  it("--request-file が FIFO なら止まらずに終了コード1で、何も書かない", async () => {
    const root = await makeRepo(withProgress, {
      "docs/progress.md": PROGRESS,
    });
    const before = await git(root, "rev-parse", "HEAD");
    const dir = await makeTmpDir("req-");
    const fifo = path.join(dir, "pipe");
    await promisify(execFile)("mkfifo", [fifo]);
    const orca = fakeOrca();
    const result = await runCli(
      ["new", "--title", "a", "--slug", "a", "--request-file", fifo],
      { cwd: root, runner: orca.runner },
    );
    await rm(dir, { recursive: true, force: true });
    expect(result.code).toBe(1);
    expect(orca.calls).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
    await expect(
      stat(path.join(root, ".git/orca-flow/requests")),
    ).rejects.toThrow();
  });

  describe("成功のあと依頼のファイル", () => {
    const args = ["new", "--title", "a", "--slug", "a"];
    const withFile = async (
      run: (root: string, file: string) => Promise<void>,
    ) => {
      const root = await makeRepo();
      const dir = await makeTmpDir("req-");
      const file = path.join(dir, "r.md");
      await writeFile(file, "全文\n");
      try {
        await run(root, file);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };

    it("--json の requestFile に残り、中身は全文のまま", async () => {
      await withFile(async (root, file) => {
        const json = await runCli([...args, "--request-file", file, "--json"], {
          cwd: root,
          runner: fakeOrca().runner,
        });
        expect(json.code).toBe(0);
        const requestFile = JSON.parse(json.out).requestFile as string;
        expect(requestFile).toBe(
          path.join(root, ".git/orca-flow/requests/T01.md"),
        );
        expect(await readFile(requestFile, "utf8")).toBe("全文\n");
      });
    });

    it("「依頼：」の行がある", async () => {
      await withFile(async (root, file) => {
        const human = await runCli([...args, "--request-file", file], {
          cwd: root,
          runner: fakeOrca().runner,
        });
        expect(human.out).toContain(
          `依頼：${root}/.git/orca-flow/requests/T01.md`,
        );
      });
    });

    it("--request-file がなければ --json の requestFile は null", async () => {
      const root = await makeRepo();
      const none = await runCli([...args, "--json"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(JSON.parse(none.out).requestFile).toBeNull();
    });

    it("--request-file がなければ「依頼：」の行がない", async () => {
      const plain = await runCli(args, {
        cwd: await makeRepo(),
        runner: fakeOrca().runner,
      });
      expect(plain.out).not.toContain("依頼：");
    });
  });

  it("名前直しの前に消えても、消えたことを知らせて終了コード1", async () => {
    const root = await makeRepo();
    const orca = fakeOrca(); // ブランチ名が task/ なしなので名前直しが走る
    afterCreate(orca, async (r, wt) => {
      await rm(wt, { recursive: true, force: true });
      await git(r, "worktree", "prune");
    });
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("消えました");
    expect(result.err).not.toContain(TASK_LEAD_NOTE);
    expect(result.err).toContain("Orca/logs");
  });

  it("消えなければ終了コード0で、待ち時間が過ぎるまで終わらない", async () => {
    const root = await makeRepo();
    const t0 = Date.now();
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });

  it("8章 ④ の引数で worktree create を呼び、ブランチ名を直し、カードと進捗表を更新する", async () => {
    const root = await makeRepo(withProgress, {
      "docs/progress.md": PROGRESS,
      "docs/tasks/T91.md": "# T91\n",
      "docs/tasks/T92d.md": "# T92d\n",
    });
    await git(root, "branch", "task/T93-x");
    const orca = fakeOrca();
    orca.branchFor = (name) => `someone/${name}`; // Orca が違う名前を付けた
    const result = await runCli(
      [
        "new",
        "--title",
        "買い物の直し",
        "--slug",
        "shopping-fix",
        "--depends",
        "T91,T93",
        "--json",
      ],
      { cwd: root, runner: orca.runner },
    );
    expect(result.err).toBe("");
    expect(result.code).toBe(0);

    const wt = path.join(path.dirname(root), "T94-shopping-fix");
    expect(orca.callsOf("worktree", "create")).toEqual([
      [
        "worktree",
        "create",
        "--repo",
        `path:${root}`,
        "--name",
        "T94-shopping-fix",
        "--base-branch",
        "main",
        "--no-parent",
        "--setup",
        "run",
        "--agent",
        "claude",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high",
        "--prompt",
        "/orca-flow:spec T94 買い物の直し",
      ],
    ]);
    expect(await git(wt, "branch", "--show-current")).toBe(
      "task/T94-shopping-fix",
    );
    expect(orca.callsOf("worktree", "set")).toEqual([
      [
        "worktree",
        "set",
        "--worktree",
        `path:${wt}`,
        "--display-name",
        "T94 買い物の直し",
        "--workspace-status",
        "in-progress",
        "--comment",
        "設計中",
        "--read",
      ],
    ]);

    const progress = await readFile(
      path.join(root, "docs/progress.md"),
      "utf8",
    );
    expect(progress).toBe(
      PROGRESS.replace(
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T94 | 買い物の直し | T91、T93 | 設計中 | task/T94-shopping-fix | |\n",
      ),
    );
    expect(await git(root, "log", "-1", "--format=%s")).toBe(
      "統括役: T94 を始める",
    );
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({
      id: "T94",
      displayName: "T94 買い物の直し",
      branch: "task/T94-shopping-fix",
      worktree: wt,
    });
  });

  it("progress が null なら進捗表を書かず、コミットもしない", async () => {
    const root = await makeRepo();
    const before = await git(root, "rev-parse", "HEAD");
    const orca = fakeOrca();
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    // ブランチ名が合っていれば直さない
    expect(result.out).toContain("task/T01-a");
  });

  it("すでにある ID の指定は終了コード1で、Orca を呼ばない", async () => {
    const root = await makeRepo({}, { "docs/tasks/T05.md": "# T05\n" });
    const orca = fakeOrca();
    const result = await runCli(
      ["new", "--title", "a", "--slug", "a", "--id", "T05"],
      { cwd: root, runner: orca.runner },
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("T05");
    expect(orca.calls).toEqual([]);
  });

  it("作業中のタスクが maxActiveTasks 以上なら終了コード2", async () => {
    const root = await makeRepo({ maxActiveTasks: 1 });
    await addTaskWorktree(root, "T01", "a");
    const orca = fakeOrca();
    const result = await runCli(["new", "--title", "b", "--slug", "b"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(2);
    expect(orca.calls).toEqual([]);
  });

  it("Orca につながらなければ終了コード1で、進捗表を書かない", async () => {
    const root = await makeRepo(withProgress, { "docs/progress.md": PROGRESS });
    const before = await git(root, "rev-parse", "HEAD");
    const orca = fakeOrca();
    orca.unavailable = true;
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("Orca");
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("統括役の場所でなければ終了コード2", async () => {
    const root = await makeRepo();
    await git(root, "switch", "--quiet", "-c", "other");
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(2);
  });

  it("設定がなければ終了コード2", async () => {
    const root = await makeRepo();
    await git(root, "rm", "--quiet", ".orca-flow/config.json");
    await git(root, "commit", "--quiet", "-m", "rm");
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("/orca-flow:init");
  });

  it("表示名を出力に出す", async () => {
    const root = await makeRepo();
    const orca = fakeOrca();
    const result = await runCli(
      ["new", "--title", "買い物の直し", "--slug", "shopping-fix"],
      { cwd: root, runner: orca.runner },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("表示名：T01 買い物の直し");
  });

  it("worktree set が失敗しても警告を出して終了コード0で進む", async () => {
    const root = await makeRepo(withProgress, { "docs/progress.md": PROGRESS });
    const orca = fakeOrca();
    const inner = orca.runner;
    orca.runner = async (cmd, args, opts) =>
      cmd === "orca" && args[0] === "worktree" && args[1] === "set"
        ? { code: 1, stdout: "", stderr: "boom", timedOut: false }
        : inner(cmd, args, opts);
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("警告");
    expect(await git(root, "log", "-1", "--format=%s")).toMatch(
      /^統括役: T\d+ を始める$/,
    );
  });

  describe("片付けの直し（名前直しの前にフォルダが消えた場合）", () => {
    it("名前直しの前にフォルダが消えて prune されたら、元のブランチを調べ、片付けて流し直せる", async () => {
      const root = await makeRepo();
      const orca = fakeOrca(); // ブランチ名は task/ なしの T01-a
      afterCreate(orca, async (r, wt) => {
        await rm(wt, { recursive: true, force: true });
        await git(r, "worktree", "prune");
      });
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).not.toContain(TASK_LEAD_NOTE);
      expect(result.err).toContain(
        "欠けたもの：worktree のフォルダ、git worktree list の行\n",
      );
      expect(result.err).not.toContain("task/T01-a");
      expect(result.err).toContain("\n  残っているもの：ブランチ T01-a\n");
      expect(result.err).toContain("\n  git branch -D T01-a");
      expect(result.err).not.toMatch(/git worktree (remove|prune)/);
      const lines = await runCleanup(result.err, root);
      expect(lines).toEqual(["git branch -D T01-a"]);

      const again = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(again.code).toBe(0);
    });

    it("フォルダが残り git worktree list の行だけが欠けたら、remove を出さず、中を確かめて消す案内と branch -D を出す", async () => {
      const root = await makeRepo(withProgress, {
        "docs/progress.md": PROGRESS,
      });
      const orca = fakeOrca();
      orca.branchFor = (n) => `task/${n}`;
      afterCreate(orca, async (r) => {
        await rm(path.join(r, ".git/worktrees"), {
          recursive: true,
          force: true,
        });
      });
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      const wt = path.join(path.dirname(root), "T02-a");
      expect(result.code).toBe(1);
      expect(result.err).toContain("欠けたもの：git worktree list の行\n");
      expect(result.err).toContain(
        "\n  残っているもの：ブランチ task/T02-a、worktree のフォルダ\n",
      );
      expect(result.err).not.toContain("git worktree remove");
      expect(result.err).not.toContain("git worktree prune");
      expect(result.err).not.toMatch(/rm /);
      expect(result.err).toContain(
        `フォルダ ${wt} は git の管理から外れて残っています。中を確かめてから、フォルダを消してください`,
      );
      expect(result.err).toContain("\n  git branch -D task/T02-a");
    });

    it("親のフォルダに空白があり名前直しが失敗しても、片付けのコマンドのパスが引用符で囲まれ、そのまま流して片付く", async () => {
      const made = await makeRepo();
      const spaced = `${path.dirname(made)} with space`;
      await rename(path.dirname(made), spaced);
      const root = path.join(spaced, "main");
      const orca = fakeOrca();
      afterCreate(orca, async (r, wt, b) => {
        await git(wt, "switch", "--detach", "--quiet");
        await git(r, "branch", "-D", b);
      });
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      const wt = path.join(spaced, "T01-a");
      expect(result.code).toBe(1);
      expect(result.err).toContain(`git worktree remove --force '${wt}'`);
      const lines = await runCleanup(result.err, root);
      expect(lines).toEqual([`git worktree remove --force '${wt}'`]);
      await expect(stat(wt)).rejects.toThrow();
      expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(
        "T01-a",
      );
    });

    it("親のフォルダに空白があり、名前直しの前に消えたときも、片付けのコマンドのパスが引用符で囲まれ、そのまま流して片付く", async () => {
      const made = await makeRepo();
      const spaced = `${path.dirname(made)} with space`;
      await rename(path.dirname(made), spaced);
      const root = path.join(spaced, "main");
      const orca = fakeOrca();
      orca.branchFor = (n) => `task/${n}`;
      afterCreate(orca, async (r, wt, b) => {
        await git(wt, "switch", "--detach", "--quiet");
        await git(r, "branch", "-D", `task/${b}`);
      });
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      const wt = path.join(spaced, "T01-a");
      expect(result.code).toBe(1);
      expect(result.err).toContain("消えました");
      expect(result.err).not.toContain(TASK_LEAD_NOTE);
      expect(result.err).toContain(`git worktree remove --force '${wt}'`);
      const lines = await runCleanup(result.err, root);
      expect(lines).toEqual([`git worktree remove --force '${wt}'`]);
      await expect(stat(wt)).rejects.toThrow();
      expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(
        "T01-a",
      );
    });

    it("Orca がつけたブランチが引用符の要る名前で、名前直しの前に worktree が消えたら、branch -D のブランチが引用符で囲まれ、流すと消える", async () => {
      const root = await makeRepo();
      const orca = fakeOrca();
      orca.branchFor = (n) => `feat(${n})`;
      afterCreate(orca, async (r, wt) => {
        await rm(wt, { recursive: true, force: true });
        await git(r, "worktree", "prune");
      });
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("消えました");
      expect(result.err).not.toContain(TASK_LEAD_NOTE);
      expect(result.err).toContain("\n  git branch -D 'feat(T01-a)'");
      const lines = await runCleanup(result.err, root);
      expect(lines).toEqual(["git branch -D 'feat(T01-a)'"]);
      expect(await git(root, "branch", "--list", "feat(T01-a)")).toBe("");
    });

    it("Orca がブランチを返さず、フォルダだけが消えて行が残るとき、行のブランチを残っているものと branch -D に出し、流して片付け、もう一度 new が通る", async () => {
      const root = await makeRepo();
      const orca = fakeOrca();
      afterCreate(orca, async (_r, wt) => {
        await rm(wt, { recursive: true, force: true });
      });
      withoutBranch(orca);
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("消えました");
      expect(result.err).not.toContain(TASK_LEAD_NOTE);
      expect(result.err).toContain(
        "\n  残っているもの：git worktree list の行、ブランチ T01-a\n",
      );
      expect(result.err).toContain("\n  git branch -D T01-a");
      expect(result.err).not.toContain("git branch で確かめ");
      const lines = await runCleanup(result.err, root);
      expect(lines).toEqual(["git worktree prune", "git branch -D T01-a"]);
      expect(await git(root, "branch", "--list", "T01-a")).toBe("");
      const again = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(again.code).toBe(0);
    });

    it("Orca がブランチを返さず、フォルダも行も消えたら、目的のブランチを出さず、git branch で確かめる案内を出す", async () => {
      const root = await makeRepo();
      const orca = fakeOrca();
      afterCreate(orca, async (r, wt) => {
        await rm(wt, { recursive: true, force: true });
        await git(r, "worktree", "prune");
      });
      withoutBranch(orca);
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("消えました");
      expect(result.err).not.toContain(TASK_LEAD_NOTE);
      expect(result.err).not.toContain("task/T01-a");
      expect(result.err).toContain("git branch で確かめ");
      expect(result.err).not.toMatch(/^ {2}git /m);
    });

    it("git branch -m だけが失敗し worktree が残るとき、git のエラーに残っていること・パス・進捗表・片付けを添えて終了コード1", async () => {
      const root = await makeRepo(withProgress, {
        "docs/progress.md": PROGRESS,
      });
      const before = await git(root, "rev-parse", "HEAD");
      const orca = fakeOrca(); // 名前直しが走る
      const inner = orca.runner;
      orca.runner = async (cmd, args, opts) =>
        cmd === "git" && args[0] === "branch" && args[1] === "-m"
          ? {
              code: 1,
              stdout: "",
              stderr: "fatal: 名前直しの失敗",
              timedOut: false,
            }
          : inner(cmd, args, opts);
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      const wt = path.join(path.dirname(root), "T02-a");
      expect(result.code).toBe(1);
      expect(result.err).not.toContain("消えました");
      expect(result.err).toContain("git branch -m");
      expect(result.err).toContain("fatal: 名前直しの失敗");
      expect(result.err).toContain("残っています");
      expect(result.err).toContain(`worktree：${wt}`);
      expect(result.err).toContain("進捗表は書いていません");
      expect(result.err).toContain(`git worktree remove --force ${wt}`);
      expect(result.err).toContain("git branch -D T02-a");
      // Orca でタスク長がもう動いていることと、先に止める1文を、最初の remove より前に書く
      const stop = result.err.indexOf("先に Orca でタスク長を止めてから");
      const remove = result.err.indexOf("\n  git worktree remove --force");
      const del = result.err.indexOf("\n  git branch -D T02-a");
      expect(result.err).toContain("Orca ではタスク長がもう動いています。");
      // 案内は1文：「もう動いています。」と改行1つのすぐあとに、先に止める文が切れ目なく続く
      expect(result.err).toContain(
        "Orca ではタスク長がもう動いています。\n先に Orca でタスク長を止めてから、中を確かめて、メインのチェックアウトで次を流して片付けてください：",
      );
      expect(stop).toBeGreaterThan(-1);
      expect(result.err.indexOf("git worktree remove")).toBeGreaterThan(stop);
      expect(remove).toBeGreaterThan(stop);
      expect(del).toBeGreaterThan(remove);
      expect(result.err.split("片付けてください").length - 1).toBe(1);
      expect(result.err).not.toContain("worktree を消して");
      expect(result.err).not.toMatch(/^ {2}git .*タスク長/m);
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
      expect(await readFile(path.join(root, "docs/progress.md"), "utf8")).toBe(
        PROGRESS,
      );
      // 流すと片付き、もう一度 new が通る
      await runCleanup(result.err, root);
      await expect(stat(wt)).rejects.toThrow();
      expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(
        "T02-a",
      );
      expect(await git(root, "branch", "--list", "T02-a")).toBe("");
      const again = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(again.code).toBe(0);
    });

    it("同じ ID の古い依頼のファイルを消せないなら、終了コード1で Orca を呼ばず進捗表を書かない", async () => {
      const root = await makeRepo(withProgress, {
        "docs/progress.md": PROGRESS,
      });
      const before = await git(root, "rev-parse", "HEAD");
      // 次の ID は T02。同じ名前のディレクトリは rm（再帰なし）で消せない
      const stale = path.join(root, ".git/orca-flow/requests/T02.md");
      await mkdir(path.join(stale, "inner"), { recursive: true });
      const orca = fakeOrca();
      const result = await runCli(["new", "--title", "a", "--slug", "a"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("古い依頼のファイルを消せません");
      expect(orca.calls).toEqual([]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
      expect(await readFile(path.join(root, "docs/progress.md"), "utf8")).toBe(
        PROGRESS,
      );
    });

    it("--request-file にシンボリックリンク（先は通常のファイル）を渡すと、リンク先の中身が依頼のファイルに入る", async () => {
      const root = await makeRepo();
      const dir = await makeTmpDir("req-");
      const target = path.join(dir, "real.md");
      const link = path.join(dir, "link.md");
      await writeFile(target, "リンク先の中身\n");
      await symlink(target, link);
      const result = await runCli(
        ["new", "--title", "a", "--slug", "a", "--request-file", link],
        { cwd: root, runner: fakeOrca().runner },
      );
      await rm(dir, { recursive: true, force: true });
      expect(result.code).toBe(0);
      expect(
        await readFile(
          path.join(root, ".git/orca-flow/requests/T01.md"),
          "utf8",
        ),
      ).toBe("リンク先の中身\n");
    });
  });
});
