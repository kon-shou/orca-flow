import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { ORCA_FLOW_MAIN } from "../../src/lib/background.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import {
  capture,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../init/helpers.ts";

interface NodeCall {
  file: string;
  args: string[];
  cwd?: string;
}
type Child = (call: NodeCall) => Partial<RunResult>;

const done = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});
const configAnswer = (baseBranch = "main") => ({
  code: 0,
  stdout: JSON.stringify({ baseBranch }),
});

/** git は本物、node（子の CLI）は child に回す Runner */
function fakeNode(child: Child) {
  const nodeCalls: NodeCall[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === process.execPath) {
      // 他の起こし方（bin/orca-flow など）と同じ形：警告の抑止 → main.ts → 引数
      expect(args[0]).toBe("--disable-warning=ExperimentalWarning");
      const call = { file: args[1]!, args: args.slice(2), cwd: opts?.cwd };
      nodeCalls.push(call);
      return done(child(call));
    }
    return realRunner(cmd, args, opts);
  };
  return { runner, nodeCalls };
}

function setup(extra: Record<string, unknown>[] = []) {
  const common = makeRepo();
  const app = makeRepo();
  const dir = tempDir("orca-flow-ws-");
  const repos = [
    {
      name: "demo-core",
      path: common,
      role: "common",
      keywords: ["共通"],
      scope: "共通の処理",
      package: "@demo/core",
      bumpCommand: "pnpm up @demo/core",
    },
    { name: "demo-app", path: app, role: "app", keywords: ["画面"] },
    ...extra,
  ];
  writeFiles(dir, {
    "orca-flow-workspace.json": JSON.stringify({ repos }),
  });
  return { common, app, dir };
}

async function call(argv: string[], dir: string, child: Child) {
  const io = capture();
  const f = fakeNode(child);
  const code = await main(argv, { ...io, cwd: dir, runner: f.runner });
  return { code, io, nodeCalls: f.nodeCalls };
}

describe("workspace 一覧の nextId", () => {
  const table = (ids: string[]) =>
    [
      "| ID | タスク | 依存 | 状態 | ブランチ |",
      "| --- | --- | --- | --- | --- |",
      ...ids.map((id) => `| ${id} | x | - | 設計中 | - |`),
      "",
    ].join("\n");
  const answer = (extra: Record<string, unknown> = {}) => ({
    code: 0,
    stdout: JSON.stringify({ baseBranch: "main", ...extra }),
  });

  it("init 済みの子に、tasksDir・進捗表・ブランチの最大の数＋1 が出る", async () => {
    const { common, dir } = setup();
    writeFiles(common, {
      "docs/tasks/T03.md": "x\n",
      "docs/progress.md": table(["T07", "T05"]),
    });
    git(common, "add", "-A");
    git(common, "commit", "-q", "-m", "docs");
    git(common, "branch", "task/T11-demo");
    const r = await call(["workspace", "--json"], dir, () =>
      answer({ progress: { file: "docs/progress.md" } }),
    );
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].nextId).toBe("T12");
  });

  it("進捗表の数が一番大きいときは、進捗表の最大＋1 が出る", async () => {
    const { common, dir } = setup();
    writeFiles(common, {
      "docs/tasks/T03.md": "x\n",
      "docs/progress.md": table(["T25", "T05"]),
    });
    git(common, "add", "-A");
    git(common, "commit", "-q", "-m", "docs");
    git(common, "branch", "task/T11-demo");
    const r = await call(["workspace", "--json"], dir, () =>
      answer({ progress: { file: "docs/progress.md" } }),
    );
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].nextId).toBe("T26");
  });

  it("tasksDir だけでも数える。ブランチだけでも数える", async () => {
    const { common, app, dir } = setup();
    writeFiles(common, { "docs/tasks/T20.md": "x\n" });
    git(common, "add", "-A");
    git(common, "commit", "-q", "-m", "docs");
    git(app, "branch", "feat/Q41-demo");
    const r = await call(["workspace", "--json"], dir, (c) =>
      c.cwd === app
        ? answer({ idPrefix: "Q", branchPrefix: "feat/" })
        : answer(),
    );
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].nextId).toBe("T21");
    expect(data.repos[1].nextId).toBe("Q42");
  });

  it("init がまだの子と設定の誤りの子は null", async () => {
    const { common, dir } = setup();
    const r = await call(["workspace", "--json"], dir, (c) =>
      c.cwd === common
        ? { code: 2, stderr: "なし" }
        : { code: 1, stderr: "誤り" },
    );
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].nextId).toBeNull();
    expect(data.repos[1].nextId).toBeNull();
  });

  it("子の設定の答えが読めないときは null", async () => {
    const { dir } = setup();
    const r = await call(["workspace", "--json"], dir, () =>
      answer({ idPrefix: 5 }),
    );
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].nextId).toBeNull();
  });
});

describe("workspace 一覧", () => {
  it("全部の子が通れば0。子の CLI は子の実のパスで src/main.ts を流す", async () => {
    const { common, app, dir } = setup();
    const r = await call(["workspace"], dir, () => configAnswer());
    expect(r.code).toBe(0);
    expect(r.nodeCalls.map((c) => c.cwd)).toEqual([common, app]);
    for (const c of r.nodeCalls) {
      expect(c.file).toBe(ORCA_FLOW_MAIN);
      expect(c.args).toEqual(["config", "--json"]);
    }
    expect(r.io.text()).toContain("demo-core");
    expect(r.io.text()).toContain("demo-app");
  });

  it("--json に設定のハッシュと子ごとの欄が入る", async () => {
    const { common, app, dir } = setup();
    const r = await call(["workspace", "--json"], dir, () => configAnswer());
    expect(r.code).toBe(0);
    const data = JSON.parse(r.io.text());
    expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.dir).toBe(dir);
    expect(data.repos[0]).toEqual({
      name: "demo-core",
      path: common,
      role: "common",
      keywords: ["共通"],
      scope: "共通の処理",
      package: "@demo/core",
      bumpCommand: "pnpm up @demo/core",
      initialized: true,
      baseBranch: "main",
      nextId: "T01",
      place: { ok: true, message: null },
      message: null,
    });
    expect(data.repos[1]).toMatchObject({
      name: "demo-app",
      path: app,
      role: "app",
      scope: null,
      package: null,
      bumpCommand: null,
    });
  });

  it("baseBranch は子の config --json の答えから取る", async () => {
    const { dir } = setup();
    const r = await call(["workspace", "--json"], dir, () =>
      configAnswer("develop"),
    );
    expect(r.code).toBe(2);
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].baseBranch).toBe("develop");
    expect(data.repos[0].place.ok).toBe(false);
    expect(data.repos.length).toBe(2);
  });

  it("追跡中のファイルに未コミットの変更があれば2。全部の子を出す", async () => {
    const { common, dir } = setup();
    writeFiles(common, { "README.md": "changed\n" });
    const r = await call(["workspace", "--json"], dir, () => configAnswer());
    expect(r.code).toBe(2);
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].place.ok).toBe(false);
    expect(data.repos[0].place.message).toContain("未コミット");
    expect(data.repos[0].place.message).toMatch(
      /^子 demo-core の統括役のタブで直してください：/,
    );
    expect(data.repos[1].place.ok).toBe(true);
  });

  it("追跡していないファイルだけなら通る", async () => {
    const { common, dir } = setup();
    writeFiles(common, { "new.txt": "x\n" });
    const r = await call(["workspace"], dir, () => configAnswer());
    expect(r.code).toBe(0);
  });

  it("子が baseBranch にいなければ2", async () => {
    const { app, dir } = setup();
    git(app, "switch", "-q", "-c", "other");
    const r = await call(["workspace"], dir, () => configAnswer());
    expect(r.code).toBe(2);
    expect(r.io.text()).toContain("demo-core");
    expect(r.io.text()).toContain("demo-app");
    expect(r.io.text()).toContain(
      "子 demo-app の統括役のタブで直してください：",
    );
  });

  it("子の config が2なら init がまだで2。全部の子を出す", async () => {
    const { common, dir } = setup();
    const r = await call(["workspace", "--json"], dir, (c) =>
      c.cwd === common
        ? { code: 2, stderr: "orca-flow: 設定がありません" }
        : configAnswer(),
    );
    expect(r.code).toBe(2);
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].initialized).toBe(false);
    expect(data.repos[0].place.ok).toBeNull();
    expect(data.repos[0].message).toContain("設定がありません");
    expect(data.repos[1].initialized).toBe(true);
  });

  it("子の config が1なら1。子のメッセージを添え、1つ目が誤りでも次を出す", async () => {
    const { common, dir } = setup();
    const r = await call(["workspace", "--json"], dir, (c) =>
      c.cwd === common
        ? { code: 1, stderr: "orca-flow: baseBranch が不正です" }
        : { code: 2 },
    );
    expect(r.code).toBe(1);
    const data = JSON.parse(r.io.text());
    expect(data.repos[0].initialized).toBeNull();
    expect(data.repos[0].message).toContain("baseBranch が不正です");
    expect(data.repos[1].initialized).toBe(false);
  });

  it("設定のファイルがない場所（子のリポジトリの中）では2", async () => {
    const { common, dir } = setup();
    const r = await call(["workspace"], common, () => configAnswer());
    expect(r.code).toBe(2);
    expect(r.nodeCalls).toEqual([]);
    void dir;
  });

  it("設定は今の場所だけで探し、上の階層（ワークスペースのフォルダ）へは探しに行かない", async () => {
    const { dir } = setup();
    const sub = path.join(dir, "sub");
    writeFiles(dir, { "sub/.keep": "" });
    const r = await call(["workspace"], sub, () => configAnswer());
    expect(r.code).toBe(2);
    expect(r.nodeCalls).toEqual([]);
  });

  it("設定が誤りなら1で、子の CLI を流さない", async () => {
    const dir = tempDir("orca-flow-ws-");
    writeFiles(dir, { "orca-flow-workspace.json": "{ not json" });
    const r = await call(["workspace"], dir, () => configAnswer());
    expect(r.code).toBe(1);
    expect(r.nodeCalls).toEqual([]);
  });
});

describe("workspace 〈名前〉 〈サブコマンド〉", () => {
  it.each(["config", "active", "merged", "new"])(
    "%s は子の実のパスで src/main.ts を同じ引数で流し、--json を渡し、終了コードをそのまま返す",
    async (sub) => {
      const { app, dir } = setup();
      for (const code of [0, 1, 2, 3]) {
        const r = await call(
          ["workspace", "demo-app", sub, "T1", "--ref", "x", "--json"],
          dir,
          () => ({ code, stdout: '{"a":1}\n' }),
        );
        expect(r.code).toBe(code);
        expect(r.nodeCalls).toHaveLength(1);
        expect(r.nodeCalls[0]).toMatchObject({
          file: ORCA_FLOW_MAIN,
          args: [sub, "T1", "--ref", "x", "--json"],
          cwd: app,
        });
        expect(JSON.parse(r.io.text())).toEqual({ a: 1 });
      }
    },
  );

  it("--json でなければ --json を付けず、標準出力と標準エラーをそのまま出す", async () => {
    const { dir } = setup();
    const r = await call(["workspace", "demo-app", "active"], dir, () => ({
      stdout: "作業中のタスクはありません\n",
      stderr: "警告です\n",
    }));
    expect(r.nodeCalls[0]!.args).toEqual(["active"]);
    expect(r.io.text()).toBe("作業中のタスクはありません");
    expect(r.io.errText()).toBe("警告です");
  });

  it("0〜3の外の終了コードは1にする", async () => {
    const { dir } = setup();
    const r = await call(["workspace", "demo-app", "active"], dir, () => ({
      code: 127,
    }));
    expect(r.code).toBe(1);
  });

  it.each([
    ["integrate"],
    ["approve"],
    ["push"],
    ["send"],
    ["merge"],
    ["status"],
  ])("%s は子の CLI を流さずに1", async (sub) => {
    const { dir } = setup();
    const r = await call(["workspace", "demo-app", sub, "T1"], dir, () => ({}));
    expect(r.code).toBe(1);
    expect(r.nodeCalls).toEqual([]);
    expect(r.io.errText()).toContain(sub);
  });

  it.each([["--auto"], ["--auto=true"]])(
    "new に %s があれば子の CLI を流さずに1。auto on の案内を出す",
    async (flag) => {
      const { dir } = setup();
      const r = await call(
        ["workspace", "demo-app", "new", "--title", "題", "--slug", "s", flag],
        dir,
        () => ({}),
      );
      expect(r.code).toBe(1);
      expect(r.nodeCalls).toEqual([]);
      expect(r.io.errText()).toContain("--auto");
      expect(r.io.errText()).toContain("orca-flow auto on");
    },
  );

  it("new --auto は設定の誤りより先に1で止まる", async () => {
    const bad = tempDir("orca-flow-ws-");
    writeFiles(bad, { "orca-flow-workspace.json": '{"repos":[]}' });
    const r = await call(
      ["workspace", "demo-app", "new", "--auto"],
      bad,
      () => ({}),
    );
    expect(r.code).toBe(1);
    expect(r.nodeCalls).toEqual([]);
    expect(r.io.errText()).toContain("orca-flow auto on");
  });

  it("知らない名前・サブコマンドなし・設定の誤りでは1で流さない", async () => {
    const { dir } = setup();
    const unknown = await call(
      ["workspace", "nope", "active"],
      dir,
      () => ({}),
    );
    expect(unknown.code).toBe(1);
    expect(unknown.io.errText()).toContain("nope");
    expect(unknown.nodeCalls).toEqual([]);

    const none = await call(["workspace", "demo-app"], dir, () => ({}));
    expect(none.code).toBe(1);
    expect(none.nodeCalls).toEqual([]);

    const bad = tempDir("orca-flow-ws-");
    writeFiles(bad, { "orca-flow-workspace.json": '{"repos":[]}' });
    const broken = await call(
      ["workspace", "demo-app", "active"],
      bad,
      () => ({}),
    );
    expect(broken.code).toBe(1);
    expect(broken.nodeCalls).toEqual([]);
  });

  it("new --request-file の相対パスは親の場所で解いた絶対パスで渡る", async () => {
    const { dir } = setup();
    const r = await call(
      [
        "workspace",
        "demo-app",
        "new",
        "--title",
        "題",
        "--request-file",
        "req/a.md",
      ],
      dir,
      () => ({}),
    );
    expect(r.nodeCalls[0]!.args).toEqual([
      "new",
      "--title",
      "題",
      "--request-file",
      path.join(dir, "req/a.md"),
    ]);
    const eq = await call(
      ["workspace", "demo-app", "new", "--request-file=req/a.md"],
      dir,
      () => ({}),
    );
    expect(eq.nodeCalls[0]!.args).toEqual([
      "new",
      `--request-file=${path.join(dir, "req/a.md")}`,
    ]);
    const abs = await call(
      ["workspace", "demo-app", "new", "--request-file", "/abs/x.md"],
      dir,
      () => ({}),
    );
    expect(abs.nodeCalls[0]!.args).toEqual([
      "new",
      "--request-file",
      "/abs/x.md",
    ]);
  });
});

describe("workspace.ts のソース", () => {
  it("main.ts のパスを自分で作らない（起こし方は background.ts に任せる）", async () => {
    const text = await readFile(
      path.join(import.meta.dirname, "../../src/commands/workspace.ts"),
      "utf8",
    );
    expect(text).not.toContain("fileURLToPath");
    expect(text).not.toContain('main.ts"');
  });
});
