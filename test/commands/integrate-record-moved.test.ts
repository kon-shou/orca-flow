import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

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

const DRAFT =
  "\n## 決定の記録の文案\n\n- 見出し：形を決めた\n- 決めたこと：A\n";
const DECISIONS = "docs/decisions.md";
const entry = (name: string) =>
  `\n## 2026-01-01 ${name}\n\n- 決めたこと：${name} の形\n`;

async function setup(config: Record<string, unknown> = {}) {
  const root = await makeRepo(
    {
      verify: ["test -f src/shop/a.ts"],
      maxActiveTasks: 3,
      appendOnlyFiles: [DECISIONS],
      decisionsFile: DECISIONS,
      ...config,
    },
    { [DECISIONS]: "# 決定の記録\n" },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }) + DRAFT,
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  const verify = await runCli(["verify"], {
    cwd: wt.path,
    runner: fakeOrca().runner,
  });
  expect(verify.code).toBe(0);
  return { root, wt };
}

async function integrate(root: string, wtPath: string, args: string[] = []) {
  const orca = fakeOrca();
  orca.terminals.push({
    handle: "term_t12",
    worktreePath: wtPath,
    title: "claude",
    agentIdentity: "claude",
  });
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

const addEntry = async (wtPath: string) => {
  await writeFiles(wtPath, { [DECISIONS]: `# 決定の記録\n${entry("一つ目")}` });
  await git(wtPath, "add", "-A");
  await git(wtPath, "commit", "--quiet", "-m", "T12: 決定の記録");
};

describe("integrate：記録のあとにブランチが動いた", () => {
  it("after-merge：決定の記録の項だけを足したなら、verify のやり直しを送らずにマージし、main の確かめは「待ち」になる", async () => {
    const { root, wt } = await setup();
    await addEntry(wt.path);
    const { result, orca, shells } = await integrate(root, wt.path, ["--json"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(shells).toEqual([]);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(JSON.parse(result.out)).toMatchObject({
      verifyRoute: "record",
      mainCheck: "launched",
    });
    expect(mc.record).toHaveBeenCalledTimes(1);
    expect(mc.record.mock.calls[0]![3]).toMatchObject({
      id: "T12",
      sameTree: false,
      commands: [],
    });
    expect(mc.launch).toHaveBeenCalledTimes(1);
  });

  it("after-merge：記録のあとにタスク自身の変更が変わったら、今までどおり verify のやり直しを送る", async () => {
    const { root, wt } = await setup();
    await writeFile(
      path.join(wt.path, "src/shop/a.ts"),
      "export const a = 2;\n",
    );
    await git(wt.path, "commit", "--quiet", "-am", "T12: 直す");
    const { result, orca } = await integrate(root, wt.path, [
      "--skip-decision",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("ブランチが動きました");
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    expect(mc.record).not.toHaveBeenCalled();
  });

  it("before-merge：決定の記録の項だけでも、今までどおり「ブランチが動きました」で止める", async () => {
    const { root, wt } = await setup({ integrateVerify: "before-merge" });
    await addEntry(wt.path);
    const { result, orca } = await integrate(root, wt.path);
    expect(result.code).toBe(2);
    expect(result.err).toContain("ブランチが動きました");
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
  });
});
