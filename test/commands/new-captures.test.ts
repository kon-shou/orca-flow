import {
  chmod,
  lstat,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { git, makeRepo, PROGRESS } from "../helpers/repo.ts";
import { makeTmpDir } from "../helpers/tmp/index.ts";

const withProgress = { progress: { file: "docs/progress.md" } };
// 確かめの待ち時間はテストでは短くする（main は process.env を使う）
beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});
const present = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** worktree create が呼ばれた時点で、見たい場所があるかを記録する偽の Orca */
function watching(watch: string[]) {
  const orca = fakeOrca();
  const seen: Record<string, boolean> = {};
  const inner: Runner = orca.runner;
  orca.runner = async (cmd, args, opts) => {
    if (cmd === "orca" && args[0] === "worktree" && args[1] === "create")
      for (const p of watch) seen[p] = await present(p);
    return inner(cmd, args, opts);
  };
  return { orca, seen };
}

async function setup() {
  const root = await makeRepo();
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const captures = path.join(common, "orca-flow/captures");
  return { root, captures };
}

describe("new：同じ ID の古い画面の記録", () => {
  it.each([false, true])(
    "worktree create の時点で消えていて、別の ID は残る（--request-file %s）",
    async (withRequest) => {
      const { root, captures } = await setup();
      const mine = path.join(captures, "T01");
      const other = path.join(captures, "T09");
      await mkdir(mine, { recursive: true });
      await mkdir(other, { recursive: true });
      await writeFile(path.join(mine, "a.gif"), "gif");
      await writeFile(path.join(other, "b.gif"), "gif");
      const args = ["new", "--title", "a", "--slug", "a"];
      if (withRequest) {
        const dir = await makeTmpDir("req-");
        const file = path.join(dir, "r.md");
        await writeFile(file, "依頼\n");
        args.push("--request-file", file);
      }
      const { orca, seen } = watching([mine]);
      const result = await runCli(args, { cwd: root, runner: orca.runner });
      expect(result.code).toBe(0);
      expect(seen[mine]).toBe(false);
      expect(await present(path.join(other, "b.gif"))).toBe(true);
      expect(result.err).toContain(mine);
    },
  );

  it("シンボリックリンクならリンクだけ消え、先は残る", async () => {
    const { root, captures } = await setup();
    const target = await makeTmpDir("cap-target-");
    await writeFile(path.join(target, "keep.gif"), "gif");
    await mkdir(captures, { recursive: true });
    const link = path.join(captures, "T01");
    await symlink(target, link);
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(
      await lstat(link).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await readFile(path.join(target, "keep.gif"), "utf8")).toBe("gif");
    expect(result.err).toContain(link);
  });

  it("記録の場所がなければ、今までどおり成功し、消した行を出さない", async () => {
    const { root, captures } = await setup();
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("画面の記録");
    expect(await present(captures)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "消せないときは終了コード1で、何も呼ばず何も書かない",
    async () => {
      const root = await makeRepo(withProgress, {
        "docs/progress.md": PROGRESS,
      });
      const before = await git(root, "rev-parse", "HEAD");
      const common = await git(
        root,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      );
      // 親フォルダの書き込みを外すと、中のフォルダを消せない
      const parent = path.join(common, "orca-flow/captures");
      const mine = path.join(parent, "T02");
      await mkdir(mine, { recursive: true });
      await writeFile(path.join(mine, "a.gif"), "gif");
      await chmod(parent, 0o555);
      try {
        const dir = await makeTmpDir("req-");
        const file = path.join(dir, "r.md");
        await writeFile(file, "依頼\n");
        const orca = fakeOrca();
        const result = await runCli(
          ["new", "--title", "a", "--slug", "a", "--request-file", file],
          { cwd: root, runner: orca.runner },
        );
        expect(result.code).toBe(1);
        expect(result.err).toContain("古い画面の記録を消せません");
        expect(orca.calls).toEqual([]);
        expect(await present(path.join(common, "orca-flow/requests"))).toBe(
          false,
        );
        expect(await git(root, "rev-parse", "HEAD")).toBe(before);
        expect(
          await readFile(path.join(root, "docs/progress.md"), "utf8"),
        ).toBe(PROGRESS);
      } finally {
        await chmod(parent, 0o755);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "古い画面の記録を消せないとき、メッセージに元の失敗のコードが入る",
    async () => {
      const { root, captures } = await setup();
      const mine = path.join(captures, "T01");
      await mkdir(mine, { recursive: true });
      await writeFile(path.join(mine, "a.gif"), "gif");
      await chmod(captures, 0o555);
      try {
        const result = await runCli(["new", "--title", "a", "--slug", "a"], {
          cwd: root,
          runner: fakeOrca().runner,
        });
        expect(result.code).toBe(1);
        expect(result.err).toContain("古い画面の記録を消せません");
        expect(result.err).toContain("EACCES");
      } finally {
        await chmod(captures, 0o755);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "古い依頼のファイルを消せないとき、メッセージに元の失敗のコードが入る",
    async () => {
      const root = await makeRepo();
      const common = await git(
        root,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      );
      const requests = path.join(common, "orca-flow/requests");
      await mkdir(requests, { recursive: true });
      await writeFile(path.join(requests, "T01.md"), "古い依頼");
      await chmod(requests, 0o555);
      try {
        const result = await runCli(["new", "--title", "a", "--slug", "a"], {
          cwd: root,
          runner: fakeOrca().runner,
        });
        expect(result.code).toBe(1);
        expect(result.err).toContain("古い依頼のファイルを消せません");
        expect(result.err).toContain("EACCES");
      } finally {
        await chmod(requests, 0o755);
      }
    },
  );
});
