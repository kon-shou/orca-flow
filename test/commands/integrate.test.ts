import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import {
  bashScreen,
  claudeScreen,
  fakeOrca,
  runCli,
} from "../helpers/fake-orca.ts";
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

async function setup(
  extra: Record<string, string> = {},
  config: Record<string, unknown> = {},
  baseFiles: Record<string, string> = {},
) {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      progress: { file: "docs/progress.md" },
      appendOnlyFiles: ["docs/decisions.md"],
      verify: ["test -f src/shop/a.ts"],
      ...config,
    },
    {
      "docs/progress.md": progressWith(
        "| T12 | 買い物 | — | 作業中 | task/T12-shop | |",
      ),
      "docs/decisions.md": "# 判断\n",
      ...baseFiles,
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
    "docs/decisions.md": "# 判断\n\n- T12 の判断\n",
    ...extra,
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  return { root, wt };
}

describe("integrate", () => {
  it("範囲を確かめ、verify を流し、マージして、進捗表・カード・知らせ・worktree の削除まで行う", async () => {
    const { root, wt } = await setup();
    const other = await addTaskWorktree(root, "T13", "other");
    const orca = fakeOrca();
    orca.terminals.push(
      {
        handle: "term_t12",
        worktreePath: wt.path,
        title: "claude",
        agentIdentity: "claude",
      },
      {
        handle: "term_t13",
        worktreePath: other.path,
        title: "claude",
        agentIdentity: "claude",
      },
    );
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);

    const log = (await git(root, "log", "--format=%s", "-2")).split("\n");
    expect(log).toEqual([
      "統括役: T12 の統合を進捗に記録する",
      "統括役: T12 をマージする",
    ]);
    expect(await git(root, "rev-list", "--parents", "-n1", "HEAD~1")).toMatch(
      /^\S+ \S+ \S+$/,
    );
    expect(await readFile(path.join(root, "docs/progress.md"), "utf8")).toBe(
      progressWith("| T12 | 買い物 | — | 統合済み | task/T12-shop | |"),
    );
    expect(orca.callsOf("worktree", "set")).toEqual([
      [
        "worktree",
        "set",
        "--worktree",
        `path:${wt.path}`,
        "--workspace-status",
        "completed",
        "--comment",
        "統合済み",
        "--read",
      ],
    ]);
    expect(orca.callsOf("terminal", "send")).toEqual([
      [
        "terminal",
        "send",
        "--terminal",
        "term_t13",
        "--text",
        "（統括役より）main に T12 が入りました。区切りのよいところで git merge main をして、テストを流してください。統合待ちなら、orca-flow verify を流し直して integrate-wait に戻してください。",
        "--enter",
      ],
    ]);
    expect(orca.callsOf("worktree", "rm")).toEqual([
      ["worktree", "rm", "--worktree", `path:${wt.path}`],
    ]);
    expect(existsSync(wt.path)).toBe(false);
    // ブランチは消さない
    expect(await git(root, "branch", "--list", wt.branch)).toContain(wt.branch);
  });

  it("Setup だけのタスクには main が進んだ知らせを送らず、警告を出してマージは成功する", async () => {
    const { root, wt } = await setup();
    const other = await addTaskWorktree(root, "T13", "other");
    const orca = fakeOrca();
    orca.terminals.push(
      {
        handle: "term_t12",
        worktreePath: wt.path,
        agentIdentity: "claude",
      },
      { handle: "setup_t13", worktreePath: other.path, title: "Setup" },
    );
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("警告");
    expect(result.err).toContain("T13");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(await git(root, "log", "--format=%s", "-2")).toContain(
      "統括役: T12 をマージする",
    );
  });

  it("main が進んだ知らせは、候補が2つのタスクにも送らず警告を出す", async () => {
    const { root } = await setup();
    const other = await addTaskWorktree(root, "T13", "other");
    const orca = fakeOrca();
    orca.terminals.push(
      {
        handle: "a",
        worktreePath: other.path,
        title: "一",
        agentIdentity: "claude",
      },
      {
        handle: "b",
        worktreePath: other.path,
        title: "二",
        agentIdentity: "claude",
      },
    );
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("警告");
    expect(result.err).toContain("一");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
  });

  it("--keep-worktree なら worktree rm を呼ばない", async () => {
    const { root, wt } = await setup();
    const orca = fakeOrca();
    const result = await runCli(
      ["integrate", "T12", "--verify-here", "--keep-worktree"],
      {
        cwd: root,
        runner: orca.runner,
      },
    );
    expect(result.code).toBe(0);
    expect(orca.callsOf("worktree", "rm")).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("書き込んでよい場所の外のファイルがあれば終了コード1で、何も書き換えない", async () => {
    const { root } = await setup({
      "src/other/b.ts": "x\n",
      "package.json": "{}\n",
    });
    const before = await git(root, "rev-parse", "HEAD");
    const orca = fakeOrca();
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("src/other/b.ts");
    expect(result.err).toContain("package.json");
    expect(result.err).not.toContain("docs/decisions.md");
    expect(result.err).not.toContain("reports/T12.md");
    expect(orca.calls).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("報告がなければ終了コード1", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop", {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
    });
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("報告");
  });

  it("verify が落ちたら最後の80行を出して終了コード1で、マージしない", async () => {
    const { root } = await setup(
      {},
      {
        verify: ["for i in $(seq 1 100); do echo line$i; done; exit 1"],
      },
    );
    const before = await git(root, "rev-parse", "HEAD");
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("line100");
    expect(result.err).toContain("line21");
    expect(result.err).not.toContain("line20\n");
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("差分が当たる pathVerify だけを流す", async () => {
    const { root } = await setup(
      {},
      {
        verify: [],
        pathVerify: [
          { paths: ["src/shop/"], commands: ["echo shop-check"] },
          { paths: ["services/"], commands: ["exit 1"] },
        ],
      },
    );
    const result = await runCli(
      ["integrate", "T12", "--verify-here", "--json"],
      {
        cwd: root,
        runner: fakeOrca().runner,
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).verified).toEqual(["echo shop-check"]);
  });

  it("かっこを含むパス（Expo Router のグループ）の差分を範囲の中として統合する", async () => {
    const root = await makeRepo(
      {
        integrateVerify: "before-merge",
        progress: { file: "docs/progress.md" },
        verify: [],
      },
      {
        "docs/progress.md": progressWith(
          "| T512 | 設定 | — | 作業中 | task/T512-settings | |",
        ),
      },
    );
    const wt = await addTaskWorktree(root, "T512", "settings", {
      "docs/tasks/T512.md": specDoc("T512", {
        allowed: [
          "apps/mobile/app/(core)/settings.tsx",
          "apps/mobile/app/(shop)/list.tsx",
        ],
      }),
    });
    await writeFiles(wt.path, {
      "apps/mobile/app/(core)/settings.tsx": "export {};\n",
      "apps/mobile/app/(shop)/list.tsx": "export {};\n",
      "docs/tasks/reports/T512.md": "# 報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T512: 作る");
    const result = await runCli(
      ["integrate", "T512", "--verify-here", "--keep-worktree"],
      {
        cwd: root,
        runner: fakeOrca().runner,
      },
    );
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(
      existsSync(path.join(root, "apps/mobile/app/(core)/settings.tsx")),
    ).toBe(true);
    expect(existsSync(path.join(root, "apps/mobile/app/(shop)/list.tsx"))).toBe(
      true,
    );
  });

  it("かっこを含むパスの範囲を広げず、ほかのグループのファイルは範囲の外として止める", async () => {
    const root = await makeRepo({ verify: [] });
    await addTaskWorktree(root, "T512", "settings", {
      "docs/tasks/T512.md": specDoc("T512", {
        allowed: ["apps/mobile/app/(core)/"],
      }),
      "apps/mobile/app/(core)/settings.tsx": "export {};\n",
      "apps/mobile/app/(auth)/login.tsx": "export {};\n",
      "docs/tasks/reports/T512.md": "# 報告\n",
    });
    const before = await git(root, "rev-parse", "HEAD");
    const orca = fakeOrca();
    const result = await runCli(["integrate", "T512", "--verify-here"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("apps/mobile/app/(auth)/login.tsx");
    expect(result.err).not.toContain("apps/mobile/app/(core)/settings.tsx");
    expect(orca.calls).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("Orca につながらなければ終了コード1で、マージしない", async () => {
    const { root } = await setup();
    const before = await git(root, "rev-parse", "HEAD");
    const orca = fakeOrca();
    orca.unavailable = true;
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(1);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });

  describe("知らせを送れなかったときの警告", () => {
    /** terminal send だけが失敗する（呼び出しは偽の Orca に記録される） */
    const sendFails = (orca: ReturnType<typeof fakeOrca>): Runner => {
      return async (cmd, args, opts) => {
        const result = await orca.runner(cmd, args, opts);
        return cmd === "orca" && args[0] === "terminal" && args[1] === "send"
          ? { code: 1, stdout: "", stderr: "boom", timedOut: false }
          : result;
      };
    };
    const two = (path: string) => [
      {
        handle: "tab_a",
        worktreePath: path,
        title: "一つめの題",
        agentIdentity: "claude",
      },
      {
        handle: "tab_b",
        worktreePath: path,
        title: "",
        agentIdentity: "claude",
      },
    ];

    it("verify のやり直し：見つからないとき「知らせを送れませんでした」と開き直しの一言が入る", async () => {
      const { root } = await setup();
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain(
        "警告：T12 のタスク長に verify のやり直しの知らせを送れませんでした：",
      );
      expect(result.err).toContain("開き直してください");
      expect(result.err).toContain("orca-flow tell T12");
    });

    it("verify のやり直し：1つに決まらないとき、2つの候補の題名とハンドルが入る", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push(...two(wt.path));
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain("知らせを送れませんでした");
      for (const word of ["一つめの題", "tab_a", "（題名なし）", "tab_b"])
        expect(result.err).toContain(word);
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });

    it("verify のやり直し：Orca の送信が失敗しても、send まで行って失敗の文つきの警告が出る", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_t12",
        worktreePath: wt.path,
        agentIdentity: "claude",
      });
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner: sendFails(orca),
      });
      expect(result.code).toBe(2);
      expect(orca.callsOf("terminal", "send")).toHaveLength(1);
      expect(result.err).toContain(
        "警告：T12 のタスク長に verify のやり直しの知らせを送れませんでした：Orca の送信が失敗しました（",
      );
      expect(result.err).toContain("boom");
      expect(result.err).toContain("送れませんでした");
      // 〈すること〉は verify のやり直しを伝える（main を取り込むとは言わない）
      expect(result.err).toContain(
        "原因を直してから、orca-flow tell T12 で orca-flow verify をやり直して integrate-wait に戻すよう伝えてください",
      );
      expect(result.err).not.toContain("main を取り込む");
    });

    it("verify のやり直し：入力欄に打ちかけがあれば送らず、警告を出す", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_t12",
        worktreePath: wt.path,
        agentIdentity: "claude",
        screen: claudeScreen("途中の文"),
      });
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain(
        "警告：T12 のタスク長に verify のやり直しの知らせを送れませんでした：",
      );
      expect(result.err).toContain("入力欄");
      expect(result.err).toContain("送るか消して");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });

    it("main が進んだ知らせ：見つからないとき「知らせを送れませんでした」が入る", async () => {
      const { root, wt } = await setup();
      const other = await addTaskWorktree(root, "T13", "other");
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_t12",
        worktreePath: wt.path,
        agentIdentity: "claude",
      });
      const result = await runCli(["integrate", "T12", "--verify-here"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        "警告：T13 のタスク長に main が進んだ知らせを送れませんでした：",
      );
      expect(result.err).not.toContain("main が進んだの");
      // 見つからない T13 には send していない
      expect(
        orca.callsOf("terminal", "send").filter((c) => c.includes("term_t13")),
      ).toEqual([]);
      expect(orca.callsOf("terminal", "send")).toEqual([]);
      // 警告は見つからない T13 のものだけ（見つかった T12 には出ない）
      expect(result.err).toContain("動いているターミナルが見つかりません");
      expect(result.err.match(/警告：/g)).toHaveLength(1);
      expect(result.err).not.toContain("警告：T12");
    });

    it("main が進んだ知らせ：Orca の送信が失敗しても、send まで行って失敗の文つきの警告が出て、マージは成功する", async () => {
      const { root } = await setup();
      const other = await addTaskWorktree(root, "T13", "other");
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_t13",
        worktreePath: other.path,
        agentIdentity: "claude",
      });
      const result = await runCli(["integrate", "T12", "--verify-here"], {
        cwd: root,
        runner: sendFails(orca),
      });
      expect(result.code).toBe(0);
      expect(orca.callsOf("terminal", "send")).toHaveLength(1);
      expect(result.err).toContain(
        "警告：T13 のタスク長に main が進んだ知らせを送れませんでした：Orca の送信が失敗しました（",
      );
      expect(result.err).toContain("boom");
      expect(result.err).toContain("送れませんでした");
    });

    it("main が進んだ知らせ：1つに決まらないとき、候補の題名とハンドルが入る", async () => {
      const { root } = await setup();
      const other = await addTaskWorktree(root, "T13", "other");
      const orca = fakeOrca();
      orca.terminals.push(...two(other.path));
      const result = await runCli(["integrate", "T12", "--verify-here"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      expect(result.err).toContain("知らせを送れませんでした");
      for (const word of ["一つめの題", "tab_a", "（題名なし）", "tab_b"])
        expect(result.err).toContain(word);
    });

    it("main が進んだ知らせ：入力欄に打ちかけがあれば送らず警告を出し、マージは成功する", async () => {
      const { root } = await setup();
      const other = await addTaskWorktree(root, "T13", "other");
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_t13",
        worktreePath: other.path,
        agentIdentity: "claude",
        screen: claudeScreen("書きかけ", ["の続き"]),
      });
      const result = await runCli(["integrate", "T12", "--verify-here"], {
        cwd: root,
        runner: orca.runner,
      });
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        "警告：T13 のタスク長に main が進んだ知らせを送れませんでした：",
      );
      expect(result.err).toContain("書きかけ の続き");
      expect(result.err).toContain("送るか消して");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
      expect(await git(root, "log", "--format=%s", "-2")).toContain(
        "統括役: T12 をマージする",
      );
    });

    it("〈すること〉は、直したあと tell で何を伝えるかを言う（verify のやり直しの知らせ）", async () => {
      const a = await setup();
      const verify = await runCli(["integrate", "T12"], {
        cwd: a.root,
        runner: fakeOrca().runner,
      });
      expect(verify.err).toContain(
        "orca-flow tell T12 で orca-flow verify をやり直して integrate-wait に戻すよう伝えてください",
      );
    });

    it("〈すること〉は、直したあと tell で何を伝えるかを言う（main が進んだ知らせ）", async () => {
      const b = await setup();
      await addTaskWorktree(b.root, "T13", "other");
      const main = await runCli(["integrate", "T12", "--verify-here"], {
        cwd: b.root,
        runner: fakeOrca().runner,
      });
      expect(main.err).toContain(
        "から、orca-flow tell T13 で main を取り込むよう伝えてください",
      );
    });

    describe("〈すること〉の枝", () => {
      const branches: [string, (path: string) => object[], string][] = [
        [
          "ambiguous",
          (p) => two(p),
          "余分なタブを閉じてから、orca-flow tell T13 で main を取り込むよう伝えてください",
        ],
        [
          "bash",
          (p) => [
            {
              handle: "term_t13",
              worktreePath: p,
              agentIdentity: "claude",
              screen: bashScreen(),
            },
          ],
          "T13 のタブの bash モードを抜けてから、orca-flow tell T13 で main を取り込むよう伝えてください",
        ],
        [
          "unverifiable",
          (p) => [
            {
              handle: "term_t13",
              worktreePath: p,
              agentIdentity: "claude",
              readFails: true,
            },
          ],
          "T13 のタブを入力欄に戻してから、orca-flow tell T13 で main を取り込むよう伝えてください",
        ],
      ];
      for (const [kind, terminals, expected] of branches)
        it(`${kind}：〈直すこと〉と tell を含む`, async () => {
          const { root } = await setup();
          const other = await addTaskWorktree(root, "T13", "other");
          const orca = fakeOrca();
          orca.terminals.push(...(terminals(other.path) as never[]));
          const result = await runCli(["integrate", "T12", "--verify-here"], {
            cwd: root,
            runner: orca.runner,
          });
          expect(result.err).toContain(expected);
          expect(orca.callsOf("terminal", "send")).toEqual([]);
        });
    });

    it("送信の失敗：理由と〈すること〉が「。」でつながり、「原因を直してから」で始まる", async () => {
      const { root } = await setup();
      const other = await addTaskWorktree(root, "T13", "other");
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_t13",
        worktreePath: other.path,
        agentIdentity: "claude",
      });
      const result = await runCli(["integrate", "T12", "--verify-here"], {
        cwd: root,
        runner: sendFails(orca),
      });
      expect(result.err).toMatch(
        /Orca の送信が失敗しました（.*boom.*）。原因を直してから、orca-flow tell T13 で main を取り込むよう伝えてください/,
      );
    });
  });

  describe("タスク側の verify の記録", () => {
    const counting = (orca: ReturnType<typeof fakeOrca>) => {
      const shells: string[] = [];
      const runner: Runner = (cmd, args, opts) => {
        if (cmd === "sh") shells.push(args.join(" "));
        return orca.runner(cmd, args, opts);
      };
      return { runner, shells };
    };
    const verifyInTask = async (wt: string, orca = fakeOrca()) => {
      const result = await runCli(["verify"], { cwd: wt, runner: orca.runner });
      expect(result.code).toBe(0);
    };

    it("記録とブランチと main がそろえば、verify のコマンドを1つも流さずにマージする", async () => {
      const { root, wt } = await setup();
      await verifyInTask(wt.path);
      const orca = fakeOrca();
      const { runner, shells } = counting(orca);
      const result = await runCli(["integrate", "T12", "--json"], {
        cwd: root,
        runner,
      });
      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      expect(shells).toEqual([]);
      const data = JSON.parse(result.out);
      expect(data.verifyRoute).toBe("record");
      expect(data.verified).toEqual([]);
      expect(await git(root, "log", "--format=%s", "-2")).toContain(
        "統括役: T12 をマージする",
      );
    });

    it("記録を使うときは、使う記録の時刻を出す", async () => {
      const { root, wt } = await setup();
      await verifyInTask(wt.path);
      const result = await runCli(["integrate", "T12", "--keep-worktree"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(result.out).toMatch(/に T12 のコンソールで通った記録を使います/);
    });

    const expectBlocked = async (
      root: string,
      wt: { path: string },
      reason: string,
    ) => {
      const before = await git(root, "rev-parse", "HEAD");
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_t12",
        worktreePath: wt.path,
        title: "claude",
        agentIdentity: "claude",
      });
      const { runner, shells } = counting(orca);
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner,
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain("orca-flow verify");
      expect(result.err).toContain(reason);
      expect(shells).toEqual([]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
      const sends = orca.callsOf("terminal", "send");
      expect(sends).toHaveLength(1);
      expect(sends[0]![3]).toBe("term_t12");
      expect(sends[0]![5]).toContain("（統括役より）");
      expect(sends[0]![5]).toContain("orca-flow verify");
      expect(sends[0]![5]).toContain("integrate-wait");
    };

    it("ブランチが記録から動いていれば終了コード2で、テストもマージもせず知らせを送る", async () => {
      const { root, wt } = await setup();
      await verifyInTask(wt.path);
      await writeFiles(wt.path, { "src/shop/c.ts": "export {};\n" });
      await git(wt.path, "add", "-A");
      await git(wt.path, "commit", "--quiet", "-m", "T12: 足す");
      await expectBlocked(root, wt, "ブランチが動きました");
    });

    it("main が記録から動いていれば終了コード2で、テストもマージもせず知らせを送る", async () => {
      const { root, wt } = await setup();
      await verifyInTask(wt.path);
      await writeFiles(root, { "other.txt": "x\n" });
      await git(root, "add", "-A");
      await git(root, "commit", "--quiet", "-m", "main が進む");
      await expectBlocked(root, wt, "main が動きました");
    });

    it("記録がなければ終了コード2で、知らせを送る", async () => {
      const { root, wt } = await setup();
      await expectBlocked(root, wt, "記録がありません");
    });

    it("コマンドが変わっていれば終了コード2", async () => {
      const { root, wt } = await setup();
      await verifyInTask(wt.path);
      const dir = path.join(root, ".git/orca-flow/verified/T12.json");
      const record = JSON.parse(await readFile(dir, "utf8"));
      record.commands = ["echo old"];
      await writeFile(dir, JSON.stringify(record));
      await expectBlocked(root, wt, "コマンドが変わりました");
    });

    it("ターミナルがなくても警告だけで、終了コード2", async () => {
      const { root } = await setup();
      const before = await git(root, "rev-parse", "HEAD");
      const { runner, shells } = counting(fakeOrca());
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner,
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain("警告");
      expect(result.err).toContain("orca-flow verify");
      expect(shells).toEqual([]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    });

    it("Setup だけのタスクには verify のやり直しの知らせを送らず、警告を出す", async () => {
      const { root, wt } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "setup_t12",
        worktreePath: wt.path,
        title: "Setup",
      });
      const { runner } = counting(orca);
      const result = await runCli(["integrate", "T12"], { cwd: root, runner });
      expect(result.code).toBe(2);
      expect(result.err).toContain("警告");
      expect(orca.callsOf("terminal", "send")).toEqual([]);
    });

    it("終了コード2の標準エラーに orca-flow verify が入るのは、記録が使えないときだけ", async () => {
      const { root } = await setup();
      await git(root, "switch", "--quiet", "-c", "other");
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(2);
      expect(result.err).not.toContain("orca-flow verify");
    });

    it("範囲の外のファイルがあれば、記録があっても終了コード1", async () => {
      const { root, wt } = await setup({ "src/other/b.ts": "x\n" });
      await verifyInTask(wt.path);
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("src/other/b.ts");
    });

    it("差分がすべて verifySkipPaths の中なら、記録がなくてもテストを流さずにマージする", async () => {
      const { root, wt } = await setup(
        {},
        { verifySkipPaths: ["src/shop/", "docs/"] },
      );
      const orca = fakeOrca();
      const { runner, shells } = counting(orca);
      const result = await runCli(["integrate", "T12", "--json"], {
        cwd: root,
        runner,
      });
      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      expect(shells).toEqual([]);
      expect(JSON.parse(result.out).verifyRoute).toBe("skipped");
      expect(existsSync(wt.path)).toBe(false);
    });

    it("verifySkipPaths が docs/ のとき、src/ のファイルを docs/ へ移しても skipped にならない", async () => {
      const spec = specDoc("T12", { allowed: ["src/shop/", "docs/"] });
      const { root, wt } = await setup(
        { "docs/tasks/T12.md": spec },
        // setup が足す src/shop/a.ts も飛ばす場所に入れ、移動元だけが外に残るようにする
        { verifySkipPaths: ["docs/", "src/shop/a.ts"] },
        { "src/shop/old.ts": "export const old = 1;\n" },
      );
      await git(wt.path, "mv", "src/shop/old.ts", "docs/old.ts");
      await git(wt.path, "commit", "--quiet", "-m", "T12: 移す");
      const result = await runCli(["integrate", "T12"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain("記録がありません");
      expect(existsSync(path.join(root, "docs/old.ts"))).toBe(false);
    });

    it("書き込んでよい場所の外のファイルを中へ移すと、移動元が範囲外として終了コード1", async () => {
      const { root, wt } = await setup(
        {},
        {},
        { "lib/old.ts": "export const old = 1;\n" },
      );
      await git(wt.path, "mv", "lib/old.ts", "src/shop/old.ts");
      await git(wt.path, "commit", "--quiet", "-m", "T12: 移す");
      const result = await runCli(["integrate", "T12", "--verify-here"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("- lib/old.ts");
      // 移動先 src/shop/old.ts は範囲内なので、範囲外の一覧に出ない
      expect(result.err).not.toContain("src/shop/old.ts");
    });

    it("verifySkipPaths の外のファイルが1つでもあれば記録が要る", async () => {
      const { root, wt } = await setup(
        {},
        {
          verifySkipPaths: ["docs/"],
        },
      );
      await expectBlocked(root, wt, "記録がありません");
    });

    it("skip のとき main が進んでいても main を取り込んでマージする", async () => {
      const { root, wt } = await setup(
        {},
        { verifySkipPaths: ["src/shop/", "docs/"] },
      );
      await writeFiles(root, { "other.txt": "x\n" });
      await git(root, "add", "-A");
      await git(root, "commit", "--quiet", "-m", "main が進む");
      const before = await git(wt.path, "rev-parse", "HEAD");
      const result = await runCli(["integrate", "T12", "--keep-worktree"], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(0);
      // 書き換えていない：取り込む前のタスクの先頭が今の先頭の祖先のまま
      await git(wt.path, "merge-base", "--is-ancestor", before, "HEAD");
      expect(existsSync(path.join(root, "other.txt"))).toBe(true);
      expect(existsSync(path.join(root, "src/shop/a.ts"))).toBe(true);
      expect(await git(root, "log", "--format=%s", wt.branch)).toContain(
        "main が進む",
      );
    });

    it("--verify-here は記録を見ず、ここで main の取り込みとテストを流す", async () => {
      const { root, wt } = await setup();
      await writeFiles(root, { "other.txt": "x\n" });
      await git(root, "add", "-A");
      await git(root, "commit", "--quiet", "-m", "main が進む");
      const before = await git(wt.path, "rev-parse", "HEAD");
      const orca = fakeOrca();
      const { runner, shells } = counting(orca);
      const result = await runCli(
        ["integrate", "T12", "--verify-here", "--keep-worktree", "--json"],
        { cwd: root, runner },
      );
      expect(result.code).toBe(0);
      // 書き換えていない：取り込む前のタスクの先頭が今の先頭の祖先のまま
      await git(wt.path, "merge-base", "--is-ancestor", before, "HEAD");
      expect(shells).toEqual(["-c test -f src/shop/a.ts"]);
      expect(JSON.parse(result.out).verifyRoute).toBe("here");
    });
  });
});
