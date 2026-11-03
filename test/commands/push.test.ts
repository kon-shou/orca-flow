import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  finishMergedTask,
  readPushRecord,
  tryMainLock,
  writePushRecord,
} from "../../src/lib/finish.ts";
import { acquireLock } from "../../src/lib/lock.ts";
import type { Runner } from "../../src/lib/exec.ts";
import type { CommandContext } from "../../src/types.ts";
import { createPush } from "../../src/commands/push.ts";
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
  missing: boolean;
  /** gh pr create を失敗させるときの標準エラー */
  createFails: string | null;
  /** gh pr list を失敗させるときの標準エラー */
  listFails: string | null;
}

/** orca は偽物、gh と git push は記録するだけ、ほかの git は本物 */
function harness() {
  const orca = fakeOrca();
  const gh: Gh = {
    prs: [],
    created: [],
    ready: [],
    missing: false,
    createFails: null,
    listFails: null,
  };
  const pushes: string[][] = [];
  const launches: string[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    const ok = (stdout = "") => ({
      code: 0,
      stdout,
      stderr: "",
      timedOut: false,
    });
    if (cmd === "gh") {
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
        return ok("https://github.com/o/r/pull/7\n");
      }
      return ok();
    }
    if (cmd === "git" && args[0] === "push") {
      pushes.push([...args]);
      return ok();
    }
    return orca.runner(cmd, args, opts);
  };
  const deps = {
    launch: async (_ctx: CommandContext, id: string) => {
      launches.push(id);
    },
  };
  return { orca, gh, pushes, launches, runner, deps };
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

describe("push の確かめ", () => {
  it("範囲外のファイルがあると終了コード1で止まり、push も PR も出さない", async () => {
    const { root, wt, body } = await setup({ "other/x.ts": "x\n" });
    void wt;
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("書き込んでよい場所");
    nothingPushed(h);
  });

  it("報告がないと終了コード1で止まる", async () => {
    const { root, wt, body } = await setup();
    await git(wt.path, "rm", "--quiet", "docs/tasks/reports/T12.md");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 報告を消す");
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("報告");
    nothingPushed(h);
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
    nothingPushed(h);
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
    nothingPushed(h);
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
    nothingPushed(h);
  });

  it("決定の記録のすでにある項を書き換えていたら終了コード1で止まる（追記だけでなければ push しない）", async () => {
    const { root, body } = await setup(
      { "docs/decisions.md": "# 判断 改\n" },
      {
        decisionsFile: "docs/decisions.md",
        appendOnlyFiles: ["docs/decisions.md"],
      },
      { "docs/decisions.md": "# 判断\n" },
    );
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("先頭と同じではありません");
    expect(result.err).toContain("もう一度 push");
    nothingPushed(h);
  });
});

describe("push", () => {
  it("タスクのブランチだけを push し、base 向きの下書きの PR を件名と本文つきで出して、待ち受けを起こす", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    const result = await push(h, root, ["--body-file", body]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(h.pushes).toEqual([["push", "--set-upstream", "origin", wt.branch]]);
    expect(h.gh.created).toEqual([
      [
        "pr",
        "create",
        "--draft",
        "--base",
        "main",
        "--head",
        wt.branch,
        "--title",
        "T12: 買い物かご",
        "--body-file",
        body,
      ],
    ]);
    expect(h.launches).toEqual(["T12"]);
    const record = JSON.parse(
      await readFile(
        path.join(root, ".git", "orca-flow", "push", "T12.json"),
        "utf8",
      ),
    );
    expect(record).toMatchObject({
      pushedHead: await git(wt.path, "rev-parse", "HEAD"),
      pr: { number: 7 },
    });
  });

  it("無視された設計書と報告は、push の前にメインの作業ツリーの同じパスへ写る", async () => {
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
    // push が呼ばれた時点で写っているか
    const seen: boolean[] = [];
    const inner = h.runner;
    h.runner = async (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "push")
        seen.push(
          existsSync(path.join(root, "docs/tasks/T12.md")) &&
            existsSync(path.join(root, "docs/tasks/reports/T12.md")),
        );
      return inner(cmd, args, opts);
    };
    const result = await push(h, root, [
      "--body-file",
      path.join(bodyDir, "b.md"),
    ]);
    expect(result.err).toBe("");
    expect(seen).toEqual([true]);
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

  it("2回目の push で早送りにならないとき、前の先頭を期待値にした --force-with-lease でタスクのブランチだけを push する", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    expect((await push(h, root, ["--body-file", body])).code).toBe(0);
    const first = await git(wt.path, "rev-parse", "HEAD");
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
    h.gh.prs = [
      {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        isDraft: true,
        state: "OPEN",
        headRefOid: first,
        statusCheckRollup: [],
      },
    ];
    const second = await push(h, root);
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    expect(h.pushes[1]).toEqual([
      "push",
      `--force-with-lease=${wt.branch}:${first}`,
      "--set-upstream",
      "origin",
      wt.branch,
    ]);
    expect(h.gh.created).toHaveLength(1);
    // base を push する引数は1度も出ない
    for (const args of h.pushes) {
      expect(args).not.toContain("main");
      expect(args.some((a) => /(^|:)main$|HEAD:main|:main/.test(a))).toBe(
        false,
      );
    }
    expect(h.launches).toEqual(["T12", "T12"]);
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
    nothingPushed(h);
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
    nothingPushed(h);
  });

  it("--watch と --show は待ち受けの部品へ渡す", async () => {
    const calls: string[] = [];
    const run = createPush({
      run: async (_c, id) => (calls.push(`run ${id}`), { code: 0 }),
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
    await run({ ...base, argv: ["T12", "--watch"] });
    await run({ ...base, argv: ["T12", "--show"] });
    expect(calls).toEqual(["run T12", "show T12"]);
  });

  it("早送りになる2回目の push は --force-with-lease をつけない", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    expect((await push(h, root, ["--body-file", body])).code).toBe(0);
    const first = await git(wt.path, "rev-parse", "HEAD");
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
    expect(h.pushes[1]).toEqual([
      "push",
      "--set-upstream",
      "origin",
      wt.branch,
    ]);
    expect(h.pushes[1]!.some((a) => a.includes("force"))).toBe(false);
  });

  it("push が通って PR を出せなかったときも、先頭を記録し、rebase 後の打ち直しで lease がつく", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    h.gh.createFails = "boom";
    const failed = await push(h, root, ["--body-file", body]);
    expect(failed.code).toBe(1);
    const first = await git(wt.path, "rev-parse", "HEAD");
    expect((await readPushRecord(testRunner, root, "T12"))?.pushedHead).toBe(
      first,
    );
    await git(wt.path, "commit", "--quiet", "--amend", "-m", "T12: 直し");
    expect(
      (await runCli(["verify"], { cwd: wt.path, runner: fakeOrca().runner }))
        .code,
    ).toBe(0);
    h.gh.createFails = null;
    const again = await push(h, root, ["--body-file", body]);
    expect(again.code).toBe(0);
    expect(h.pushes[1]).toContain(`--force-with-lease=${wt.branch}:${first}`);
  });

  it("先頭が変わっていない2回目の push は、確かめも push もせず待ち受けだけ起こす（main が進んでいても）", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    expect((await push(h, root, ["--body-file", body])).code).toBe(0);
    const head = await git(wt.path, "rev-parse", "HEAD");
    h.gh.prs = [openPr(head)];
    // main が進んで、タスクのブランチが先頭を含まなくなっても止まらない
    await writeFiles(root, { "new.txt": "n\n" });
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "main が進む");
    const second = await push(h, root);
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    expect(h.pushes).toHaveLength(1);
    expect(h.gh.created).toHaveLength(1);
    expect(h.launches).toEqual(["T12", "T12"]);
    expect(h.orca.callsOf("terminal", "send")).toEqual([]);
  });

  it("待ち受けが動いているなら、起こし直しは何もしない", async () => {
    const { root, wt, body } = await setup();
    const h = harness();
    expect((await push(h, root, ["--body-file", body])).code).toBe(0);
    h.gh.prs = [openPr(await git(wt.path, "rev-parse", "HEAD"))];
    const lock = await acquireLock(
      path.join(root, ".git", "orca-flow", "push", "T12.lock"),
      { waitMs: 0, maxAttempts: 1, failed: (f, d) => `${f}${d}` },
    );
    expect(lock.kind).toBe("acquired");
    const second = await push(h, root);
    expect(second.code).toBe(0);
    expect(h.launches).toEqual(["T12"]);
    if (lock.kind === "acquired") await lock.release();
  });

  it("--body-file は相対パスでも絶対パスにして gh へ渡す", async () => {
    const { root, body } = await setup();
    const h = harness();
    const relative = path.relative(root, body);
    expect(path.isAbsolute(relative)).toBe(false);
    const result = await push(h, root, ["--body-file", relative]);
    expect(result.code).toBe(0);
    const args = h.gh.created[0]!;
    expect(args[args.indexOf("--body-file") + 1]).toBe(body);
  });

  it("ID の形が正しくなければ --watch と --show の前に終了コード1", async () => {
    const calls: string[] = [];
    const run = createPush({
      run: async () => (calls.push("run"), { code: 0 }),
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

  it("待ち受けが動いている間の後始末のやり直しは、何もせず待ち受けに任せる", async () => {
    const { root, wt } = await mergedOnGithub();
    await seedRecord(root, wt);
    const lock = await acquireLock(
      path.join(root, ".git", "orca-flow", "push", "T12.lock"),
      { waitMs: 0, maxAttempts: 1, failed: (f, d) => `${f}${d}` },
    );
    expect(lock.kind).toBe("acquired");
    const h = harness();
    h.gh.prs = await mergedPr(wt.path);
    const result = await push(h, root);
    expect(result.code).toBe(0);
    expect(result.out).toContain("待ち受けが後始末をしています");
    expect(existsSync(wt.path)).toBe(true);
    expect(h.orca.callsOf("worktree", "rm")).toEqual([]);
    if (lock.kind === "acquired") await lock.release();
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
    expect(result.err).toContain("main を書き換えています");
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
    expect(out.err).toContain("背景の後始末が main を書き換えています");
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

  it("push のあとにタスクのブランチへコミットがあると、worktree を消さずに止める", async () => {
    const { root, wt } = await mergedOnGithub();
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
