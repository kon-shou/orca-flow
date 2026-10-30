import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// 担当Aの main-check.ts は差し替え、integrate の振る舞いだけを確かめる
const mc = vi.hoisted(() => ({
  state: vi.fn(),
  record: vi.fn(),
  launch: vi.fn(),
  unsent: vi.fn(),
}));
vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: mc.state,
  recordMerge: mc.record,
  launchMainCheck: mc.launch,
  unsentNoticeWarnings: mc.unsent,
}));

beforeEach(() => {
  mc.state.mockReset().mockResolvedValue({ kind: "none" });
  mc.record.mockReset().mockResolvedValue(undefined);
  mc.launch.mockReset().mockResolvedValue(undefined);
  mc.unsent.mockReset().mockResolvedValue([]);
});

const COMMAND = "test -f src/shop/a.ts";

async function setup(config: Record<string, unknown> = {}) {
  const root = await makeRepo(
    {
      progress: { file: "docs/progress.md" },
      verifySkipPaths: ["notes/"],
      verify: [COMMAND],
      maxActiveTasks: 3,
      ...config,
    },
    {
      "docs/progress.md": PROGRESS.replace(
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 作業中 | task/T12-shop | |\n",
      ),
      "notes/n.md": "n\n",
      "shared.txt": "base\n",
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", {
      allowed: ["src/shop/", "shared.txt", "notes/"],
    }),
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  return { root, wt };
}

const verifyInTask = async (wtPath: string) => {
  const result = await runCli(["verify"], {
    cwd: wtPath,
    runner: fakeOrca().runner,
  });
  expect(result.code).toBe(0);
};

const commitMain = async (root: string, files: Record<string, string>) => {
  await writeFiles(root, files);
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", "main が進む");
};

const FAILED = {
  kind: "failed",
  commit: "f".repeat(40),
  culprit: "abcdef0123456789abcdef0123456789abcdef01",
  culpritLabel: "T07",
  failedCommand: "pnpm test",
  cause: "known",
};

async function integrate(
  root: string,
  wtPath: string,
  args: string[] = [],
  extraTerminals: { handle: string; worktreePath: string }[] = [],
) {
  const orca = fakeOrca();
  orca.terminals.push(
    {
      handle: "term_t12",
      worktreePath: wtPath,
      title: "claude",
      agentIdentity: "claude",
    },
    ...extraTerminals.map((t) => ({
      ...t,
      title: "claude",
      agentIdentity: "claude",
    })),
  );
  const shells: string[] = [];
  const runner: Runner = (cmd, a, opts) => {
    if (cmd === "sh") shells.push(a.join(" "));
    return orca.runner(cmd, a, opts);
  };
  const result = await runCli(
    ["integrate", "T12", "--keep-worktree", ...args],
    { cwd: root, runner },
  );
  return { result, orca, shells };
}

describe("integrate（after-merge）：記録のあとに main が動いた", () => {
  it("テストに関係するファイルが動いても、rebase が競合しなければ待たずにマージし、「待ち」の記録と背景の確かめを1回だけ起こす", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    await commitMain(root, { "other.txt": "x\n" });
    const mainBefore = await git(root, "rev-parse", "HEAD");
    const { result, orca, shells } = await integrate(root, wt.path, ["--json"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(shells).toEqual([]);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    // 本当に rebase された：タスクの先頭が直前の main を含む
    await git(wt.path, "merge-base", "--is-ancestor", mainBefore, "HEAD");
    const data = JSON.parse(result.out);
    expect(data).toMatchObject({
      verifyRoute: "record",
      mainCheck: "launched",
      notified: [],
    });
    expect(data.mainChangedFiles).toEqual(["other.txt"]);
    // rebase されて main の変更を含み、マージされている
    const merge = await git(root, "rev-parse", "HEAD~1");
    expect(await git(root, "log", "--format=%s", "-1", merge)).toBe(
      "統括役: T12 をマージする",
    );
    expect(mc.record).toHaveBeenCalledTimes(1);
    expect(mc.record.mock.calls[0]![3]).toMatchObject({
      commit: merge,
      id: "T12",
      sameTree: false,
    });
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it("記録の base が今の main と同じでも、タスクの先頭が main を含まなければ、rebase して「待ち」にする", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    // verify の最中に main が進んだ形：main を進め、記録の base だけ新しい main にする
    await commitMain(root, { "other.txt": "x\n" });
    const mainBefore = await git(root, "rev-parse", "HEAD");
    const file = path.join(root, ".git/orca-flow/verified/T12.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    record.base = await git(root, "rev-parse", "HEAD");
    await writeFile(file, JSON.stringify(record));
    const { result } = await integrate(root, wt.path, ["--json"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).mainCheck).toBe("launched");
    expect(
      await git(wt.path, "merge-base", "--is-ancestor", mainBefore, "HEAD")
        .then(() => "ok")
        .catch(() => "ng"),
    ).toBe("ok");
    expect(await git(root, "show", "HEAD~1:other.txt")).toBe("x");
    expect(mc.record.mock.calls[0]![3]).toMatchObject({ sameTree: false });
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it("記録の base が今の main と同じなら、「通った（同じ木）」を記録し、確かめも起動する", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    const { result } = await integrate(root, wt.path, ["--json"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).mainCheck).toBe("same-tree");
    expect(mc.record).toHaveBeenCalledTimes(1);
    expect(mc.record.mock.calls[0]![3]).toMatchObject({
      commit: await git(root, "rev-parse", "HEAD~1"),
      id: "T12",
      sameTree: true,
      commands: [COMMAND],
    });
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it("--verify-here で流したときも「通った」を記録し、確かめも起動する", async () => {
    const { root, wt } = await setup();
    const { result, shells } = await integrate(root, wt.path, [
      "--verify-here",
    ]);
    expect(result.code).toBe(0);
    expect(shells).toHaveLength(1);
    expect(mc.record.mock.calls[0]![3]).toMatchObject({
      sameTree: true,
      commands: [COMMAND],
    });
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it("verifySkipPaths だけの差分で飛ばしたときは、「待ち」を記録して起動する", async () => {
    const { root, wt } = await setup({
      verifySkipPaths: ["notes/", "docs/"],
    });
    // タスクの差分を notes/ と docs/ だけにする
    await git(wt.path, "reset", "--quiet", "--hard", "HEAD~1");
    await writeFiles(wt.path, {
      "notes/t12.md": "x\n",
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: notes");
    const { result, shells } = await integrate(root, wt.path, ["--json"]);
    expect(result.code).toBe(0);
    expect(shells).toEqual([]);
    expect(JSON.parse(result.out)).toMatchObject({
      verifyRoute: "skipped",
      mainCheck: "launched",
    });
    expect(mc.record.mock.calls[0]![3]).toMatchObject({ sameTree: false });
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it("rebase が競合したら、終了コード2でマージせず、verify のやり直しを送る", async () => {
    const { root, wt } = await setup();
    await writeFile(path.join(wt.path, "shared.txt"), "task\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: shared");
    await verifyInTask(wt.path);
    await commitMain(root, { "shared.txt": "main\n" });
    const mainBefore = await git(root, "rev-parse", "HEAD");
    const taskBefore = await git(wt.path, "rev-parse", "HEAD");
    const { result, orca } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("orca-flow verify");
    expect(result.err).toContain("競合");
    expect(await git(root, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(taskBefore);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    const sends = orca.callsOf("terminal", "send");
    expect(sends).toHaveLength(1);
    expect(String(sends[0]![5])).toContain("orca-flow verify");
    expect(mc.record).not.toHaveBeenCalled();
    expect(mc.launch).not.toHaveBeenCalled();
  });

  it("記録の base が今の main と同じでも先頭が main を含まず、rebase が競合したら、終了コード2でマージせずやり直しを送る", async () => {
    const { root, wt } = await setup();
    await writeFile(path.join(wt.path, "shared.txt"), "task\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: shared");
    await verifyInTask(wt.path);
    await commitMain(root, { "shared.txt": "main\n" });
    const file = path.join(root, ".git/orca-flow/verified/T12.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    record.base = await git(root, "rev-parse", "HEAD");
    await writeFile(file, JSON.stringify(record));
    const mainBefore = await git(root, "rev-parse", "HEAD");
    const taskBefore = await git(wt.path, "rev-parse", "HEAD");
    const { result, orca } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("タスクの先頭が今の main を含んでいません");
    expect(result.err).toContain("競合");
    expect(await git(root, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(taskBefore);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    expect(mc.record).not.toHaveBeenCalled();
    expect(mc.launch).not.toHaveBeenCalled();
  });

  it("背景の確かめの起動は、進捗表のコミットのあとに1回だけ", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    let subjectAtLaunch = "";
    mc.launch.mockImplementation(async () => {
      subjectAtLaunch = await git(root, "log", "-1", "--format=%s");
    });
    const { result } = await integrate(root, wt.path);
    expect(result.code).toBe(0);
    expect(mc.launch).toHaveBeenCalledTimes(1);
    expect(subjectAtLaunch).toBe("統括役: T12 の統合を進捗に記録する");
  });

  it("進捗表のコミットが失敗しても、確かめを起動する", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    const hook = path.join(root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const { result } = await integrate(root, wt.path);
    expect(result.code).not.toBe(0);
    expect(mc.record).toHaveBeenCalledTimes(1);
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it("起動が失敗したら、警告を出してマージは成功のまま", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    mc.launch.mockRejectedValue(
      new Error("main の確かめを起動できませんでした"),
    );
    const { result } = await integrate(root, wt.path, ["--json"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain("orca-flow main-check run");
    expect(JSON.parse(result.out).mainCheck).toBe("same-tree");
  });

  it("記録がなければ、今のまま終了コード2でやり直しを頼む", async () => {
    const { root, wt } = await setup();
    const { result, orca } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("orca-flow verify");
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    expect(mc.launch).not.toHaveBeenCalled();
  });

  it("コマンドが変わったら、今のまま終了コード2", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    const file = path.join(root, ".orca-flow/config.json");
    const current = JSON.parse(await readFile(file, "utf8"));
    await commitMain(root, {
      ".orca-flow/config.json": JSON.stringify({
        ...current,
        verify: ["true"],
      }),
    });
    const { result } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("コマンドが変わりました");
  });

  it("ブランチが記録のあとに動いたら、今のまま終了コード2", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    await writeFile(path.join(wt.path, "shared.txt"), "task\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: あと");
    const { result } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("orca-flow verify");
  });

  it("main のほかのタスクへ「main が進んだ知らせ」を送らず、最後の文は確かめのあとに送る旨", async () => {
    const { root, wt } = await setup();
    const other = await addTaskWorktree(root, "T13", "other");
    await verifyInTask(wt.path);
    const { result, orca } = await integrate(
      root,
      wt.path,
      [],
      [{ handle: "term_t13", worktreePath: other.path }],
    );
    expect(result.code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(result.out).toContain("確かめが通ってから送ります");
  });
});

describe("integrate（after-merge）：落ちた main", () => {
  it("落ちていたら、何もせず終了コード2で止まり、原因・短いコミット・戻すコマンドを出す", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    mc.state.mockResolvedValue(FAILED);
    const before = await git(root, "rev-parse", "HEAD");
    const { result, orca } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(
      /main の確かめが T07 の時点（abcdef01）で落ちています/,
    );
    expect(result.err).toContain("pnpm test");
    expect(result.err).toContain(`git revert -m 1 ${FAILED.culprit}`);
    expect(result.err).toContain("--fixes-main");
    expect(result.err).toContain("orca-flow main-check run");
    expect(result.err).not.toContain("orca-flow verify");
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(orca.calls).toEqual([]);
    expect(mc.record).not.toHaveBeenCalled();
    expect(mc.launch).not.toHaveBeenCalled();
  });

  it("上で確かめが流れていても、落ちていれば止まり、上で流れていることとそのコミットを出す", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    mc.state.mockResolvedValue({
      ...FAILED,
      above: { kind: "pending", commit: "1234567890abcdef".repeat(2) },
    });
    const before = await git(root, "rev-parse", "HEAD");
    const { result } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("上のコミット 12345678 は確かめが待ちです");
    expect(result.err).toContain("--fixes-main");
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("上で確かめが流れていても、--fixes-main ならマージする", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    mc.state.mockResolvedValue({
      ...FAILED,
      above: { kind: "running", commit: "1234567890abcdef".repeat(2) },
    });
    const { result } = await integrate(root, wt.path, ["--fixes-main"]);
    expect(result.code).toBe(0);
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it("先頭が「確かめられなかった」なら、止めずにマージし、ログのパスと main-check run の警告を出す", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    mc.state.mockResolvedValue({
      kind: "unchecked",
      commit: "f".repeat(40),
      logPath: "/x/logs/ffff.log",
      failedCommand: "bash .orca-flow/setup.sh",
    });
    const { result, orca } = await integrate(root, wt.path);
    expect(result.code).toBe(0);
    expect(result.err).toContain("/x/logs/ffff.log");
    expect(result.err).toContain("orca-flow main-check run");
    expect(orca.callsOf("terminal", "send")).toEqual([]);
  });

  it.each([
    ["searching", "原因を探しています。orca-flow main-check で様子を見"],
    ["stalled", "orca-flow main-check run"],
    ["unknown", "原因が分かりません"],
  ])(
    "原因が決まっていない落ちた（%s）では止まるが、git revert は出さない",
    async (cause, b) => {
      const { root, wt } = await setup();
      await verifyInTask(wt.path);
      mc.state.mockResolvedValue({
        ...FAILED,
        culprit: null,
        culpritLabel: null,
        cause,
      });
      const before = await git(root, "rev-parse", "HEAD");
      const { result } = await integrate(root, wt.path);
      expect(result.code).toBe(2);
      expect(result.err).not.toContain("git revert");
      expect(result.err).not.toContain("orca-flow verify");
      expect(result.err).toMatch(new RegExp(b.replace(/[-]/g, "\\$&")));
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    },
  );

  it("--fixes-main なら、落ちていてもマージし、確かめを起動する", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    await commitMain(root, { "other.txt": "x\n" });
    mc.state.mockResolvedValue(FAILED);
    const { result } = await integrate(root, wt.path, ["--fixes-main"]);
    expect(result.code).toBe(0);
    expect(await git(root, "log", "--format=%s", "-2")).toContain(
      "統括役: T12 をマージする",
    );
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "pending"])(
    "%s のときは止めずにマージし、様子を1行出す",
    async (kind) => {
      const { root, wt } = await setup();
      await verifyInTask(wt.path);
      mc.state.mockResolvedValue({ kind, commit: "1234567890".repeat(4) });
      const { result } = await integrate(root, wt.path);
      expect(result.code).toBe(0);
      expect(result.out).toContain("main の確かめは");
      expect(result.out).toContain("12345678");
    },
  );

  it("--json のときは様子の行を出さない", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    mc.state.mockResolvedValue({ kind: "running", commit: "1234567890" });
    const { result } = await integrate(root, wt.path, ["--json"]);
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.out)).not.toThrow();
  });

  it("通知を送れなかった警告は、止めずに標準エラーへそのまま出す", async () => {
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    mc.unsent.mockResolvedValue([
      "警告：T13 のタスク長に main が進んだ知らせを送れませんでした：x",
    ]);
    const { result } = await integrate(root, wt.path);
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      "警告：T13 のタスク長に main が進んだ知らせを送れませんでした：x",
    );
  });
});

describe("integrate（before-merge）", () => {
  it("main の確かめを一切呼ばず、知らせをすぐ送り、テストに関係するファイルが動いたら終了コード2", async () => {
    const { root, wt } = await setup({ integrateVerify: "before-merge" });
    const other = await addTaskWorktree(root, "T13", "other");
    await verifyInTask(wt.path);
    const ok = await integrate(
      root,
      wt.path,
      ["--json"],
      [{ handle: "term_t13", worktreePath: other.path }],
    );
    expect(ok.result.code).toBe(0);
    const data = JSON.parse(ok.result.out);
    expect(data.notified).toEqual(["T13"]);
    expect(data.mainCheck).toBeNull();
    expect(ok.orca.callsOf("terminal", "send")).toHaveLength(1);
    expect(mc.state).not.toHaveBeenCalled();
    expect(mc.unsent).not.toHaveBeenCalled();
    expect(mc.record).not.toHaveBeenCalled();
    expect(mc.launch).not.toHaveBeenCalled();
  });

  it("テストに関係するファイルが main で動いたら、今までどおり終了コード2", async () => {
    const { root, wt } = await setup({ integrateVerify: "before-merge" });
    await verifyInTask(wt.path);
    await commitMain(root, { "other.txt": "x\n" });
    const { result } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("main が動きました");
    expect(mc.state).not.toHaveBeenCalled();
  });
});

describe("integrate（after-merge）：本物の main-check.ts と組み合わせる", () => {
  const useActual = async () => {
    const actual = await vi.importActual<
      typeof import("../../src/lib/main-check.ts")
    >("../../src/lib/main-check.ts");
    mc.state.mockImplementation(actual.mainCheckState);
    mc.record.mockImplementation(actual.recordMerge);
    mc.launch.mockImplementation(actual.launchMainCheck);
    mc.unsent.mockImplementation(actual.unsentNoticeWarnings);
    return actual;
  };

  const runWith = async (root: string, wtPath: string) => {
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_t12",
      worktreePath: wtPath,
      title: "claude",
      agentIdentity: "claude",
    });
    const launches: (readonly string[])[] = [];
    const runner: Runner = async (cmd, args, opts) => {
      // 背景の起動役は、本物の子を起こさず呼び出しだけ残す
      if (cmd === process.execPath) {
        launches.push(args);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      return orca.runner(cmd, args, opts);
    };
    const result = await runCli(["integrate", "T12", "--keep-worktree"], {
      cwd: root,
      runner,
    });
    return { result, launches, runner };
  };

  it("main が動いたあとの統合は「待ち」の記録を残し、起動の呼び出しが1回残る", async () => {
    const actual = await useActual();
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    await commitMain(root, { "other.txt": "x\n" });
    const { result, launches, runner } = await runWith(root, wt.path);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.join(" ")).toContain("main-check");
    const config = JSON.parse(
      await readFile(path.join(root, ".orca-flow/config.json"), "utf8"),
    );
    const state = await actual.mainCheckState(runner, root, {
      ...config,
      baseBranch: "main",
    });
    expect(state).toEqual({
      kind: "pending",
      commit: await git(root, "rev-parse", "HEAD~1"),
    });
  });

  it("記録の base が今の main と同じなら「通った」で、起動の呼び出しは1回（run が知らせだけ送る）", async () => {
    const actual = await useActual();
    const { root, wt } = await setup();
    await verifyInTask(wt.path);
    const { result, launches, runner } = await runWith(root, wt.path);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(launches).toHaveLength(1);
    const config = JSON.parse(
      await readFile(path.join(root, ".orca-flow/config.json"), "utf8"),
    );
    const state = await actual.mainCheckState(runner, root, {
      ...config,
      baseBranch: "main",
    });
    expect(state).toEqual({
      kind: "passed",
      commit: await git(root, "rev-parse", "HEAD~1"),
    });
  });
});
