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
  const nodeCalls: { args: string[]; cwd?: string }[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === process.execPath) {
      expect(args.slice(0, 2)).toEqual([
        "--disable-warning=ExperimentalWarning",
        ORCA_FLOW_MAIN,
      ]);
      nodeCalls.push({ args: args.slice(2), cwd: opts?.cwd });
      return done({});
    }
    return realRunner(cmd, args, opts);
  };
  return { runner, nodeCalls };
}

function setup() {
  const core = makeRepo();
  const app = makeRepo();
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
    { name: "demo-app", path: app, role: "app", keywords: ["画面"] },
  ];
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  return { core, app, dir };
}

async function call(argv: string[], dir: string) {
  const io = capture();
  const f = fakeNode();
  const code = await main(argv, { ...io, cwd: dir, runner: f.runner });
  return { code, io, nodeCalls: f.nodeCalls };
}

const valueOf = (args: string[], key: string) => {
  const at = args.indexOf(key);
  return at < 0 ? undefined : args[at + 1];
};

describe("workspace 〈名前〉 new --start-after", () => {
  it("ほかの子の名前は実のパスつきの --start-after-json に、同じ子の ID は --start-after にして渡す", async () => {
    const { core, app, dir } = setup();
    const r = await call(
      [
        "workspace",
        "demo-app",
        "new",
        "--title",
        "題",
        "--slug",
        "s",
        "--start-after",
        "demo-core:C1,demo-app:A2",
        "--start-after=demo-core:C3",
      ],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.nodeCalls).toHaveLength(1);
    expect(r.nodeCalls[0]!.cwd).toBe(app);
    const args = r.nodeCalls[0]!.args;
    expect(args.slice(0, 5)).toEqual(["new", "--title", "題", "--slug", "s"]);
    expect(args.filter((a) => a.startsWith("--start-after="))).toEqual([]);
    expect(valueOf(args, "--start-after")).toBe("A2");
    expect(JSON.parse(valueOf(args, "--start-after-json")!)).toEqual([
      { name: "demo-core", path: core, ids: ["C1", "C3"] },
    ]);
  });

  it("ほかの子だけなら --start-after を渡さない", async () => {
    const { dir } = setup();
    const r = await call(
      ["workspace", "demo-app", "new", "--start-after", "demo-core:C1"],
      dir,
    );
    expect(r.code).toBe(0);
    const args = r.nodeCalls[0]!.args;
    expect(args).not.toContain("--start-after");
    expect(args).toContain("--start-after-json");
  });

  it("付けなければ今まで通り", async () => {
    const { dir } = setup();
    const r = await call(["workspace", "demo-app", "new", "--slug", "s"], dir);
    expect(r.code).toBe(0);
    expect(r.nodeCalls[0]!.args).toEqual(["new", "--slug", "s"]);
  });

  it("知らない名前は子を流さず終了コード1", async () => {
    const { dir } = setup();
    const r = await call(
      ["workspace", "demo-app", "new", "--start-after", "nobody:C1"],
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.nodeCalls).toHaveLength(0);
    expect(r.io.errText()).toContain("nobody");
  });

  it("〈名前〉:〈ID〉 の形でなければ子を流さず終了コード1", async () => {
    const { dir } = setup();
    const r = await call(
      ["workspace", "demo-app", "new", "--start-after", "C1"],
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.nodeCalls).toHaveLength(0);
  });

  it("親からの --start-after-json は子を流さず終了コード1", async () => {
    const { core, dir } = setup();
    const json = JSON.stringify([
      { name: "demo-core", path: core, ids: ["C1"] },
    ]);
    for (const argv of [
      ["--start-after-json", json],
      [`--start-after-json=${json}`],
    ]) {
      const r = await call(["workspace", "demo-app", "new", ...argv], dir);
      expect(r.code).toBe(1);
      expect(r.nodeCalls).toHaveLength(0);
      expect(r.io.errText()).toContain("--start-after-json");
    }
  });

  it("new のほかのサブコマンドに --start-after は付けられない", async () => {
    const { dir } = setup();
    const r = await call(
      ["workspace", "demo-app", "active", "--start-after", "demo-core:C1"],
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.nodeCalls).toHaveLength(0);
  });

  it("--stack-on は今の素通しのまま", async () => {
    const { dir } = setup();
    const r = await call(
      ["workspace", "demo-app", "new", "--stack-on", "A1"],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.nodeCalls[0]!.args).toEqual(["new", "--stack-on", "A1"]);
  });
});
