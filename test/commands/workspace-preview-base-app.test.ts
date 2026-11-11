import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { writeCompanionAt } from "../../src/lib/companion.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import { previewDeps, writePreviewRecord } from "../../src/lib/preview.ts";
import { writeStartAfterAt } from "../../src/lib/start-after.ts";
import {
  capture,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../init/helpers.ts";

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

const GROUP_BRANCH = "task/T1-flow";
const SECRET = "TOKEN=abc123-secret";
const T0 = new Date("2026-11-05T00:00:00.000Z");

const done = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

const commonOf = (root: string) => path.join(root, ".git");

interface Setup {
  dir: string;
  paths: Record<string, string>;
}

/** core（共通）・app-a・app-b・e2e（app-a と app-b に伴う）。組のブランチは e2e と app-b にだけある */
async function setup(
  options: {
    baseApps?: boolean;
    /** 伴う記録の taskBranch（既定は組のブランチ） */
    taskBranch?: string;
    /** e2e に置くブランチ（既定は組のブランチ） */
    e2eBranch?: string;
    /** true なら baseApps の app-a のパスを、ワークスペースの設定にないリポジトリにする */
    strayBaseApp?: boolean;
  } = {},
): Promise<Setup> {
  const dir = tempDir("orca-flow-wspb-");
  const config = JSON.stringify({ idPrefix: "T" });
  const paths: Record<string, string> = {
    core: makeRepo(),
    "app-a": makeRepo({ ".orca-flow/config.json": config }),
    "app-b": makeRepo({ ".orca-flow/config.json": config }),
    e2e: makeRepo({ ".orca-flow/config.json": config }),
    stray: makeRepo({ ".orca-flow/config.json": config }),
  };
  for (const key of Object.keys(paths)) paths[key] = realpathSync(paths[key]!);
  const repos = [
    {
      name: "core",
      path: paths.core,
      role: "common",
      keywords: ["共通"],
      scope: "共通",
      package: "@demo/core",
      bumpCommand: "pnpm up @demo/core",
    },
    { name: "app-a", path: paths["app-a"], role: "app", keywords: ["a"] },
    { name: "app-b", path: paths["app-b"], role: "app", keywords: ["b"] },
    {
      name: "e2e",
      path: paths.e2e,
      role: "app",
      keywords: ["e2e"],
      companion: {
        apps: ["app-a", "app-b"],
        when: "画面の動きが変わるとき",
        command: "run-e2e {previewUrl:app-a} {previewUrl:app-b}",
      },
    },
  ];
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  git(paths.e2e!, "branch", options.e2eBranch ?? GROUP_BRANCH);
  git(paths["app-b"]!, "branch", GROUP_BRANCH);
  await writeCompanionAt(
    commonOf(paths.e2e!),
    "T1",
    {
      command:
        options.baseApps === false
          ? "run-e2e {previewUrl:app-b}"
          : "run-e2e {previewUrl:app-a} {previewUrl:app-b}",
      apps: [{ name: "app-b", path: paths["app-b"]! }],
      ...(options.baseApps === false
        ? {}
        : {
            baseApps: [
              {
                name: "app-a",
                path: options.strayBaseApp ? paths.stray! : paths["app-a"]!,
              },
            ],
          }),
    },
    T0,
    options.taskBranch ?? GROUP_BRANCH,
  );
  return { dir, paths };
}

/** e2e の T1 の前を待つ印に app-a の id を置き、app-a にそのタスクのブランチ（worktree つきなら作業中）を作る */
async function dependOnAppA(
  s: Setup,
  id: string,
  options: { active: boolean },
): Promise<string> {
  const app = s.paths["app-a"]!;
  const branch = `task/${id}-change`;
  const wt = path.join(tempDir("orca-flow-wspb-wt-"), `${id}-change`);
  git(app, "worktree", "add", "--quiet", "-b", branch, wt, "main");
  writeFiles(wt, { "change.txt": "x\n" });
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", `${id}: 変える`);
  if (!options.active) git(app, "worktree", "remove", "--force", wt);
  await writeStartAfterAt(
    commonOf(s.paths.e2e!),
    "T1",
    [
      {
        id,
        repo: { name: "app-a", path: app },
        wait: "implemented",
      },
    ],
    T0,
  );
  return wt;
}

interface Opts {
  /** 子の preview --companion-base --stop の答えの hadRecord */
  hadBase?: boolean;
  /** 子の preview が落ちる子の名前 */
  failing?: string[];
}

function harness(s: Setup, opts: Opts = {}) {
  const events: string[] = [];
  const nameOf = (cwd: string) =>
    Object.keys(s.paths).find((n) => s.paths[n] === cwd) ?? cwd;
  const runner: Runner = async (cmd, args, o) => {
    if (cmd === "orca")
      return done({ stdout: JSON.stringify({ ok: true, result: {} }) });
    if (cmd !== process.execPath) return realRunner(cmd, args, o ?? {});
    const [sub, ...rest] = args.slice(2);
    const name = nameOf(o?.cwd ?? "");
    if (sub === "config")
      return done({
        stdout: JSON.stringify({
          baseBranch: "main",
          preview: name === "e2e" ? null : { up: "x", timeoutSeconds: 5 },
        }),
      });
    if (sub === "active")
      return done({
        stdout: JSON.stringify(
          name === "app-b" || name === "e2e"
            ? [{ id: "T1", path: `/wt/${name}` }]
            : [],
        ),
      });
    if (sub === "preview") {
      events.push(`${name}:${rest.join(" ")}`);
      if (opts.failing?.includes(name))
        return done({
          code: 1,
          stderr: `orca-flow: 立ちませんでした\n${SECRET}`,
        });
      if (rest.includes("--stop"))
        return done({
          stdout: JSON.stringify({
            id: rest[0],
            companionBase: rest.includes("--companion-base"),
            hadRecord: opts.hadBase ?? true,
            hadLeftover: false,
            ranDown: false,
            closedTerminal: false,
            removedWorktree: false,
          }),
        });
      const tag = rest.includes("--companion-base") ? "-base" : `-${rest[0]}`;
      return done({
        stdout: JSON.stringify({
          id: rest[0],
          url: `http://${name}${tag}.test/`,
          extra: SECRET,
        }),
      });
    }
    return done({ code: 1 });
  };
  return { runner, events };
}

async function call(argv: string[], s: Setup, opts: Opts = {}) {
  const h = harness(s, opts);
  const io = capture();
  const code = await main(argv, {
    ...io,
    cwd: s.dir,
    runner: h.runner,
    env: { ...process.env },
  } as never);
  return { code, io, events: h.events };
}

interface Row {
  name: string;
  url: string | null;
  result: string;
  reason: string | null;
  baseApp?: { e2e: string; source: string | null; task?: string };
}

const rowsOf = (r: { io: { out: string[] } }) =>
  (JSON.parse(r.io.out.join("\n")) as { repos: Row[] }).repos;

const answering = (answers: boolean) => {
  const seen: string[] = [];
  previewDeps.fetch = (async (url: string) => {
    seen.push(String(url));
    if (!answers) throw new Error("refused");
    return { status: 200, body: null };
  }) as unknown as typeof fetch;
  return seen;
};

describe("workspace --preview の土台のアプリ", () => {
  it("前を待つ印がなければ、アプリの子に E2E のタスクの ID で土台のアプリを立てさせ、行に出どころを出す", async () => {
    const s = await setup();
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "app-b:T1 --after-setup --no-open --json",
      `app-a:T1 --companion-base --owner ${s.paths.e2e} --no-open --json`,
    ]);
    const row = rowsOf(r).find((x) => x.baseApp !== undefined)!;
    expect(row).toMatchObject({
      name: "app-a",
      url: "http://app-a-base.test/",
      result: "started",
      reason: null,
      baseApp: { e2e: "e2e", source: "baseBranch" },
    });
    expect(r.io.out.join("\n") + r.io.err.join("\n")).not.toContain(SECRET);
  });

  it("答えている依存元のタスクのプレビューは、立て直さず使い回す", async () => {
    const s = await setup();
    const wt = await dependOnAppA(s, "T5", { active: true });
    await writePreviewRecord(commonOf(s.paths["app-a"]!), {
      id: "T5",
      worktree: wt,
      terminal: "term_dep",
      url: "http://localhost:5400/",
      at: T0.toISOString(),
    });
    const seen = answering(true);
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual(["app-b:T1 --after-setup --no-open --json"]);
    expect(seen).toContain("http://localhost:5400/");
    expect(
      rowsOf(r).find((x) => x.name === "app-a" && x.baseApp),
    ).toMatchObject({
      url: "http://localhost:5400/",
      result: "reused",
      baseApp: { e2e: "e2e", source: "task", task: "T5" },
    });
  });

  it("依存元のタスクのプレビューが答えなければ、アプリの子にその ID の preview を流す", async () => {
    const s = await setup();
    const wt = await dependOnAppA(s, "T5", { active: true });
    await writePreviewRecord(commonOf(s.paths["app-a"]!), {
      id: "T5",
      worktree: wt,
      terminal: "term_dep",
      url: "http://localhost:5400/",
      at: T0.toISOString(),
    });
    answering(false);
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "app-b:T1 --after-setup --no-open --json",
      "app-a:T5 --after-setup --no-open --json",
    ]);
    expect(
      rowsOf(r).find((x) => x.name === "app-a" && x.baseApp),
    ).toMatchObject({
      url: "http://app-a-T5.test/",
      result: "started",
      baseApp: { source: "task", task: "T5" },
    });
  });

  it("決めきれないアプリは失敗の行に理由を出し、終了コード1", async () => {
    const s = await setup();
    await dependOnAppA(s, "T5", { active: false });
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
    expect(r.code).toBe(1);
    expect(r.events).toEqual(["app-b:T1 --after-setup --no-open --json"]);
    const row = rowsOf(r).find((x) => x.name === "app-a" && x.baseApp)!;
    expect(row).toMatchObject({
      result: "failed",
      baseApp: { source: "undecided" },
    });
    expect(row.reason).toContain("T5");
    expect(r.io.err.join("\n")).toContain("T5");
  });

  it("土台のアプリの子が落ちたら、stderr の理由の行だけを失敗の行に出す", async () => {
    const s = await setup();
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--json"],
      s,
      {
        failing: ["app-a"],
      },
    );
    expect(r.code).toBe(1);
    const row = rowsOf(r).find((x) => x.name === "app-a" && x.baseApp)!;
    expect(row.result).toBe("failed");
    expect(row.reason).toContain("立ちませんでした");
    expect(r.io.out.join("\n") + r.io.err.join("\n")).not.toContain(SECRET);
  });

  it("--base（前の画面）では土台のアプリを立てない", async () => {
    const s = await setup();
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--base"], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual(["app-b:T1 --base --no-open --json"]);
  });

  it("baseApps のない伴う記録では、今までと同じ子だけを流す", async () => {
    const s = await setup({ baseApps: false });
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual(["app-b:T1 --after-setup --no-open --json"]);
    expect(rowsOf(r).some((x) => x.baseApp !== undefined)).toBe(false);
  });
});

describe("workspace --preview --stop の土台のアプリ", () => {
  it("土台のアプリだけを止め、依存元のタスクのプレビューは止めない", async () => {
    const s = await setup();
    await dependOnAppA(s, "T5", { active: true });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--stop", "--json"],
      s,
    );
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      `app-a:T1 --companion-base --stop --owner ${s.paths.e2e} --json`,
      "e2e:T1 --stop",
      "app-b:T1 --stop",
    ]);
    expect(r.events.some((e) => e.includes("T5"))).toBe(false);
    expect(
      rowsOf(r).find((x) => x.name === "app-a" && x.baseApp),
    ).toMatchObject({
      result: "stopped",
      baseApp: { e2e: "e2e", source: null },
    });
  });

  it("止める土台のアプリがなければ飛ばした行にする", async () => {
    const s = await setup();
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--stop", "--json"],
      s,
      { hadBase: false },
    );
    expect(r.code).toBe(0);
    expect(
      rowsOf(r).find((x) => x.name === "app-a" && x.baseApp),
    ).toMatchObject({ result: "skipped", reason: "土台のアプリがありません" });
  });

  it("--base --stop では土台のアプリを止めない", async () => {
    const s = await setup();
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--stop"],
      s,
    );
    expect(r.code).toBe(0);
    expect(r.events.some((e) => e.includes("--companion-base"))).toBe(false);
  });
});

describe("workspace --preview の土台のアプリを飛ばす・落ちる道", () => {
  const OTHER = "task/T1-other";
  const start = (s: Setup) =>
    call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
  const stop = (s: Setup) =>
    call(["workspace", "--preview", GROUP_BRANCH, "--stop", "--json"], s);
  const baseRows = (r: { io: { out: string[] } }) =>
    rowsOf(r).filter((x) => x.baseApp !== undefined);

  it("伴う記録の taskBranch が組のブランチと違えば、立てるときは飛ばす", async () => {
    const s = await setup({ taskBranch: OTHER });
    const r = await start(s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual(["app-b:T1 --after-setup --no-open --json"]);
    expect(baseRows(r)).toEqual([]);
  });

  it("伴う記録の taskBranch が組のブランチと違えば、--stop でも飛ばす", async () => {
    const s = await setup({ taskBranch: OTHER });
    const r = await stop(s);
    expect(r.code).toBe(0);
    expect(r.events.some((e) => e.includes("--companion-base"))).toBe(false);
    expect(baseRows(r)).toEqual([]);
  });

  it("E2E の子が組の外なら、立てるときも --stop でも飛ばす", async () => {
    const s = await setup({ e2eBranch: OTHER });
    const r = await start(s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual(["app-b:T1 --after-setup --no-open --json"]);
    expect(baseRows(r)).toEqual([]);
    const stopped = await stop(s);
    expect(stopped.code).toBe(0);
    expect(stopped.events).toEqual(["app-b:T1 --stop"]);
    expect(baseRows(stopped)).toEqual([]);
  });

  it("伴う記録を読めなければ、E2E の子の名前で失敗の行が出る（立てるときも --stop でも）", async () => {
    const s = await setup();
    await writeFile(
      path.join(commonOf(s.paths.e2e!), "orca-flow", "companion", "T1.json"),
      "{",
    );
    for (const r of [await start(s), await stop(s)]) {
      expect(r.code).toBe(1);
      expect(r.events.some((e) => e.includes("--companion-base"))).toBe(false);
      const rows = baseRows(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "e2e",
        result: "failed",
        baseApp: { e2e: "e2e", source: null },
      });
      expect(rows[0]!.reason).toContain("伴う記録を読めません");
    }
  });

  it("baseApps のパスがワークスペースのアプリになければ、失敗の行と理由が出る（立てるときも --stop でも）", async () => {
    const s = await setup({ strayBaseApp: true });
    for (const r of [await start(s), await stop(s)]) {
      expect(r.code).toBe(1);
      expect(r.events.some((e) => e.includes("--companion-base"))).toBe(false);
      const rows = baseRows(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: "app-a", result: "failed" });
      expect(rows[0]!.reason).toContain(s.paths.stray!);
      expect(rows[0]!.reason).toContain(
        "ワークスペースの設定のアプリにありません",
      );
    }
  });
});
