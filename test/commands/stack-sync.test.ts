import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { writeStackAt } from "../../src/lib/stack.ts";
import { readStackNotice } from "../../src/lib/stack-notice.ts";
import { claudeScreen, fakeOrca, type FakeOrca } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";

const common = (root: string) => path.join(root, ".git");
const fast = {
  ORCA_FLOW_AUTO_POLL_MS: "5",
  ORCA_FLOW_AUTO_MAX_WAIT_MS: "60",
  ORCA_FLOW_STACK_RETRY_MS: "600000",
};

async function cli(
  argv: string[],
  cwd: string,
  runner: Runner,
  env: Record<string, string> = fast,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd,
    runner,
    env: { ...process.env, ...env },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const head = async (cwd: string) =>
  (await git(cwd, "rev-parse", "HEAD")).trim();

/** 乗せた先の verify の記録を、今の先頭で書く（verify を流した形） */
async function verified(root: string, front: string) {
  const dir = path.join(common(root), "orca-flow", "verified");
  await mkdir(dir, { recursive: true });
  const record = {
    id: "T01",
    head: await head(front),
    base: (await git(root, "rev-parse", "main")).trim(),
    commands: ["true"],
    at: new Date().toISOString(),
  };
  await writeFile(path.join(dir, "T01.json"), JSON.stringify(record));
  return record.head;
}

/** 前のタスク T01 に T02 を乗せる。T01 は乗せたあとに直しのコミットを1つ積み、verify を通した */
async function setup(options: { advanced?: boolean } = {}) {
  const root = await makeRepo({ verify: ["true"], maxActiveTasks: 5 });
  const front = await addTaskWorktree(root, "T01", "front", {
    "front.txt": "前\n",
  });
  const backPath = path.join(path.dirname(root), "T02-back");
  await git(
    root,
    "worktree",
    "add",
    "--quiet",
    "-b",
    "task/T02-back",
    backPath,
    front.branch,
  );
  await writeStackAt(
    common(root),
    "T02",
    { id: "T01", branch: front.branch },
    new Date(),
  );
  if (options.advanced ?? true) {
    await writeFiles(front.path, { "front.txt": "前の直し\n" });
    await git(front.path, "commit", "--quiet", "-am", "直す");
  }
  return { root, front, backPath };
}

function withLead(worktreePath: string, typed?: string) {
  const orca = fakeOrca();
  orca.terminals.push({
    handle: "term_back",
    worktreePath,
    title: "claude",
    agentIdentity: "claude",
    ...(typed !== undefined ? { screen: claudeScreen(typed) } : {}),
  });
  return orca;
}

const sent = (orca: FakeOrca) =>
  orca
    .callsOf("terminal", "send")
    .map((call) => call[call.indexOf("--text") + 1]);

const ADVANCED =
  "（統括役より）乗せた先 T01 の verify が通り、前の枝が進んだので知らせます。土台の枝は orca-flow depends T02 --base で読めます。区切りのよいところで土台の枝を取り込んで見直し、orca-flow verify を流してください。統合待ちなら、取り込んで verify を流し直し、integrate-wait に戻してください。";

describe("待ち受けが乗せたタスクに前の直しを知らせ直す", () => {
  it("乗せた先の verify の先頭を後ろの枝が含まなければ、1回だけ送り、送れた先頭を記録する", async () => {
    const { root, front, backPath } = await setup();
    const verifiedHead = await verified(root, front.path);
    const orca = withLead(backPath);
    const r = await cli(["auto", "wait", "--json"], root, orca.runner);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ turn: null });
    expect(sent(orca)).toEqual([ADVANCED]);
    expect(await readStackNotice(common(root), "T02")).toMatchObject({
      id: "T02",
      on: "T01",
      sentHead: verifiedHead,
    });

    // 同じ先頭は二度送らない（間を置いても）
    await cli(["auto", "wait", "--json"], root, orca.runner, {
      ...fast,
      ORCA_FLOW_STACK_RETRY_MS: "0",
    });
    expect(sent(orca)).toHaveLength(1);
  });

  it("後ろの枝が先頭を含んでいれば送らない", async () => {
    const { root, front, backPath } = await setup();
    await verified(root, front.path);
    await git(backPath, "merge", "--quiet", "--no-edit", front.branch);
    const orca = withLead(backPath);
    await cli(["auto", "wait", "--json"], root, orca.runner);
    expect(sent(orca)).toEqual([]);
    expect(await readStackNotice(common(root), "T02")).toBeNull();
  });

  it("送れなければ送れた先頭を書かず、間を置いた次の見直しで送り直す", async () => {
    const { root, front, backPath } = await setup();
    const verifiedHead = await verified(root, front.path);
    const busy = withLead(backPath, "人の打ちかけ");
    const first = await cli(["auto", "wait", "--json"], root, busy.runner);
    expect(first.code).toBe(0);
    expect(sent(busy)).toEqual([]);
    expect(first.err).toContain("前の枝が進んだ知らせを送れませんでした");
    expect(
      (await readStackNotice(common(root), "T02"))?.sentHead ?? null,
    ).toBeNull();

    // 間を置く前は送り直さない
    const idle = withLead(backPath);
    await cli(["auto", "wait", "--json"], root, idle.runner);
    expect(sent(idle)).toEqual([]);

    await cli(["auto", "wait", "--json"], root, idle.runner, {
      ...fast,
      ORCA_FLOW_STACK_RETRY_MS: "0",
    });
    expect(sent(idle)).toEqual([ADVANCED]);
    expect((await readStackNotice(common(root), "T02"))!.sentHead).toBe(
      verifiedHead,
    );
  });

  it("乗せた先の verify の記録がなければ送らない", async () => {
    const { root, backPath } = await setup();
    const orca = withLead(backPath);
    await cli(["auto", "wait", "--json"], root, orca.runner);
    expect(sent(orca)).toEqual([]);
  });

  it("乗せた先が入っていれば送らない", async () => {
    const { root, front, backPath } = await setup();
    await verified(root, front.path);
    await git(
      root,
      "merge",
      "--quiet",
      "--no-ff",
      front.branch,
      "-m",
      "統括役: T01 をマージする",
    );
    const orca = withLead(backPath);
    await cli(["auto", "wait", "--json"], root, orca.runner);
    expect(sent(orca)).toEqual([]);
  });
});

/** orca の terminal send だけを ms 遅らせる */
function slowSend(orca: FakeOrca, ms: number): Runner {
  return async (cmd, args, opts) => {
    if (cmd === "orca" && args[0] === "terminal" && args[1] === "send")
      await new Promise((r) => setTimeout(r, ms));
    return orca.runner(cmd, args, opts);
  };
}

/** git の呼び出しを数える */
function counting(runner: Runner) {
  const calls: string[][] = [];
  const wrapped: Runner = (cmd, args, opts) => {
    if (cmd === "git") calls.push([...args]);
    return runner(cmd, args, opts);
  };
  const count = (...shape: (string | null)[]) =>
    calls.filter((c) => shape.every((p, i) => p === null || c[i] === p)).length;
  return { runner: wrapped, count };
}

const NOT_SENT = "前の枝が進んだ知らせを送れませんでした";
const occurrences = (text: string, word: string) => text.split(word).length - 1;

describe("verify と待ち受けが同じ先頭を送らない", () => {
  it("verify と待ち受けを並べて流し、送りが遅くても、後ろのタスク長には1回だけ送る", async () => {
    const { root, front, backPath } = await setup();
    const orca = withLead(backPath);
    const runner = slowSend(orca, 500);
    const [verify, waited] = await Promise.all([
      cli(["verify"], front.path, runner),
      cli(["auto", "wait", "--json"], root, runner, {
        ...fast,
        ORCA_FLOW_AUTO_MAX_WAIT_MS: "3000",
      }),
    ]);
    expect(verify.code).toBe(0);
    expect(waited.code).toBe(0);
    expect(sent(orca)).toEqual([ADVANCED]);
    expect(await readStackNotice(common(root), "T02")).toMatchObject({
      sentHead: await head(front.path),
      sendingHead: null,
      failedHead: null,
    });
  });

  it("待ち受けが送り中の先頭は、verify も送らない", async () => {
    const { root, front, backPath } = await setup();
    const verifiedHead = await verified(root, front.path);
    const orca = withLead(backPath);
    const runner = slowSend(orca, 800);
    const waiting = cli(["auto", "wait", "--json"], root, runner, {
      ...fast,
      ORCA_FLOW_AUTO_MAX_WAIT_MS: "3000",
    });
    // 待ち受けが送り中の印を書くまで待つ
    for (let i = 0; i < 500; i++) {
      if ((await readStackNotice(common(root), "T02"))?.sendingHead) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await readStackNotice(common(root), "T02"))?.sendingHead).toBe(
      verifiedHead,
    );
    const verify = await cli(["verify"], front.path, runner);
    await waiting;
    expect(verify.code).toBe(0);
    expect(sent(orca)).toEqual([ADVANCED]);
  });
});

describe("待ち受けが送れないときの警告", () => {
  it("同じ先頭の送れない警告は最初の1回だけで、tell ではなく待ち受けが送り直すと伝える", async () => {
    const { root, front, backPath } = await setup();
    await verified(root, front.path);
    const busy = withLead(backPath, "人の打ちかけ");
    const retrying = { ...fast, ORCA_FLOW_STACK_RETRY_MS: "0" };
    const first = await cli(["auto", "wait", "--json"], root, busy.runner, {
      ...retrying,
      ORCA_FLOW_AUTO_MAX_WAIT_MS: "1500",
    });
    expect(first.code).toBe(0);
    // 間を置かずに何度も送り直しても、警告は1回
    expect(busy.callsOf("terminal", "read").length).toBeGreaterThan(1);
    expect(occurrences(first.err, NOT_SENT)).toBe(1);
    expect(first.err).toContain(
      "警告：T02 のタスク長に 前の枝が進んだ知らせを送れませんでした：入力欄に打ちかけの文があります",
    );
    expect(first.err).toContain(
      "統括役の待ち受けが間を置いて送り直すので、orca-flow tell で伝え直さないでください",
    );
    expect(first.err).not.toContain("orca-flow tell T02 で");

    // 次の待ち受けでも、同じ先頭なら警告しない
    const again = await cli(
      ["auto", "wait", "--json"],
      root,
      busy.runner,
      retrying,
    );
    expect(again.err).not.toContain(NOT_SENT);
    expect(sent(busy)).toEqual([]);

    // 先頭が変われば、また1回だけ警告する
    await writeFiles(front.path, { "front.txt": "前の2つめの直し\n" });
    await git(front.path, "commit", "--quiet", "-am", "また直す");
    await verified(root, front.path);
    const moved = await cli(
      ["auto", "wait", "--json"],
      root,
      busy.runner,
      retrying,
    );
    expect(occurrences(moved.err, NOT_SENT)).toBe(1);
  });
});

describe("待ち受けの見直しの git の呼び出し", () => {
  it("見直し1回で作業中の一覧を1回だけ求める", async () => {
    const { root, front, backPath } = await setup();
    await verified(root, front.path);
    const { runner, count } = counting(withLead(backPath).runner);
    const r = await cli(["auto", "wait", "--json"], root, runner, {
      ...fast,
      ORCA_FLOW_AUTO_MAX_WAIT_MS: "1500",
    });
    expect(r.code).toBe(0);
    // 見直しのたびに、後ろの枝が乗せた先の先頭を含むかを1回確かめる。作業中の一覧（worktree list）はその回数を超えない
    const rounds = count("merge-base", "--is-ancestor", null, "task/T02-back");
    expect(rounds).toBeGreaterThan(1);
    expect(count("worktree", "list")).toBeLessThanOrEqual(rounds);
  });
});

describe("乗せたタスクがあるときの待ち受けの続け方", () => {
  it("おまかせも印もなくても、乗せた先が作業中の乗せたタスクがあれば番なしですぐには終わらない", async () => {
    const { root } = await setup({ advanced: false });
    const started = Date.now();
    const r = await cli(["auto", "wait", "--json"], root, fakeOrca().runner, {
      ORCA_FLOW_AUTO_POLL_MS: "5",
      ORCA_FLOW_AUTO_MAX_WAIT_MS: "200",
    });
    expect(JSON.parse(r.out)).toEqual({ turn: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("乗せた先が作業中でなければすぐに終わる", async () => {
    const { root, front } = await setup({ advanced: false });
    await git(
      root,
      "merge",
      "--quiet",
      "--no-ff",
      front.branch,
      "-m",
      "統括役: T01 をマージする",
    );
    const started = Date.now();
    const r = await cli(["auto", "wait", "--json"], root, fakeOrca().runner, {
      ORCA_FLOW_AUTO_POLL_MS: "5",
      ORCA_FLOW_AUTO_MAX_WAIT_MS: "5000",
    });
    expect(JSON.parse(r.out)).toEqual({ turn: null });
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
