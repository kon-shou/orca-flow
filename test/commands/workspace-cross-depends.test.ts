import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { ORCA_FLOW_MAIN } from "../../src/lib/background.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import { capture, makeRepo, tempDir, writeFiles } from "../init/helpers.ts";

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
      return done({});
    }
    return realRunner(cmd, args, opts);
  };
  return { runner, nodeCalls };
}

function setup() {
  const core = makeRepo();
  const ui = makeRepo();
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
    {
      name: "demo-ui",
      path: ui,
      role: "common",
      keywords: ["部品"],
      scope: "部品",
      package: "@demo/ui",
      bumpCommand: "pnpm up @demo/ui",
    },
    { name: "demo-app", path: app, role: "app", keywords: ["画面"] },
  ];
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  return { core, ui, app, dir };
}

async function call(argv: string[], dir: string) {
  const io = capture();
  const f = fakeNode();
  const code = await main(argv, { ...io, cwd: dir, runner: f.runner });
  return { code, io, nodeCalls: f.nodeCalls };
}

describe("workspace 〈名前〉 new の --cross-depends / --bumps", () => {
  it("設定のパスとパッケージ名に解いた --cross-depends-json になり、元の2つは子に渡らない", async () => {
    const { core, ui, app, dir } = setup();
    const r = await call(
      [
        "workspace",
        "demo-app",
        "new",
        "--title",
        "題",
        "--cross-depends",
        "demo-core:Q1,demo-core:Q2,demo-ui:Q3",
        "--bumps=demo-core=1.2.0,demo-ui=0.3.0",
        "--slug",
        "s",
      ],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.nodeCalls).toHaveLength(1);
    expect(r.nodeCalls[0]!.cwd).toBe(app);
    const args = r.nodeCalls[0]!.args;
    expect(args.join(" ")).not.toContain("--bumps");
    expect(args).not.toContain("--cross-depends");
    const at = args.indexOf("--cross-depends-json");
    expect(at).toBeGreaterThan(0);
    expect(JSON.parse(args[at + 1]!)).toEqual([
      {
        name: "demo-core",
        path: core,
        package: "@demo/core",
        version: "1.2.0",
        ids: ["Q1", "Q2"],
      },
      {
        name: "demo-ui",
        path: ui,
        package: "@demo/ui",
        version: "0.3.0",
        ids: ["Q3"],
      },
    ]);
    expect(args.slice(0, 5)).toEqual(["new", "--title", "題", "--slug", "s"]);
  });

  it("--x=値 の形も受ける", async () => {
    const { dir } = setup();
    const r = await call(
      [
        "workspace",
        "demo-app",
        "new",
        "--cross-depends=demo-core:Q1",
        "--bumps",
        "demo-core=1.0.0",
      ],
      dir,
    );
    expect(r.code).toBe(0);
    const args = r.nodeCalls[0]!.args;
    expect(args[0]).toBe("new");
    expect(args).toHaveLength(3);
    expect(args[1]).toBe("--cross-depends-json");
  });

  it("どちらもなければ今まで通り（--cross-depends-json を足さない）", async () => {
    const { dir } = setup();
    const r = await call(["workspace", "demo-app", "new", "--slug", "s"], dir);
    expect(r.nodeCalls[0]!.args).toEqual(["new", "--slug", "s"]);
  });

  it.each([
    ["知らない名前", "demo-app", "nope:Q1", "nope=1.0.0"],
    ["アプリが依存先", "demo-app", "demo-app:Q1", "demo-app=1.0.0"],
    ["共通の子への new", "demo-ui", "demo-core:Q1", "demo-core=1.0.0"],
    ["版のない依存先", "demo-app", "demo-core:Q1", undefined],
    ["依存のない版", "demo-app", undefined, "demo-core=1.0.0"],
  ])("%s は子を流さず1", async (_label, child, dep, bump) => {
    const { dir } = setup();
    const argv = ["workspace", child, "new", "--slug", "s"];
    if (dep) argv.push("--cross-depends", dep);
    if (bump) argv.push("--bumps", bump);
    const r = await call(argv, dir);
    expect(r.code).toBe(1);
    expect(r.nodeCalls).toEqual([]);
    expect(r.io.errText()).not.toBe("");
  });

  it.each([[["--cross-depends-json", "[]"]], [["--cross-depends-json=[]"]]])(
    "--cross-depends-json は子に通さず1（%j）",
    async (extra) => {
      const { dir } = setup();
      const r = await call(
        ["workspace", "demo-app", "new", "--slug", "s", ...extra],
        dir,
      );
      expect(r.code).toBe(1);
      expect(r.nodeCalls).toEqual([]);
      expect(r.io.errText()).toContain("--cross-depends-json は渡せません");
    },
  );
});
