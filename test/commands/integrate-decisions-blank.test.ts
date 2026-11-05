import { existsSync } from "node:fs";
import path from "node:path";
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { requireConfig } from "../../src/config.ts";
import { finishMergedTask, syncBaseFromOrigin } from "../../src/lib/finish.ts";
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
const entry = (name: string) =>
  `\n## 2026-01-01 ${name}\n\n- 決めたこと：${name} の形\n`;
const BASE = "# 決定の記録\n";
const DRAFT =
  "\n## 決定の記録の文案\n\n- 見出し：形を決めた\n- 決めたこと：A\n";

const passesPrettier = (text: string) =>
  prettier.check(text, { parser: "markdown" });

// くっついた見出し（空でない行の次の行が見出し）があると落ちる verify
const NO_GLUED_HEADING = `node -e 'const t=require("fs").readFileSync("${FILE}","utf8");process.exit(/[^\\n]\\n#/.test(t)?1:0)'`;

async function setup(
  options: { taskAdds: boolean; mainAdds: boolean },
  extraConfig: Record<string, unknown> = {},
) {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      progress: { file: "docs/progress.md" },
      appendOnlyFiles: [FILE],
      decisionsFile: FILE,
      verify: ["test -f src/shop/a.ts", NO_GLUED_HEADING],
      ...extraConfig,
    },
    {
      "docs/progress.md": PROGRESS.replace(
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 作業中 | task/T12-shop | |\n",
      ),
      [FILE]: BASE,
      ".gitattributes": `${FILE} merge=union\n`,
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }) + DRAFT,
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
    ...(options.taskAdds ? { [FILE]: BASE + entry("タスク") } : {}),
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  if (options.mainAdds) {
    await writeFiles(root, { [FILE]: BASE + entry("main") });
    await git(root, "add", FILE);
    await git(root, "commit", "--quiet", "-m", "main の項");
  }
  return { root, wt };
}

const integrate = (root: string, ...extra: string[]) =>
  runCli(["integrate", "T12", ...extra], {
    cwd: root,
    runner: fakeOrca().runner,
  });

// 取り込みのあとの組み直し（空行も戻す）のコミットの件名
const SUBJECT = "統括役: 取り込みで欠けた決定の記録の行を戻す";

describe("integrate は union で欠けた決定の記録の空行を戻す", () => {
  it.each([[["--verify-here"]], [["--verify-here", "--skip-decision"]]])(
    "両方が末尾に項を足すと、main の記録が prettier に通り両方の項が残る（%j）",
    async (flags) => {
      const { root } = await setup({ taskAdds: true, mainAdds: true });
      const result = await integrate(root, ...flags);
      expect(result.err).not.toContain("先頭と同じではありません");
      expect(result.code).toBe(0);
      const text = await readFile(path.join(root, FILE), "utf8");
      expect(await passesPrettier(text)).toBe(true);
      expect(text).toContain("2026-01-01 main");
      expect(text).toContain("2026-01-01 タスク");
    },
  );

  it("直しのコミットは件名のとおりで、変えたのは decisionsFile だけ", async () => {
    const { root, wt } = await setup({ taskAdds: true, mainAdds: true });
    const run = await integrate(root, "--verify-here");
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const log = (
      await git(root, "log", "--format=%H %s", "--no-merges", "main")
    ).split("\n");
    const fix = log.filter((l) =>
      l.endsWith(`: 取り込みで欠けた決定の記録の行を戻す`),
    );
    expect(fix).toHaveLength(1);
    expect(fix[0]).toContain(SUBJECT);
    const sha = fix[0]!.split(" ")[0]!;
    expect(await git(root, "show", "--format=", "--name-only", sha)).toBe(FILE);
    // 直しはタスクの worktree で入る：マージのコミットのタスク側（2つ目の親）の祖先で、main 側（1つ目の親）にはない
    const merge = await git(
      root,
      "log",
      "--merges",
      "--format=%H",
      "-1",
      "main",
    );
    await git(root, "merge-base", "--is-ancestor", sha, `${merge}^2`);
    await expect(
      git(root, "merge-base", "--is-ancestor", sha, `${merge}^1`),
    ).rejects.toThrow();
    expect(await git(root, "branch", "--contains", sha)).toContain(wt.branch);
  });

  it("記録の道（--verify-here なし）でも、記録のあとに main が足した項との union で空行を戻す", async () => {
    const { root, wt } = await setup(
      { taskAdds: true, mainAdds: false },
      { verifySkipPaths: [FILE] },
    );
    const verify = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(verify.code).toBe(0);
    await writeFiles(root, { [FILE]: BASE + entry("main") });
    await git(root, "add", FILE);
    await git(root, "commit", "--quiet", "-m", "main の項");
    const result = await integrate(root, "--json");
    expect(result.err).not.toContain("先頭と同じではありません");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).verifyRoute).toBe("record");
    const text = await readFile(path.join(root, FILE), "utf8");
    expect(await passesPrettier(text)).toBe(true);
    expect(text).toContain("2026-01-01 main");
    expect(text).toContain("2026-01-01 タスク");
    const log = (await git(root, "log", "--format=%s", "main")).split("\n");
    expect(log.filter((l) => l === SUBJECT)).toHaveLength(1);
  });

  it("片方だけが足したときは、直しのコミットができない", async () => {
    for (const adds of [
      { taskAdds: true, mainAdds: false },
      { taskAdds: false, mainAdds: true },
    ]) {
      const { root } = await setup(adds);
      const result = await integrate(root, "--verify-here", "--skip-decision");
      expect(result.code).toBe(0);
      expect(await git(root, "log", "--format=%s", "main")).not.toContain(
        "マージで欠けた決定の記録の空行を戻す",
      );
    }
  });
});

// 最後の行が同じ項（union が最後の行を1つにまとめる）
const sameEnd = (name: string) =>
  `\n## 2026-01-01 ${name}\n\n- 決めたこと：${name}\n- 理由：同じ\n`;

describe("push の道の取り込みがマージになったとき", () => {
  async function mergeSetup(make: (name: string) => string = entry) {
    const { root, wt } = await setup({ taskAdds: false, mainAdds: false });
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
    const clone = path.join(await tempDir("orca-flow-clone-"), "c");
    await git(path.dirname(clone), "clone", "--quiet", origin, clone);
    await git(clone, "config", "user.name", "GH");
    await git(clone, "config", "user.email", "gh@example.com");
    await writeFiles(clone, { [FILE]: BASE + make("origin") });
    await git(clone, "commit", "--quiet", "-am", "origin の項");
    await git(clone, "push", "--quiet", "origin", "main");
    await writeFiles(root, { [FILE]: BASE + make("手元") });
    await git(root, "commit", "--quiet", "-am", "手元の項");

    return { root, wt };
  }

  const ctxOf = (
    root: string,
    stderr: (line: string) => void = () => {},
  ): CommandContext => ({
    argv: [],
    cwd: root,
    json: false,
    runner: fakeOrca().runner,
    env: {},
    stdout: () => {},
    stderr,
    now: () => new Date("2026-11-03T00:00:00Z"),
  });

  it("マージのあとの記録が prettier に通る", async () => {
    const { root, wt } = await mergeSetup();
    const result = await finishMergedTask(
      ctxOf(root),
      await requireConfig(root),
      root,
      { id: "T12", branch: wt.branch, path: wt.path },
    );
    expect(result.kind === "done" && result.sync.how).toBe("merge");
    const text = await readFile(path.join(root, FILE), "utf8");
    expect(await passesPrettier(text)).toBe(true);
    expect(text).toContain("2026-01-01 origin");
    expect(text).toContain("2026-01-01 手元");
    expect(await git(root, "log", "--format=%s", "main")).toContain(
      "マージで欠けた決定の記録の空行を戻す",
    );
  });

  it("空行の戻しのコミットが失敗しても、止まらずに警告して merge で返し、作業ツリーはきれいなまま", async () => {
    const { root } = await mergeSetup();
    const hook = path.join(root, ".git/hooks/pre-commit");
    // 直しのコミットだけを pre-commit で落とす（マージの途中で呼ばれても通すよう、MERGE_HEAD があるときは通す）
    await writeFile(
      hook,
      '#!/bin/sh\nif [ -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then exit 0; fi\nexit 1\n',
    );
    await chmod(hook, 0o755);
    const warnings: string[] = [];
    const result = await syncBaseFromOrigin(
      ctxOf(root, (line) => warnings.push(line)),
      await requireConfig(root),
      root,
    );
    expect(result.kind === "synced" && result.how).toBe("merge");
    expect(warnings.join("\n")).toContain(
      "決定の記録の空行の戻しをコミットできませんでした（元に戻しました）",
    );
    expect(warnings.join("\n")).toContain("orca-flow main-check run");
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  describe("手元と origin の項の最後の行が同じとき", () => {
    it("取り込みは戻して止まった扱いで返り、手元の main は取り込む前のまま、作業ツリーはきれい", async () => {
      const { root } = await mergeSetup(sameEnd);
      const before = await git(root, "rev-parse", "HEAD");
      const textBefore = await readFile(path.join(root, FILE), "utf8");
      const result = await syncBaseFromOrigin(
        ctxOf(root),
        await requireConfig(root),
        root,
      );
      expect(result.kind).toBe("stopped");
      if (result.kind !== "stopped") return;
      expect(result.reason).toBe("lost");
      expect(result.detail).toContain(
        `origin の main を取り込むと、${FILE} の手元の行が取り込んだあとの先頭に残りません`,
      );
      expect(result.detail).toContain(
        "手元の行のあとに origin の足した項が続く形",
      );
      expect(result.detail).toContain("見出しの前に空行");
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
      expect(await git(root, "status", "--porcelain")).toBe("");
      expect(await readFile(path.join(root, FILE), "utf8")).toBe(textBefore);
    });

    it("fetch のあいだにされた、マージで触られない追跡中のファイルの未コミットの編集は消えない", async () => {
      const { root } = await mergeSetup(sameEnd);
      const edited = path.join(root, "docs/progress.md");
      const orca = fakeOrca();
      const ctx = ctxOf(root);
      ctx.runner = async (cmd, args, opts) => {
        const r = await orca.runner(cmd, args, opts);
        if (cmd === "git" && args[0] === "fetch")
          await appendFile(edited, "\n手元の編集\n");
        return r;
      };
      const before = await git(root, "rev-parse", "HEAD");
      const result = await syncBaseFromOrigin(
        ctx,
        await requireConfig(root),
        root,
      );
      expect(result.kind === "stopped" && result.reason).toBe("lost");
      expect(await git(root, "rev-parse", "HEAD")).toBe(before);
      expect(await readFile(edited, "utf8")).toContain("手元の編集");
    });

    it("戻す reset が失敗しても投げず、止まった扱いで返り、残ったマージと戻し方を文に書く", async () => {
      const { root } = await mergeSetup(sameEnd);
      const before = await git(root, "rev-parse", "HEAD");
      const orca = fakeOrca();
      const ctx = ctxOf(root);
      ctx.runner = (cmd, args, opts) =>
        cmd === "git" && args[0] === "reset"
          ? Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "reset 失敗",
              timedOut: false,
            })
          : orca.runner(cmd, args, opts);
      const result = await syncBaseFromOrigin(
        ctx,
        await requireConfig(root),
        root,
      );
      expect(result.kind).toBe("stopped");
      if (result.kind !== "stopped") return;
      expect(result.reason).toBe("lost");
      expect(result.detail).toContain(
        `origin の main を取り込むと、${FILE} の手元の行が取り込んだあとの先頭に残りません`,
      );
      expect(result.detail).toContain(
        "行の消えたマージが手元の main に残っています",
      );
      expect(result.detail).toContain(`git reset --keep ${before}`);
    });

    it("finishMergedTask は止まった扱いで返り、worktree を消さず統合済みにしない", async () => {
      const { root, wt } = await mergeSetup(sameEnd);
      const result = await finishMergedTask(
        ctxOf(root),
        await requireConfig(root),
        root,
        { id: "T12", branch: wt.branch, path: wt.path },
      );
      expect(result.kind).toBe("stopped");
      expect(result.kind === "stopped" && result.reason).toBe("lost");
      expect(existsSync(wt.path)).toBe(true);
      expect(
        await readFile(path.join(root, "docs/progress.md"), "utf8"),
      ).not.toMatch(/T12 .*統合済み/);
    });
  });
});
