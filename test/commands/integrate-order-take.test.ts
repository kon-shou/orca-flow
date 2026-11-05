import { readFile } from "node:fs/promises";
import path from "node:path";
import * as prettier from "prettier";
import { describe, expect, it, vi } from "vitest";
import { readMergeOrder, writeMergeOrder } from "../../src/lib/merge-order.ts";
import { recordMerge } from "../../src/lib/main-check.ts";
import { readReviewed } from "../../src/lib/rebase-review.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

// after-merge の integrate が、前のタスクのマージを自分で取り込む道（main の確かめの背景のプロセスは差し替える）
vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

const DRAFT =
  "\n## 決定の記録の文案\n\n- 見出し：形を決めた\n- 決めたこと：A\n";
const SHARED = "src/shared.txt";
const BASE = "head\nmid1\nmid2\nmid3\ntail\n";
const DECISIONS = "docs/decisions.md";
const entry = (name: string) =>
  `\n## 2026-01-01 ${name}\n\n- 決めたこと：${name} の形\n`;

type Mode = "disjoint" | "conflict" | "same-change";

/** T12 → T14 の鎖。T12 は先頭の行を、T14 は mode に応じて変える。どちらも決定の記録に項を足す */
async function setup(mode: Mode, config: Record<string, unknown> = {}) {
  const root = await makeRepo(
    {
      verifySkipPaths: ["src/", "docs/"],
      maxActiveTasks: 5,
      appendOnlyFiles: [DECISIONS],
      decisionsFile: DECISIONS,
      ...config,
    },
    {
      [SHARED]: BASE,
      [DECISIONS]: "# 決定の記録\n",
      ".gitattributes": `${DECISIONS} merge=union\n`,
    },
  );
  const make = async (id: string, content: string) => {
    const wt = await addTaskWorktree(root, id, "shop", {
      [`docs/tasks/${id}.md`]: specDoc(id, { allowed: ["src/"] }) + DRAFT,
    });
    await writeFiles(wt.path, {
      [SHARED]: content,
      [DECISIONS]: `# 決定の記録\n${entry(id === "T12" ? "一つ目" : "二つ目")}`,
      [`docs/tasks/reports/${id}.md`]: "# 報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", `${id}: 作る`);
    return wt;
  };
  const t12 = "T12head\nmid1\nmid2\nmid3\ntail\n";
  const wt12 = await make("T12", t12);
  const wt14 = await make(
    "T14",
    mode === "conflict"
      ? "T14head\nmid1\nmid2\nmid3\ntail\n"
      : mode === "same-change"
        ? t12
        : "head\nmid1\nmid2\nmid3\nT14tail\n",
  );
  await writeMergeOrder(testRunner, root, {
    chains: [
      [
        { id: "T12", integrated: false, mergeCommit: null },
        { id: "T14", integrated: false, mergeCommit: null },
      ],
    ],
  });
  return { root, wt12, wt14 };
}

async function integrate(
  root: string,
  id: string,
  wt: { path: string },
  args: string[] = [],
  withTerminal = true,
) {
  const orca = fakeOrca();
  if (withTerminal)
    orca.terminals.push({
      handle: `term_${id}`,
      worktreePath: wt.path,
      title: "claude",
      agentIdentity: "claude",
    });
  const result = await runCli(["integrate", id, "--keep-worktree", ...args], {
    cwd: root,
    runner: orca.runner,
  });
  return { result, orca };
}

const sent = (orca: ReturnType<typeof fakeOrca>) =>
  orca.callsOf("terminal", "send").map((c) => c.join(" "));

const isMerged = async (root: string, branch: string) =>
  (
    await testRunner("git", ["merge-base", "--is-ancestor", branch, "main"], {
      cwd: root,
    })
  ).code === 0;

async function afterFirst(mode: Mode, config: Record<string, unknown> = {}) {
  const ctx = await setup(mode, config);
  const first = await integrate(ctx.root, "T12", ctx.wt12);
  expect(first.result.code).toBe(0);
  return ctx;
}

describe("integrate（after-merge）：前のタスクのマージを含まない先頭を取り込む", () => {
  it("取り込みが競合せずタスク自身の変更が同じなら、タスク長に送らずにマージし、見直しの記録を今の先頭で書き直し、統合済みの印がつく", async () => {
    const { root, wt14 } = await afterFirst("disjoint");
    const before = await git(wt14.path, "rev-parse", "HEAD");
    const { result, orca } = await integrate(root, "T14", wt14, ["--json"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(sent(orca)).toEqual([]);
    expect(await isMerged(root, "task/T14-shop")).toBe(true);
    // 取り込んだので、タスクの先頭は取り込みの前と違う。前の先頭は祖先のまま残る（書き換えない）
    const head = await git(wt14.path, "rev-parse", "HEAD");
    expect(head).not.toBe(before);
    await git(wt14.path, "merge-base", "--is-ancestor", before, head);
    const record = await readReviewed(testRunner, root, "T14");
    // 記録の先頭は取り込み直後の先頭（そのあとの空行の直しのコミットより前）
    await git(wt14.path, "merge-base", "--is-ancestor", record!.head, head);
    expect(record?.head).not.toBe(before);
    // 順の印：全部統合済みになった鎖は消える
    expect((await readMergeOrder(testRunner, root)).chains).toEqual([]);
    // main の記録に両方の項が残る
    const text = await git(root, "show", `main:${DECISIONS}`);
    expect(text).toContain("2026-01-01 一つ目");
    expect(text).toContain("2026-01-01 二つ目");
  });

  it("取り込んだ旨の文に「git merge main」が入り、「（取り込み）」の崩れた言い回しがない", async () => {
    const { root, wt14 } = await afterFirst("disjoint");
    const { result } = await integrate(root, "T14", wt14);
    expect(result.code).toBe(0);
    expect(result.out).toContain("を取り込みました（git merge main）。");
    expect(result.out).not.toContain("（取り込み）");
  });

  it("取り込みのあとの merge の段でも、union で欠けた決定の記録の空行が戻る（つなぎ目）", async () => {
    const { root, wt14 } = await afterFirst("disjoint");
    const { result } = await integrate(root, "T14", wt14);
    expect(result.err).not.toContain("先頭と同じではありません");
    expect(result.code).toBe(0);
    const text = await readFile(path.join(root, DECISIONS), "utf8");
    expect(await prettier.check(text, { parser: "markdown" })).toBe(true);
  });

  it("取り込みが競合したら、worktree は 取り込みの前の先頭に戻り、終了コード2で取り込みを送る", async () => {
    const { root, wt14 } = await afterFirst("conflict");
    const before = await git(wt14.path, "rev-parse", "HEAD");
    const { result, orca } = await integrate(root, "T14", wt14);
    expect(result.code).toBe(2);
    expect(result.err).toContain("マージの順");
    expect(result.err).toContain("競合");
    expect(result.err).not.toContain("orca-flow verify");
    expect(await git(wt14.path, "rev-parse", "HEAD")).toBe(before);
    expect(await git(wt14.path, "status", "--porcelain")).toBe("");
    const messages = sent(orca);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("T12 を取り込み、見直して verify をやり直し");
    expect(messages[0]).toContain("競合");
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
    expect(await readReviewed(testRunner, root, "T14")).toBeNull();
  });

  it("競合したときタブがなければ、送れていないと言う", async () => {
    const { root, wt14 } = await afterFirst("conflict");
    const { result } = await integrate(root, "T14", wt14, [], false);
    expect(result.code).toBe(2);
    expect(result.err).toContain("送れていません");
    expect(result.err).not.toContain("と送りました");
  });

  it("タスク自身の変更が変わったら、取り込んだまま終了コード2で止め、前の先頭と rebase-review のコマンドを含む文を送る", async () => {
    const { root, wt14 } = await afterFirst("same-change");
    const before = await git(wt14.path, "rev-parse", "HEAD");
    const { result, orca } = await integrate(root, "T14", wt14);
    expect(result.code).toBe(2);
    expect(result.err).toContain("マージの順");
    expect(result.err).not.toContain("orca-flow verify");
    // 取り込んだまま：先頭は変わり、main を含み、前の先頭は祖先のまま残る
    const head = await git(wt14.path, "rev-parse", "HEAD");
    expect(head).not.toBe(before);
    await git(wt14.path, "merge-base", "--is-ancestor", before, head);
    await git(wt14.path, "merge-base", "--is-ancestor", "main", "HEAD");
    expect(await git(wt14.path, "status", "--porcelain")).toBe("");
    const messages = sent(orca);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      `T12 を取り込みました（取り込みの前の先頭 ${before}）`,
    );
    expect(messages[0]).toContain(`orca-flow rebase-review ${before}`);
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
    expect(await readReviewed(testRunner, root, "T14")).toBeNull();
    // 送ったとおりに見直せる：rebase-review が前の先頭と今を比べる
    const review = await runCli(["rebase-review", before], {
      cwd: wt14.path,
      runner: fakeOrca().runner,
    });
    expect(review.code).toBe(1);
  });

  it("--skip-order なら取り込まずに通る", async () => {
    const { root, wt14 } = await afterFirst("disjoint");
    const before = await git(wt14.path, "rev-parse", "HEAD");
    const { result } = await integrate(root, "T14", wt14, ["--skip-order"]);
    expect(result.code).toBe(0);
    expect(await isMerged(root, "task/T14-shop")).toBe(true);
    expect(await readReviewed(testRunner, root, "T14")).toBeNull();
    expect(before).toBeTruthy();
  });
});

describe("integrate（before-merge）：取り込みはタスク長に頼む（今のまま）", () => {
  it.each(["disjoint", "conflict", "same-change"] as const)(
    "%s：rebase せず、終了コード2で取り込みを頼む",
    async (mode) => {
      const { root, wt14 } = await afterFirst(mode, {
        integrateVerify: "before-merge",
      });
      const before = await git(wt14.path, "rev-parse", "HEAD");
      const { result, orca } = await integrate(root, "T14", wt14);
      expect(result.code).toBe(2);
      expect(result.err).toContain("マージの順");
      expect(result.err).toContain("先頭が、統合済みの前のタスク");
      expect(result.err).not.toContain("orca-flow verify");
      expect(await git(wt14.path, "rev-parse", "HEAD")).toBe(before);
      const messages = sent(orca);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(
        "T12 を取り込み、見直して verify をやり直し",
      );
      expect(messages[0]).not.toContain("取り込みました");
      expect(await isMerged(root, "task/T14-shop")).toBe(false);
    },
  );
});

describe("integrate：見直しのあとに決定の記録の項だけを足したタスク", () => {
  it("見直しの依頼なしでマージする", async () => {
    const { root, wt14 } = await afterFirst("disjoint");
    await git(wt14.path, "rebase", "--quiet", "main");
    const reviewed = await runCli(["rebase-review", "--done"], {
      cwd: wt14.path,
      runner: fakeOrca().runner,
    });
    expect(reviewed.code).toBe(0);
    // 見直しのあとに、決定の記録の項だけを足してコミットする
    const text = await readFile(path.join(wt14.path, DECISIONS), "utf8");
    await writeFiles(wt14.path, { [DECISIONS]: `${text}${entry("追加")}` });
    await git(wt14.path, "commit", "--quiet", "-am", "T14: 決定の記録");
    const { result, orca } = await integrate(root, "T14", wt14);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(sent(orca)).toEqual([]);
    expect(await isMerged(root, "task/T14-shop")).toBe(true);
  });
});

describe("integrate（after-merge）：Orca に届かないときは取り込まない", () => {
  it("取り込みの前に Orca の確かめで止まり、worktree は取り込まれず、マージもしない", async () => {
    const { root, wt14 } = await afterFirst("disjoint");
    const before = await git(wt14.path, "rev-parse", "HEAD");
    const orca = fakeOrca();
    orca.unavailable = true;
    const result = await runCli(["integrate", "T14", "--keep-worktree"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(result.code).not.toBe(0);
    expect(await git(wt14.path, "rev-parse", "HEAD")).toBe(before);
    expect(await git(wt14.path, "status", "--porcelain")).toBe("");
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
    expect(await readReviewed(testRunner, root, "T14")).toBeNull();
  });
});

describe("integrate（after-merge）：取り込みで変わったとき、送れないなら人間に伝える言葉に取り込みを入れる", () => {
  it("警告に「取り込みました（取り込みの前の先頭 〜）」と rebase-review のコマンドが入り、標準エラーにも入る（orca-flow verify は入らない）", async () => {
    const { root, wt14 } = await afterFirst("same-change");
    const before = await git(wt14.path, "rev-parse", "HEAD");
    const { result } = await integrate(root, "T14", wt14, [], false);
    expect(result.code).toBe(2);
    expect(result.err).toContain("送れませんでした");
    expect(result.err).toContain("送れていません");
    expect(result.err).toContain(
      `T12 を取り込みました（取り込みの前の先頭 ${before}）`,
    );
    expect(result.err).toContain(`orca-flow rebase-review ${before}`);
    expect(result.err).not.toContain("orca-flow verify");
    // 警告（tellWhat）の中にも入る：人間がタスク長に伝えるのはこの言葉
    const warning = result.err
      .split("\n")
      .filter((l) => l.startsWith("警告："))
      .join("\n");
    expect(warning).toContain(`T12 を取り込みました`);
    expect(warning).toContain(`orca-flow rebase-review ${before}`);
  });
});

describe("integrate（after-merge）：取り込みのあとテストの記録を使う", () => {
  it("両方のタスクで verify を流し、T12、T14 の順に integrate すると、送らずに記録を使い、main の確かめは待ちになる", async () => {
    const root = await makeRepo(
      { verify: ["true"], maxActiveTasks: 5 },
      { "src/shop/shared.ts": "line1\n" },
    );
    const wts: Record<string, { path: string }> = {};
    for (const [id, file] of [
      ["T12", "src/shop/a.ts"],
      ["T14", "src/shop/b.ts"],
    ] as const) {
      const wt = await addTaskWorktree(root, id, "shop", {
        [`docs/tasks/${id}.md`]: specDoc(id, { allowed: ["src/shop/"] }),
      });
      await writeFiles(wt.path, {
        [file]: `export const x = "${id}";\n`,
        [`docs/tasks/reports/${id}.md`]: "# 報告\n",
      });
      await git(wt.path, "add", "-A");
      await git(wt.path, "commit", "--quiet", "-m", `${id}: 作る`);
      const verify = await runCli(["verify"], {
        cwd: wt.path,
        runner: fakeOrca().runner,
      });
      expect(verify.code).toBe(0);
      wts[id] = wt;
    }
    await writeMergeOrder(testRunner, root, {
      chains: [
        [
          { id: "T12", integrated: false, mergeCommit: null },
          { id: "T14", integrated: false, mergeCommit: null },
        ],
      ],
    });
    const first = await integrate(root, "T12", wts.T12!);
    expect(first.result.code).toBe(0);
    vi.mocked(recordMerge).mockClear();
    const before = await git(wts.T14!.path, "rev-parse", "HEAD");
    const { result, orca } = await integrate(root, "T14", wts.T14!, ["--json"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(sent(orca)).toEqual([]);
    expect(await git(wts.T14!.path, "rev-parse", "HEAD")).not.toBe(before);
    expect(JSON.parse(result.out)).toMatchObject({ verifyRoute: "record" });
    expect(await isMerged(root, "task/T14-shop")).toBe(true);
    expect(recordMerge).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordMerge).mock.calls[0]![3]).toMatchObject({
      id: "T14",
      sameTree: false,
    });
  });
});

describe("push の道：前のタスクのマージを含まなければ今までどおり止める", () => {
  it("after-merge の設定でも「マージの順」で終了コード2になり、取り込まない", async () => {
    const { root, wt14 } = await afterFirst("disjoint");
    const before = await git(wt14.path, "rev-parse", "HEAD");
    const orca = fakeOrca();
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "gh") {
        const out = args[0] === "pr" && args[1] === "list" ? "[]" : "ok";
        return { code: 0, stdout: out, stderr: "", timedOut: false };
      }
      return orca.runner(cmd, args, opts);
    };
    const result = await runCli(["push", "T14"], { cwd: root, runner });
    expect(result.code).toBe(2);
    expect(result.err).toContain("マージの順");
    expect(result.err).not.toContain("orca-flow verify");
    expect(await git(wt14.path, "rev-parse", "HEAD")).toBe(before);
    expect(await readReviewed(testRunner, root, "T14")).toBeNull();
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
  });
});
