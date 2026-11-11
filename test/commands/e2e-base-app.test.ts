import { realpathSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeCompanionAt,
  type CompanionInput,
} from "../../src/lib/companion.ts";
import { writeCompanionBaseRecord } from "../../src/lib/companion-base.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { previewDeps, writePreviewRecord } from "../../src/lib/preview.ts";
import { writePreviewBaseRecord } from "../../src/lib/preview-base.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import { writeStartAfterAt } from "../../src/lib/start-after.ts";
import { runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

const ID = "T12";
const DEP = "T3";
const URL_B = "http://127.0.0.1:5002/";
const URL_B_BEFORE = "http://127.0.0.1:6002/";
const URL_A_BASE = "http://127.0.0.1:7001/";
const URL_A_TASK = "http://127.0.0.1:7101/";
const COMMAND = "run-b {previewUrl:app-b} --a {previewUrl:app-a}";

interface Fixture {
  wt: string;
  e2eRoot: string;
  appA: string;
  appB: string;
  shells: string[];
  /** 答えない URL */
  dead: Set<string>;
  runner: Runner;
}

const commonOf = async (dir: string) =>
  (
    await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();

const stage = (common: string, id: string) =>
  appendStage(common, id, {
    at: "2026-01-01T00:00:00.000Z",
    state: "integrate-wait",
    note: null,
    command: "status",
  });

async function fixture(
  opts: {
    /** 土台のアプリの出どころ。task＝依存元のタスク、base＝baseBranch、undecided＝決めきれない */
    source?: "task" | "base" | "undecided";
    /** baseBranch のときに土台のアプリの記録を書くか */
    baseRecord?: boolean;
    /** 依存元のタスクの段の記録に integrate-wait を書くか */
    depImplemented?: boolean;
    /** 依存元のタスクの preview の記録を書くか */
    depPreview?: boolean;
    capture?: CompanionInput["capture"];
    /** baseApps を書かない（今までの記録） */
    plain?: boolean;
  } = {},
): Promise<Fixture> {
  const source = opts.source ?? "base";
  const e2eRoot = realpathSync(await makeRepo({}));
  const wt = await addTaskWorktree(e2eRoot, ID, "e2e");
  const appA = realpathSync(await makeRepo({}));
  const appB = realpathSync(await makeRepo({}));
  const e2eCommon = await commonOf(e2eRoot);
  const commonA = await commonOf(appA);
  const commonB = await commonOf(appB);
  await writeCompanionAt(
    e2eCommon,
    ID,
    opts.plain
      ? {
          command: "run-b {previewUrl:app-b}",
          apps: [{ name: "app-b", path: appB }],
        }
      : {
          command: COMMAND,
          apps: [{ name: "app-b", path: appB }],
          baseApps: [{ name: "app-a", path: appA }],
          ...(opts.capture ? { capture: opts.capture } : {}),
        },
    new Date(),
    wt.branch,
  );
  await writePreviewRecord(commonB, {
    id: ID,
    worktree: appB,
    terminal: "term_1",
    url: URL_B,
    at: "2026-01-01T00:00:00.000Z",
  });
  await writePreviewBaseRecord(commonB, {
    id: ID,
    worktree: "/tmp/base",
    taskWorktree: wt.path,
    terminal: "term_2",
    commit: "abc",
    url: URL_B_BEFORE,
    at: "2026-01-01T00:00:00.000Z",
  });
  await stage(commonB, ID);

  if (source === "task" || source === "undecided") {
    if (source === "task") await addTaskWorktree(appA, DEP, "a");
    await writeStartAfterAt(
      e2eCommon,
      ID,
      [{ id: DEP, repo: { name: "app-a", path: appA }, wait: "implemented" }],
      new Date(),
    );
  }
  if (source === "task") {
    if (opts.depPreview !== false)
      await writePreviewRecord(commonA, {
        id: DEP,
        worktree: appA,
        terminal: "term_3",
        url: URL_A_TASK,
        at: "2026-01-01T00:00:00.000Z",
      });
    if (opts.depImplemented !== false) await stage(commonA, DEP);
  }
  if (source === "base" && opts.baseRecord !== false)
    await writeCompanionBaseRecord(commonA, {
      id: ID,
      worktree: "/tmp/companion-base",
      mainWorktree: appA,
      terminal: "term_4",
      baseBranch: "main",
      commit: "abc",
      owner: { repo: e2eRoot, taskBranch: wt.branch },
      url: URL_A_BASE,
      at: "2026-01-01T00:00:00.000Z",
    });

  let now = 1_700_000_000_000;
  previewDeps.clock = () => now;
  const f: Fixture = {
    wt: wt.path,
    e2eRoot,
    appA,
    appB,
    shells: [],
    dead: new Set(),
    runner: async (cmd, args, o) => {
      if (cmd === "sh" && args[0] === "-c") {
        const command = args[1]!;
        f.shells.push(command);
        now += 1000;
        if (command.includes("--video")) {
          const file = path.join(wt.path, "videos", `${now}.webm`);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, "x");
          await utimes(file, new Date(now), new Date(now));
        }
        now += 1000;
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      return testRunner(cmd, args, o);
    },
  };
  previewDeps.fetch = (async (url: string | URL | Request) =>
    new Response(null, {
      status: f.dead.has(String(url)) ? 503 : 200,
    })) as typeof fetch;
  return f;
}

const call = (f: Fixture, argv: string[]) =>
  runCli(["e2e", ID, ...argv], { cwd: f.wt, runner: f.runner });

const filled = (aUrl: string, bUrl = URL_B) => `run-b '${bUrl}' --a '${aUrl}'`;

describe("e2e：ブランチにない印のアプリ", () => {
  it("依存元のタスクがなければ、baseBranch の先頭で立てた土台のアプリの URL で埋めて流す", async () => {
    const f = await fixture({ source: "base" });
    const r = await call(f, ["--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(f.shells).toEqual([filled(URL_A_BASE)]);
    const data = JSON.parse(r.out) as { apps: Record<string, unknown>[] };
    expect(data.apps).toEqual([
      expect.objectContaining({
        name: "app-b",
        url: URL_B,
        source: { kind: "branch" },
      }),
      expect.objectContaining({
        name: "app-a",
        url: URL_A_BASE,
        answered: true,
        source: { kind: "baseBranch", branch: "main" },
      }),
    ]);
  });

  it("依存元のタスクが作業中なら、そのプレビューの URL で埋めて流す", async () => {
    const f = await fixture({ source: "task" });
    const r = await call(f, ["--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(f.shells).toEqual([filled(URL_A_TASK)]);
    const data = JSON.parse(r.out) as { apps: Record<string, unknown>[] };
    expect(data.apps[1]).toMatchObject({
      name: "app-a",
      url: URL_A_TASK,
      source: { kind: "task", id: DEP },
    });
  });

  it("依存元のタスクに integrate-wait の行がなければ、流さず2で理由を出す", async () => {
    const f = await fixture({ source: "task", depImplemented: false });
    const r = await call(f, []);
    expect(r.code).toBe(2);
    expect(f.shells).toEqual([]);
    expect(r.err).toContain(`app-a：依存元のタスク ${DEP} の実装がまだです`);
  });

  it("依存元のタスクのプレビューが答えない・URL がなければ、流さず2で組のプレビューを頼む", async () => {
    const f = await fixture({ source: "task" });
    f.dead.add(URL_A_TASK);
    const r = await call(f, []);
    expect(r.code).toBe(2);
    expect(f.shells).toEqual([]);
    expect(r.err).toContain(
      `依存元のタスク ${DEP} のプレビューの URL が答えません`,
    );
    expect(r.err).toContain("workspace --preview");

    const g = await fixture({ source: "task", depPreview: false });
    const r2 = await call(g, []);
    expect(r2.code).toBe(2);
    expect(r2.err).toContain("URL がありません");
  });

  it("土台のアプリの記録がない・答えなければ、流さず2で組のプレビューを頼む", async () => {
    const f = await fixture({ source: "base", baseRecord: false });
    const r = await call(f, []);
    expect(r.code).toBe(2);
    expect(f.shells).toEqual([]);
    expect(r.err).toContain("app-a：main の先頭で立てる土台のアプリ");
    expect(r.err).toContain("workspace --preview");

    const g = await fixture({ source: "base" });
    g.dead.add(URL_A_BASE);
    const r2 = await call(g, []);
    expect(r2.code).toBe(2);
    expect(g.shells).toEqual([]);
  });

  it("決めきれないときは流さず2で理由を出し、ほかの URL で流さない", async () => {
    const f = await fixture({ source: "undecided" });
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(2);
    expect(f.shells).toEqual([]);
    expect(r.err).toContain(
      "app-a：ブランチにないアプリをどこに向けるか決められません",
    );
    expect(r.err).toContain(DEP);
    const data = JSON.parse(r.out) as { apps: Record<string, unknown>[] };
    expect(data.apps[1]).toMatchObject({
      name: "app-a",
      url: null,
      source: { kind: "undecided" },
    });
  });

  it("--wait は土台のアプリもそろうまで待つ", async () => {
    const f = await fixture({ source: "base", baseRecord: false });
    let slept = 0;
    previewDeps.sleep = async () => {
      slept++;
      await writeCompanionBaseRecord(await commonOf(f.appA), {
        id: ID,
        worktree: "/tmp/companion-base",
        mainWorktree: f.appA,
        terminal: "term_4",
        baseBranch: "main",
        commit: "abc",
        owner: {
          repo: f.e2eRoot,
          taskBranch: `task/${ID}-e2e`,
        },
        url: URL_A_BASE,
        at: "2026-01-01T00:00:00.000Z",
      });
    };
    const r = await call(f, ["--wait"]);
    expect(r.code).toBe(0);
    expect(slept).toBe(1);
  });

  it("--capture の前の画面で、土台のアプリの印を後と同じ URL で埋める", async () => {
    const f = await fixture({
      source: "base",
      capture: {
        command: "rec --video {previewUrl:app-b} --a {previewUrl:app-a}",
        output: "videos",
      },
    });
    const r = await call(f, ["--capture", "login", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(f.shells).toEqual([
      `rec --video '${URL_B_BEFORE}' --a '${URL_A_BASE}'`,
      `rec --video '${URL_B}' --a '${URL_A_BASE}'`,
    ]);
    const data = JSON.parse(r.out) as { apps: Record<string, unknown>[] };
    expect(data.apps[1]).toMatchObject({
      name: "app-a",
      baseUrl: URL_A_BASE,
      baseAnswered: true,
    });
  });

  it("baseApps のない記録は、流すコマンド・終了コード・--json の形が今と同じ", async () => {
    const f = await fixture({ plain: true });
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(0);
    expect(f.shells).toEqual([`run-b '${URL_B}'`]);
    expect(JSON.parse(r.out)).toEqual({
      id: ID,
      result: "passed",
      apps: [{ name: "app-b", url: URL_B, answered: true, implemented: true }],
      reasons: [],
    });
  });

  it("baseApps を指す印で、ほかの理由で壊れた記録は終了コード1と「伴う記録が壊れています」", async () => {
    for (const breakIt of [
      (raw: Record<string, unknown>) => ({ ...raw, at: 1 }),
      (raw: Record<string, unknown>) => ({
        ...raw,
        baseApps: [{ name: "app-a", path: "rel" }],
      }),
    ]) {
      const f = await fixture({ source: "base" });
      const file = path.join(
        await commonOf(f.e2eRoot),
        "orca-flow/companion",
        `${ID}.json`,
      );
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
      await writeFile(file, JSON.stringify(breakIt(raw)));
      const r = await call(f, []);
      expect(r.code).toBe(1);
      expect(r.err).toContain("伴う記録が壊れています");
      expect(r.err).not.toContain("名前が伴う記録にありません");
      expect(f.shells).toEqual([]);
    }
  });
});
