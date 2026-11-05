import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { ORCA_FLOW_MAIN } from "../../src/lib/background.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import { capture, makeRepo, tempDir, writeFiles } from "../init/helpers.ts";

const done = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

function fakeNode() {
  const nodeCalls: {
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === process.execPath) {
      expect(args[1]).toBe(ORCA_FLOW_MAIN);
      nodeCalls.push({ args: args.slice(2), cwd: opts?.cwd, env: opts?.env });
      return done({});
    }
    return realRunner(cmd, args, opts);
  };
  return { runner, nodeCalls };
}

function setup(withBranchCommand = true) {
  const core = makeRepo();
  const plain = makeRepo();
  const app = makeRepo();
  const dir = tempDir("orca-flow-ws-");
  const repos = [
    {
      name: "core-kit",
      path: core,
      role: "common",
      keywords: ["共通"],
      scope: "共通の処理",
      package: "acme/core-kit",
      bumpCommand: "composer require acme/core-kit:^1",
      ...(withBranchCommand
        ? { branchCommand: "composer require core-kit:dev-{branch}" }
        : {}),
    },
    {
      name: "plain-kit",
      path: plain,
      role: "common",
      keywords: ["部品"],
      scope: "部品",
      package: "acme/plain-kit",
      bumpCommand: "composer require acme/plain-kit:^1",
    },
    { name: "shop-app", path: app, role: "app", keywords: ["画面"] },
  ];
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  return { core, plain, app, dir };
}

async function call(argv: string[], dir: string) {
  const io = capture();
  const f = fakeNode();
  const code = await main(argv, { ...io, cwd: dir, runner: f.runner });
  return { code, io, nodeCalls: f.nodeCalls };
}

const base = ["workspace", "shop-app", "new"];

describe("workspace 〈名前〉 new の --branches", () => {
  it("設定の branchCommand を置き換えた記録の JSON にして子へ渡し、--branches は渡らない", async () => {
    const { core, app, dir } = setup();
    const r = await call(
      [
        ...base,
        "--title",
        "題",
        "--cross-depends",
        "core-kit:K01,plain-kit:Q01",
        "--branches",
        "core-kit=task/K01-fix",
        "--bumps=plain-kit=2.0.0",
      ],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.nodeCalls).toHaveLength(1);
    expect(r.nodeCalls[0]!.cwd).toBe(app);
    const args = r.nodeCalls[0]!.args;
    expect(args.join(" ")).not.toContain("--branches");
    const at = args.indexOf("--cross-depends-json");
    const json = JSON.parse(args[at + 1]!);
    expect(json[0]).toEqual({
      name: "core-kit",
      path: core,
      package: "acme/core-kit",
      branch: "task/K01-fix",
      branchCommand: "composer require core-kit:dev-task/K01-fix",
      bumpCommand: "composer require acme/core-kit:^1",
      ids: ["K01"],
    });
    expect(json[1].version).toBe("2.0.0");
  });

  it("--branches=値 の形も受ける", async () => {
    const { dir } = setup();
    const r = await call(
      [...base, "--cross-depends=core-kit:K01", "--branches=core-kit=feat/x"],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.nodeCalls[0]!.args).toHaveLength(3);
  });

  it("branchCommand のない共通・同じ名前の両方・枝の形の外れは、子を流さず終了コード1", async () => {
    const cases: [boolean, string[]][] = [
      [true, ["--cross-depends", "plain-kit:Q01", "--branches", "plain-kit=x"]],
      [
        true,
        [
          "--cross-depends",
          "core-kit:K01",
          "--bumps",
          "core-kit=1.0.0",
          "--branches",
          "core-kit=x",
        ],
      ],
      [true, ["--cross-depends", "core-kit:K01", "--branches", "core-kit=a;b"]],
      [false, ["--cross-depends", "core-kit:K01", "--branches", "core-kit=x"]],
    ];
    for (const [withCommand, extra] of cases) {
      const { dir } = setup(withCommand);
      const r = await call([...base, ...extra], dir);
      expect(r.code).toBe(1);
      expect(r.nodeCalls).toHaveLength(0);
    }
  });

  it.each([["--allow-branch-push"], ["--allow-branch-push=1"]])(
    "アプリへの new に %s があれば子を流さず1。branchCommand のある共通へは環境変数つきで流す",
    async (flag) => {
      const { dir } = setup();
      const r = await call([...base, flag], dir);
      expect(r.code).toBe(1);
      expect(r.nodeCalls).toHaveLength(0);
      expect(r.io.errText()).toContain("--allow-branch-push");
      const ok = await call(["workspace", "core-kit", "new", flag], dir);
      expect(ok.code).toBe(0);
      expect(ok.nodeCalls).toHaveLength(1);
      expect(ok.nodeCalls[0]!.env?.ORCA_FLOW_FROM_WORKSPACE).toBe("1");
    },
  );

  it.each([["--allow-branch-push"], ["--allow-branch-push=1"]])(
    "branchCommand のない共通への new に %s があれば子を流さず1",
    async (flag) => {
      const { dir } = setup();
      const r = await call(["workspace", "plain-kit", "new", flag], dir);
      expect(r.code).toBe(1);
      expect(r.nodeCalls).toHaveLength(0);
      expect(r.io.errText()).toContain("branchCommand");
      // branchCommand がなければ、--allow-branch-push なしの new は今までどおり流す
      const ok = await call(["workspace", "plain-kit", "new"], dir);
      expect(ok.code).toBe(0);
      expect(ok.nodeCalls).toHaveLength(1);
    },
  );

  it("workspace --json に branchCommand が出る（なければキーがない）", async () => {
    const { dir } = setup();
    const r = await call(["workspace", "--json"], dir);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; branchCommand?: string }[];
    };
    expect(data.repos.map((x) => x.branchCommand)).toEqual([
      "composer require core-kit:dev-{branch}",
      undefined,
      undefined,
    ]);
  });
});
