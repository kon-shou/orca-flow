import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeBranchPushMarkAt } from "../../src/lib/branch-push.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";

vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn(),
  launchMainCheck: vi.fn(),
  unsentNoticeWarnings: vi.fn(async () => []),
}));

const PUSHED = "0123456789abcdef0123456789abcdef01234567";
const NEWER = "aaaabbbbccccddddeeeeffff00001111222233334444";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";
const BRANCH = "task/S5-core-kit";

async function commonOf(root: string) {
  return (
    await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();
}

/**
 * 共通（core-kit）は本物の git で、印は共通の側に置く。
 * アプリ（shop-app）のタスクは記録に枝があり、ロックファイルに lockHead の先頭がある
 */
async function setup(options: {
  mark: "none" | "unpushed" | "pushed";
  lockHead: string;
  record?: boolean;
  /** ロックファイルに枝の名前を残すか（既定は残す。false は正式な版に戻した状態） */
  branchInLock?: boolean;
  /** 共通の push の記録（PR の道で送った先頭）。branch を省くと BRANCH */
  pushRecord?: { head: string; branch?: string };
}) {
  const dep = await makeRepo({ idPrefix: "S" });
  const depCommon = await commonOf(dep);
  if (options.mark !== "none") {
    await writeBranchPushMarkAt(depCommon, "S5", BRANCH, new Date());
    if (options.mark === "pushed") {
      const file = path.join(depCommon, "orca-flow/branch-push/S5.json");
      const { readFile } = await import("node:fs/promises");
      const mark = JSON.parse(await readFile(file, "utf8"));
      await writeFile(
        file,
        JSON.stringify({
          ...mark,
          pushedHead: PUSHED,
          pushedAt: "2026-11-04T01:00:00.000Z",
        }),
      );
    }
  }
  if (options.pushRecord) {
    const dir = path.join(depCommon, "orca-flow", "push");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "S5.json"),
      JSON.stringify({
        id: "S5",
        branch: options.pushRecord.branch ?? BRANCH,
        base: "main",
        pushedHead: options.pushRecord.head,
        pushedAt: "2026-11-04T02:00:00.000Z",
        pr: null,
      }),
    );
  }
  const root = await makeRepo({ verify: ["test -f src/a.ts"] });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/a.ts": "export {};\n",
    "composer.lock": `{"packages": [{"name": "acme/core-kit", "version": "${options.branchInLock === false ? "1.4.0" : `dev-${BRANCH}`}", "source": {"reference": "${options.lockHead}"}}]}\n`,
  });
  if (options.record !== false) {
    const dir = path.join(await commonOf(root), "orca-flow", "cross-depends");
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
            package: "acme/core-kit",
            branch: BRANCH,
            branchCommand: `composer require acme/core-kit:dev-${BRANCH}`,
            bumpCommand: "composer require acme/core-kit:^1.4",
            ids: ["S5"],
          },
        ],
      }),
    );
  }
  return { root, wt };
}

const verify = (cwd: string) =>
  runCli(["verify"], { cwd, runner: fakeOrca().runner });

describe("verify：古い枝の取り込みの警告", () => {
  it("push した先頭がロックファイルになければ「取り込み直す」と警告し、終了コードは0のまま", async () => {
    const { wt } = await setup({ mark: "pushed", lockHead: OLD });
    const result = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(result.err).toContain("core-kit");
    expect(result.err).toContain("取り込み直す");
    expect(result.err).toContain(PUSHED.slice(0, 12));
  });

  it("先頭の頭12文字がロックファイルにあれば警告しない", async () => {
    const { wt } = await setup({ mark: "pushed", lockHead: PUSHED });
    const result = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("印がない・まだ push していないときは、その旨を警告する（終了コードは0）", async () => {
    const none = await setup({ mark: "none", lockHead: OLD });
    const a = await verify(none.wt.path);
    expect(a.code).toBe(0);
    expect(a.err).toContain("印がありません");
    const unpushed = await setup({ mark: "unpushed", lockHead: OLD });
    const b = await verify(unpushed.wt.path);
    expect(b.code).toBe(0);
    expect(b.err).toContain("まだ push していません");
  });

  it("記録に枝がないタスクでは何も警告しない", async () => {
    const { wt } = await setup({
      mark: "pushed",
      lockHead: OLD,
      record: false,
    });
    const result = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("ロックファイルが正式な版で枝の名前がなければ、何も警告しない（印なし・未 push でも）", async () => {
    for (const mark of ["pushed", "none", "unpushed"] as const) {
      const { wt } = await setup({
        mark,
        lockHead: OLD,
        branchInLock: false,
      });
      const result = await verify(wt.path);
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
    }
  });

  it("push の記録の先頭がロックファイルにあれば、印の先頭が古くても警告しない", async () => {
    const { wt } = await setup({
      mark: "pushed",
      lockHead: NEWER,
      pushRecord: { head: NEWER },
    });
    const result = await verify(wt.path);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("push の記録の先頭がロックファイルになく印の先頭だけにあれば、記録の先頭で「取り込み直す」と警告する", async () => {
    const { wt } = await setup({
      mark: "pushed",
      lockHead: PUSHED,
      pushRecord: { head: NEWER },
    });
    const result = await verify(wt.path);
    expect(result.err).toContain("取り込み直す");
    expect(result.err).toContain(NEWER.slice(0, 12));
    expect(result.err).not.toContain(PUSHED.slice(0, 12));
  });

  it("push の記録の枝が違えば記録を使わず、印の先頭で比べる", async () => {
    const { wt } = await setup({
      mark: "pushed",
      lockHead: PUSHED,
      pushRecord: { head: NEWER, branch: "task/S5-other" },
    });
    const result = await verify(wt.path);
    expect(result.err).toBe("");
  });

  it("push の記録があり印がないときも、記録の先頭で比べ「印がありません」を出さない", async () => {
    const ok = await setup({
      mark: "none",
      lockHead: NEWER,
      pushRecord: { head: NEWER },
    });
    expect((await verify(ok.wt.path)).err).toBe("");
    const stale = await setup({
      mark: "none",
      lockHead: OLD,
      pushRecord: { head: NEWER },
    });
    const result = await verify(stale.wt.path);
    expect(result.err).toContain("取り込み直す");
    expect(result.err).not.toContain("印がありません");
  });

  it("印が未 push でも、記録の先頭で比べる", async () => {
    const { wt } = await setup({
      mark: "unpushed",
      lockHead: OLD,
      pushRecord: { head: NEWER },
    });
    const result = await verify(wt.path);
    expect(result.err).toContain("取り込み直す");
    expect(result.err).not.toContain("まだ push していません");
  });

  it("テストが落ちたときの終了コードも変わらない", async () => {
    const { wt } = await setup({ mark: "pushed", lockHead: OLD });
    await git(wt.path, "rm", "--quiet", "src/a.ts");
    await git(wt.path, "commit", "--quiet", "-m", "消す");
    const result = await verify(wt.path);
    expect(result.code).toBe(1);
  });
});
