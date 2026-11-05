import { mkdir, writeFile } from "node:fs/promises";
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

vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

const PACKAGE = "acme/core-kit";

/** 依存先（共通）は入った状態の本物の git。記録の枝は、パッケージの定義には残さない */
async function setup(options: {
  record: boolean | "plain" | "broken";
  extra?: boolean;
}) {
  const dep = await makeRepo({ idPrefix: "S" });
  await git(
    dep,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "統括役: S5 をマージする",
  );
  const root = await makeRepo({
    verifySkipPaths: [
      "src/",
      "docs/",
      "composer.json",
      "composer.lock",
      "app/",
    ],
    maxActiveTasks: 5,
  });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const x = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
    "composer.json": `{"require": {"${PACKAGE}": "^1.4"}}\n`,
    "composer.lock": `{"packages": [{"name": "${PACKAGE}"}]}\n`,
    "app/composer.json": "{}\n",
    ...(options.extra ? { "src/other.ts": "export {};\n" } : {}),
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  if (options.record === "broken") {
    const dir = path.join(root, ".git", "orca-flow", "cross-depends");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "T12.json"), "{");
  } else if (options.record) {
    const dir = path.join(root, ".git", "orca-flow", "cross-depends");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "T12.json"),
      JSON.stringify({
        id: "T12",
        at: "2026-11-04T00:00:00.000Z",
        repos: [
          {
            name: "core-kit",
            path: dep,
            package: PACKAGE,
            ...(options.record === "plain"
              ? { version: "^1.4" }
              : {
                  branch: "task/S5-core-kit",
                  branchCommand:
                    "composer require acme/core-kit:dev-task/S5-core-kit",
                }),
            bumpCommand: "composer require acme/core-kit:^1.4",
            ids: ["S5"],
          },
        ],
      }),
    );
  }
  return { root, wt };
}

async function integrate(
  t: { root: string; wt: { path: string } },
  extra: string[] = [],
) {
  const orca = fakeOrca();
  orca.terminals.push({
    handle: "term_T12",
    worktreePath: t.wt.path,
    title: "claude",
    agentIdentity: "claude",
  });
  return runCli(["integrate", "T12", "--keep-worktree", ...extra], {
    cwd: t.root,
    runner: orca.runner,
  });
}

describe("integrate：枝で取り込むタスクの範囲", () => {
  it("記録に branch があっても、--skip-cross-depends なら範囲を通ってマージまで進む", async () => {
    const t = await setup({ record: true });
    const result = await integrate(t, ["--skip-cross-depends"]);
    expect(result.err).not.toContain("外のファイル");
    expect(result.err).toMatch(/^警告：/m);
    expect(result.code).toBe(0);
  });

  it("記録に branch があれば、パッケージの定義とロックファイルの差分を範囲の外に数えない（範囲を通ってから、またぐ依存で止まる）", async () => {
    const t = await setup({ record: true });
    const result = await integrate(t);
    expect(result.err).not.toContain("外のファイル");
    expect(result.code).toBe(2);
    expect(result.err).toContain("integrate では入れられません");
  });

  it("記録がなければ、今までどおり範囲の外に数える", async () => {
    const t = await setup({ record: false });
    const result = await integrate(t);
    expect(result.code).toBe(1);
    expect(result.err).toContain("- composer.json");
    expect(result.err).toContain("- composer.lock");
    expect(result.err).toContain("- app/composer.json");
  });

  it("記録があっても、ほかのファイルは範囲の外のまま", async () => {
    const t = await setup({ record: true, extra: true });
    const result = await integrate(t);
    expect(result.code).toBe(1);
    expect(result.err).toContain("- src/other.ts");
    expect(result.err).not.toContain("composer");
  });

  it("version だけの記録（branch なし）は、今までどおり範囲の外に数える", async () => {
    const t = await setup({ record: "plain" });
    const result = await integrate(t);
    expect(result.code).toBe(1);
    expect(result.err).toContain("- composer.json");
  });

  it("記録が壊れていれば、範囲の外の文より先に「壊れています」で止まる", async () => {
    const t = await setup({ record: "broken" });
    const result = await integrate(t);
    expect(result.code).toBe(1);
    expect(result.err).toContain("T12 のまたぐ依存の記録が壊れています");
    expect(result.err).not.toContain("外のファイル");
  });
});
