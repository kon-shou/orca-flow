import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";

const mainCheck = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: mainCheck.state,
  recordMerge: vi.fn(),
  launchMainCheck: vi.fn(),
  unsentNoticeWarnings: vi.fn(async () => []),
}));

const FAILED = {
  kind: "failed",
  commit: "f".repeat(40),
  culprit: "abcdef0123456789abcdef0123456789abcdef01",
  culpritLabel: "T07",
  failedCommand: "pnpm test",
  cause: "known",
};

beforeEach(() => {
  mainCheck.state.mockReset();
  mainCheck.state.mockResolvedValue({ kind: "none" });
});

const recordPath = (root: string) =>
  path.join(root, ".git/orca-flow/verified/T12.json");

async function setup(config: Record<string, unknown> = {}) {
  const root = await makeRepo({ verify: ["test -f src/a.ts"], ...config });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/a.ts": "export {};\n",
  });
  return { root, wt };
}

const counting = () => {
  const shells: string[] = [];
  const orca = fakeOrca();
  const runner: Runner = (cmd, args, opts) => {
    if (cmd === "sh") shells.push(args[1]!);
    return orca.runner(cmd, args, opts);
  };
  return { runner, shells };
};

describe("verify", () => {
  it("通ったら記録ができ、先頭のコミット・main のコミット・コマンド・時刻が入る", async () => {
    const { root, wt } = await setup();
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const record = JSON.parse(await readFile(recordPath(root), "utf8"));
    expect(record).toMatchObject({
      id: "T12",
      head: await git(wt.path, "rev-parse", "HEAD"),
      base: await git(root, "rev-parse", "main"),
      commands: ["test -f src/a.ts"],
    });
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  it("記録は作業ツリーに現れない", async () => {
    const { root, wt } = await setup();
    await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner });
    expect(existsSync(recordPath(root))).toBe(true);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("落ちたら記録ができず、前の記録があっても消える", async () => {
    const { root, wt } = await setup({ verify: ["echo boom; exit 1"] });
    await mkdir(path.dirname(recordPath(root)), { recursive: true });
    await writeFile(recordPath(root), "{}");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("boom");
    expect(existsSync(recordPath(root))).toBe(false);
  });

  it("未コミットの変更があれば終了コード2で、テストを流さない", async () => {
    const { wt } = await setup();
    await writeFiles(wt.path, { "src/a.ts": "export const x = 1;\n" });
    const { runner, shells } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(2);
    expect(shells).toEqual([]);
  });

  it("main を取り込んでいなければ rebase してからテストを流す", async () => {
    const { root, wt } = await setup({ verify: ["test -f other.txt"] });
    await writeFiles(root, { "other.txt": "x\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "main が進む");
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(await git(wt.path, "log", "--format=%s")).toContain("main が進む");
    const record = JSON.parse(await readFile(recordPath(root), "utf8"));
    expect(record.head).toBe(await git(wt.path, "rev-parse", "HEAD"));
    expect(record.base).toBe(await git(root, "rev-parse", "main"));
  });

  it("rebase が競合すれば終了コード3で、テストを流さず、記録もない", async () => {
    const { root, wt } = await setup();
    await writeFiles(root, { "src/a.ts": "export const main = 1;\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "main で a を作る");
    const { runner, shells } = counting();
    const result = await runCli(["verify"], { cwd: wt.path, runner });
    expect(result.code).toBe(3);
    expect(shells).toEqual([]);
    expect(existsSync(recordPath(root))).toBe(false);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
  });

  it("当たる pathVerify も流し、記録のコマンドに入る", async () => {
    const { root, wt } = await setup({
      verify: [],
      pathVerify: [
        { paths: ["src/"], commands: ["echo src-check"] },
        { paths: ["services/"], commands: ["exit 1"] },
      ],
    });
    const result = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(
      JSON.parse(await readFile(recordPath(root), "utf8")).commands,
    ).toEqual(["echo src-check"]);
  });

  it("タスクのブランチでなければ終了コード1", async () => {
    const { root } = await setup();
    const result = await runCli(["verify"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
  });

  describe("落ちた main の警告", () => {
    it("after-merge で main の確かめが落ちていたら、警告を出すだけで終了コードは変わらない", async () => {
      mainCheck.state.mockResolvedValue(FAILED);
      const { root, wt } = await setup();
      const result = await runCli(["verify"], {
        cwd: wt.path,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        "警告：main の確かめが T07 の時点（abcdef01）で落ちています",
      );
      expect(existsSync(recordPath(root))).toBe(true);
    });

    it("mainCheckState が投げても、警告に変えて verify は進む", async () => {
      mainCheck.state.mockRejectedValue(new Error("壊れた記録"));
      const { wt } = await setup();
      const result = await runCli(["verify"], {
        cwd: wt.path,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(0);
      expect(result.err).toContain("壊れた記録");
    });

    it("落ちた記録の上で確かめが流れていても、警告だけで終了コードは変わらない", async () => {
      mainCheck.state.mockResolvedValue({
        ...FAILED,
        above: { kind: "running", commit: "1".repeat(40) },
      });
      const { wt } = await setup();
      const result = await runCli(["verify"], {
        cwd: wt.path,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(0);
      expect(result.err).toContain("警告：main の確かめが T07 の時点");
    });

    it("落ちたテストの終了コードは警告があっても1のまま", async () => {
      mainCheck.state.mockResolvedValue(FAILED);
      const { wt } = await setup({ verify: ["exit 1"] });
      const result = await runCli(["verify"], {
        cwd: wt.path,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("警告：main の確かめが");
    });

    it("before-merge なら mainCheckState を呼ばない", async () => {
      mainCheck.state.mockResolvedValue(FAILED);
      const { wt } = await setup({ integrateVerify: "before-merge" });
      const result = await runCli(["verify"], {
        cwd: wt.path,
        runner: fakeOrca().runner,
      });
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
      expect(mainCheck.state).not.toHaveBeenCalled();
    });
  });
});
