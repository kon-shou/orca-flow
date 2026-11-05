import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeMergeOrder } from "../../src/lib/merge-order.ts";
import { ownChange, readReviewed } from "../../src/lib/rebase-review.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

// 背景のプロセスは差し替える
vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

const DECISIONS = "docs/decisions.md";
const DRAFT =
  "\n## 決定の記録の文案\n\n- 見出し：形を決めた\n- 決めたこと：A\n";
const TAIL = "- 捨てた案と理由：なし\n- 人が選んだこと：おすすめどおり。\n";
const entry = (name: string) => `\n## 2026-01-01 ${name}\n\n${TAIL}`;
const stop = "の先頭と同じではありません";

/** T12 と T14 が、同じ末尾の行を持つ項を足す。T14 は T12 のあとで union の取り込みを受けると、T12 の項が崩れる */
async function setup(
  options: {
    config?: Record<string, unknown>;
    t14Entry?: string;
    initial?: string;
    chain?: boolean;
  } = {},
) {
  const initial = options.initial ?? "# 決定の記録\n";
  const root = await makeRepo(
    {
      maxActiveTasks: 5,
      appendOnlyFiles: [DECISIONS],
      decisionsFile: DECISIONS,
      verify: ["true"],
      ...options.config,
    },
    {
      [DECISIONS]: initial,
      ".gitattributes": `${DECISIONS} merge=union\n`,
    },
  );
  const wts: Record<string, { path: string }> = {};
  for (const [id, file, text] of [
    ["T12", "src/shop/a.ts", `${initial}${entry("A")}`],
    ["T14", "src/shop/b.ts", `${initial}${options.t14Entry ?? entry("B")}`],
  ] as const) {
    const wt = await addTaskWorktree(root, id, "shop", {
      [`docs/tasks/${id}.md`]: specDoc(id, { allowed: ["src/shop/"] }) + DRAFT,
    });
    await writeFiles(wt.path, {
      [file]: `export const x = "${id}";\n`,
      [`docs/tasks/reports/${id}.md`]: "# 報告\n",
      [DECISIONS]: text,
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", `${id}: 作る`);
    wts[id] = wt;
  }
  if (options.chain !== false)
    await writeMergeOrder(testRunner, root, {
      chains: [
        [
          { id: "T12", integrated: false, mergeCommit: null },
          { id: "T14", integrated: false, mergeCommit: null },
        ],
      ],
    });
  return { root, wt12: wts.T12!, wt14: wts.T14! };
}

async function verify(wt: { path: string }) {
  const result = await runCli(["verify"], {
    cwd: wt.path,
    runner: fakeOrca().runner,
  });
  expect(result.code).toBe(0);
}

async function integrate(
  root: string,
  id: string,
  wt: { path: string },
  args: string[] = [],
) {
  const orca = fakeOrca();
  orca.terminals.push({
    handle: `term_${id}`,
    worktreePath: wt.path,
    title: "claude",
    agentIdentity: "claude",
  });
  return runCli(["integrate", id, "--keep-worktree", ...args], {
    cwd: root,
    runner: orca.runner,
  });
}

const isMerged = async (root: string, branch: string) =>
  (
    await testRunner("git", ["merge-base", "--is-ancestor", branch, "main"], {
      cwd: root,
    })
  ).code === 0;

const count = (text: string, needle: string) => text.split(needle).length - 1;

async function bothEntriesIn(root: string) {
  const text = await git(root, "show", `main:${DECISIONS}`);
  expect(text).toContain("## 2026-01-01 A");
  expect(text).toContain("## 2026-01-01 B");
  expect(count(text, "- 人が選んだこと")).toBe(2);
}

describe("integrate：取り込みで欠けた決定の記録の行を戻す", () => {
  it("鎖の取り込みで行が消えても戻してマージし、戻しのコミットは記録のファイルだけを変え、記録の指紋は変わらず記録を使う", async () => {
    const { root, wt12, wt14 } = await setup();
    await verify(wt12);
    await verify(wt14);
    await verify(wt12);
    // 取り込みの前の、タスク自身の変更の指紋（見直しの記録の指紋と同じ求め方）
    const fingerprintBefore = (
      await ownChange(
        testRunner,
        wt14.path,
        "main",
        await git(root, "rev-parse", "task/T14-shop"),
        ["docs/tasks/T14.md", "docs/tasks/reports/T14.md", DECISIONS],
      )
    ).fingerprint;
    expect((await integrate(root, "T12", wt12)).code).toBe(0);
    const result = await integrate(root, "T14", wt14);
    expect(result.err).not.toContain(stop);
    expect(result.code).toBe(0);
    expect(result.out).toContain("のコンソールで通った記録を使います");
    expect(await isMerged(root, "task/T14-shop")).toBe(true);
    await bothEntriesIn(root);
    // 戻しのコミット
    const log = (await git(wt14.path, "log", "--format=%H %s", "-20")).split(
      "\n",
    );
    const restore = log.find((l) => l.includes("取り込みで欠けた"));
    expect(restore!.slice(restore!.indexOf(" ") + 1)).toBe(
      "統括役: 取り込みで欠けた決定の記録の行を戻す",
    );
    const files = await git(
      wt14.path,
      "show",
      "--name-only",
      "--format=",
      restore!.split(" ")[0]!,
    );
    expect(files).toBe(DECISIONS);
    // 見直しの記録が書かれている
    const recordAfter = await readReviewed(testRunner, root, "T14");
    expect(recordAfter).not.toBeNull();
    expect(recordAfter!.fingerprint).toBe(fingerprintBefore);
  });

  it("取り込みで指紋が変わって終了コード2で止まる道でも、タスクの worktree の記録は戻っている", async () => {
    const { root, wt12, wt14 } = await setup();
    // 同じファイルを同じ中身で両方に足す。取り込みで T14 の変更から消えて指紋が変わる
    await writeFiles(wt12.path, { "src/shop/shared.ts": "same\n" });
    await git(wt12.path, "add", "-A");
    await git(wt12.path, "commit", "--quiet", "-m", "T12: 共有");
    await writeFiles(wt14.path, { "src/shop/shared.ts": "same\n" });
    await git(wt14.path, "add", "-A");
    await git(wt14.path, "commit", "--quiet", "-m", "T14: 共有");
    await verify(wt12);
    await verify(wt14);
    expect((await integrate(root, "T12", wt12)).code).toBe(0);
    const result = await integrate(root, "T14", wt14);
    expect(result.code).toBe(2);
    expect(result.err).toContain("タスク自身の変更が変わったので止めました");
    const text = await readFile(path.join(wt14.path, DECISIONS), "utf8");
    expect(count(text, "- 人が選んだこと")).toBe(2);
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
  });

  it("記録を使う道で main が動いて ④ の取り込みがかかるときも、戻してマージする", async () => {
    const { root, wt12, wt14 } = await setup({ chain: false });
    await verify(wt14);
    await verify(wt12);
    expect((await integrate(root, "T12", wt12)).code).toBe(0);
    const result = await integrate(root, "T14", wt14);
    expect(result.err).not.toContain(stop);
    expect(result.code).toBe(0);
    expect(result.out).toContain("のコンソールで通った記録を使います");
    await bothEntriesIn(root);
  });

  it("--verify-here の道でも、戻してから verify を流してマージする", async () => {
    // verify は、項の見出しと「人が選んだこと」の行の数が同じときだけ通る
    const { root, wt12, wt14 } = await setup({
      chain: false,
      config: {
        verify: [
          `test "$(grep -c 人が選んだこと ${DECISIONS})" = "$(grep -c '^## 2026' ${DECISIONS})"`,
        ],
      },
    });
    const first = await integrate(root, "T12", wt12, ["--verify-here"]);
    expect(first.code).toBe(0);
    const result = await integrate(root, "T14", wt14, ["--verify-here"]);
    expect(result.err).not.toContain(stop);
    expect(result.code).toBe(0);
    expect(await isMerged(root, "task/T14-shop")).toBe(true);
    await bothEntriesIn(root);
  });

  it("タスクがすでにある項を書き換えていたら、戻さずに今の止めの文で終了コード1になる", async () => {
    const initial = "# 決定の記録\n\n## 古い\n\n- x\n";
    const { root, wt12, wt14 } = await setup({
      initial,
      chain: false,
      t14Entry: undefined,
    });
    await writeFiles(wt14.path, {
      [DECISIONS]: "# 決定の記録\n\n## 古い\n\n- y\n",
    });
    await git(wt14.path, "commit", "--quiet", "-am", "T14: 書き換え");
    await verify(wt12);
    expect((await integrate(root, "T12", wt12)).code).toBe(0);
    const result = await integrate(root, "T14", wt14, ["--verify-here"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(stop);
    expect(result.err).toContain("警告：決定の記録の行を戻せませんでした（");
    expect(result.err).toContain("マージしていません");
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
  });

  it("足す項の見出しが main にすでにあるときも、戻さずに止まる", async () => {
    const { root, wt12, wt14 } = await setup({
      chain: false,
      t14Entry: `\n## 2026-01-01 A\n\n- 別の\n${TAIL}`,
    });
    await verify(wt12);
    expect((await integrate(root, "T12", wt12)).code).toBe(0);
    const result = await integrate(root, "T14", wt14, ["--verify-here"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(stop);
    expect(result.err).toContain("main にすでにあります");
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
  });

  it("鎖の取り込みで戻せず警告を出したあとも、警告は1行だけで、今の止めの文で終了コード1になる", async () => {
    const { root, wt12, wt14 } = await setup({
      t14Entry: `\n## 2026-01-01 A\n\n- 別の\n${TAIL}`,
    });
    await verify(wt12);
    await verify(wt14);
    await verify(wt12);
    expect((await integrate(root, "T12", wt12)).code).toBe(0);
    const result = await integrate(root, "T14", wt14);
    expect(result.code).toBe(1);
    expect(count(result.err, "警告：決定の記録の行を戻せませんでした")).toBe(1);
    expect(result.err).toContain(stop);
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
  });
});
