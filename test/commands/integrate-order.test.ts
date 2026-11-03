import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readMergeOrder,
  writeMergeOrder,
  type MergeOrder,
} from "../../src/lib/merge-order.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

// main の確かめ（背景のプロセス）は差し替え、integrate の順の守りだけを確かめる
vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

const FILES: Record<string, string> = {
  T12: "src/shop/a.ts",
  T14: "src/shop/b.ts",
  T15: "src/shop/c.ts",
};

async function setup(
  ids = ["T12", "T14"],
  config: Record<string, unknown> = {},
) {
  const root = await makeRepo(
    {
      verifySkipPaths: ["src/", "docs/"],
      maxActiveTasks: 5,
      ...config,
    },
    { "src/shop/shared.ts": "line1\nline2\nline3\n" },
  );
  const wts: Record<string, { path: string; branch: string }> = {};
  for (const id of ids) {
    const wt = await addTaskWorktree(root, id, "shop", {
      [`docs/tasks/${id}.md`]: specDoc(id, { allowed: ["src/shop/"] }),
    });
    await writeFiles(wt.path, {
      [FILES[id]!]: `export const x = "${id}";\n`,
      [`docs/tasks/reports/${id}.md`]: "# 報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", `${id}: 作る`);
    wts[id] = wt;
  }
  return { root, wts };
}

const chain = (...items: [string, boolean?][]): MergeOrder => ({
  chains: [
    items.map(([id, integrated]) => ({
      id,
      integrated: integrated ?? false,
      mergeCommit: null,
    })),
  ],
});

const orderFile = (root: string) =>
  path.join(root, ".git", "orca-flow", "merge-order.json");

async function integrate(
  root: string,
  id: string,
  wts: Record<string, { path: string }>,
  args: string[] = [],
  withTerminal = true,
) {
  const orca = fakeOrca();
  if (withTerminal)
    orca.terminals.push({
      handle: `term_${id}`,
      worktreePath: wts[id]!.path,
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

describe("integrate：順のファイルがない", () => {
  it("今までどおりに統合し、順のファイルを作らない", async () => {
    const { root, wts } = await setup();
    const { result } = await integrate(root, "T14", wts);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(orderFile(root))).toBe(false);
  });
});

describe("integrate：自動で足した順", () => {
  it("overlap が自動で足した印のある順でも「先に T12」の門で止まる", async () => {
    const { root, wts } = await setup();
    await writeMergeOrder(testRunner, root, {
      chains: [
        [
          { id: "T12", integrated: false, mergeCommit: null },
          {
            id: "T14",
            integrated: false,
            mergeCommit: null,
            auto: { at: "2026-11-02T00:00:00.000Z" },
          },
        ],
      ],
    });
    const { result } = await integrate(root, "T14", wts);
    expect(result.code).toBe(2);
    expect(result.err).toContain("先に T12");
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
  });
});

describe("integrate：前のタスクが未統合", () => {
  it("終了コード2で「マージの順」と「先に T12」を出し、マージせず、タスク長には送らない", async () => {
    const { root, wts } = await setup();
    await writeMergeOrder(testRunner, root, chain(["T12"], ["T14"]));
    const { result, orca } = await integrate(root, "T14", wts);
    expect(result.code).toBe(2);
    expect(result.err).toContain("マージの順");
    expect(result.err).toContain("先に T12");
    expect(result.err).toContain("--skip-order");
    expect(result.err).toContain("order --remove T14");
    expect(result.err).not.toContain("orca-flow verify");
    expect(sent(orca)).toEqual([]);
    expect(await isMerged(root, "task/T14-shop")).toBe(false);
  });

  it("--skip-order をつければ通り、統合済みの印がつく", async () => {
    const { root, wts } = await setup();
    await writeMergeOrder(testRunner, root, chain(["T12"], ["T14"]));
    const { result } = await integrate(root, "T14", wts, ["--skip-order"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(await isMerged(root, "task/T14-shop")).toBe(true);
    const order = await readMergeOrder(testRunner, root);
    expect(order.chains[0]!.map((i) => i.integrated)).toEqual([false, true]);
  });

  it("順に入っていないタスクは止まらない", async () => {
    const { root, wts } = await setup(["T12", "T14", "T15"]);
    await writeMergeOrder(testRunner, root, chain(["T12"], ["T14"]));
    const { result } = await integrate(root, "T15", wts);
    expect(result.code).toBe(0);
  });
});

// 前のタスクのマージを含まない先頭の扱いだけが設定で変わる（before-merge は止めてタスク長に頼む。
// after-merge の取り込みの道は integrate-order-take.test.ts）。それ以外は両方の設定で同じ
describe.each(["before-merge", "after-merge"] as const)(
  "integrate：前のタスクの統合のあと（%s）",
  (mode) => {
    async function afterFirst() {
      const ctx = await setup(["T12", "T14"], { integrateVerify: mode });
      await writeMergeOrder(testRunner, ctx.root, chain(["T12"], ["T14"]));
      const first = await integrate(ctx.root, "T12", ctx.wts);
      // before-merge は T14 に「main が進んだ」知らせを送る（T14 のタブはないので、その警告が1行だけ出る）。
      // after-merge は何も出さない
      if (mode === "before-merge") {
        expect(
          first.result.err.match(/^警告：T14 のタスク長に.*$/gm),
        ).toHaveLength(1);
        expect(
          first.result.err.replace(/^警告：T14 のタスク長に.*$/gm, "").trim(),
        ).toBe("");
      } else {
        expect(first.result.err).toBe("");
      }
      expect(first.result.code).toBe(0);
      return ctx;
    }
    const rebase = async (wt: { path: string }) =>
      git(wt.path, "rebase", "--quiet", "main");

    it("T12 が統合され、鎖に印がつき、マージのコミットが入る", async () => {
      const { root } = await afterFirst();
      const order = await readMergeOrder(testRunner, root);
      const first = order.chains[0]![0]!;
      expect(first.integrated).toBe(true);
      expect(first.mergeCommit).toBe(await git(root, "rev-parse", "main"));
    });

    it.runIf(mode === "before-merge")(
      "先頭が前のタスクのマージを含まなければ終了コード2で止め、タスク長に取り込みを頼む",
      async () => {
        const { root, wts } = await afterFirst();
        const { result, orca } = await integrate(root, "T14", wts);
        expect(result.code).toBe(2);
        expect(result.err).toContain("マージの順");
        expect(result.err).not.toContain("orca-flow verify");
        const messages = sent(orca);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(
          "T12 を取り込み、見直して verify をやり直し",
        );
        expect(messages[0]).toContain("integrate-wait に戻して");
        expect(await isMerged(root, "task/T14-shop")).toBe(false);
      },
    );

    it("含んでいても見直しの記録がなければ止め、見直しを頼む", async () => {
      const { root, wts } = await afterFirst();
      await rebase(wts.T14!);
      const { result, orca } = await integrate(root, "T14", wts);
      expect(result.code).toBe(2);
      expect(result.err).toContain("マージの順");
      expect(result.err).toContain("見直しの記録がありません");
      expect(result.err).not.toContain("orca-flow verify");
      expect(sent(orca)).toHaveLength(1);
      expect(sent(orca)[0]).toContain("rebase-review");
      expect(await isMerged(root, "task/T14-shop")).toBe(false);
    });

    it("指紋が違えば止める（見直したあとにタスク自身の変更が変わった）", async () => {
      const { root, wts } = await afterFirst();
      await rebase(wts.T14!);
      const reviewed = await runCli(["rebase-review", "--done"], {
        cwd: wts.T14!.path,
        runner: fakeOrca().runner,
      });
      expect(reviewed.code).toBe(0);
      await writeFiles(wts.T14!.path, {
        "src/shop/b.ts": "export const y = 2;\n",
      });
      await git(wts.T14!.path, "commit", "--quiet", "-am", "T14: 直す");
      const { result, orca } = await integrate(root, "T14", wts);
      expect(result.code).toBe(2);
      expect(result.err).toContain("変わっています");
      expect(result.err).not.toContain("orca-flow verify");
      expect(sent(orca)).toHaveLength(1);
    });

    it("送れないとき（タブがない）は「送れませんでした」の警告にして、止める", async () => {
      const { root, wts } = await afterFirst();
      await rebase(wts.T14!);
      const { result } = await integrate(root, "T14", wts, [], false);
      expect(result.code).toBe(2);
      expect(result.err).toContain("送れませんでした");
      expect(result.err).toContain("マージの順");
      expect(result.err).toContain("送れていません");
      expect(result.err).not.toContain("送りました");
      expect(result.err).not.toContain("頼みました");
    });

    it.runIf(mode === "before-merge")(
      "取り込みの知らせが送れないとき（タブがない）も「送りました」を出さない",
      async () => {
        const { root, wts } = await afterFirst();
        const { result } = await integrate(root, "T14", wts, [], false);
        expect(result.code).toBe(2);
        expect(result.err).toContain("送れませんでした");
        expect(result.err).toContain("送れていません");
        expect(result.err).not.toContain("送りました");
      },
    );

    it.runIf(mode === "before-merge")(
      "送れたときは「送りました」「頼みました」を出す",
      async () => {
        const { root, wts } = await afterFirst();
        const first = await integrate(root, "T14", wts);
        expect(first.result.err).toContain("と送りました");
        await rebase(wts.T14!);
        const second = await integrate(root, "T14", wts);
        expect(second.result.err).toContain("頼みました");
      },
    );

    it("見直しが済んでいれば通り、全部統合済みになった鎖は消える", async () => {
      const { root, wts } = await afterFirst();
      await rebase(wts.T14!);
      await runCli(["rebase-review", "--done"], {
        cwd: wts.T14!.path,
        runner: fakeOrca().runner,
      });
      const { result, orca } = await integrate(root, "T14", wts);
      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      expect(sent(orca)).toEqual([]);
      expect(await isMerged(root, "task/T14-shop")).toBe(true);
      expect(existsSync(orderFile(root))).toBe(false);
    });

    it("--skip-order は3つとも飛ばす", async () => {
      const { root, wts } = await afterFirst();
      const { result } = await integrate(root, "T14", wts, ["--skip-order"]);
      expect(result.code).toBe(0);
      expect(await isMerged(root, "task/T14-shop")).toBe(true);
    });
  },
);

describe("integrate：差分なしで片づけたとき", () => {
  it("統合済みの印をつける（マージのコミットは null）", async () => {
    const root = await makeRepo(
      { integrateVerify: "before-merge" },
      { ".gitignore": "docs/tasks/\n" },
    );
    const wts: Record<string, { path: string }> = {};
    wts.T12 = await addTaskWorktree(root, "T12", "shop");
    wts.T14 = await addTaskWorktree(root, "T14", "shop");
    await writeFiles(wts.T12!.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["docs/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    await writeMergeOrder(testRunner, root, chain(["T12"], ["T14"]));
    const { result } = await runCliIntegrate(root, "T12");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const order = await readMergeOrder(testRunner, root);
    expect(order.chains[0]![0]).toMatchObject({
      id: "T12",
      integrated: true,
      mergeCommit: null,
    });
  });
});

async function runCliIntegrate(root: string, id: string) {
  const result = await runCli(["integrate", id], {
    cwd: root,
    runner: fakeOrca().runner,
  });
  return { result };
}
