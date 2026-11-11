import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireConfig } from "../../src/config.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { finishMergedTask } from "../../src/lib/finish.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";

const refOf = (id: string) => `refs/orca-flow/split/${id}`;

async function refExists(root: string, id: string): Promise<boolean> {
  return (await git(root, "for-each-ref", refOf(id))).trim() !== "";
}

async function setup() {
  const root = await makeRepo({ integrateVerify: "before-merge" });
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

const updateRefFails =
  (inner: Runner): Runner =>
  async (cmd, args, opts) =>
    cmd === "git" && args[0] === "update-ref" && args[1] === "-d"
      ? { code: 1, stdout: "", stderr: "locked", timedOut: false }
      : inner(cmd, args, opts);

describe("統合のあとの、分けた参照の後始末", () => {
  it("統合した ID の参照があれば消える", async () => {
    const { root } = await setup();
    await git(root, "update-ref", refOf("T12"), "HEAD");
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(await refExists(root, "T12")).toBe(false);
  });

  it("参照がなければ何も言わない", async () => {
    const { root } = await setup();
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
  });

  it("親を統合しても、子の参照は残る", async () => {
    const { root } = await setup();
    await git(root, "update-ref", refOf("T12"), "HEAD");
    await git(root, "update-ref", refOf("T12a"), "HEAD");
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(await refExists(root, "T12")).toBe(false);
    expect(await refExists(root, "T12a")).toBe(true);
  });

  it("参照を消せなくても統合は成功し、警告が標準エラーに出る", async () => {
    const { root } = await setup();
    await git(root, "update-ref", refOf("T12"), "HEAD");
    const result = await runCli(["integrate", "T12", "--verify-here"], {
      cwd: root,
      runner: updateRefFails(fakeOrca().runner),
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("警告");
    expect(result.err).toContain(refOf("T12"));
    expect(await refExists(root, "T12")).toBe(true);
  });

  it("PR の道の後始末でも、参照が消える", async () => {
    const { root, wt } = await setup();
    const origin = path.join(await tempDir("orca-flow-origin-"), "origin.git");
    await git(
      path.dirname(origin),
      "init",
      "--quiet",
      "--bare",
      "-b",
      "main",
      origin,
    );
    await git(root, "remote", "add", "origin", origin);
    await git(root, "push", "--quiet", "origin", "main");
    await git(wt.path, "push", "--quiet", "origin", wt.branch);
    const clone = path.join(await tempDir("orca-flow-clone-"), "c");
    await git(path.dirname(clone), "clone", "--quiet", origin, clone);
    await git(clone, "config", "user.name", "GH");
    await git(clone, "config", "user.email", "gh@example.com");
    await git(
      clone,
      "merge",
      "--quiet",
      "--no-ff",
      "-m",
      "Merge PR",
      `origin/${wt.branch}`,
    );
    await git(clone, "push", "--quiet", "origin", "main");
    await git(root, "update-ref", refOf("T12"), "HEAD");

    const err: string[] = [];
    const ctx: CommandContext = {
      argv: [],
      cwd: root,
      json: false,
      runner: fakeOrca().runner,
      env: {},
      stdout: () => {},
      stderr: (t) => err.push(t),
      now: () => new Date("2026-11-03T00:00:00Z"),
    };
    const result = await finishMergedTask(
      ctx,
      await requireConfig(root),
      root,
      { id: "T12", branch: wt.branch, path: wt.path },
    );
    expect(result.kind).toBe("done");
    expect(await refExists(root, "T12")).toBe(false);
    expect(err.join("")).not.toContain(refOf("T12"));
  });

  it("差分がない統合でも、参照が消える", async () => {
    const root = await makeRepo(
      { integrateVerify: "before-merge" },
      { ".gitignore": "docs/tasks/\n" },
    );
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["docs/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    await git(root, "update-ref", refOf("T12"), "HEAD");
    const result = await runCli(["integrate", "T12", "--json"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).merged).toBe(false);
    expect(await refExists(root, "T12")).toBe(false);
  });
});
