import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

// main の確かめ（背景のプロセス）は差し替え、またぐ依存の門だけを確かめる
vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

const PACKAGE = "@acme/core";
const VERSION = "1.4.0";

/** 依存先の子（本物の git）。landed なら統合のマージの件名の行を足す */
async function makeDependency(landed: boolean) {
  const dep = await makeRepo({ idPrefix: "S" });
  if (landed) {
    await git(
      dep,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "統括役: S5 をマージする",
    );
  }
  return dep;
}

async function setup(options: { landed: boolean; bump: boolean }) {
  const dep = await makeDependency(options.landed);
  const root = await makeRepo(
    { verifySkipPaths: ["src/", "docs/", "package.json"], maxActiveTasks: 5 },
    { "src/shop/shared.ts": "line1\n" },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", {
      allowed: ["src/shop/", "package.json"],
    }),
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const x = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
    ...(options.bump
      ? {
          "package.json": `{\n  "dependencies": { "${PACKAGE}": "^${VERSION}" }\n}\n`,
        }
      : {}),
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  const dir = path.join(root, ".git", "orca-flow", "cross-depends");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "T12.json"),
    JSON.stringify({
      id: "T12",
      at: "2026-11-04T00:00:00.000Z",
      repos: [
        {
          name: "core",
          path: dep,
          package: PACKAGE,
          version: VERSION,
          ids: ["S5"],
        },
      ],
    }),
  );
  return { root, wt, dep };
}

async function integrate(
  t: { root: string; wt: { path: string } },
  args: string[] = [],
  keepWorktree = true,
) {
  const orca = fakeOrca();
  orca.terminals.push({
    handle: "term_T12",
    worktreePath: t.wt.path,
    title: "claude",
    agentIdentity: "claude",
  });
  const result = await runCli(
    ["integrate", "T12", ...(keepWorktree ? ["--keep-worktree"] : []), ...args],
    {
      cwd: t.root,
      runner: orca.runner,
    },
  );
  return { result, orca };
}

const isMerged = async (root: string) =>
  (
    await testRunner(
      "git",
      ["merge-base", "--is-ancestor", "task/T12-shop", "main"],
      { cwd: root },
    )
  ).code === 0;

describe("integrate：またぐ依存の記録があるタスクは止まる", () => {
  it("依存先が入って版上げがあっても終了コード2で止まり、マージせず worktree も残る", async () => {
    const t = await setup({ landed: true, bump: true });
    const { result, orca } = await integrate(t, [], false);
    expect(result.code).toBe(2);
    expect(result.err).toContain("またぐ依存");
    expect(result.err).toContain("マージしていません");
    expect(result.err).toContain("/orca-flow:push T12");
    expect(result.err).toContain("core:S5");
    expect(await isMerged(t.root)).toBe(false);
    expect(orca.callsOf("worktree", "rm")).toHaveLength(0);
    expect(existsSync(t.wt.path)).toBe(true);
    expect(existsSync(path.join(t.root, "docs/tasks/reports/T12.md"))).toBe(
      false,
    );
    expect(
      existsSync(path.join(t.root, ".git", "orca-flow", "main.lock")),
    ).toBe(false);
  });

  it("依存先の確かめは流さない（依存先が入っていなくても版上げがなくても、同じ止まりの文）", async () => {
    const t = await setup({ landed: false, bump: false });
    const { result } = await integrate(t, [], false);
    expect(result.code).toBe(2);
    expect(result.err).toContain("/orca-flow:push T12");
    expect(result.err).not.toContain("版上げ");
    expect(result.err).not.toContain("PR でマージされていません");
    expect(await isMerged(t.root)).toBe(false);
  });

  it("--skip-cross-depends なら「警告：」で始まる1行を出してマージまで進む", async () => {
    const t = await setup({ landed: false, bump: false });
    const { result } = await integrate(t, ["--skip-cross-depends"]);
    expect(result.code).toBe(0);
    const warnings = result.err
      .split("\n")
      .filter((l) => l.startsWith("警告："));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("core:S5");
    expect(await isMerged(t.root)).toBe(true);
  });

  it("記録がなければ今までどおり", async () => {
    const t = await setup({ landed: false, bump: false });
    await rm(
      path.join(t.root, ".git", "orca-flow", "cross-depends", "T12.json"),
    );
    const { result } = await integrate(t);
    expect(result.code).toBe(0);
    expect(await isMerged(t.root)).toBe(true);
  });

  it("記録がなければ --skip-cross-depends をつけても警告を出さない", async () => {
    const t = await setup({ landed: false, bump: false });
    await rm(
      path.join(t.root, ".git", "orca-flow", "cross-depends", "T12.json"),
    );
    const { result } = await integrate(t, ["--skip-cross-depends"]);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("警告：");
  });

  it("記録が壊れていると終了コード1で止まる", async () => {
    const t = await setup({ landed: true, bump: true });
    await writeFile(
      path.join(t.root, ".git", "orca-flow", "cross-depends", "T12.json"),
      "{",
    );
    const { result } = await integrate(t);
    expect(result.code).toBe(1);
    expect(await isMerged(t.root)).toBe(false);
  });
});
