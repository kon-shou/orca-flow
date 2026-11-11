import { readFile } from "node:fs/promises";
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

// マージのあとの main の確かめは差し替え、記録を使う道だけを確かめる
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

const FILE = "docs/decisions.md";
const BASE = "# 決定の記録\n";
const entry = `\n## 2026-01-01 a\n\n- 決めたこと：a\n`;

async function setup(mode: "before-merge" | "after-merge") {
  const root = await makeRepo(
    {
      integrateVerify: mode,
      progress: { file: "docs/progress.md" },
      appendOnlyFiles: [FILE],
      verify: ["test -f src/shop/a.ts"],
      pathVerify: [{ paths: [FILE], commands: ["test -s docs/decisions.md"] }],
      maxActiveTasks: 3,
    },
    {
      "docs/progress.md": PROGRESS.replace(
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 作業中 | task/T12-shop | |\n",
      ),
      [FILE]: BASE,
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/", FILE] }),
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  const first = await runCli(["verify"], {
    cwd: wt.path,
    runner: fakeOrca().runner,
  });
  expect(first.code).toBe(0);
  const fullAt = JSON.parse(
    await readFile(path.join(root, ".git/orca-flow/verified/T12.json"), "utf8"),
  ).at as string;
  await writeFiles(wt.path, { [FILE]: BASE + entry });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 決定の記録");
  const carried = await runCli(["verify"], {
    cwd: wt.path,
    runner: fakeOrca().runner,
  });
  expect(carried.code).toBe(0);
  expect(carried.out).toContain("引き継ぎ");
  const carriedAt = JSON.parse(
    await readFile(path.join(root, ".git/orca-flow/verified/T12.json"), "utf8"),
  ).at as string;
  expect(carriedAt).not.toBe(fullAt);
  return { root, wt, fullAt, carriedAt };
}

const integrate = async (
  root: string,
  wtPath: string,
  extra: string[] = [],
) => {
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
    ["integrate", "T12", "--keep-worktree", ...extra],
    {
      cwd: root,
      runner,
    },
  );
  return { result, shells };
};

describe("integrate は引き継いだ記録を使う", () => {
  for (const mode of ["before-merge", "after-merge"] as const) {
    it(`${mode}：引き継いだ記録で通り、全部を流した時刻と引き継いだファイルを出す`, async () => {
      const { root, wt, fullAt, carriedAt } = await setup(mode);
      const { result, shells } = await integrate(root, wt.path);
      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      expect(shells).toEqual([]);
      expect(result.out).toContain(
        `${carriedAt} に T12 のコンソールで通った記録を使います`,
      );
      expect(result.out).toContain(
        `引き継いだ記録：${fullAt} に全部を流し、追記だけのファイルの変更を引き継ぎました：${FILE}`,
      );
    });
  }

  it("after-merge：引き継いだ記録では main の確かめを同じ木で済ませず、背景で始める", async () => {
    const { root, wt } = await setup("after-merge");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_t12",
      worktreePath: wt.path,
      title: "claude",
      agentIdentity: "claude",
    });
    const result = await runCli(
      ["integrate", "T12", "--keep-worktree", "--json"],
      { cwd: root, runner: orca.runner },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).mainCheck).toBe("launched");
    expect(mc.launch).toHaveBeenCalled();
  });
});
