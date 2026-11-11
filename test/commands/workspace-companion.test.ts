import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { readCompanion, writeCompanionAt } from "../../src/lib/companion.ts";
import { ORCA_FLOW_MAIN } from "../../src/lib/background.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import { capture, makeRepo, tempDir, writeFiles } from "../init/helpers.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { git, makeRepo as makeRepoAsync } from "../helpers/repo.ts";

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

interface NodeCall {
  args: string[];
  cwd?: string;
}

const done = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

function fakeNode() {
  const nodeCalls: NodeCall[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === process.execPath) {
      expect(args.slice(0, 2)).toEqual([
        "--disable-warning=ExperimentalWarning",
        ORCA_FLOW_MAIN,
      ]);
      nodeCalls.push({ args: args.slice(2), cwd: opts?.cwd });
      return done({ stdout: JSON.stringify({ baseBranch: "main" }) });
    }
    return realRunner(cmd, args, opts);
  };
  return { runner, nodeCalls };
}

const COMMAND = "pnpm test:e2e --base-url {previewUrl:shop}";

function setup() {
  const core = makeRepo();
  const shop = makeRepo();
  const tests = makeRepo();
  const dir = tempDir("orca-flow-ws-");
  const repos = [
    {
      name: "demo-core",
      path: core,
      role: "common",
      keywords: ["共通"],
      scope: "共通の処理",
      package: "@demo/core",
      bumpCommand: "pnpm up @demo/core",
    },
    { name: "shop", path: shop, role: "app", keywords: ["画面"] },
    {
      name: "e2e-tests",
      path: tests,
      role: "app",
      keywords: ["e2e"],
      companion: {
        apps: ["shop"],
        when: "利用者から見た画面の動きが変わるとき",
        command: COMMAND,
      },
    },
  ];
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  return { shop, tests, dir };
}

async function call(argv: string[], dir: string) {
  const io = capture();
  const f = fakeNode();
  const code = await main(argv, { ...io, cwd: dir, runner: f.runner });
  return { code, io, nodeCalls: f.nodeCalls };
}

describe("workspace 一覧の companion", () => {
  it("--json は書いた子だけに companion を出し、ほかの子にはキーを出さない", async () => {
    const { dir } = setup();
    const r = await call(["workspace", "--json"], dir);
    const repos = JSON.parse(r.io.text()).repos as Record<string, unknown>[];
    const by = Object.fromEntries(repos.map((x) => [x.name as string, x]));
    expect(by["e2e-tests"]!.companion).toEqual({
      apps: ["shop"],
      when: "利用者から見た画面の動きが変わるとき",
      command: COMMAND,
    });
    expect("companion" in by["shop"]!).toBe(false);
    expect("companion" in by["demo-core"]!).toBe(false);
  });
});

describe("workspace 〈名前〉 new --companion", () => {
  it("名前を実のパスと command に解いた --companion-json を子に渡し、--companion は渡さない", async () => {
    const { shop, tests, dir } = setup();
    const r = await call(
      [
        "workspace",
        "e2e-tests",
        "new",
        "--title",
        "題",
        "--companion",
        "shop",
        "--slug",
        "s",
      ],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.nodeCalls).toHaveLength(1);
    expect(r.nodeCalls[0]!.cwd).toBe(tests);
    const args = r.nodeCalls[0]!.args;
    expect(args).not.toContain("--companion");
    expect(args.slice(0, 5)).toEqual(["new", "--title", "題", "--slug", "s"]);
    const at = args.indexOf("--companion-json");
    expect(JSON.parse(args[at + 1]!)).toEqual({
      command: COMMAND,
      apps: [{ name: "shop", path: shop }],
    });
  });

  it("--companion=値 の形も受け、付けなければ --companion-json も付かない", async () => {
    const { dir } = setup();
    const a = await call(
      ["workspace", "e2e-tests", "new", "--companion=shop"],
      dir,
    );
    expect(a.nodeCalls[0]!.args).toHaveLength(3);
    expect(a.nodeCalls[0]!.args[1]).toBe("--companion-json");
    const b = await call(["workspace", "e2e-tests", "new", "--slug", "s"], dir);
    expect(b.nodeCalls[0]!.args).not.toContain("--companion-json");
  });

  it("companion のない子・apps にない名前・new 以外では、子を流さず終了コード1", async () => {
    const { dir } = setup();
    for (const argv of [
      ["workspace", "shop", "new", "--companion", "shop"],
      ["workspace", "e2e-tests", "new", "--companion", "demo-core"],
      ["workspace", "e2e-tests", "preview", "--companion", "shop"],
      ["workspace", "e2e-tests", "new", "--companion-json", "{}"],
    ]) {
      const r = await call(argv, dir);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.nodeCalls).toEqual([]);
    }
  });
});

describe("workspace 〈名前〉 new --companion の一部", () => {
  it("command が使う印の名前が --companion に足りなくても子を流し、足りないアプリを子への JSON の baseApps に入れる", async () => {
    const shop = makeRepo();
    const admin = makeRepo();
    const tests = makeRepo();
    const core = makeRepo();
    const dir = tempDir("orca-flow-ws-");
    const repos = [
      {
        name: "demo-core",
        path: core,
        role: "common",
        keywords: ["共通"],
        scope: "共通の処理",
        package: "@demo/core",
        bumpCommand: "pnpm up @demo/core",
      },
      { name: "shop", path: shop, role: "app", keywords: ["画面"] },
      { name: "admin", path: admin, role: "app", keywords: ["管理"] },
      {
        name: "e2e-tests",
        path: tests,
        role: "app",
        keywords: ["e2e"],
        companion: {
          apps: ["shop", "admin"],
          when: "画面が変わるとき",
          command: "A={previewUrl:shop} B={previewUrl:admin} run",
        },
      },
    ];
    writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
    const r = await call(
      ["workspace", "e2e-tests", "new", "--companion", "shop"],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.nodeCalls).toHaveLength(1);
    expect(r.nodeCalls[0]!.cwd).toBe(tests);
    const args = r.nodeCalls[0]!.args;
    expect(JSON.parse(args[args.indexOf("--companion-json") + 1]!)).toEqual({
      command: "A={previewUrl:shop} B={previewUrl:admin} run",
      apps: [{ name: "shop", path: shop }],
      baseApps: [{ name: "admin", path: admin }],
    });
    const ok = await call(
      ["workspace", "e2e-tests", "new", "--companion", "shop,admin"],
      dir,
    );
    expect(ok.code).toBe(0);
    const okArgs = ok.nodeCalls[0]!.args;
    expect(
      JSON.parse(okArgs[okArgs.indexOf("--companion-json") + 1]!),
    ).not.toHaveProperty("baseApps");
  });
});

describe("new --companion-json", () => {
  const json = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      command: COMMAND,
      apps: [{ name: "shop", path: "/tmp/shop-main" }],
      ...over,
    });
  const newTask = (
    root: string,
    orca: ReturnType<typeof fakeOrca>,
    value?: string,
  ) =>
    runCli(
      [
        "new",
        "--title",
        "a",
        "--slug",
        "a",
        ...(value === undefined ? [] : ["--companion-json", value]),
      ],
      { cwd: root, runner: orca.runner },
    );

  async function root() {
    const r = await makeRepoAsync();
    const common = await git(
      r,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    return { r, file: path.join(common, "orca-flow/companion/T01.json") };
  }

  it("記録を作業ツリーの外に書く", async () => {
    const { r, file } = await root();
    const result = await newTask(r, fakeOrca(), json());
    expect(result.code).toBe(0);
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record).toMatchObject({
      id: "T01",
      command: COMMAND,
      apps: [{ name: "shop", path: "/tmp/shop-main" }],
    });
    expect(typeof record.at).toBe("string");
  });

  it("記録にタスクのブランチ名を書き、読む関数が返す", async () => {
    const { r, file } = await root();
    expect((await newTask(r, fakeOrca(), json())).code).toBe(0);
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record.taskBranch).toBe("task/T01-a");
    expect((await readCompanion(realRunner, r, "T01"))?.taskBranch).toBe(
      "task/T01-a",
    );
  });

  it("形の外れは Orca を呼ぶ前に終了コード1で止まり、記録も worktree も作らない", async () => {
    for (const value of [
      "{",
      json({ taskBranch: "task/T01-a" }),
      json({ apps: [] }),
      json({ command: "pnpm test:e2e" }),
      json({ command: "run {previewUrl:other}" }),
    ]) {
      const { r, file } = await root();
      const orca = fakeOrca();
      const result = await newTask(r, orca, value);
      expect(result.code, value).toBe(1);
      expect(orca.calls).toEqual([]);
      await expect(stat(file)).rejects.toThrow();
      expect(await git(r, "branch", "--list", "task/*")).toBe("");
    }
  });

  it("付けない new は同じ ID の古い記録を消す", async () => {
    const { r, file } = await root();
    const common = path.dirname(path.dirname(path.dirname(file)));
    await writeCompanionAt(common, "T01", JSON.parse(json()), new Date());
    await stat(file);
    expect((await newTask(r, fakeOrca())).code).toBe(0);
    await expect(stat(file)).rejects.toThrow();
  });
});
