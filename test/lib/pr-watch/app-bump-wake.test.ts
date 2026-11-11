import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../../src/commands/pr-watch.ts";
import { writeCrossDepends } from "../../../src/lib/cross-depends.ts";
import { writePushRecord } from "../../../src/lib/finish.ts";
import type { Runner } from "../../../src/lib/exec.ts";
import { bumpNote, stripBumpNote } from "../../../src/lib/pr-watch/wake.ts";
import { readState, updateState } from "../../../src/lib/pr-watch/store.ts";
import { gitCommonDir } from "../../../src/lib/git.ts";
import { appendStage } from "../../../src/lib/stage-log.ts";
import { claudeScreen } from "../../helpers/fake-orca.ts";
import { git, makeRepo, tempDir, writeFiles } from "../../helpers/repo.ts";
import { testRunner } from "../../helpers/runner.ts";
import {
  SECRET_MARK,
  comments,
  harness,
  taskWithRecord,
  type Harness,
} from "./helpers.ts";

const round = (h: Harness) => run(h.ctx(["--root", h.root]));
const background = (h: Harness) => run(h.ctx(["background", "--root", h.root]));
const sends = (h: Harness) => h.orca.callsOf("terminal", "send");
const launches = (h: Harness) => h.orca.callsOf("agent", "launch");
const flagValue = (call: string[], name: string) =>
  call[call.indexOf(name) + 1];
const minutes = (h: Harness, m: number) => {
  h.now = new Date(h.now.getTime() + m * 60_000);
};

const BRANCH = "task/T05-lib";
const repoOf = (common: string, branch: string | null) => ({
  name: "core-kit",
  path: common,
  package: "acme/core-kit",
  ...(branch === null
    ? { version: "1.0.0", bumpCommand: "composer require acme/core-kit:^1" }
    : {
        branch,
        branchCommand: "composer require acme/core-kit:dev-{branch}",
        bumpCommand: "composer require acme/core-kit:^1",
      }),
  ids: ["T05"],
});

/** 共通（origin つき）と、共通の枝を取り込んだアプリのタスク（PR つき）を作り、初めての回を済ませる */
async function setup(
  options: {
    lock?: string;
    depends?: "branch" | "bumps" | "none";
    pr?: boolean;
    maxLaunches?: number;
  } = {},
) {
  const h = await harness(
    options.maxLaunches === undefined
      ? {}
      : { prWatch: { maxLaunches: options.maxLaunches } },
  );
  const origin = await tempDir("orca-flow-origin-");
  await git(origin, "init", "--bare", "--quiet", "-b", "main");
  const common = await makeRepo();
  await git(common, "remote", "add", "origin", origin);
  await git(common, "push", "--quiet", "origin", "main");
  const pushedHead = await git(common, "rev-parse", "HEAD");
  const lock = options.lock ?? pushedHead;
  const { wt, head } = await taskWithRecord(h, "T01", 7, {
    "composer.json": `{"require":{"acme/core-kit":"dev-${BRANCH}"}}\n`,
    "composer.lock": `{"name":"acme/core-kit","version":"dev-${BRANCH}","reference":"${lock}"}\n`,
  });
  if (options.pr === false)
    await writePushRecord(testRunner, h.root, "T01", {
      id: "T01",
      branch: wt.branch,
      base: "main",
      pushedHead: head,
      pushedAt: "2026-11-04T00:00:00Z",
      pr: null,
    });
  const depends = options.depends ?? "branch";
  if (depends !== "none")
    await writeCrossDepends(testRunner, h.root, "T01", [
      repoOf(common, depends === "branch" ? BRANCH : null),
    ]);
  h.gh.add({ number: 7, branch: wt.branch, head });
  await round(h);
  return { h, origin, common, wt, pushedHead };
}

/** 共通の main に PR のマージのコミットを足し、push の記録に残して origin へ送る */
async function mergeCommon(common: string, pushedHead: string) {
  await writeFiles(common, { "feature.txt": "x\n" });
  await git(common, "add", "-A");
  await git(common, "commit", "--quiet", "-m", "GitHub のマージ");
  const mergeCommit = await git(common, "rev-parse", "HEAD");
  await git(common, "push", "--quiet", "origin", "main");
  await writePushRecord(testRunner, common, "T05", {
    id: "T05",
    branch: BRANCH,
    base: "main",
    pushedHead,
    pushedAt: "2026-11-03T00:00:00Z",
    pr: { number: 1, url: "https://example.invalid/pr/1" },
    mergeCommit,
  });
  return mergeCommit;
}

let tick = 0;
/** PR に他人のレビューを足す（respond の起こしになる動き） */
function review(h: Harness, number: number) {
  tick++;
  const pr = h.gh.prs.get(number)!;
  pr.updatedAt = `2026-11-04T03:${String(tick % 60).padStart(2, "0")}:${String(Math.floor(tick / 60)).padStart(2, "0")}Z`;
  pr.reviews.push({ id: `r${tick}`, author: "alice", body: SECRET_MARK });
}

/** 取り込みが古いアプリのタスクをもう1つ（PR 付き）置き、回で見張りに入れる */
async function addTask(h: Harness, common: string, id: string, number: number) {
  const { wt, head } = await taskWithRecord(h, id, number, {
    "composer.json": `{"require":{"acme/core-kit":"dev-${BRANCH}"}}\n`,
    "composer.lock": `{"name":"acme/core-kit","version":"dev-${BRANCH}","reference":"${"a".repeat(40)}"}\n`,
  });
  await writeCrossDepends(testRunner, h.root, id, [repoOf(common, BRANCH)]);
  h.gh.add({ number, branch: wt.branch, head });
  await round(h);
  return wt;
}

const stageOf = async (h: Harness, id: string, state: string) =>
  appendStage(await gitCommonDir(testRunner, h.root), id, {
    at: h.now.toISOString(),
    state,
    note: null,
    command: "status",
  });

const pushUnmerged = (common: string, pushedHead: string) =>
  writePushRecord(testRunner, common, "T05", {
    id: "T05",
    branch: BRANCH,
    base: "main",
    pushedHead,
    pushedAt: "2026-11-03T00:00:00Z",
    pr: null,
  });

describe("共通の版上げで起こす", () => {
  it("共通がマージされ版のタグが出たら、タスク長を /orca-flow:bump 〈ID〉 で起こし、次の回に同じ版では起こさない", async () => {
    const { h, origin, common, pushedHead } = await setup();
    const merge = await mergeCommon(common, pushedHead);
    await git(origin, "tag", "v1.3.0", merge);
    await git(origin, "tag", "v1.2.0", merge);
    await round(h);
    const state = await readState(h.dir);
    expect(state.appBumpCheck).toEqual(["T01"]);
    expect((await background(h)).code).toBe(0);
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe("/orca-flow:bump T01");
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toMatchObject({
      pending: false,
      woken: ["bump:core-kit:1.2.0"],
    });
    minutes(h, 600);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect(sends(h)).toEqual([]);
  });

  it("生きたタスク長がいれば送る。版が変われば間隔のあとにもう一度起こす", async () => {
    const { h, origin, common, wt, pushedHead } = await setup();
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    const merge = await mergeCommon(common, pushedHead);
    await git(origin, "tag", "v1.3.0", merge);
    await round(h);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(flagValue(sends(h)[0]!, "--text")).toBe("/orca-flow:bump T01");
    expect(launches(h)).toEqual([]);
    // 版が変わった（より小さい版が出た）：間隔の中は待ち、過ぎたら起こす
    await git(origin, "tag", "v1.2.0", merge);
    minutes(h, 1);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toMatchObject({
      pending: true,
      wait: "interval",
    });
    minutes(h, 600);
    await background(h);
    expect(sends(h)).toHaveLength(2);
    // 同じ版では、間隔のあとでも起こさない
    minutes(h, 600);
    await background(h);
    expect(sends(h)).toHaveLength(2);
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.woken).toEqual([
      "bump:core-kit:1.3.0",
      "bump:core-kit:1.2.0",
    ]);
  });

  it("共通が未マージで取り込みが古ければ、取り込み直しで起こす", async () => {
    const { h, common, pushedHead } = await setup({ lock: "a".repeat(40) });
    await pushUnmerged(common, pushedHead);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe("/orca-flow:bump T01");
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.woken).toEqual([
      `reimport:core-kit:${pushedHead.slice(0, 12)}`,
    ]);
  });

  it("前置きつきの版だけなら「待つ」で、起こさない", async () => {
    const { h, origin, common, pushedHead } = await setup();
    const merge = await mergeCommon(common, pushedHead);
    await git(origin, "tag", "v1.2.0-rc.1", merge);
    await round(h);
    await background(h);
    expect(launches(h)).toEqual([]);
    expect(sends(h)).toEqual([]);
    expect((await readState(h.dir)).bumpWakes).toBeUndefined();
  });

  it("タグを取ってこられなければ起こさず、見張りは落ちない", async () => {
    const { h, origin, common, pushedHead } = await setup();
    const merge = await mergeCommon(common, pushedHead);
    await git(origin, "tag", "v1.2.0", merge);
    await git(common, "remote", "set-url", "origin", `${origin}-missing`);
    await round(h);
    expect((await background(h)).code).toBe(0);
    expect(launches(h)).toEqual([]);
  });

  it("回で確かめる対象に入れたあと、背景の前に記録が壊れても、背景は落ちずに警告を出し、ほかのタスクの起こしは続く", async () => {
    const { h, common, pushedHead } = await setup({ lock: "a".repeat(40) });
    await pushUnmerged(common, pushedHead);
    await addTask(h, common, "T02", 8);
    await round(h);
    expect((await readState(h.dir)).appBumpCheck).toEqual(["T01", "T02"]);
    const dir = path.join(h.root, ".git", "orca-flow", "cross-depends");
    await writeFile(path.join(dir, "T01.json"), "{");
    expect((await background(h)).code).toBe(0);
    expect(
      h.err.some((e) => e.includes("T01 の共通の版上げを確かめられません")),
    ).toBe(true);
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe("/orca-flow:bump T02");
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toBeUndefined();
  });

  it("PR が閉じられたら起こしの記録を捨てる", async () => {
    const { h, common, wt, pushedHead } = await setup({
      lock: "a".repeat(40),
    });
    await pushUnmerged(common, pushedHead);
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    await round(h);
    await background(h);
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toBeDefined();
    h.gh.prs.get(7)!.state = "CLOSED";
    h.gh.prs.get(7)!.updatedAt = "2026-11-04T05:00:00Z";
    await round(h);
    const state = await readState(h.dir);
    expect(state.bumpWakes?.["T01"]).toBeUndefined();
    expect(state.appBumpCheck).toBeUndefined();
  });
});

describe("共通の版上げの対象でないタスク", () => {
  it.each([
    ["またぐ依存の記録がない", { depends: "none" as const }],
    ["--bumps の記録（branch がない）", { depends: "bumps" as const }],
    ["PR がない", { pr: false }],
  ])("%s：判定も起こしもしない", async (_name, options) => {
    const calls: string[][] = [];
    const { h, common, pushedHead } = await setup({
      lock: "a".repeat(40),
      ...options,
    });
    await pushUnmerged(common, pushedHead);
    const inner = h.runner;
    const watching: Runner = async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      return inner(cmd, args, opts);
    };
    h.runner = watching;
    await round(h);
    await background(h);
    const state = await readState(h.dir);
    expect(state.appBumpCheck).toBeUndefined();
    expect(state.bumpWakes).toBeUndefined();
    expect(calls.filter((c) => c.includes("fetch"))).toEqual([]);
    expect(launches(h)).toEqual([]);
    expect(sends(h)).toEqual([]);
  });

  it("新しい欄のない古い state.json も、誤りにせず読んで回を続ける", async () => {
    const { h } = await setup({ depends: "none" });
    const file = path.join(h.dir, "state.json");
    const old = await readState(h.dir);
    delete old.appBumpCheck;
    delete old.bumpWakes;
    await writeFile(file, JSON.stringify(old));
    const result = await round(h);
    expect(result.code).toBe(1);
    expect((await readState(h.dir)).lastRun?.result).toBe("success");
    expect((await background(h)).code).toBe(0);
  });

  it("取り込みを確かめる対象のタスクでも、新しい欄を消した state.json から回と背景を流して起こせる", async () => {
    const { h, common, pushedHead } = await setup({ lock: "a".repeat(40) });
    await pushUnmerged(common, pushedHead);
    const file = path.join(h.dir, "state.json");
    const old = await readState(h.dir);
    delete old.appBumpCheck;
    delete old.bumpWakes;
    await writeFile(file, JSON.stringify(old));
    expect((await round(h)).code).toBe(1);
    expect((await readState(h.dir)).appBumpCheck).toEqual(["T01"]);
    expect((await background(h)).code).toBe(0);
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe("/orca-flow:bump T01");
  });
});

describe("版上げの起こしの待ちと上限", () => {
  const stale = async (options: Parameters<typeof setup>[0] = {}) => {
    const s = await setup({ lock: "a".repeat(40), ...options });
    await pushUnmerged(s.common, s.pushedHead);
    return s;
  };

  it("別のタスクの生きた会話が上限に届いていれば、立てずに limit で待つ", async () => {
    const { h, common, wt } = await stale({ maxLaunches: 1 });
    h.orca.trackComments = true;
    h.orca.worktreeComments[wt.path] = "前の一言";
    await addTask(h, common, "T02", 8);
    review(h, 8);
    await round(h);
    await background(h);
    // T02 の respond が立てた1つだけ。T01 の版上げは上限で待つ
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe(
      "/orca-flow:respond T02",
    );
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toMatchObject({
      pending: true,
      wait: "limit",
    });
    expect(h.err).toEqual([]);
  });

  it("タスク長が人の答えを待っている（question）あいだは送らず、待ちが残る", async () => {
    const { h, wt } = await stale();
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    await stageOf(h, "T01", "question");
    await round(h);
    await background(h);
    expect(sends(h)).toEqual([]);
    expect(launches(h)).toEqual([]);
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toMatchObject({
      pending: true,
      wait: "question",
    });
    await stageOf(h, "T01", "running");
    minutes(h, 1);
    await background(h);
    expect(sends(h)).toHaveLength(1);
  });

  it("立てる呼び出しが落ちたら failed と試した時刻が残り、間隔の中は立て直さない", async () => {
    const { h } = await stale();
    h.orca.launchTimesOut = true;
    await round(h);
    await background(h);
    h.orca.launchTimesOut = false;
    expect(launches(h)).toHaveLength(1);
    const state = await readState(h.dir);
    expect(state.bumpWakes?.["T01"]).toMatchObject({
      pending: true,
      wait: "failed",
      lastWokeAt: h.now.toISOString(),
    });
    expect(state.launched["T01"]).toMatchObject({ taskId: "T01" });
    minutes(h, 5);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.wait).toBe("interval");
  });

  it("版上げで立てた会話は次の背景でも記録に残り、上限に数えられる", async () => {
    const { h, common } = await stale({ maxLaunches: 1 });
    await addTask(h, common, "T02", 8);
    // T01 を先に立てる（T02 は立てたあとに動かす）
    await background(h);
    expect(launches(h).map((c) => flagValue(c, "--prompt"))).toEqual([
      "/orca-flow:bump T01",
    ]);
    review(h, 8);
    minutes(h, 1);
    await round(h);
    await background(h);
    const state = await readState(h.dir);
    expect(Object.keys(state.launched)).toEqual(["T01"]);
    expect(state.wakes["8"]).toMatchObject({ pending: true, wait: "limit" });
    expect(launches(h)).toHaveLength(1);
  });
});

describe("同じタスクの respond と版上げの待ち", () => {
  it("同じ背景で両方が待っていて会話がないとき、会話を立てるのは1回だけ", async () => {
    const { h, common, pushedHead, wt } = await setup({
      lock: "a".repeat(40),
    });
    await pushUnmerged(common, pushedHead);
    h.orca.trackComments = true;
    review(h, 7);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe(
      "/orca-flow:respond T01",
    );
    expect(h.orca.worktreeComments[wt.path]).toBe(
      "レビュー待ち：PR #7（レビュー1件）（版上げを起こせていません：前に立てた会話がまだ動いています）",
    );
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toMatchObject({
      pending: true,
      wait: "live",
    });
  });

  it("版上げで立てた直後の背景に respond の待ちが来ても、二つ目を立てない", async () => {
    const { h, common, pushedHead } = await setup({ lock: "a".repeat(40) });
    await pushUnmerged(common, pushedHead);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect(flagValue(launches(h)[0]!, "--prompt")).toBe("/orca-flow:bump T01");
    review(h, 7);
    minutes(h, 1);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
    expect((await readState(h.dir)).wakes["7"]).toMatchObject({
      pending: true,
      wait: "live",
    });
    expect(comments(h.orca).at(-1)).toContain(
      "（起こせていません：前に立てた会話がまだ動いています）",
    );
  });
});

const PRIOR = "レビュー待ち：PR #7（レビュー1件）";
const NOTE_DRAFT = "（版上げを起こせていません：入力欄に打ちかけがあります）";

/** 一言を Orca の一覧から読ませ、前の一言を置いて、版上げが打ちかけで待つ形にする */
async function waitingOnDraft() {
  const ctx = await setup({ lock: "a".repeat(40) });
  const { h, common, pushedHead, wt } = ctx;
  await pushUnmerged(common, pushedHead);
  h.orca.trackComments = true;
  h.orca.worktreeComments[wt.path] = PRIOR;
  h.orca.terminals.push({
    handle: "term_lead",
    worktreePath: wt.path,
    agentIdentity: "claude",
    screen: claudeScreen(`書きかけ ${SECRET_MARK}`),
  });
  await round(h);
  await background(h);
  return ctx;
}

describe("版上げの待ちのカードの一言", () => {
  it("打ちかけで待つと前の一言の後ろに理由が足され、打ちかけの文は出ない", async () => {
    const { h, wt } = await waitingOnDraft();
    expect(sends(h)).toEqual([]);
    expect(h.orca.worktreeComments[wt.path]).toBe(`${PRIOR}${NOTE_DRAFT}`);
    expect(comments(h.orca).join("\n")).not.toContain(SECRET_MARK);
    expect(comments(h.orca).join("\n")).not.toContain(
      "共通の版上げを待っています",
    );
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toMatchObject({
      wait: "draft",
      noteReason: "draft",
    });
  });

  it("同じ理由が続くあいだは書き直さず、理由が変われば末尾の文だけが替わる", async () => {
    const { h, wt } = await waitingOnDraft();
    const before = comments(h.orca).length;
    minutes(h, 1);
    await background(h);
    expect(comments(h.orca)).toHaveLength(before);
    h.orca.terminals.push({
      handle: "term_second",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    minutes(h, 1);
    await background(h);
    expect(h.orca.worktreeComments[wt.path]).toBe(
      `${PRIOR}（版上げを起こせていません：ターミナルが1つに決まりません）`,
    );
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.noteReason).toBe(
      "ambiguous",
    );
  });

  it("起こせたら版上げの文が外れて前の一言に戻り、理由の記録が空になる", async () => {
    const { h, wt } = await waitingOnDraft();
    h.orca.terminals[0]!.screen = undefined;
    minutes(h, 1);
    await background(h);
    expect(sends(h)).toHaveLength(1);
    expect(h.orca.worktreeComments[wt.path]).toBe(PRIOR);
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.noteReason).toBeNull();
  });

  it("判定が変わって鍵がなくなり待ちが終わると、次の背景で文が外れて記録が空になる", async () => {
    const { h, wt, pushedHead } = await waitingOnDraft();
    // アプリが共通の最新を取り込んだので、版上げは要らなくなる
    await writeFiles(wt.path, {
      "composer.lock": `{"name":"acme/core-kit","version":"dev-${BRANCH}","reference":"${pushedHead}"}\n`,
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "取り込み");
    minutes(h, 1);
    await background(h);
    expect(sends(h)).toEqual([]);
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toMatchObject({
      pending: false,
      noteReason: null,
    });
    expect(h.orca.worktreeComments[wt.path]).toBe(PRIOR);
  });

  it("背景が動いた PR のカードを書き直しても、次の背景で新しい一言の後ろに足し直される", async () => {
    const { h, wt } = await waitingOnDraft();
    review(h, 7);
    minutes(h, 1);
    await round(h);
    await background(h);
    const now = h.orca.worktreeComments[wt.path]!;
    expect(now.startsWith(PRIOR)).toBe(true);
    expect(now.endsWith(NOTE_DRAFT)).toBe(true);
    expect(now.split("版上げを起こせていません")).toHaveLength(2);
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.noteReason).toBe(
      "draft",
    );
  });

  it("CI だけの変化で背景がカードを書き直しても（respond の起こしがなくても）、次の背景で版上げの文が戻る", async () => {
    const { h, wt } = await waitingOnDraft();
    expect((await readState(h.dir)).wakes["7"]).toBeUndefined();
    h.gh.prs.get(7)!.ci = "PENDING";
    minutes(h, 1);
    await round(h);
    await background(h);
    expect((await readState(h.dir)).wakes["7"]).toBeUndefined();
    expect(h.orca.worktreeComments[wt.path]).toBe(
      `CI 待ち：PR #7${NOTE_DRAFT}`,
    );
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.noteReason).toBe(
      "draft",
    );
  });

  it("記録が空になった状態から、次の背景で版上げの文を足し直す", async () => {
    const { h, wt } = await waitingOnDraft();
    // 背景が一言を新しく書き直した状態（文が消え、記録も空）
    h.orca.worktreeComments[wt.path] = "新しい一言";
    await updateState(h.dir, (st) => {
      st.bumpWakes!["T01"]!.noteReason = null;
    });
    minutes(h, 1);
    await background(h);
    expect(h.orca.worktreeComments[wt.path]).toBe(`新しい一言${NOTE_DRAFT}`);
  });

  it("respond が一言を書くとき、版上げの文が出ていれば後ろに残す", async () => {
    const { h, wt } = await waitingOnDraft();
    await updateState(h.dir, (st) => {
      st.wakes["7"] = {
        number: 7,
        taskId: "T01",
        pending: true,
        wait: null,
        lastWokeAt: null,
        registeredKey: "k",
        baseComment: PRIOR,
        noteReason: null,
        since: h.now.toISOString(),
      };
    });
    minutes(h, 1);
    await background(h);
    expect(h.orca.worktreeComments[wt.path]).toBe(
      `${PRIOR}（起こせていません：入力欄に打ちかけがあります）${NOTE_DRAFT}`,
    );
  });

  it("前の版の一言が残っていても、理由が変われば版上げの文は1つだけで、起こせたら古い文は消える", async () => {
    const { h, wt } = await waitingOnDraft();
    const OLD = "共通の版上げを待っています：PR #7";
    h.orca.worktreeComments[wt.path] =
      `${OLD}（起こせていません：入力欄に打ちかけがあります）`;
    await updateState(h.dir, (st) => {
      st.bumpWakes!["T01"]!.noteReason = null;
    });
    h.orca.terminals.push({
      handle: "term_second",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    minutes(h, 1);
    await background(h);
    expect(h.orca.worktreeComments[wt.path]).toBe(
      "（版上げを起こせていません：ターミナルが1つに決まりません）",
    );
    h.orca.worktreeComments[wt.path] = OLD;
    await updateState(h.dir, (st) => {
      st.bumpWakes!["T01"]!.noteReason = "draft";
    });
    h.orca.terminals.length = 0;
    minutes(h, 1);
    await background(h);
    expect(h.orca.worktreeComments[wt.path]).toBe("");
  });

  it("respond だけが待ちから起こせたとき、一言は元の一言の後ろに版上げの文を残す", async () => {
    const { h, wt } = await waitingOnDraft();
    await updateState(h.dir, (st) => {
      st.wakes["7"] = {
        number: 7,
        taskId: "T01",
        pending: true,
        wait: "draft",
        lastWokeAt: null,
        registeredKey: "k",
        baseComment: PRIOR,
        noteReason: "draft",
        since: h.now.toISOString(),
      };
    });
    h.orca.worktreeComments[wt.path] =
      `${PRIOR}（起こせていません：入力欄に打ちかけがあります）${NOTE_DRAFT}`;
    // 版上げは待ったまま、respond の待ちだけが起こせる状態にする
    await updateState(h.dir, (st) => {
      st.bumpWakes!["T01"]!.lastWokeAt = h.now.toISOString();
    });
    h.orca.terminals[0]!.screen = claudeScreen("");
    const before = comments(h.orca).length;
    minutes(h, 1);
    await background(h);
    // respond が一言を元に戻すとき、版上げの文は後ろに残る
    expect(comments(h.orca)[before]).toBe(`${PRIOR}${NOTE_DRAFT}`);
    const now = h.orca.worktreeComments[wt.path]!;
    expect(now).toBe(
      `${PRIOR}（版上げを起こせていません：前に起こしてから間隔の中です）`,
    );
  });

  it("Orca の一覧を読めないときは一言を書かず、記録も変えず、背景は落ちない", async () => {
    const { h, wt } = await waitingOnDraft();
    const before = comments(h.orca).length;
    h.orca.worktreeListFails = true;
    h.orca.terminals[0]!.screen = undefined;
    minutes(h, 1);
    expect((await background(h)).code).toBe(0);
    expect(comments(h.orca)).toHaveLength(before);
    expect(h.orca.worktreeComments[wt.path]).toBe(`${PRIOR}${NOTE_DRAFT}`);
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.noteReason).toBe(
      "draft",
    );
    // 読めるようになった次の回に外れる
    h.orca.worktreeListFails = false;
    minutes(h, 1);
    await background(h);
    expect(h.orca.worktreeComments[wt.path]).toBe(PRIOR);
  });

  it("一覧のパスがタスクの worktree へのシンボリックリンクでも、前の一言の後ろに足す", async () => {
    const ctx = await setup({ lock: "a".repeat(40) });
    const { h, common, pushedHead, wt } = ctx;
    await pushUnmerged(common, pushedHead);
    const link = path.join(await tempDir("orca-flow-link-"), "linked");
    await symlink(wt.path, link);
    h.orca.trackComments = true;
    h.orca.worktreeComments[link] = PRIOR;
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
      screen: claudeScreen("書きかけ"),
    });
    await round(h);
    await background(h);
    expect(comments(h.orca).at(-1)).toBe(`${PRIOR}${NOTE_DRAFT}`);
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.noteReason).toBe(
      "draft",
    );
  });

  it("一覧にタスクの worktree がないときは警告を出して書かず、記録も変えず、出た次の回に足す", async () => {
    const { h, wt } = await waitingOnDraft();
    const before = comments(h.orca).length;
    delete h.orca.worktreeComments[wt.path];
    h.orca.worktreeComments["/elsewhere/other"] = "ほかの一言";
    h.orca.terminals.push({
      handle: "term_second",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    h.err.length = 0;
    minutes(h, 1);
    expect((await background(h)).code).toBe(0);
    expect(comments(h.orca)).toHaveLength(before);
    expect(h.orca.worktreeComments[wt.path]).toBeUndefined();
    expect(
      h.err.some((e) => e.includes("T01 のカードの一言を書けませんでした")),
    ).toBe(true);
    expect(h.err.join("\n")).not.toContain(PRIOR);
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.noteReason).toBe(
      "draft",
    );
    // 一覧に出た次の回に、前の一言の後ろに足される
    h.orca.worktreeComments[wt.path] = PRIOR;
    minutes(h, 1);
    await background(h);
    expect(h.orca.worktreeComments[wt.path]).toBe(
      `${PRIOR}（版上げを起こせていません：ターミナルが1つに決まりません）`,
    );
    expect((await readState(h.dir)).bumpWakes?.["T01"]?.noteReason).toBe(
      "ambiguous",
    );
  });
});

describe("版上げの文の外し方", () => {
  const reasons = [
    "draft",
    "bash",
    "unverifiable",
    "ambiguous",
    "failed",
    "interval",
    "live",
    "question",
  ] as const;
  it.each([
    ...reasons.map((r) => [r, 3] as const),
    ["limit", 1] as const,
    ["limit", 12] as const,
  ])("理由 %s（%i）の文を外せる", (r, n) => {
    expect(stripBumpNote(`前${bumpNote(r, n)}`)).toBe("前");
  });

  it("前の版の固定の一言は、全体がその形のときだけ空とみなす", () => {
    expect(stripBumpNote("共通の版上げを待っています：PR #7")).toBe("");
    expect(
      stripBumpNote(
        "共通の版上げを待っています：PR #7（起こせていません：入力欄に打ちかけがあります）",
      ),
    ).toBe("");
    expect(stripBumpNote("前 共通の版上げを待っています：PR #7")).toBe(
      "前 共通の版上げを待っています：PR #7",
    );
    expect(stripBumpNote("共通の版上げを待っています：PR #7 後")).toBe(
      "共通の版上げを待っています：PR #7 後",
    );
    expect(
      stripBumpNote(
        "共通の版上げを待っています：PR #7（起こせていません：他）",
      ),
    ).toBe("共通の版上げを待っています：PR #7（起こせていません：他）");
  });

  it("末尾の決まった形の文を1つだけ外し、ほかは触らない", () => {
    const note = bumpNote("limit", 3);
    expect(stripBumpNote(`前${note}`)).toBe("前");
    expect(stripBumpNote(`前${note}${note}`)).toBe(`前${note}`);
    expect(stripBumpNote(`前${note}後`)).toBe(`前${note}後`);
    expect(stripBumpNote("（版上げを起こせていません：ほかの文）")).toBe(
      "（版上げを起こせていません：ほかの文）",
    );
    expect(stripBumpNote("前")).toBe("前");
  });
});

describe("PR が終わったときの起こしの鍵", () => {
  it("手で開いた別の PR が閉じても、起こした PR の鍵は残る", async () => {
    const { h, common, wt, pushedHead } = await setup({
      lock: "a".repeat(40),
    });
    await pushUnmerged(common, pushedHead);
    h.orca.terminals.push({
      handle: "term_lead",
      worktreePath: wt.path,
      agentIdentity: "claude",
    });
    await round(h);
    await background(h);
    const before = (await readState(h.dir)).bumpWakes?.["T01"];
    expect(before).toMatchObject({ number: 7, woken: expect.any(Array) });
    h.gh.add({ number: 9, branch: wt.branch, head: "other" });
    await round(h);
    h.gh.prs.get(9)!.state = "CLOSED";
    h.gh.prs.get(9)!.updatedAt = "2026-11-04T06:00:00Z";
    await round(h);
    expect((await readState(h.dir)).prs["9"]?.final).not.toBeNull();
    expect((await readState(h.dir)).bumpWakes?.["T01"]).toEqual(before);
  });
});
