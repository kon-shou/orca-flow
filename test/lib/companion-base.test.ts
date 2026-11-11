import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previewDeps } from "../../src/lib/preview.ts";
import {
  COMPANION_BASE,
  companionBaseRecordPath,
  companionBaseStatus,
  companionBaseStatusAt,
  isBrokenCompanionBase,
  readCompanionBaseRecord,
  sameCompanionBaseOwner,
  writeCompanionBaseRecord,
  type CompanionBaseRecord,
} from "../../src/lib/companion-base.ts";
import { writeCompanionAt } from "../../src/lib/companion.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { removeTaskWorktree } from "../../src/lib/finish.ts";
import { createOrca } from "../../src/lib/orca.ts";
import { outsideWorktreeDir } from "../../src/lib/preview-base.ts";
import type { CommandContext } from "../../src/types.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { testRunner } from "../helpers/runner.ts";
import { addTaskWorktree, git, makeRepo, tempDir } from "../helpers/repo.ts";

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

const record: CompanionBaseRecord = {
  id: "T7",
  worktree: "/state/companion-base/T7",
  mainWorktree: "/repos/app-a",
  terminal: "term_1",
  baseBranch: "main",
  commit: "abc123",
  owner: { repo: "/repos/e2e", taskBranch: "task/T7-flow" },
  url: "http://localhost:5174/",
  at: "2026-11-05T00:00:00.000Z",
};
const owner = record.owner;

const answering = (status: number | "refused") => {
  previewDeps.fetch = (async () => {
    if (status === "refused") throw new Error("refused");
    return { status, body: null };
  }) as unknown as typeof fetch;
};

describe("土台のアプリの記録", () => {
  it("書いたものが同じ形で読め、なければ null。taskBranch と url は省ける", async () => {
    const common = await tempDir("orca-flow-common-");
    expect(await readCompanionBaseRecord(common, "T7")).toBeNull();
    await writeCompanionBaseRecord(common, record);
    expect(await readCompanionBaseRecord(common, "T7")).toEqual(record);
    expect(companionBaseRecordPath(common, "T7")).toBe(
      path.join(common, "orca-flow", "companion-base", "T7.json"),
    );
    const { url: _url, ...noUrl } = record;
    const old = { ...noUrl, owner: { repo: "/repos/e2e" } };
    await writeCompanionBaseRecord(common, old);
    expect(await readCompanionBaseRecord(common, "T7")).toEqual(old);
  });

  it("JSON でない・キーが足りない・型が違う・ID が違うものは、投げずに印つきで返す", async () => {
    const common = await tempDir("orca-flow-common-");
    const file = companionBaseRecordPath(common, "T7");
    await mkdir(path.dirname(file), { recursive: true });
    for (const text of [
      "{壊れ",
      "null",
      "[]",
      JSON.stringify({ ...record, commit: undefined }),
      JSON.stringify({ ...record, terminal: 3 }),
      JSON.stringify({ ...record, owner: "x" }),
      JSON.stringify({ ...record, owner: { taskBranch: "b" } }),
      JSON.stringify({ ...record, owner: { repo: "/r", taskBranch: 1 } }),
      JSON.stringify({ ...record, id: "T8" }),
    ]) {
      await writeFile(file, text);
      const read = await readCompanionBaseRecord(common, "T7");
      expect(isBrokenCompanionBase(read)).toBe(true);
    }
  });

  it("ID の形が外れたら記録の場所を組まない", () => {
    expect(() => companionBaseRecordPath("/c", "../x")).toThrow();
  });

  it("持ち主はリポジトリの実のパスと taskBranch で比べる", () => {
    expect(sameCompanionBaseOwner(owner, { ...owner })).toBe(true);
    expect(sameCompanionBaseOwner(owner, { repo: owner.repo })).toBe(false);
    expect(
      sameCompanionBaseOwner(owner, { ...owner, taskBranch: "task/T7-x" }),
    ).toBe(false);
    expect(sameCompanionBaseOwner(owner, { ...owner, repo: "/repos/b" })).toBe(
      false,
    );
  });
});

describe("土台のアプリが答えるかの判定", () => {
  it("記録がない・壊れている・別の持ち主・URL がまだ・答えないときは、理由つきで answers: false", async () => {
    const common = await tempDir("orca-flow-common-");
    answering(200);
    const none = await companionBaseStatusAt(common, "T7", owner);
    expect(none).toMatchObject({ answers: false, record: null });
    expect((none as { reason: string }).reason).toContain("記録がありません");

    const file = companionBaseRecordPath(common, "T7");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{壊れ");
    expect(
      (await companionBaseStatusAt(common, "T7", owner)) as { reason: string },
    ).toMatchObject({
      answers: false,
      reason: expect.stringContaining("壊れ"),
    });

    await writeCompanionBaseRecord(common, record);
    const other = await companionBaseStatusAt(common, "T7", {
      repo: "/repos/other",
    });
    expect(other).toMatchObject({
      answers: false,
      reason: expect.stringContaining("別の持ち主"),
    });

    const { url: _url, ...noUrl } = record;
    await writeCompanionBaseRecord(common, noUrl);
    expect(await companionBaseStatusAt(common, "T7", owner)).toMatchObject({
      answers: false,
      reason: expect.stringContaining("URL がまだ"),
    });

    await writeCompanionBaseRecord(common, record);
    answering("refused");
    expect(await companionBaseStatusAt(common, "T7", owner)).toMatchObject({
      answers: false,
      reason: expect.stringContaining("答えません"),
    });
  });

  it("持ち主が同じで URL が答えれば answers: true と URL を返す。アプリのリポジトリのパスからも読める", async () => {
    const app = await makeRepo();
    const common = path.join(app, ".git");
    await writeCompanionBaseRecord(common, record);
    answering(200);
    expect(await companionBaseStatusAt(common, "T7", owner)).toMatchObject({
      answers: true,
      url: "http://localhost:5174/",
    });
    expect(
      await companionBaseStatus(testRunner, app, "T7", owner),
    ).toMatchObject({ answers: true, url: "http://localhost:5174/" });
    const missing = await companionBaseStatus(
      testRunner,
      path.join(app, "no-such"),
      "T7",
      owner,
    );
    expect(missing).toMatchObject({ answers: false, record: null });
  });
});

describe("E2E のタスクの終わりの土台のアプリの片づけ", () => {
  async function finishSetup(ownerBranch = "task/T7-flow") {
    const e2e = await realpath(await makeRepo({ idPrefix: "T" }));
    const app = await realpath(
      await makeRepo({
        idPrefix: "T",
        preview: { up: "make dev", down: "make down" },
      }),
    );
    const wt = await addTaskWorktree(e2e, "T7", "flow");
    await writeCompanionAt(
      path.join(e2e, ".git"),
      "T7",
      {
        command: "run-e2e {previewUrl:app-a} {previewUrl:app-b}",
        apps: [{ name: "app-b", path: e2e }],
        baseApps: [{ name: "app-a", path: app }],
      },
      new Date("2026-11-05T00:00:00.000Z"),
      "task/T7-flow",
    );
    const state = await tempDir("orca-flow-state-");
    const env = { XDG_STATE_HOME: state };
    const appCommon = path.join(app, ".git");
    const dir = outsideWorktreeDir(COMPANION_BASE, env, appCommon, "T7");
    await mkdir(path.dirname(dir), { recursive: true });
    await git(app, "worktree", "add", "--detach", "--quiet", dir, "main");
    await writeCompanionBaseRecord(appCommon, {
      ...record,
      worktree: dir,
      mainWorktree: app,
      terminal: "term_cb",
      owner: { repo: e2e, taskBranch: ownerBranch },
    });
    const fake = fakeOrca();
    fake.terminals.push(
      { handle: "term_cb", worktreePath: app },
      { handle: "term_dep", worktreePath: app },
    );
    const downs: { command: string; cwd: string | undefined }[] = [];
    let downCode = 0;
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "sh" && args[0] === "-c") {
        downs.push({ command: args[1]!, cwd: opts?.cwd });
        return { code: downCode, stdout: "", stderr: "", timedOut: false };
      }
      return fake.runner(cmd, args, opts);
    };
    const errs: string[] = [];
    const ctx = {
      argv: [],
      cwd: e2e,
      json: false,
      runner,
      env,
      stdout: () => {},
      stderr: (t: string) => errs.push(t),
      now: () => new Date(),
    } as CommandContext;
    return {
      e2e,
      app,
      wt,
      dir,
      fake,
      downs,
      errs,
      ctx,
      appCommon,
      orca: createOrca(runner, e2e),
      setDownCode: (c: number) => (downCode = c),
    };
  }

  it("記録の baseApps の土台のアプリを止め（down・ターミナル・作業ツリー・記録）、ほかのターミナルは閉じない", async () => {
    const s = await finishSetup();
    const real = await realpath(s.dir);
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.downs).toEqual([{ command: "make down", cwd: real }]);
    const closed = s.fake.callsOf("terminal", "close");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain("term_cb");
    expect(await exists(s.dir)).toBe(false);
    expect(await readCompanionBaseRecord(s.appCommon, "T7")).toBeNull();
    expect(s.errs).toEqual([]);
  });

  it("止められなくても終わりは続き、警告が出る", async () => {
    const s = await finishSetup();
    s.setDownCode(3);
    s.fake.closeFails = true;
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.errs.join("\n")).toContain("警告");
    expect(s.errs.join("\n")).toContain("土台のアプリ");
    expect(s.fake.callsOf("worktree", "rm")).toHaveLength(1);
  });

  it("違う持ち主の土台のアプリは止めず、警告だけで終わりは続く", async () => {
    const s = await finishSetup("task/T7-else");
    const removed = await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path);
    expect(removed).toBe(true);
    expect(s.downs).toEqual([]);
    expect(await exists(s.dir)).toBe(true);
    expect(s.errs.join("\n")).toContain("別の持ち主");
  });

  it("baseApps のない伴う記録・伴う記録のないタスクでは何も流さない", async () => {
    const s = await finishSetup();
    await writeCompanionAt(
      path.join(s.e2e, ".git"),
      "T7",
      {
        command: "run-e2e {previewUrl:app-b}",
        apps: [{ name: "app-b", path: s.e2e }],
      },
      new Date("2026-11-05T00:00:00.000Z"),
      "task/T7-flow",
    );
    expect(await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path)).toBe(true);
    expect(s.downs).toEqual([]);
    expect(s.errs).toEqual([]);
    expect(await exists(s.dir)).toBe(true);
  });
});
