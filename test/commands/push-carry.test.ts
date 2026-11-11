import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPush } from "../../src/commands/push.ts";
import type { Runner } from "../../src/lib/exec.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";

const FILE = "docs/decisions.md";
const BASE = "# 決定の記録\n";

describe("push は引き継いだ記録で止まらない", () => {
  it("引き継いだ記録でも「記録が使えない」と止まらず、案を積む", async () => {
    const root = await makeRepo(
      {
        integrateVerify: "before-merge",
        progress: { file: "docs/progress.md" },
        appendOnlyFiles: [FILE],
        verify: ["test -f src/shop/a.ts"],
        pathVerify: [
          { paths: [FILE], commands: ["test -s docs/decisions.md"] },
        ],
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
    const verify = () =>
      runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner });
    expect((await verify()).code).toBe(0);
    await writeFiles(wt.path, {
      [FILE]: `${BASE}\n## 2026-01-01 a\n\n- 決めたこと：a\n`,
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 決定の記録");
    const carried = await verify();
    expect(carried.code).toBe(0);
    expect(carried.out).toContain("引き継ぎ");

    const orca = fakeOrca();
    const runner: Runner = async (cmd, args, opts) => {
      const ok = (stdout = "") => ({
        code: 0,
        stdout,
        stderr: "",
        timedOut: false,
      });
      if (cmd === "gh") {
        if (args[0] === "pr" && args[1] === "list") return ok("[]");
        return ok("ok");
      }
      if (cmd === "git" && args[0] === "push") return ok();
      return orca.runner(cmd, args, opts);
    };
    const body = path.join(await tempDir(), "body.md");
    await writeFiles(path.dirname(body), { "body.md": "## 概要\n本文\n" });
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CommandContext = {
      argv: ["T12", "--body-file", body],
      cwd: root,
      json: false,
      runner,
      env: {},
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      now: () => new Date("2026-11-03T00:00:00Z"),
    };
    const result = await createPush({})(ctx);
    expect(err.join("\n")).not.toContain("記録が使えない");
    expect(result.code).toBe(0);
    expect(out.join("\n")).toContain("先頭：");
  });
});
