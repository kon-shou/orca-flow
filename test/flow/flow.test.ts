import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

// new の作成のあとの確かめの待ち時間はテストでは短くする（main は process.env を使う）
beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

describe("通し", () => {
  it("new → status spec-review → approve → integrate", async () => {
    const root = await makeRepo(
      {
        progress: { file: "docs/progress.md" },
        verify: ["test -f src/shop/a.ts"],
      },
      { "docs/progress.md": PROGRESS },
    );
    const orca = fakeOrca();
    orca.branchFor = (name) => `orca/${name}`;
    const cli = (argv: string[], cwd: string) =>
      runCli(argv, { cwd, runner: orca.runner });

    // 統括役：始める
    const created = await cli(
      ["new", "--title", "買い物", "--slug", "shop", "--json"],
      root,
    );
    expect(created.code).toBe(0);
    const { id, worktree } = JSON.parse(created.out) as {
      id: string;
      worktree: string;
    };
    expect(id).toBe("T02");
    expect(worktree).toBe(path.join(path.dirname(root), "T02-shop"));

    // タスク長：設計書を書いてレビュー待ちに
    await writeFiles(worktree, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["src/shop/"] }),
    });
    expect((await cli(["overlap", "T02"], worktree)).code).toBe(0);
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "--quiet", "-m", "T02: 設計書を書く");
    expect((await cli(["status", "spec-review"], worktree)).code).toBe(0);

    // 統括役：承認
    const approved = await cli(["approve", "T02"], root);
    expect(approved.err).toBe("");
    expect(approved.code).toBe(0);
    expect(orca.callsOf("terminal", "send").at(-1)).toContain(
      "/orca-flow:run T02",
    );

    // タスク長：実装して報告を書く
    expect((await cli(["status", "working"], worktree)).code).toBe(0);
    await writeFiles(worktree, {
      "src/shop/a.ts": "export const a = 1;\n",
      "docs/tasks/reports/T02.md": "# 報告\n\n完了\n",
    });
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "--quiet", "-m", "T02: 作る");
    const verified = await cli(["verify"], worktree);
    expect(verified.err).toBe("");
    expect(verified.code).toBe(0);
    expect((await cli(["status", "integrate-wait"], worktree)).code).toBe(0);

    // 統括役：統合
    const integrated = await cli(["integrate", "T02"], root);
    expect(integrated.err).toBe("");
    expect(integrated.code).toBe(0);
    // 背景の確かめは偽物が記録するだけで、本物は起動しない（起動は1回）
    expect(orca.launches).toHaveLength(1);
    expect(orca.launches[0]!.join(" ")).toContain("main-check");

    // 進捗表
    const progress = await readFile(
      path.join(root, "docs/progress.md"),
      "utf8",
    );
    expect(progress).toBe(
      PROGRESS.replace(
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T02 | 買い物 | — | 統合済み | task/T02-shop | |\n",
      ),
    );

    // main の履歴（first-parent）
    const history = (
      await git(root, "log", "--first-parent", "--format=%s")
    ).split("\n");
    expect(history).toEqual([
      "統括役: T02 の統合を進捗に記録する",
      "統括役: T02 をマージする",
      "統括役: T02 の設計を承認する",
      "統括役: T02 を始める",
      "init",
    ]);
    // マージで入ったタスクのコミット
    const merged = (
      await git(root, "log", "--format=%s", "HEAD~2..HEAD~1")
    ).split("\n");
    // 承認のコミットの取り込みが merge で入る（前のコミットは書き換わらず残る）
    expect(merged).toEqual([
      "統括役: T02 をマージする",
      "T02: 作る",
      "T02: main を取り込む",
      "T02: main を取り込む",
      "T02: 設計書を書く",
    ]);
    expect(
      (await git(root, "log", "--format=%s", "--no-merges", "HEAD~1")).split(
        "\n",
      ),
    ).toEqual(expect.arrayContaining(["T02: 作る", "T02: 設計書を書く"]));
    expect(await git(root, "show", "HEAD:src/shop/a.ts")).toBe(
      "export const a = 1;",
    );

    // カードの移り変わり
    const comments = orca
      .callsOf("worktree", "set")
      .map((call) => call[call.indexOf("--comment") + 1]);
    expect(comments).toEqual([
      "設計中",
      "設計書のレビュー待ち",
      "実装中",
      "実装中",
      "統合待ち：docs/tasks/reports/T02.md",
      "統合済み",
    ]);
    expect(orca.callsOf("worktree", "rm")).toHaveLength(1);
    expect(JSON.parse((await cli(["active", "--json"], root)).out)).toEqual([]);
  }, 120_000);
});
