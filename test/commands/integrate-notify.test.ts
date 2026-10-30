import { describe, expect, it } from "vitest";
import { bashScreen, fakeOrca, runCli } from "../helpers/fake-orca.ts";
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

async function setup() {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      progress: { file: "docs/progress.md" },
      verify: ["test -f src/shop/a.ts"],
    },
    {
      "docs/progress.md": progressWith(
        "| T12 | 買い物 | — | 作業中 | task/T12-shop | |",
      ),
    },
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
  return { root, wt };
}

describe("integrate の main が進んだ知らせ（入力欄の確かめ）", () => {
  it("ほかのタスクが bash モードなら、知らせを送らず警告を出し、マージは成功する", async () => {
    const { root } = await setup();
    const other = await addTaskWorktree(root, "T13", "other");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_t13",
      worktreePath: other.path,
      agentIdentity: "claude",
      screen: bashScreen(),
    });
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("T13");
    expect(result.err).toContain("知らせを送れませんでした");
    expect(result.err).toContain("bash モード");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(await git(root, "log", "--format=%s", "-2")).toContain(
      "統括役: T12 をマージする",
    );
  });

  it("ほかのタスクの入力欄を確かめられない（claude）なら、知らせを送らず警告を出す", async () => {
    const { root } = await setup();
    const other = await addTaskWorktree(root, "T13", "other");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_t13",
      worktreePath: other.path,
      agentIdentity: "claude",
      readFails: true,
    });
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("知らせを送れませんでした");
    expect(result.err).toContain("入力欄を確かめられません");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
  });
});
