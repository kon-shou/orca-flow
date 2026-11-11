import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { previewDeps } from "../../src/lib/preview.ts";
import {
  outsideWorktreeDir,
  previewBaseRecordPath,
  previewBaseWorktreeDir,
  writePreviewBaseRecord,
} from "../../src/lib/preview-base.ts";
import {
  COMPANION_BASE,
  companionBaseRecordPath,
  writeCompanionBaseRecord,
} from "../../src/lib/companion-base.ts";
import { writeCompanionAt } from "../../src/lib/companion.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { git, makeRepo, tempDir } from "../helpers/repo.ts";

const SAVED = { ...previewDeps };
let now = 0;
beforeEach(() => {
  now = 0;
  previewDeps.clock = () => now;
  previewDeps.sleep = async (ms) => {
    now += ms;
  };
  previewDeps.pollMs = 1_000;
});
afterEach(() => Object.assign(previewDeps, SAVED));

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

interface Harness {
  runner: Runner;
  orcaCalls: string[][];
  sent: { handle: string; text: string }[];
  downs: { command: string; cwd: string | undefined }[];
  alive: Set<string>;
  downCode: number;
}

function harness(): Harness {
  const base = fakeOrca();
  const state: Harness = {
    runner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    orcaCalls: [],
    sent: [],
    downs: [],
    alive: new Set(),
    downCode: 0,
  };
  const ok = (result: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, result }),
    stderr: "",
    timedOut: false,
  });
  const val = (args: readonly string[], name: string) =>
    args[args.indexOf(name) + 1] ?? "";
  let n = 0;
  state.runner = async (cmd, args, opts) => {
    if (cmd === "sh" && args[0] === "-c") {
      state.downs.push({ command: args[1]!, cwd: opts?.cwd });
      return { code: state.downCode, stdout: "", stderr: "", timedOut: false };
    }
    if (cmd !== "orca") return base.runner(cmd, args, opts);
    const plain = args.filter((a) => a !== "--json");
    state.orcaCalls.push(plain);
    const [group, action] = plain;
    if (group === "terminal" && action === "create") {
      const handle = `term_${++n}`;
      state.alive.add(handle);
      return ok({ terminal: { handle } });
    }
    if (group === "terminal" && action === "send") {
      state.sent.push({
        handle: val(plain, "--terminal"),
        text: val(plain, "--text"),
      });
      return ok({});
    }
    if (group === "terminal" && action === "read")
      return ok({
        terminal: { tail: ["ORCA_FLOW_URL=http://localhost:5301/"] },
      });
    if (group === "terminal" && action === "list") {
      const wt = val(plain, "--worktree").replace(/^path:/, "");
      return ok({
        terminals: [...state.alive].map((handle) => ({
          handle,
          worktreePath: wt,
          title: "companion-base",
          connected: true,
          writable: true,
          orphaned: false,
        })),
      });
    }
    if (group === "terminal" && action === "close") {
      state.alive.delete(val(plain, "--terminal"));
      return ok({ closed: true });
    }
    return base.runner(cmd, args, opts);
  };
  return state;
}

const answering = (answers = true) => {
  previewDeps.fetch = (async () => {
    if (!answers) throw new Error("refused");
    return { status: 200, body: null };
  }) as unknown as typeof fetch;
};

const TASK_BRANCH = "task/T7-flow";

async function setup(
  preview: Record<string, unknown> | null = {
    up: "make dev",
    down: "make down",
  },
  files: Record<string, string> = {},
  options: { inBaseApps?: boolean; record?: boolean } = {},
) {
  const app = await realpath(await makeRepo({ idPrefix: "T", preview }, files));
  const e2e = await realpath(await makeRepo({ idPrefix: "T" }));
  const other = await realpath(await makeRepo({ idPrefix: "T" }));
  if (options.record !== false)
    await writeCompanionAt(
      path.join(e2e, ".git"),
      "T7",
      {
        command: "run-e2e {previewUrl:app-a} {previewUrl:app-b}",
        apps: [{ name: "app-b", path: other }],
        baseApps:
          options.inBaseApps === false
            ? [{ name: "app-a", path: other }]
            : [{ name: "app-a", path: app }],
      },
      new Date("2026-11-05T00:00:00.000Z"),
      TASK_BRANCH,
    );
  const state = await tempDir("orca-flow-state-");
  const common = path.join(app, ".git");
  const head = await git(app, "rev-parse", "main");
  return { app, e2e, other, state, common, head };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function run(s: Setup, h: Harness, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["preview", "T7", "--companion-base", ...argv], {
    cwd: s.app,
    runner: h.runner,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
    env: { ...process.env, XDG_STATE_HOME: s.state },
  } as never);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const start = (s: Setup, h: Harness, ...argv: string[]) =>
  run(s, h, "--owner", s.e2e, "--no-open", ...argv);

const baseDir = (s: Setup) =>
  outsideWorktreeDir(
    COMPANION_BASE,
    { XDG_STATE_HOME: s.state },
    s.common,
    "T7",
  );
const recordFile = (s: Setup) => companionBaseRecordPath(s.common, "T7");

/** 同じ ID の前の画面の作業ツリーと記録を置く（ターミナルは動いているものにする） */
async function putPreviewBase(s: Setup) {
  const dir = previewBaseWorktreeDir(
    { XDG_STATE_HOME: s.state },
    s.common,
    "T7",
  );
  await mkdir(path.dirname(dir), { recursive: true });
  await git(s.app, "worktree", "add", "--detach", "--quiet", dir, "main");
  const real = await realpath(dir);
  await writePreviewBaseRecord(s.common, {
    id: "T7",
    worktree: real,
    taskWorktree: s.app,
    terminal: "term_pb",
    commit: s.head,
    at: "2026-11-05T00:00:00.000Z",
  });
  return { dir, real, record: previewBaseRecordPath(s.common, "T7") };
}

async function advanceMain(s: Setup): Promise<string> {
  await writeFile(path.join(s.app, "later.txt"), "later\n");
  await git(s.app, "add", "-A");
  await git(s.app, "commit", "--quiet", "-m", "later");
  return git(s.app, "rev-parse", "main");
}

describe("preview --companion-base：起動", () => {
  it("baseBranch の先頭の作業ツリーをリポジトリの外に作り、メインの作業ツリーにターミナルを作り、記録を書いて URL を返す", async () => {
    const s = await setup(undefined, {
      ".orca-flow/setup.sh": "touch setup-ran\n",
    });
    const h = harness();
    answering();
    const r = await start(s, h, "--json");
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as Record<string, unknown>;
    expect(data).toMatchObject({
      id: "T7",
      companionBase: true,
      url: "http://localhost:5301/",
      started: true,
      restarted: false,
      commit: s.head,
    });
    const dir = data.worktree as string;
    expect(dir.startsWith(s.state)).toBe(true);
    expect(dir.startsWith(s.app)).toBe(false);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(s.head);
    expect(await git(dir, "branch", "--show-current")).toBe("");
    expect(await exists(path.join(dir, "setup-ran"))).toBe(true);
    const create = h.orcaCalls.find(
      (c) => c[0] === "terminal" && c[1] === "create",
    )!;
    expect(create).toContain(`path:${s.app}`);
    expect(create[create.indexOf("--title") + 1]).toBe("companion-base");
    expect(h.sent.map((x) => x.text)).toEqual([`cd '${dir}'`, "make dev"]);
    expect(h.orcaCalls.some((c) => c[0] === "tab")).toBe(false);
    expect(JSON.parse(await readFile(recordFile(s), "utf8"))).toEqual({
      id: "T7",
      worktree: dir,
      mainWorktree: s.app,
      terminal: "term_1",
      baseBranch: "main",
      commit: s.head,
      owner: { repo: s.e2e, taskBranch: TASK_BRANCH },
      url: "http://localhost:5301/",
      at: expect.any(String),
    });
  });

  it("--no-open がなければ、アプリのメインの作業ツリーのタブに開く", async () => {
    const s = await setup();
    const h = harness();
    answering();
    const r = await run(s, h, "--owner", s.e2e);
    expect(r.code).toBe(0);
    const tab = h.orcaCalls.find((c) => c[0] === "tab")!;
    expect(tab).toContain("http://localhost:5301/");
    expect(tab).toContain(`path:${s.app}`);
  });

  it("設定の url が固定なら、何も立てずに終了コード2", async () => {
    const s = await setup({ up: "make dev", url: "http://localhost:8080/" });
    const h = harness();
    answering();
    const r = await start(s, h);
    expect(r.code).toBe(2);
    expect(r.err).toContain("固定");
    expect(await exists(baseDir(s))).toBe(false);
    expect(h.orcaCalls.some((c) => c[0] === "terminal")).toBe(false);
  });

  it("setup.sh が落ちたら、作業ツリーを消して終了コード1（ターミナルは作らず、出力も写さない）", async () => {
    const s = await setup(undefined, {
      ".orca-flow/setup.sh": "echo leaked-secret-value; exit 3\n",
    });
    const h = harness();
    answering();
    const r = await start(s, h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("setup.sh");
    expect(r.out + r.err).not.toContain("leaked-secret-value");
    expect(await exists(baseDir(s))).toBe(false);
    expect(await exists(recordFile(s))).toBe(false);
    expect(h.orcaCalls.some((c) => c[0] === "terminal")).toBe(false);
    expect(await git(s.app, "worktree", "list")).not.toContain(
      "companion-base",
    );
  });

  it("違う持ち主の記録があれば、触らずに終了コード1（--stop も同じ）", async () => {
    const s = await setup();
    const h = harness();
    answering();
    await writeCompanionBaseRecord(s.common, {
      id: "T7",
      worktree: baseDir(s),
      mainWorktree: s.app,
      terminal: "term_other",
      baseBranch: "main",
      commit: s.head,
      owner: { repo: s.other, taskBranch: "task/T7-else" },
      url: "http://localhost:5999/",
      at: "2026-11-05T00:00:00.000Z",
    });
    const r = await start(s, h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("別の持ち主");
    const stop = await run(s, h, "--stop", "--owner", s.e2e);
    expect(stop.code).toBe(1);
    expect(stop.err).toContain("別の持ち主");
    expect(await exists(recordFile(s))).toBe(true);
    expect(h.downs).toEqual([]);
    expect(h.orcaCalls.some((c) => c[1] === "create")).toBe(false);
  });

  it("持ち主の taskBranch が違えば、同じリポジトリでも違う持ち主", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await start(s, h)).code).toBe(0);
    await writeCompanionAt(
      path.join(s.e2e, ".git"),
      "T7",
      {
        command: "run-e2e {previewUrl:app-a} {previewUrl:app-b}",
        apps: [{ name: "app-b", path: s.other }],
        baseApps: [{ name: "app-a", path: s.app }],
      },
      new Date("2026-11-06T00:00:00.000Z"),
      "task/T7-again",
    );
    const r = await start(s, h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("別の持ち主");
  });

  it("動いていて先頭が同じなら立て直さず、先頭が進んでいれば down を流して新しい先頭で立て直す", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await start(s, h)).code).toBe(0);
    const again = await start(s, h, "--json");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({
      started: false,
      restarted: false,
    });
    expect(h.sent).toHaveLength(2);
    expect(h.downs).toEqual([]);

    const next = await advanceMain(s);
    const moved = await start(s, h, "--json");
    expect(moved.code).toBe(0);
    const data = JSON.parse(moved.out) as Record<string, unknown>;
    expect(data).toMatchObject({
      started: true,
      restarted: true,
      commit: next,
    });
    expect(h.downs.map((d) => d.command)).toEqual(["make down"]);
    expect(h.alive).toEqual(new Set(["term_2"]));
    expect(await git(data.worktree as string, "rev-parse", "HEAD")).toBe(next);
    expect(JSON.parse(await readFile(recordFile(s), "utf8")).commit).toBe(next);
  });

  it("ターミナルが死んでいれば、記録を捨てて立て直す", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await start(s, h)).code).toBe(0);
    h.alive.clear();
    const again = await start(s, h, "--json");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ started: true });
    expect(h.sent).toHaveLength(4);
  });

  it("--owner がない・伴う記録がない・このアプリが baseApps にないときは、立てずに終了コード1", async () => {
    const h = harness();
    answering();
    const s = await setup();
    const noOwner = await run(s, h, "--no-open");
    expect(noOwner.code).toBe(1);
    expect(noOwner.err).toContain("--owner");
    const noRecord = await setup(undefined, {}, { record: false });
    const r1 = await start(noRecord, h);
    expect(r1.code).toBe(1);
    expect(r1.err).toContain("伴う記録がありません");
    const notBase = await setup(undefined, {}, { inBaseApps: false });
    const r2 = await start(notBase, h);
    expect(r2.code).toBe(1);
    expect(r2.err).toContain("baseApps");
    expect(h.orcaCalls.some((c) => c[0] === "terminal")).toBe(false);
  });

  it("--base・--restart・--after-setup とは一緒に使えず、--owner は --companion-base のときだけ", async () => {
    const s = await setup();
    const h = harness();
    for (const flag of ["--base", "--restart", "--after-setup"]) {
      const r = await start(s, h, flag);
      expect(r.code).toBe(1);
      expect(r.err).toContain("使い方：orca-flow preview");
    }
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["preview", "T7", "--owner", s.e2e], {
      cwd: s.app,
      runner: h.runner,
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
    } as never);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("使い方：orca-flow preview");
    expect(h.orcaCalls).toEqual([]);
  });
});

describe("preview --companion-base --stop", () => {
  it("down・ターミナル・作業ツリー・記録を片づける", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await start(s, h)).code).toBe(0);
    const dir = baseDir(s);
    const real = await realpath(dir);
    const r = await run(s, h, "--stop", "--owner", s.e2e, "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      id: "T7",
      companionBase: true,
      hadRecord: true,
      ranDown: true,
      removedWorktree: true,
    });
    expect(h.downs).toEqual([{ command: "make down", cwd: real }]);
    expect(h.alive.size).toBe(0);
    expect(await exists(dir)).toBe(false);
    expect(await exists(recordFile(s))).toBe(false);
    expect(await git(s.app, "worktree", "list")).not.toContain(
      "companion-base",
    );
  });

  it("--owner なしでも止められ、記録も置き場もなければ何もせず終了コード0", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await start(s, h)).code).toBe(0);
    expect((await run(s, h, "--stop")).code).toBe(0);
    expect(await exists(recordFile(s))).toBe(false);
    const again = await run(s, h, "--stop");
    expect(again.code).toBe(0);
    expect(again.out).toContain("ありません");
    expect(h.downs).toHaveLength(1);
  });

  it("伴う記録が消えたあとも、--owner のリポジトリが同じなら止める", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await start(s, h)).code).toBe(0);
    await rm(path.join(s.e2e, ".git", "orca-flow", "companion"), {
      recursive: true,
      force: true,
    });
    const r = await run(s, h, "--stop", "--owner", s.e2e);
    expect(r.code).toBe(0);
    expect(await exists(recordFile(s))).toBe(false);
  });

  it("--companion-base --stop は前の画面（--base）の記録と作業ツリーを残す", async () => {
    const s = await setup();
    const h = harness();
    answering();
    const pb = await putPreviewBase(s);
    expect((await start(s, h)).code).toBe(0);
    const companionReal = await realpath(baseDir(s));
    const r = await run(s, h, "--stop", "--owner", s.e2e);
    expect(r.code).toBe(0);
    expect(await exists(recordFile(s))).toBe(false);
    expect(await exists(baseDir(s))).toBe(false);
    expect(await exists(pb.record)).toBe(true);
    expect(await exists(pb.dir)).toBe(true);
    expect(await git(s.app, "worktree", "list")).toContain(pb.real);
    expect(h.downs.map((d) => d.cwd)).toEqual([companionReal]);
  });

  it("--base --stop は土台のアプリの記録と作業ツリーを残す", async () => {
    const s = await setup();
    const h = harness();
    answering();
    const pb = await putPreviewBase(s);
    expect((await start(s, h)).code).toBe(0);
    const companionReal = await realpath(baseDir(s));
    const r = await main(["preview", "T7", "--base", "--stop"], {
      cwd: s.app,
      runner: h.runner,
      stdout: () => {},
      stderr: () => {},
      env: { ...process.env, XDG_STATE_HOME: s.state },
    } as never);
    expect(r).toBe(0);
    expect(await exists(pb.record)).toBe(false);
    expect(await exists(pb.dir)).toBe(false);
    expect(await exists(recordFile(s))).toBe(true);
    expect(await exists(baseDir(s))).toBe(true);
    expect(await git(s.app, "worktree", "list")).toContain(companionReal);
    expect(h.downs.map((d) => d.cwd)).toEqual([pb.real]);
    expect(h.alive.has("term_1")).toBe(true);
  });

  it("down が落ちたら終了コード1で、記録を残す", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await start(s, h)).code).toBe(0);
    h.downCode = 4;
    const r = await run(s, h, "--stop", "--owner", s.e2e);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--companion-base --stop");
    expect(await exists(recordFile(s))).toBe(true);
  });
});
