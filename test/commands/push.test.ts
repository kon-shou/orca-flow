import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  finishMergedTask,
  readPushRecord,
  tryMainLock,
  writePushRecord,
} from "../../src/lib/finish.ts";
import { acquireLock, parseLockKind } from "../../src/lib/lock.ts";
import type { Runner } from "../../src/lib/exec.ts";
import type { CommandContext } from "../../src/types.ts";
import { createPush } from "../../src/commands/push.ts";
import { createSend } from "../../src/commands/send.ts";
import { computeFingerprint, readItems } from "../../src/lib/outbox.ts";
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
import { testRunner } from "../helpers/runner.ts";
import { requireConfig } from "../../src/config.ts";
import { mainWorktreePath } from "../../src/lib/git.ts";
import { watchAutomationName } from "../../src/lib/watch-automation.ts";

const progressWith = (row: string) =>
  PROGRESS.replace(
    "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
    `| T01 | 雛形   | —    | 統合済み | main         |      |\n${row}\n`,
  );

interface Gh {
  /** gh pr list が返す PR */
  prs: Record<string, unknown>[];
  created: string[][];
  ready: string[][];
  /** gh の呼び出しを全部（引数だけ） */
  calls: string[][];
  /** gh pr create が出力する PR の番号（一覧の番号と変えて区別する） */
  createdNumber: number;
  /** 作った PR を、そのあとの gh pr list にも出す */
  listCreated: boolean;
  /** 一覧に出る番号（既定は作成の番号と同じ。変えると、記録の番号と一覧の番号を区別できる） */
  listedNumber: number | null;
  missing: boolean;
  /** gh pr create を失敗させるときの標準エラー */
  createFails: string | null;
  /** gh pr list を失敗させるときの標準エラー */
  listFails: string | null;
}

/** orca は偽物、gh と git push は記録するだけ、ほかの git は本物 */
function harness(options: { realPush?: boolean } = {}) {
  const orca = fakeOrca();
  const gh: Gh = {
    prs: [],
    created: [],
    ready: [],
    calls: [],
    createdNumber: 7,
    listCreated: true,
    listedNumber: null,
    missing: false,
    createFails: null,
    listFails: null,
  };
  const pushes: string[][] = [];
  const runner: Runner = async (cmd, args, opts) => {
    const ok = (stdout = "") => ({
      code: 0,
      stdout,
      stderr: "",
      timedOut: false,
    });
    if (cmd === "gh") {
      gh.calls.push([...args]);
      if (gh.missing)
        return { code: 127, stdout: "", stderr: "ENOENT", timedOut: false };
      if (args[0] === "--version" || args[0] === "auth") return ok("ok");
      if (args[0] === "pr" && args[1] === "list") {
        if (gh.listFails !== null)
          return { code: 1, stdout: "", stderr: gh.listFails, timedOut: false };
        return ok(JSON.stringify(gh.prs));
      }
      if (args[0] === "pr" && args[1] === "create") {
        if (gh.createFails !== null)
          return {
            code: 1,
            stdout: "",
            stderr: gh.createFails,
            timedOut: false,
          };
        gh.created.push([...args]);
        if (gh.listCreated) {
          const headIndex = args.indexOf("--head");
          gh.prs.push({
            number: gh.listedNumber ?? gh.createdNumber,
            url: `https://github.com/o/r/pull/${gh.listedNumber ?? gh.createdNumber}`,
            isDraft: true,
            state: "OPEN",
            headRefOid: pushes.at(-1)?.at(-1)?.split(":")[0] ?? "",
            headRefName: args[headIndex + 1],
            statusCheckRollup: [],
          });
        }
        return ok(`https://github.com/o/r/pull/${gh.createdNumber}\n`);
      }
      if (args[0] === "pr" && args[1] === "ready") gh.ready.push([...args]);
      return ok();
    }
    if (cmd === "git" && args[0] === "push") {
      pushes.push([...args]);
      if (options.realPush) return orca.runner(cmd, args, opts);
      return ok();
    }
    return orca.runner(cmd, args, opts);
  };
  return { orca, gh, pushes, runner, deps: {} };
}

async function setup(
  extra: Record<string, string> = {},
  config: Record<string, unknown> = {},
  rootFiles: Record<string, string> = {},
) {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      progress: { file: "docs/progress.md" },
      verify: ["test -f src/shop/a.ts"],
      ...config,
    },
    {
      "docs/progress.md": progressWith(
        "| T12 | 買い物 | — | 作業中 | task/T12-shop | |",
      ),
      ...rootFiles,
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }).replace(
      "# タスク T12：テスト",
      "# タスク T12：買い物かご",
    ),
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
    ...extra,
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  const verify = await runCli(["verify"], {
    cwd: wt.path,
    runner: fakeOrca().runner,
  });
  expect(verify.code).toBe(0);
  const body = path.join(await tempDir(), "body.md");
  await writeFiles(path.dirname(body), { "body.md": "## 概要\n本文\n" });
  return { root, wt, body };
}

/** 前に push して PR を出した記録（send が書く欄）を、テストが直接書く */
async function recordPushed(
  h: ReturnType<typeof harness>,
  root: string,
  pushedHead: string,
  pr: { number: number; url: string } | null = {
    number: 7,
    url: "https://github.com/o/r/pull/7",
  },
) {
  void h;
  await writePushRecord(testRunner, root, "T12", {
    id: "T12",
    branch: (await git(root, "branch", "--list", "task/T12-*"))
      .replace("+", "")
      .trim(),
    base: "main",
    pushedHead,
    pushedAt: "2026-11-03T00:00:00Z",
    pr,
  });
}

/** 出た束の指紋と先頭で send を打つ（偽物の Runner。待ちは偽物の時計） */
async function send(
  h: ReturnType<typeof harness>,
  root: string,
  expect_: string,
  head: string,
) {
  const out: string[] = [];
  const err: string[] = [];
  const run = createSend({
    clock: { now: () => 1_700_000_000_000, sleep: async () => {} },
  });
  const ctx: CommandContext = {
    argv: ["T12", "--expect", expect_, "--head", head],
    cwd: root,
    json: false,
    runner: h.runner,
    env: {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => new Date("2026-11-03T00:00:00Z"),
  };
  try {
    const result = await run(ctx);
    return { code: result.code, out: out.join("\n"), err: err.join("\n") };
  } catch (error) {
    const e = error as { code?: number; message: string };
    return {
      code: e.code ?? 1,
      out: out.join("\n"),
      err: [...err, e.message].join("\n"),
    };
  }
}

async function push(
  h: ReturnType<typeof harness>,
  root: string,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const run = createPush(h.deps);
  const ctx: CommandContext = {
    argv: ["T12", ...extra],
    cwd: root,
    json: false,
    runner: h.runner,
    env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => new Date("2026-11-03T00:00:00Z"),
  };
  try {
    const result = await run(ctx);
    return {
      code: result.code,
      out: out.join("\n"),
      err: err.join("\n"),
      result,
    };
  } catch (error) {
    const e = error as { code?: number; message: string };
    return {
      code: e.code ?? 1,
      out: out.join("\n"),
      err: [...err, e.message].join("\n"),
      result: null,
    };
  }
}

const openPr = (head: string) => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  isDraft: true,
  state: "OPEN",
  headRefOid: head,
  statusCheckRollup: [],
});

const nothingPushed = (h: ReturnType<typeof harness>) => {
  expect(h.pushes).toEqual([]);
  expect(h.gh.created).toEqual([]);
};

/** 確かめに落ちたとき：何も送らず、案も積まず、送る前の確認待ちのカードも出さない */
const nothingStacked = async (h: ReturnType<typeof harness>, root: string) => {
  nothingPushed(h);
  expect(await readItems(path.join(root, ".git"), "T12")).toEqual([]);
  for (const set of h.orca.callsOf("worktree", "set"))
    expect(set.join(" ")).not.toContain("送る前の確認待ち");
};

/** push のあとに gh が呼ぶのは読むものだけ（--version・auth・pr list・pr view） */
const ghOnlyReads = (h: ReturnType<typeof harness>) => {
  expect(h.gh.calls.length).toBeGreaterThan(0);
  for (const args of h.gh.calls) {
    const readOnly =
      args[0] === "--version" ||
      args[0] === "auth" ||
      (args[0] === "pr" && (args[1] === "list" || args[1] === "view"));
    expect(readOnly, `gh ${args.join(" ")}`).toBe(true);
  }
};

describe("push の確かめ", () => {
  it("範囲外のファイルがあると終了コード1で止まり、push も PR も出さない", async () => {
    const { root, wt, body } = await setup({ "other/x.ts": "x\n" });
    void wt;
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("書き込んでよい場所");
    await nothingStacked(h, root);
  });

  it("報告がないと終了コード1で止まる", async () => {
    const { root, wt, body } = await setup();
    await git(wt.path, "rm", "--quiet", "docs/tasks/reports/T12.md");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 報告を消す");
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("報告");
    await nothingStacked(h, root);
  });

  it("verify の記録がないと終了コード2で止まり、タスク長に知らせる", async () => {
    const { root, wt, body } = await setup();
    await writeFiles(wt.path, { "src/shop/b.ts": "b\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 足す");
    const h = harness();
    h.orca.terminals.push({
      handle: "term_t12",
      worktreePath: wt.path,
      title: "claude",
      agentIdentity: "claude",
    });
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(2);
    expect(h.orca.callsOf("terminal", "send")).toHaveLength(1);
    await nothingStacked(h, root);
  });

  it("マージの順の前のタスクが統合済みでなければ終了コード2で止まる", async () => {
    const { root, body } = await setup();
    await addTaskWorktree(root, "T11", "prev");
    const order = await runCli(["order", "T11,T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(order.code).toBe(0);
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("マージの順");
    // push にはないフラグは案内しない
    expect(result.err).not.toContain("--skip-order");
    expect(result.err).toContain("orca-flow order --remove T12");
    expect(result.err).toContain("もう一度 push");
    await nothingStacked(h, root);
  });

  it("決定の記録の抜けで終了コード1になる", async () => {
    const { root, body } = await setup(
      { "docs/decisions.md": "# 判断\n" },
      {
        decisionsFile: "docs/decisions.md",
        appendOnlyFiles: ["docs/decisions.md"],
      },
      { "docs/decisions.md": "# 判断\n" },
    );
    void body;
    // 文案のある設計書に差し替える
    const wt = path.join(path.dirname(root), "T12-shop");
    await writeFiles(wt, {
      "docs/tasks/T12.md": `${specDoc("T12", { allowed: ["src/shop/", "docs/decisions.md"] })}\n## 決定の記録の文案\n\n- 見出し：x\n`,
    });
    await git(wt, "add", "-A");
    await git(wt, "reset", "--quiet", "--", "docs/decisions.md");
    await git(wt, "commit", "--quiet", "-m", "T12: 文案");
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("決定の記録");
    expect(result.err).not.toContain("--skip-decision");
    expect(result.err).toContain("もう一度 push");
    await nothingStacked(h, root);
  });

  it("決定の記録のすでにある項を書き換えていたら終了コード1で止まる（追記だけでなければ push しない）", async () => {
    const { root, wt, body } = await setup(
      {},
      {
        decisionsFile: "docs/decisions.md",
        appendOnlyFiles: ["docs/decisions.md"],
      },
      { "docs/decisions.md": "# 判断\n" },
    );
    // verify も同じ確かめで止まるので、verify を通したあとで書き換えてコミットする
    await writeFiles(wt.path, { "docs/decisions.md": "# 判断 改\n" });
    await git(wt.path, "commit", "--quiet", "-am", "T12: 記録を書き換える");
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("先頭と同じではありません");
    expect(result.err).toContain("もう一度 push");
    await nothingStacked(h, root);
  });
});

describe("push", () => {
  it("確かめのあと案を積んで見せるだけで、git push も gh の書き込みも呼ばず、カードを送る前の確認待ち（未読）にする", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    nothingPushed(h);
    expect(h.gh.ready).toEqual([]);
    ghOnlyReads(h);
    const head = await git(wt.path, "rev-parse", "HEAD");
    const data = result.result!.data as {
      bundleFingerprint: string;
      head: string;
      stacked: string[];
    };
    expect(data.head).toBe(head);
    expect(data.stacked).toEqual(["push-v1", "pr-create-v1"]);
    // 本文・先頭・束の指紋・send の打ち方が出る
    expect(result.out).toContain("## 概要");
    expect(result.out).toContain(`束の指紋：${data.bundleFingerprint}`);
    expect(result.out).toContain(`先頭：${head}`);
    expect(result.out).toContain(
      `orca-flow send T12 --expect ${data.bundleFingerprint} --head ${head}`,
    );
    expect(result.out).toContain("T12: 買い物かご");
    const items = await readItems(path.join(root, ".git"), "T12");
    expect(items.map((i) => [i.id, i.state])).toEqual([
      ["push-v1", "queued"],
      ["pr-create-v1", "queued"],
    ]);
    expect(items[0]!.target.expectedRemoteHead ?? null).toBeNull();
    expect(items[1]!.target.title).toBe("T12: 買い物かご");
    expect(items[1]!.body).toContain("## 概要");
    // カード：送る前の確認待ち（未読）
    const set = h.orca.callsOf("worktree", "set").at(-1)!;
    expect(set.join(" ")).toContain("送る前の確認待ち：push-v1、pr-create-v1");
    expect(set).toContain("--unread");
    // 背景の待ち受けは起こさない（見張りが見る）
    expect(h.orca.launches).toEqual([]);
    expect((await readPushRecord(testRunner, root, "T12")) ?? null).toBeNull();
  });

  it("push のあと、出た束の指紋と先頭で send を打ったときにだけ、承認した SHA の push と下書きの PR の作成が起きる", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    const stacked = await push(h, root, ["--body-file", body]);
    const head = await git(wt.path, "rev-parse", "HEAD");
    const data = stacked.result!.data as { bundleFingerprint: string };
    // 違う指紋では何も送られない
    const wrong = await send(h, root, "0".repeat(64), head);
    expect(wrong.code).toBe(1);
    nothingPushed(h);
    const sent = await send(h, root, data.bundleFingerprint, head);
    expect(sent.err).toBe("");
    expect(sent.code).toBe(0);
    expect(h.pushes).toEqual([
      ["push", "origin", `${head}:refs/heads/${wt.branch}`],
    ]);
    expect(h.gh.created).toHaveLength(1);
    const created = h.gh.created[0]!;
    expect(created.slice(0, 8)).toEqual([
      "pr",
      "create",
      "--draft",
      "--base",
      "main",
      "--head",
      wt.branch,
      "--title",
    ]);
    expect(created[8]).toBe("T12: 買い物かご");
  });

  it("push → send の通し：作った PR の番号が記録に入り、PR とカードが結ばれ、CI 待ちのカードになり、待ち受けが起きる（作成の番号は一覧の番号と変えてある）", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    h.gh.createdNumber = 9;
    h.gh.listedNumber = 8;
    const stacked = await push(h, root, ["--body-file", body]);
    expect(stacked.code).toBe(0);
    const head = await git(wt.path, "rev-parse", "HEAD");
    const data = stacked.result!.data as { bundleFingerprint: string };
    const sent = await send(h, root, data.bundleFingerprint, head);
    expect(sent.err).toBe("");
    expect(sent.code).toBe(0);
    const record = await readPushRecord(testRunner, root, "T12");
    expect(record?.pushedHead).toBe(head);
    expect(record?.pr).toEqual({
      number: 9,
      url: "https://github.com/o/r/pull/9",
    });
    const sets = h.orca.callsOf("worktree", "set");
    expect(sets.filter((c) => c.includes("--pr"))).toEqual([
      ["worktree", "set", "--worktree", `path:${wt.path}`, "--pr", "9"],
    ]);
    expect(sets.at(-1)!.join(" ")).toContain("CI 待ち：PR #9");
    expect(h.orca.launches).toEqual([]);
  });

  it("作った PR の番号は、あとの案が落ちても記録に残る", async () => {
    const { root, wt, body } = await setup({}, { prReady: "after-ci" });
    const h = harness();
    h.gh.createdNumber = 9;
    h.gh.listCreated = false;
    const stacked = await push(h, root, ["--body-file", body]);
    expect(stacked.result!.data).toMatchObject({
      stacked: ["push-v1", "pr-create-v1", "pr-ready-v1"],
    });
    const head = await git(wt.path, "rev-parse", "HEAD");
    const { bundleFingerprint } = stacked.result!.data as {
      bundleFingerprint: string;
    };
    const sent = await send(h, root, bundleFingerprint, head);
    expect(sent.code).toBe(0);
    expect((await readPushRecord(testRunner, root, "T12"))?.pr?.number).toBe(9);
  });

  it("PR がまだない最初の push で、prReady が after-ci なら push・pr-create・pr-ready を積み、send のあと pr-ready は CI 待ちになる。下書きでない開いた PR では pr-ready を積まない", async () => {
    const { root, wt, body } = await setup({}, { prReady: "after-ci" });
    const h = harness();
    const first = await push(h, root, ["--body-file", body]);
    expect(first.code).toBe(0);
    const head = await git(wt.path, "rev-parse", "HEAD");
    const { bundleFingerprint } = first.result!.data as {
      stacked: string[];
      bundleFingerprint: string;
    };
    expect((first.result!.data as { stacked: string[] }).stacked).toEqual([
      "push-v1",
      "pr-create-v1",
      "pr-ready-v1",
    ]);
    expect((await send(h, root, bundleFingerprint, head)).code).toBe(0);
    const items = await readItems(path.join(root, ".git"), "T12");
    expect(items.map((i) => [i.kind, i.state])).toEqual([
      ["push", "sent"],
      ["pr-create", "sent"],
      ["pr-ready", "ci-wait"],
    ]);
    expect(h.gh.ready).toEqual([]);

    // 下書きでない開いた PR：pr-ready は積まない
    const other = await setup({}, { prReady: "after-ci" });
    const h2 = harness();
    h2.gh.prs = [{ ...openPr("0".repeat(40)), isDraft: false }];
    const second = await push(h2, other.root, []);
    expect(second.code).toBe(0);
    expect((second.result!.data as { stacked: string[] }).stacked).toEqual([
      "push-v1",
    ]);
  });

  it("push のあと、本文か先頭が変わってから send を打つと何も送られず、照らしたあとに先頭が動いても承認した SHA だけが push される", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    const stacked = await push(h, root, ["--body-file", body]);
    const head = await git(wt.path, "rev-parse", "HEAD");
    const { bundleFingerprint } = stacked.result!.data as {
      bundleFingerprint: string;
    };
    // 先頭が動くと、見せた先頭では送れない
    await writeFiles(wt.path, { "src/shop/c.ts": "c\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 動く");
    const moved = await send(h, root, bundleFingerprint, head);
    expect(moved.code).toBe(1);
    nothingPushed(h);
    await git(wt.path, "reset", "--quiet", "--hard", head);
    // 本文が書き換わると、束の指紋が合わない
    const file = path.join(
      root,
      ".git",
      "orca-flow",
      "outbox",
      "T12",
      "pr-create-v1.json",
    );
    const item = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...item, body: "書き換えた\n" }));
    const changed = await send(h, root, bundleFingerprint, head);
    expect(changed.code).toBe(1);
    nothingPushed(h);
    await writeFile(file, JSON.stringify(item));
    // 照らしたあとに先頭が動いても、承認した SHA だけが push される
    const inner = h.runner;
    h.runner = async (cmd, args, opts) => {
      if (cmd === "gh" && args[0] === "--version") {
        await writeFiles(wt.path, { "src/shop/d.ts": "d\n" });
        await git(wt.path, "add", "-A");
        await git(wt.path, "commit", "--quiet", "-m", "T12: 照らした後に動く");
      }
      return inner(cmd, args, opts);
    };
    const sent = await send(h, root, bundleFingerprint, head);
    expect(sent.code).toBe(0);
    expect(h.pushes).toEqual([
      ["push", "origin", `${head}:refs/heads/${wt.branch}`],
    ]);
  });

  it("無視された設計書と報告は、案を積む前にメインの作業ツリーの同じパスへ写る（push も PR もしない）", async () => {
    const root = await makeRepo(
      { integrateVerify: "before-merge", verify: ["test -f src/shop/a.ts"] },
      { ".gitignore": "docs/tasks/\n" },
    );
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "src/shop/a.ts": "a\n",
    });
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
        .code,
    ).toBe(0);
    const bodyDir = await tempDir();
    await writeFiles(bodyDir, { "b.md": "本文\n" });
    const h = harness();
    const result = await push(h, root, [
      "--body-file",
      path.join(bodyDir, "b.md"),
    ]);
    expect(result.err).toBe("");
    expect(existsSync(path.join(root, "docs/tasks/T12.md"))).toBe(true);
    expect(existsSync(path.join(root, "docs/tasks/reports/T12.md"))).toBe(true);
    nothingPushed(h);
  });

  it("PR がなく本文もないと終了コード1で、push しない", async () => {
    const { root } = await setup();
    const h = harness();
    const result = await push(h, root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--body-file");
    nothingPushed(h);
  });

  it("タスクのブランチが base の先頭を含まないと終了コード2で、push せずタスク長に知らせる", async () => {
    const { root, wt, body } = await setup();
    await writeFiles(root, { "new.txt": "n\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "main が進む");
    const h = harness();
    h.orca.terminals.push({
      handle: "term_t12",
      worktreePath: wt.path,
      title: "claude",
      agentIdentity: "claude",
    });
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("先頭を含んでいない");
    const sends = h.orca.callsOf("terminal", "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.join(" ")).toContain("rebase");
    nothingPushed(h);
  });

  it("rebase のあと（記録の先頭が今の先頭の祖先でない）は、記録の先頭を期待値として案に入れ、show に出し、send が期待値つきの --force-with-lease で承認した SHA を push する", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    const first = await git(wt.path, "rev-parse", "HEAD");
    await recordPushed(h, root, first);
    // 書き換える（commit --amend）→ verify を流し直す
    await git(
      wt.path,
      "commit",
      "--quiet",
      "--amend",
      "-m",
      "T12: 作る（直し）",
    );
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
        .code,
    ).toBe(0);
    h.gh.prs = [openPr(first)];
    const second = await push(h, root);
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    nothingPushed(h);
    const data = second.result!.data as {
      expectedRemoteHead: string;
      bundleFingerprint: string;
    };
    expect(data.expectedRemoteHead).toBe(first);
    expect(second.out).toContain(first);
    const show = await runCli(["outbox", "show", "T12"], {
      cwd: root,
      runner: h.orca.runner,
    });
    expect(show.out).toContain(first);
    // 期待値が変わると指紋が変わる
    const item = (await readItems(path.join(root, ".git"), "T12"))[0]!;
    const without = {
      ...item,
      target: { ...item.target, expectedRemoteHead: null },
    };
    expect(computeFingerprint(without)).not.toBe(computeFingerprint(item));
    const head = await git(wt.path, "rev-parse", "HEAD");
    const sent = await send(h, root, data.bundleFingerprint, head);
    expect(sent.code).toBe(0);
    expect(h.pushes).toEqual([
      [
        "push",
        `--force-with-lease=refs/heads/${wt.branch}:${first}`,
        "origin",
        `${head}:refs/heads/${wt.branch}`,
      ],
    ]);
    expect(h.gh.created).toEqual([]);
    // base を push する引数は1度も出ない
    for (const args of h.pushes)
      expect(args.some((a) => /(^|:)main$|HEAD:main|:main/.test(a))).toBe(
        false,
      );
  });

  it("gh がないと終了コード2で、環境変数のトークンも標準エラーに出ない", async () => {
    const { root, body } = await setup();
    const h = harness();
    h.gh.missing = true;
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const result = await push(h, root, ["--body-file", body], {
      GH_TOKEN: token,
    });
    expect(result.code).toBe(2);
    expect(result.err).not.toContain(token);
    expect(result.err).not.toMatch(/ghp_|github_pat_/);
    await nothingStacked(h, root);
  });

  it("gh の失敗の出力にトークンが混ざっても、エラーにも標準エラーにも出ない", async () => {
    const { root, body } = await setup();
    const h = harness();
    const plain = "plain-secret-value-12345";
    h.gh.listFails = `denied token=${plain} ghp_abcdefghijklmnopqrstuvwxyz0123`;
    const result = await push(h, root, ["--body-file", body], {
      GH_TOKEN: plain,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("PR の検索に失敗");
    expect(result.err).not.toContain(plain);
    expect(result.err).not.toContain("ghp_");
    await nothingStacked(h, root);
  });

  it("--show は様子の表示の部品へ渡す", async () => {
    const calls: string[] = [];
    const run = createPush({
      show: async (_c, id) => (calls.push(`show ${id}`), { code: 0 }),
    });
    const base = {
      cwd: "/nowhere",
      json: false,
      runner: testRunner,
      env: {},
      stdout: () => {},
      stderr: () => {},
      now: () => new Date(),
    };
    await run({ ...base, argv: ["T12", "--show"] });
    expect(calls).toEqual(["show T12"]);
  });

  it("push の記録がなく、開いている PR があり、早送りにならない2回目の push は、PR の先頭を期待値として案と show に入れる", async () => {
    const { root, wt } = await setup();
    const h = harness();
    const prHead = await git(wt.path, "rev-parse", "HEAD");
    // 記録は書かない。PR の先頭から見て、今の先頭は祖先でなくなる
    await git(wt.path, "commit", "--quiet", "--amend", "-m", "T12: 直し");
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
        .code,
    ).toBe(0);
    h.gh.prs = [openPr(prHead)];
    const again = await push(h, root);
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
    nothingPushed(h);
    const data = again.result!.data as { expectedRemoteHead: string };
    expect(data.expectedRemoteHead).toBe(prHead);
    expect(again.out).toContain(prHead);
    const items = await readItems(path.join(root, ".git"), "T12");
    expect(
      items.find((i) => i.kind === "push")?.target.expectedRemoteHead,
    ).toBe(prHead);
    const show = await runCli(["outbox", "show", "T12"], {
      cwd: root,
      runner: h.orca.runner,
    });
    expect(show.out).toContain(prHead);
  });

  it("早送りになる2回目の push（記録の先頭が今の先頭の祖先）は期待値を持たず、send も --force-with-lease をつけない", async () => {
    const { root, wt } = await setup();
    const h = harness();
    const first = await git(wt.path, "rev-parse", "HEAD");
    await recordPushed(h, root, first);
    await writeFiles(wt.path, { "src/shop/b.ts": "b\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 足す");
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
        .code,
    ).toBe(0);
    h.gh.prs = [openPr(first)];
    const second = await push(h, root);
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    const data = second.result!.data as {
      expectedRemoteHead: string | null;
      bundleFingerprint: string;
    };
    expect(data.expectedRemoteHead).toBeNull();
    const head = await git(wt.path, "rev-parse", "HEAD");
    expect((await send(h, root, data.bundleFingerprint, head)).code).toBe(0);
    expect(h.pushes).toEqual([
      ["push", "origin", `${head}:refs/heads/${wt.branch}`],
    ]);
  });

  it("PR が開いているときは PR の作成を積まず、prReady が after-ci のときだけ CI のあとに外す印の pr-ready を積む（send は送らず承認済み・CI 待ちにする）", async () => {
    const { root, wt } = await setup({}, { prReady: "after-ci" });
    const h = harness();
    const first = await git(wt.path, "rev-parse", "HEAD");
    await recordPushed(h, root, first);
    await writeFiles(wt.path, { "src/shop/b.ts": "b\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 足す");
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
        .code,
    ).toBe(0);
    h.gh.prs = [openPr(first)];
    const second = await push(h, root);
    expect(second.code).toBe(0);
    const data = second.result!.data as {
      stacked: string[];
      bundleFingerprint: string;
    };
    expect(data.stacked).toEqual(["push-v1", "pr-ready-v1"]);
    const items = await readItems(path.join(root, ".git"), "T12");
    expect(items[1]).toMatchObject({ kind: "pr-ready", afterCi: true });
    const head = await git(wt.path, "rev-parse", "HEAD");
    expect((await send(h, root, data.bundleFingerprint, head)).code).toBe(0);
    expect(h.gh.ready).toEqual([]);
    ghOnlyReads(h);
    const after = await readItems(path.join(root, ".git"), "T12");
    expect(after.map((i) => [i.kind, i.state])).toEqual([
      ["push", "sent"],
      ["pr-ready", "ci-wait"],
    ]);
  });

  it("本物の git：期待値が合えば --force-with-lease で上書きし、リモートが動いていて期待値が古ければ断られて「送らなかった」になる", async () => {
    for (const stale of [false, true]) {
      const { root, wt } = await setup();
      const origin = path.join(await tempDir("orca-flow-origin-"), "o.git");
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
      const first = await git(wt.path, "rev-parse", "HEAD");
      const h = harness({ realPush: true });
      await recordPushed(h, root, first);
      await git(wt.path, "commit", "--quiet", "--amend", "-m", "T12: 直し");
      expect(
        (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
          .code,
      ).toBe(0);
      h.gh.prs = [openPr(first)];
      const stacked = await push(h, root);
      expect(stacked.code).toBe(0);
      expect(h.pushes).toEqual([]);
      const head = await git(wt.path, "rev-parse", "HEAD");
      // 積んだあと、別の人がリモートのブランチを動かした
      const other = await git(root, "rev-parse", "main");
      if (stale)
        await git(
          wt.path,
          "push",
          "--quiet",
          "--force",
          "origin",
          `${other}:refs/heads/${wt.branch}`,
        );
      const data = stacked.result!.data as { bundleFingerprint: string };
      const sent = await send(h, root, data.bundleFingerprint, head);
      const remote = await git(origin, "rev-parse", `refs/heads/${wt.branch}`);
      const items = await readItems(path.join(root, ".git"), "T12");
      if (stale) {
        expect(sent.code).toBe(1);
        expect(remote).toBe(other);
        expect(items[0]!.state).toBe("skipped");
        expect(h.gh.created).toEqual([]);
      } else {
        expect(sent.err).toBe("");
        expect(sent.code).toBe(0);
        expect(remote).toBe(head);
        expect(items[0]!.state).toBe("sent");
      }
    }
  });

  it("prReady が manual（既定）なら pr-ready を積まない", async () => {
    const { root, body } = await setup();
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect((result.result!.data as { stacked: string[] }).stacked).toEqual([
      "push-v1",
      "pr-create-v1",
    ]);
  });

  it("push の記録の先頭が今の先頭の祖先でなければ、PR がなくても期待値を案に入れる", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    const first = await git(wt.path, "rev-parse", "HEAD");
    await recordPushed(h, root, first, null);
    await git(wt.path, "commit", "--quiet", "--amend", "-m", "T12: 直し");
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
        .code,
    ).toBe(0);
    const again = await push(h, root, ["--body-file", body]);
    expect(again.code).toBe(0);
    expect(
      (again.result!.data as { expectedRemoteHead: string }).expectedRemoteHead,
    ).toBe(first);
    nothingPushed(h);
  });

  it("先頭が変わっていない2回目の push は、確かめも push もせず、背景の待ち受けも起こさない（main が進んでいても）", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    const head = await git(wt.path, "rev-parse", "HEAD");
    await recordPushed(h, root, head);
    h.gh.prs = [openPr(head)];
    // main が進んで、タスクのブランチが先頭を含まなくなっても止まらない
    await writeFiles(root, { "new.txt": "n\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "main が進む");
    const second = await push(h, root);
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    nothingPushed(h);
    expect(h.orca.launches).toEqual([]);
    expect(h.orca.callsOf("terminal", "send")).toEqual([]);
    expect(await readItems(path.join(root, ".git"), "T12")).toEqual([]);
  });

  it("push のとき、見張りの automation がなければ作り方の案内が出る。あれば出ない（taskEnd が integrate でも pr でも）", async () => {
    for (const taskEnd of ["integrate", "pr"]) {
      const { root, body } = await setup({}, { taskEnd });
      const h = harness();
      const missing = await push(h, root, ["--body-file", body]);
      expect(missing.code).toBe(0);
      expect(missing.out).toContain("見張りの automation がありません");
      expect(missing.out).toContain("orca-flow pr-watch install");
      expect(missing.result!.data).toMatchObject({ automation: "missing" });

      const found = harness();
      found.orca.automations.push({
        id: "auto-1",
        name: watchAutomationName(root),
      });
      const withAutomation = await push(found, root, ["--body-file", body]);
      expect(withAutomation.code).toBe(0);
      expect(withAutomation.out).not.toContain(
        "見張りの automation がありません",
      );
      expect(withAutomation.result!.data).toMatchObject({
        automation: "found",
      });

      // Orca につながらず分からないときは、ないとは言わない
      const unknown = harness();
      unknown.orca.automationsListFails = true;
      const notSure = await push(unknown, root, ["--body-file", body]);
      expect(notSure.out).not.toContain("見張りの automation がありません");
      expect(notSure.out).toContain(
        "見張りの automation があるか確かめられません。Orca を起動してから orca-flow pr-watch install を打ってください（あれば今の中身に直すだけです）",
      );
      // 打ち直し（積んだ案の取り下げと積み直し）は勧めない
      expect(notSure.out).not.toContain("push を打ち直して");
      expect(notSure.result!.data).toMatchObject({ automation: "unknown" });
    }
  });

  it("先頭が変わっていない2回目の push も、automation がなければ案内する", async () => {
    const { root, wt } = await setup();
    const h = harness();
    const head = await git(wt.path, "rev-parse", "HEAD");
    await recordPushed(h, root, head);
    h.gh.prs = [openPr(head)];
    const second = await push(h, root);
    expect(second.code).toBe(0);
    expect(second.out).toContain("見張りの automation がありません");
    expect(h.orca.launches).toEqual([]);
  });

  it("push 〈ID〉 --watch は「見張りに置き換わりました」と出して終了コード1", async () => {
    const { root } = await setup();
    const h = harness();
    const result = await push(h, root, ["--watch"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("見張りに置き換わりました");
    expect(h.orca.launches).toEqual([]);
    expect(h.gh.calls).toEqual([]);
  });

  it("--body-file は相対パスでも、渡した場所から読んで案の本文にする", async () => {
    const { root, body } = await setup();
    const h = harness();
    const relative = path.relative(root, body);
    expect(path.isAbsolute(relative)).toBe(false);
    const result = await push(h, root, ["--body-file", relative]);
    expect(result.code).toBe(0);
    const items = await readItems(path.join(root, ".git"), "T12");
    expect(items.find((i) => i.kind === "pr-create")!.body).toContain("本文");
  });

  it("ID の形が正しくなければ --watch と --show の前に終了コード1", async () => {
    const calls: string[] = [];
    const run = createPush({
      show: async () => (calls.push("show"), { code: 0 }),
    });
    const base = {
      cwd: "/nowhere",
      json: false,
      runner: testRunner,
      env: {},
      stdout: () => {},
      stderr: () => {},
      now: () => new Date(),
    };
    await expect(
      run({ ...base, argv: ["../etc", "--show"] }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      run({ ...base, argv: ["a/b", "--watch"] }),
    ).rejects.toMatchObject({ code: 1 });
    expect(calls).toEqual([]);
  });
});

describe("PR の本文の確かめ", () => {
  const cases: [
    string,
    (ctx: { root: string; wtPath: string }) => string,
    string,
  ][] = [
    [
      "リポジトリのパス",
      ({ root }) => `見て ${root}/src\n`,
      "リポジトリのパス",
    ],
    [
      "worktree のパス",
      ({ wtPath }) => `作業は ${wtPath} で\n`,
      "タスクの worktree のパス",
    ],
    ["設計書のパス", () => "docs/tasks/T12.md を見る\n", "設計書のパス"],
    ["報告のパス", () => "docs/tasks/reports/T12.md を見る\n", "報告のパス"],
    [
      "秘密",
      () => "token ghp_abcdefghijklmnopqrstuvwxyz0123\n",
      "秘密らしい値",
    ],
  ];
  for (const [name, text, kind] of cases)
    it(`本文に${name}があると終了コード1で止まり、値は出さない`, async () => {
      const { root, wt } = await setup();
      const dir = await tempDir();
      const file = path.join(dir, "b.md");
      const content = text({ root, wtPath: wt.path });
      await writeFiles(dir, { "b.md": content });
      const h = harness();
      const result = await push(h, root, ["--body-file", file]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(kind);
      expect(result.err).not.toContain("ghp_");
      expect(result.err).not.toContain(root);
      nothingPushed(h);
      expect(await readItems(path.join(root, ".git"), "T12")).toEqual([]);
      expect(h.orca.callsOf("worktree", "set")).toEqual([]);
    });

  it("環境変数のトークンの値が本文にあっても止まる", async () => {
    const { root } = await setup();
    const dir = await tempDir();
    await writeFiles(dir, { "b.md": "値は plain-secret-value-12345 です\n" });
    const h = harness();
    const result = await push(
      h,
      root,
      ["--body-file", path.join(dir, "b.md")],
      {
        GH_TOKEN: "plain-secret-value-12345",
      },
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("秘密らしい値");
    expect(result.err).not.toContain("plain-secret");
    nothingPushed(h);
    expect(await readItems(path.join(root, ".git"), "T12")).toEqual([]);
  });
});

/** origin（本物の bare リポジトリ）つきで、PR が GitHub でマージされた状態を作る */
async function mergedOnGithub(made?: Awaited<ReturnType<typeof setup>>) {
  const { root, wt, body } = made ?? (await setup());
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
  return { root, wt, body, origin, clone };
}

const lockPath = (root: string) =>
  path.join(root, ".git", "orca-flow", "main.lock");

const finishCtx = (root: string, err: string[]): CommandContext => ({
  argv: [],
  cwd: root,
  json: false,
  runner: fakeOrca().runner,
  env: {},
  stdout: () => {},
  stderr: (t) => err.push(t),
  now: () => new Date("2026-11-03T00:00:00Z"),
});

describe("finishMergedTask", () => {
  it("origin の base を早送りで取り込み、統合済みの印・カード・worktree の削除まで行う", async () => {
    const { root, wt } = await mergedOnGithub();
    const err: string[] = [];
    const ctx = finishCtx(root, err);
    const orca = fakeOrca();
    ctx.runner = orca.runner;
    const config = await requireConfig(root);
    const result = await finishMergedTask(ctx, config, root, {
      id: "T12",
      branch: wt.branch,
      path: wt.path,
    });
    expect(result.kind).toBe("done");
    if (result.kind === "done") expect(result.sync.how).toBe("fast-forward");
    await git(root, "merge-base", "--is-ancestor", "origin/main", "main");
    expect(orca.callsOf("worktree", "set")).toHaveLength(1);
    expect(orca.callsOf("worktree", "rm")).toHaveLength(1);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("手元の main が先に進んでいれば、origin の main をマージで取り込む", async () => {
    const { root, wt } = await mergedOnGithub();
    await writeFiles(root, { "local.txt": "l\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "事前変更");
    const ctx = finishCtx(root, []);
    const orca = fakeOrca();
    ctx.runner = orca.runner;
    const result = await finishMergedTask(
      ctx,
      await requireConfig(root),
      root,
      {
        id: "T12",
        branch: wt.branch,
        path: wt.path,
      },
    );
    expect(result.kind === "done" && result.sync.how).toBe("merge");
    await git(root, "merge-base", "--is-ancestor", "origin/main", "main");
    // 進捗表のコミットの下に、取り込みのマージのコミット（親が2つ）がある
    expect(
      (await git(root, "show", "-s", "--format=%P", "main~1"))
        .split(" ")
        .filter(Boolean),
    ).toHaveLength(2);
    expect(existsSync(path.join(root, "local.txt"))).toBe(true);
  });

  it("メインの作業ツリーに未コミットの変更があると、何も変えずに止まって理由を返す", async () => {
    const { root, wt } = await mergedOnGithub();
    await writeFiles(root, { "README.md": "汚した\n" });
    const before = await git(root, "rev-parse", "main");
    const orca = fakeOrca();
    const ctx = finishCtx(root, []);
    ctx.runner = orca.runner;
    const result = await finishMergedTask(
      ctx,
      await requireConfig(root),
      root,
      {
        id: "T12",
        branch: wt.branch,
        path: wt.path,
      },
    );
    expect(result).toMatchObject({ kind: "stopped", reason: "dirty" });
    expect(await git(root, "rev-parse", "main")).toBe(before);
    expect(orca.callsOf("worktree", "rm")).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("取り込みが競合すると、戻して止まる", async () => {
    const { root, wt, clone } = await mergedOnGithub();
    // origin と手元で同じ行を別々に変える
    await writeFiles(clone, { "README.md": "origin 側\n" });
    await git(clone, "commit", "--quiet", "-am", "origin で変更");
    await git(clone, "push", "--quiet", "origin", "main");
    await writeFiles(root, { "README.md": "手元側\n" });
    await git(root, "commit", "--quiet", "-am", "手元で変更");
    const before = await git(root, "rev-parse", "main");
    const orca = fakeOrca();
    const ctx = finishCtx(root, []);
    ctx.runner = orca.runner;
    const result = await finishMergedTask(
      ctx,
      await requireConfig(root),
      root,
      {
        id: "T12",
        branch: wt.branch,
        path: wt.path,
      },
    );
    expect(result).toMatchObject({ kind: "stopped", reason: "conflict" });
    expect(await git(root, "rev-parse", "main")).toBe(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(orca.callsOf("worktree", "rm")).toEqual([]);
  });

  it("push は、PR がマージ済みなら push せず後始末をやり直す", async () => {
    const { root, wt } = await mergedOnGithub();
    const h = harness();
    h.gh.prs = [
      {
        number: 7,
        url: "u",
        isDraft: false,
        state: "MERGED",
        headRefOid: await git(wt.path, "rev-parse", "HEAD"),
        statusCheckRollup: [],
      },
    ];
    const result = await push(h, root);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(h.pushes).toEqual([]);
    expect(h.orca.callsOf("worktree", "rm")).toHaveLength(1);
    expect(existsSync(wt.path)).toBe(false);
  });

  const mergedPr = async (wtPath: string) => [
    {
      number: 7,
      url: "u",
      isDraft: false,
      state: "MERGED",
      headRefOid: await git(wtPath, "rev-parse", "HEAD"),
      statusCheckRollup: [],
    },
  ];
  /** 前に push したときの記録（push のあとで PR がマージされた状態） */
  const seedRecord = async (
    root: string,
    wt: { branch: string; path: string },
  ) =>
    writePushRecord(testRunner, root, "T12", {
      id: "T12",
      branch: wt.branch,
      base: "main",
      pushedHead: await git(wt.path, "rev-parse", "HEAD"),
      pushedAt: "2026-11-03T00:00:00Z",
      pr: { number: 7, url: "u" },
    });
  const cardComments = (orca: ReturnType<typeof fakeOrca>) =>
    orca
      .callsOf("worktree", "set")
      .map((c) => c[c.indexOf("--comment") + 1] ?? "");

  it("手元の main が進んでいても、マージ済みなら後始末をやり直し、タスク長に rebase を送らない", async () => {
    const { root, wt } = await mergedOnGithub();
    await seedRecord(root, wt);
    await writeFiles(root, { "local.txt": "l\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "事前変更");
    const h = harness();
    h.orca.terminals.push({
      handle: "term_t12",
      worktreePath: wt.path,
      title: "claude",
      agentIdentity: "claude",
    });
    h.gh.prs = await mergedPr(wt.path);
    const result = await push(h, root);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(h.pushes).toEqual([]);
    expect(h.orca.callsOf("terminal", "send")).toEqual([]);
    expect(existsSync(wt.path)).toBe(false);
    expect(cardComments(h.orca)).toContain("統合済み");
    expect(
      (await readPushRecord(testRunner, root, "T12"))?.watch,
    ).toMatchObject({ status: "merged" });
  });

  it("後始末で手元の main に入ったあと（タスクが作業中から外れたあと）でも、push の記録があれば後始末をやり直せる", async () => {
    const { root, wt } = await mergedOnGithub();
    await writePushRecord(testRunner, root, "T12", {
      id: "T12",
      branch: wt.branch,
      base: "main",
      pushedHead: await git(wt.path, "rev-parse", "HEAD"),
      pushedAt: "2026-11-03T00:00:00Z",
      pr: { number: 7, url: "u" },
    });
    // 人が手で取り込んだ：タスクのブランチはマージ済みになり、作業中の一覧から外れる
    await git(root, "fetch", "--quiet", "origin");
    await git(root, "merge", "--quiet", "--ff-only", "origin/main");
    const h = harness();
    h.gh.prs = await mergedPr(wt.path);
    const result = await push(h, root);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(wt.path)).toBe(false);
    expect(cardComments(h.orca)).toContain("統合済み");
  });

  it("後始末のロックの持ち主で文が分かれる（種類なし＝古い待ち受け・watch＝見張り・push＝ほかの push）", async () => {
    const expected: [string | undefined, string][] = [
      [undefined, "古い待ち受けが後始末をしています"],
      ["watch", "見張りが後始末をしています"],
      ["push", "ほかの push が後始末をしています"],
    ];
    for (const [kind, text] of expected) {
      const { root, wt } = await mergedOnGithub();
      await seedRecord(root, wt);
      const lock = await acquireLock(
        path.join(root, ".git", "orca-flow", "push", "T12.lock"),
        {
          waitMs: 0,
          maxAttempts: 1,
          ...(kind ? { kind } : {}),
          failed: (f, d) => `${f}${d}`,
        },
      );
      expect(lock.kind).toBe("acquired");
      const h = harness();
      h.gh.prs = await mergedPr(wt.path);
      const result = await push(h, root);
      expect(result.code).toBe(0);
      expect(result.out).toContain(text);
      expect(existsSync(wt.path)).toBe(true);
      expect(h.orca.callsOf("worktree", "rm")).toEqual([]);
      if (lock.kind === "acquired") await lock.release();
    }
  });

  it("2回目の push が取るロックには種類 push を書く", async () => {
    const { root, wt } = await mergedOnGithub();
    await seedRecord(root, wt);
    const h = harness();
    h.gh.prs = await mergedPr(wt.path);
    let seen: string | null = null;
    const lockPath = path.join(root, ".git", "orca-flow", "push", "T12.lock");
    const spy = {
      ...h,
      runner: (async (cmd, args, opts) => {
        if (seen === null && existsSync(lockPath))
          seen = await readFile(lockPath, "utf8");
        return h.runner(cmd, args, opts);
      }) as Runner,
    };
    await push(spy, root);
    expect(parseLockKind(seen ?? "")).toBe("push");
  });

  it("automation は mainWorktreePath の場所で探す", async () => {
    const { root, body } = await setup();
    const h = harness();
    const roots: string[] = [];
    const run = createPush({
      ...h.deps,
      findAutomation: async (_runner, r) => {
        roots.push(r);
        return { state: "missing" } as never;
      },
    });
    await run({
      argv: ["T12", "--body-file", body],
      cwd: root,
      json: false,
      runner: h.runner,
      env: {},
      stdout: () => {},
      stderr: () => {},
      now: () => new Date("2026-11-03T00:00:00Z"),
    });
    expect(roots).toEqual([await mainWorktreePath(h.runner, root)]);
  });

  it("後始末のやり直しが止まったら、記録とカードに理由が残る", async () => {
    const { root, wt, clone } = await mergedOnGithub();
    await seedRecord(root, wt);
    await writeFiles(clone, { "README.md": "origin 側\n" });
    await git(clone, "commit", "--quiet", "-am", "origin で変更");
    await git(clone, "push", "--quiet", "origin", "main");
    await writeFiles(root, { "README.md": "手元側\n" });
    await git(root, "commit", "--quiet", "-am", "手元で変更");
    const h = harness();
    h.gh.prs = await mergedPr(wt.path);
    const result = await push(h, root);
    expect(result.code).toBe(2);
    expect(
      (await readPushRecord(testRunner, root, "T12"))?.watch,
    ).toMatchObject({ status: "cleanup-stopped", reason: "conflict" });
    expect(cardComments(h.orca).at(-1)).toContain("後始末で止まった：PR #7");
  });

  it("main のロックが取られていると、終了コード2で何も変えない", async () => {
    const { root, wt } = await mergedOnGithub();
    const lock = await tryMainLock(finishCtx(root, []), root);
    expect(lock.kind).toBe("acquired");
    const h = harness();
    h.gh.prs = await mergedPr(wt.path);
    const result = await push(h, root);
    expect(result.code).toBe(2);
    expect(result.err).toContain("別の処理が main を書き換えています");
    expect(result.err).toContain(`ロック：${lockPath(root)}`);
    expect(existsSync(wt.path)).toBe(true);
    if (lock.kind === "acquired") await lock.release();
  });

  it("main のロックが種類つきで取られていると、push の打ち直しは相手の名前とロックのパスを出して止まる", async () => {
    const { root, wt } = await mergedOnGithub();
    const lock = await tryMainLock(finishCtx(root, []), root, "integrate");
    expect(lock.kind).toBe("acquired");
    const h = harness();
    h.gh.prs = await mergedPr(wt.path);
    const result = await push(h, root);
    expect(result.code).toBe(2);
    expect(result.err).toContain("integrateが main を書き換えています");
    expect(result.err).toContain(`ロック：${lockPath(root)}`);
    expect(result.err).toContain(`プロセス ${process.pid}`);
    expect(existsSync(wt.path)).toBe(true);
    if (lock.kind === "acquired") await lock.release();
  });

  it("integrate は main のロックが取られていると、終了コード2で止まりマージしない", async () => {
    const { root } = await setup();
    const lock = await tryMainLock(finishCtx(root, []), root);
    expect(lock.kind).toBe("acquired");
    const before = await git(root, "rev-parse", "main");
    const out = await runCli(["integrate", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(out.code).toBe(2);
    expect(out.err).toContain("別の処理が main を書き換えています");
    expect(out.err).toContain(
      `ロック：${path.join(root, ".git", "orca-flow", "main.lock")}`,
    );
    expect(await git(root, "rev-parse", "main")).toBe(before);
    if (lock.kind === "acquired") await lock.release();
    // ロックが外れれば integrate は通る
    expect(
      (
        await runCli(["integrate", "T12"], {
          cwd: root,
          runner: fakeOrca().runner,
        })
      ).code,
    ).toBe(0);
  });

  it("integrate は main のロックが種類つき（push の道の後始末）で取られていても、相手の名前を出して止まる", async () => {
    const { root } = await setup();
    const lock = await tryMainLock(finishCtx(root, []), root, "finish");
    expect(lock.kind).toBe("acquired");
    const before = await git(root, "rev-parse", "main");
    const out = await runCli(["integrate", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(out.code).toBe(2);
    expect(out.err).toContain("push の道の後始末が main を書き換えています");
    expect(out.err).toContain(`ロック：${lockPath(root)}`);
    expect(out.err).toContain(`プロセス ${process.pid}`);
    expect(await git(root, "rev-parse", "main")).toBe(before);
    if (lock.kind === "acquired") await lock.release();
  });

  /** main を書き換える git（commit・merge）が呼ばれた瞬間のロックの種類を集める */
  const watchKinds = (inner: Runner, root: string) => {
    const kinds: (string | null)[] = [];
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "git" && (args[0] === "commit" || args[0] === "merge")) {
        try {
          kinds.push(parseLockKind(await readFile(lockPath(root), "utf8")));
        } catch {
          kinds.push(null);
        }
      }
      return inner(cmd, args, opts);
    };
    return { runner, kinds };
  };

  it("integrate は main を書き換える間、ロックに integrate と書く", async () => {
    const { root } = await setup();
    const watch = watchKinds(fakeOrca().runner, root);
    const out = await runCli(["integrate", "T12"], {
      cwd: root,
      runner: watch.runner,
    });
    expect(out.code).toBe(0);
    expect(watch.kinds.length).toBeGreaterThan(0);
    expect(new Set(watch.kinds)).toEqual(new Set(["integrate"]));
  });

  it("push の道の後始末は main を書き換える間、ロックに finish と書く", async () => {
    const { root, wt } = await mergedOnGithub();
    await seedRecord(root, wt);
    const h = harness();
    h.gh.prs = await mergedPr(wt.path);
    const watch = watchKinds(h.runner, root);
    h.runner = watch.runner;
    const result = await push(h, root);
    expect(result.code).toBe(0);
    expect(watch.kinds.length).toBeGreaterThan(0);
    expect(new Set(watch.kinds)).toEqual(new Set(["finish"]));
  });

  it("push の打ち直しは、PR の参照を origin から取って、先に進んだ先頭の PR でも後始末が最後まで進む", async () => {
    const { root, wt, clone } = await mergedOnGithub();
    await seedRecord(root, wt);
    const prHead = await advancePrRef(clone, wt.branch, 7);
    const h = harness();
    h.gh.prs = [{ ...(await mergedPr(wt.path))[0], headRefOid: prHead }];
    const result = await push(h, root);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(wt.path)).toBe(false);
    expect(h.orca.callsOf("worktree", "rm")).toHaveLength(1);
  });

  it("push のあとにタスクのブランチへコミットがあると、worktree を消さずに止める", async () => {
    const { root, wt } = await mergedOnGithub();
    // origin の PR の参照は取れるが、手元の先頭を含まない（手元にしかないコミットがある）
    await git(root, "push", "--quiet", "origin", "main:refs/pull/7/head");
    const prs = await mergedPr(wt.path);
    await writeFiles(wt.path, { "src/shop/late.ts": "late\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: push のあとの変更");
    const h = harness();
    h.gh.prs = prs;
    const result = await push(h, root);
    expect(result.code).toBe(2);
    expect(result.err).toContain("先頭が、マージされた PR の先頭と違います");
    expect(existsSync(wt.path)).toBe(true);
    expect(h.orca.callsOf("worktree", "rm")).toEqual([]);
  });

  /** GitHub の上で提案が取り込まれた：origin の PR の参照だけが、手元の先頭より先に進む */
  const advancePrRef = async (
    clone: string,
    branch: string,
    number: number,
  ): Promise<string> => {
    await git(clone, "fetch", "--quiet", "origin", branch);
    await git(clone, "switch", "--quiet", "--detach", `origin/${branch}`);
    await writeFiles(clone, { "suggested.txt": "提案\n" });
    await git(clone, "add", "-A");
    await git(clone, "commit", "--quiet", "-m", "提案を取り込む");
    await git(
      clone,
      "push",
      "--quiet",
      "origin",
      `HEAD:refs/pull/${number}/head`,
    );
    return git(clone, "rev-parse", "HEAD");
  };
  const finishWithPr = async (
    root: string,
    wt: { branch: string; path: string },
    prHead: string,
  ) => {
    const orca = fakeOrca();
    const ctx = finishCtx(root, []);
    ctx.runner = orca.runner;
    const result = await finishMergedTask(
      ctx,
      await requireConfig(root),
      root,
      { id: "T12", branch: wt.branch, path: wt.path },
      { prHead, prNumber: 7 },
    );
    return { result, orca };
  };

  it("PR の上で提案が取り込まれて先頭が先に進んでいても、手元の先頭がその祖先なら後始末が最後まで進む", async () => {
    const { root, wt, clone } = await mergedOnGithub();
    const localHead = await git(wt.path, "rev-parse", "HEAD");
    const prHead = await advancePrRef(clone, wt.branch, 7);
    expect(prHead).not.toBe(localHead);
    const { result, orca } = await finishWithPr(root, wt, prHead);
    expect(result.kind).toBe("done");
    expect(orca.callsOf("worktree", "rm")).toHaveLength(1);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("手元の先頭が PR の参照の先頭と違い、手元にしかないコミットがあると、PR の参照を取ってきても止まる", async () => {
    const { root, wt, clone } = await mergedOnGithub();
    const prHead = await advancePrRef(clone, wt.branch, 7);
    await writeFiles(wt.path, { "src/shop/late.ts": "late\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: push のあとの変更");
    const { result, orca } = await finishWithPr(root, wt, prHead);
    expect(result).toMatchObject({ kind: "stopped", reason: "head" });
    expect(result.kind === "stopped" && result.detail).toContain(
      "先頭が、マージされた PR の先頭と違います",
    );
    expect(existsSync(wt.path)).toBe(true);
    expect(orca.callsOf("worktree", "rm")).toEqual([]);
  });

  it("PR の参照を origin から取ってこられないときも止まる", async () => {
    const { root, wt } = await mergedOnGithub();
    const localHead = await git(wt.path, "rev-parse", "HEAD");
    await writeFiles(wt.path, { "src/shop/late.ts": "late\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: push のあとの変更");
    const { result, orca } = await finishWithPr(root, wt, localHead);
    expect(result).toMatchObject({ kind: "stopped", reason: "fetch" });
    const detail = result.kind === "stopped" ? result.detail : "";
    expect(detail).toContain("PR #7 の参照（refs/pull/7/head）");
    expect(detail).toContain("取ってこられませんでした");
    expect(detail).not.toContain("push のあとにコミットがあります");
    expect(existsSync(wt.path)).toBe(true);
    expect(orca.callsOf("worktree", "rm")).toEqual([]);
  });

  it("PR の参照の fetch が時間切れになると、理由 fetch と「時間切れ」で止まる", async () => {
    const { root, wt } = await mergedOnGithub();
    const localHead = await git(wt.path, "rev-parse", "HEAD");
    const orca = fakeOrca();
    const ctx = finishCtx(root, []);
    ctx.runner = async (cmd, args, opts) =>
      cmd === "git" && args[0] === "fetch" && args.includes("refs/pull/7/head")
        ? { code: 1, stdout: "", stderr: "", timedOut: true }
        : orca.runner(cmd, args, opts);
    const result = await finishMergedTask(
      ctx,
      await requireConfig(root),
      root,
      { id: "T12", branch: wt.branch, path: wt.path },
      { prHead: `${localHead}0`, prNumber: 7 },
    );
    expect(result).toMatchObject({ kind: "stopped", reason: "fetch" });
    const detail = result.kind === "stopped" ? result.detail : "";
    expect(detail).toContain("PR #7 の参照");
    expect(detail).toContain("時間切れ");
    expect(existsSync(wt.path)).toBe(true);
    expect(orca.callsOf("worktree", "rm")).toEqual([]);
  });

  it("PR の参照は取れても FETCH_HEAD が読めないと、理由 fetch と「先頭が読めません」で止まる", async () => {
    const { root, wt } = await mergedOnGithub();
    const localHead = await git(wt.path, "rev-parse", "HEAD");
    const orca = fakeOrca();
    const ctx = finishCtx(root, []);
    ctx.runner = async (cmd, args, opts) => {
      if (
        cmd === "git" &&
        args[0] === "fetch" &&
        args.includes("refs/pull/7/head")
      )
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "FETCH_HEAD")
        return { code: 1, stdout: "", stderr: "", timedOut: false };
      return orca.runner(cmd, args, opts);
    };
    const result = await finishMergedTask(
      ctx,
      await requireConfig(root),
      root,
      { id: "T12", branch: wt.branch, path: wt.path },
      { prHead: `${localHead}0`, prNumber: 7 },
    );
    expect(result).toMatchObject({ kind: "stopped", reason: "fetch" });
    const detail = result.kind === "stopped" ? result.detail : "";
    expect(detail).toContain("PR #7 の参照");
    expect(detail).toContain("先頭が読めません");
    expect(detail).not.toContain("push のあとにコミットがあります");
    expect(existsSync(wt.path)).toBe(true);
    expect(orca.callsOf("worktree", "rm")).toEqual([]);
  });

  it("orca-flow push を通して PR の参照を取ってこられないと、終了コード2で取得の失敗の文を出す", async () => {
    const { root, wt } = await mergedOnGithub();
    await seedRecord(root, wt);
    const prs = await mergedPr(wt.path);
    await writeFiles(wt.path, { "src/shop/late.ts": "late\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: push のあとの変更");
    const h = harness();
    h.gh.prs = prs;
    const result = await push(h, root);
    expect(result.code).toBe(2);
    expect(result.err).toContain("PR #7 の参照（refs/pull/7/head）");
    expect(result.err).toContain("取ってこられませんでした");
    expect(result.err).not.toContain("push のあとにコミットがあります");
    expect(existsSync(wt.path)).toBe(true);
  });

  it("タスクの worktree に未コミットの変更があると、worktree を消さずに止める", async () => {
    const { root, wt } = await mergedOnGithub();
    await writeFiles(wt.path, { "src/shop/wip.ts": "wip\n" });
    const h = harness();
    h.gh.prs = await mergedPr(wt.path);
    const result = await push(h, root);
    expect(result.code).toBe(2);
    expect(result.err).toContain("未コミットの変更");
    expect(existsSync(path.join(wt.path, "src/shop/wip.ts"))).toBe(true);
  });

  it("無視された設計書と報告は、worktree を消す前にメインの作業ツリーへ写る", async () => {
    const root = await makeRepo(
      { integrateVerify: "before-merge", verify: ["test -f src/shop/a.ts"] },
      { ".gitignore": "docs/tasks/\n" },
    );
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "src/shop/a.ts": "a\n",
    });
    await writeFiles(wt.path, {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
      "docs/tasks/reports/T12.md": "# 報告\n",
    });
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
        .code,
    ).toBe(0);
    const bodyDir = await tempDir();
    await writeFiles(bodyDir, { "b.md": "本文\n" });
    const { origin } = await (async () => {
      const made = await mergedOnGithub({
        root,
        wt,
        body: path.join(bodyDir, "b.md"),
      });
      return made;
    })();
    void origin;
    expect(existsSync(path.join(root, "docs/tasks/T12.md"))).toBe(false);
    const orca = fakeOrca();
    const ctx = finishCtx(root, []);
    ctx.runner = orca.runner;
    const result = await finishMergedTask(
      ctx,
      await requireConfig(root),
      root,
      {
        id: "T12",
        branch: wt.branch,
        path: wt.path,
      },
    );
    expect(result.kind).toBe("done");
    expect(existsSync(path.join(root, "docs/tasks/T12.md"))).toBe(true);
    expect(existsSync(path.join(root, "docs/tasks/reports/T12.md"))).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });
});
