import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { previewLogPath } from "../../src/lib/workspace-preview.ts";
import { noStopTargetMessage } from "../../src/lib/preview.ts";
import { writeCrossDependsAt } from "../../src/lib/cross-depends.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import {
  capture,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../init/helpers.ts";

const SECRET = "TOKEN=abc123-secret";

const done = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

interface Setup {
  dir: string;
  names: string[];
}

/** 子のまたぐ依存の記録の中身を置く。text を渡すとそのまま書く */
function putRecord(app: string, core: string, id: string, text?: string) {
  const common = git(
    app,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).trim();
  const dir = path.join(common, "orca-flow", "cross-depends");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.json`),
    text ??
      JSON.stringify({
        id,
        at: "2026-01-01T00:00:00.000Z",
        repos: [
          {
            name: "core",
            path: realpathSync(core),
            package: "@demo/core",
            version: "1.0.0",
            ids: [id],
          },
        ],
      }),
  );
}

function workspace(records: Record<string, string | null> = {}): Setup {
  const dir = tempDir("orca-flow-wsp-");
  const repos = [
    {
      name: "core",
      path: makeRepo(),
      role: "common",
      keywords: ["共通"],
      scope: "共通",
      package: "@demo/core",
      bumpCommand: "pnpm up @demo/core",
    },
    { name: "web", path: makeRepo(), role: "app", keywords: ["画面"] },
    { name: "admin", path: makeRepo(), role: "app", keywords: ["管理"] },
    { name: "api", path: makeRepo(), role: "app", keywords: ["api"] },
  ];
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  for (const r of repos.filter((x) => x.role === "app")) {
    const rec = records[r.name];
    if (rec === null) continue;
    putRecord(r.path, repos[0]!.path, "T1", rec);
  }
  return { dir, names: repos.map((r) => r.name) };
}

/** 共通を使わないブランチのワークスペース（共通は設定にあるだけ）。e2e の子に伴う記録を置く */
function companionWorkspace(recordText?: string): Setup {
  const dir = tempDir("orca-flow-wsp-");
  const repos = [
    {
      name: "core",
      path: makeRepo(),
      role: "common",
      keywords: ["共通"],
      scope: "共通",
      package: "@demo/core",
      bumpCommand: "pnpm up @demo/core",
    },
    { name: "web", path: makeRepo(), role: "app", keywords: ["画面"] },
    { name: "admin", path: makeRepo(), role: "app", keywords: ["管理"] },
    {
      name: "e2e-tests",
      path: makeRepo(),
      role: "app",
      keywords: ["e2e"],
      companion: {
        apps: ["web"],
        when: "画面の動きが変わるとき",
        command: "run-e2e {previewUrl:web}",
      },
    },
  ];
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  const common = git(
    repos[3]!.path,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).trim();
  const file = path.join(common, "orca-flow", "companion", "T1.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    recordText ??
      JSON.stringify({
        id: "T1",
        at: "2026-01-01T00:00:00.000Z",
        command: "run-e2e {previewUrl:web}",
        apps: [{ name: "web", path: realpathSync(repos[1]!.path) }],
      }),
  );
  return { dir, names: repos.map((r) => r.name) };
}

interface Opts {
  /** 子の名前 → preview を持たない */
  noPreview?: string[];
  /** 子の名前 → ID が作業中でない */
  idle?: string[];
  /** 子の名前 → preview が失敗 */
  failing?: string[];
  /** 子の名前 → 起動の記録が残っている（--stop は設定や作業中でなくても止める） */
  records?: string[];
  /** 子の名前 → --stop が別の理由で落ちる */
  stopFails?: Record<string, { code: number; stderr: string }>;
  /** 子の名前 → 前の画面の --stop が何も片づけなかった */
  noBase?: string[];
  /** 子の名前 → 前の画面の --stop の答え（文字列はそのまま stdout に出す） */
  baseStop?: Record<string, Record<string, unknown> | string>;
  /** 失敗する子の stderr と stdout と終了コードを上書きする */
  failure?: { stderr: string; stdout?: string; code?: number };
  /** ワークスペースのフォルダへのタブが失敗する */
  dirTabFails?: boolean;
}

function harness(opts: Opts = {}) {
  const events: string[] = [];
  const tabs: { worktree: string; url: string }[] = [];
  const launches: string[][] = [];
  let inFlight = 0;
  const runner: Runner = async (cmd, args, o) => {
    if (cmd === "orca") {
      const plain = args.filter((a) => a !== "--json");
      if (plain[0] === "tab" && plain[1] === "create") {
        const worktree = plain[plain.indexOf("--worktree") + 1]!.replace(
          /^path:/,
          "",
        );
        const url = plain[plain.indexOf("--url") + 1]!;
        if (opts.dirTabFails && worktree.includes("orca-flow-wsp-"))
          return done({ code: 1, stderr: "git ではありません" });
        tabs.push({ worktree, url });
        return done({
          stdout: JSON.stringify({ ok: true, result: {} }),
        });
      }
      if (plain[0] === "terminal")
        return done({
          stdout: JSON.stringify({ ok: true, result: { text: SECRET } }),
        });
      return done({ stdout: JSON.stringify({ ok: true, result: {} }) });
    }
    if (cmd === process.execPath && args[0] === "-e") {
      launches.push([...args]);
      return done({});
    }
    if (cmd !== process.execPath) return realRunner(cmd, args, o ?? {});
    const [sub, ...rest] = args.slice(2);
    const repoName = repoNameOf(o?.cwd ?? "");
    if (sub === "config")
      return done({
        stdout: JSON.stringify({
          baseBranch: "main",
          preview: opts.noPreview?.includes(repoName)
            ? null
            : { up: "x", timeoutSeconds: 5 },
        }),
      });
    if (sub === "active")
      return done({
        stdout: JSON.stringify(
          opts.idle?.includes(repoName)
            ? []
            : [{ id: "T1", path: `/wt/${repoName}` }],
        ),
      });
    if (sub === "preview") {
      events.push(`${repoName}:${rest.join(" ")}`);
      if (rest.includes("--stop")) {
        const fail = opts.stopFails?.[repoName];
        if (fail) return done(fail);
        if (rest.includes("--base")) {
          const custom = opts.baseStop?.[repoName];
          if (custom !== undefined)
            return done({
              stdout:
                typeof custom === "string" ? custom : JSON.stringify(custom),
            });
          return done({
            stdout: JSON.stringify({
              id: "T1",
              base: true,
              hadRecord: !opts.noBase?.includes(repoName),
              hadLeftover: false,
              ranDown: false,
              closedTerminal: false,
              removedWorktree: false,
            }),
          });
        }
        if (opts.records?.includes(repoName)) return done({});
        if (opts.noPreview?.includes(repoName))
          return done({
            code: 2,
            stderr: "orca-flow: preview の設定がありません",
          });
        if (opts.idle?.includes(repoName))
          return done({
            code: 1,
            stderr: `orca-flow: ${noStopTargetMessage("T1")}`,
          });
        return done({});
      }
      inFlight++;
      expect(inFlight).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (opts.failing?.includes(repoName))
        return done({
          code: opts.failure?.code ?? 1,
          stderr: opts.failure?.stderr ?? "起動しませんでした\n詳細",
          stdout: opts.failure?.stdout ?? "",
        });
      return done({
        stdout: JSON.stringify({
          id: "T1",
          url: `http://${repoName}.test/`,
          extra: SECRET,
        }),
      });
    }
    return done({ code: 1 });
  };
  return { runner, events, tabs, launches };
}

let paths: Record<string, string> = {};
function repoNameOf(cwd: string): string {
  return Object.keys(paths).find((n) => paths[n] === cwd) ?? cwd;
}

async function call(argv: string[], setup: Setup, opts: Opts = {}, env = {}) {
  const raw = JSON.parse(
    await readFile(path.join(setup.dir, "orca-flow-workspace.json"), "utf8"),
  ) as { repos: { name: string; path: string }[] };
  paths = {};
  for (const r of raw.repos)
    paths[r.name] = (await import("node:fs")).realpathSync(r.path);
  const h = harness(opts);
  const io = capture();
  const code = await main(argv, {
    ...io,
    cwd: setup.dir,
    runner: h.runner,
    env: { ...process.env, ...env },
  } as never);
  return { code, io, ...h };
}

describe("workspace --preview", () => {
  it("アプリの子を設定の順に1つずつ流し、共通・設定なし・作業中でない子は飛ばす", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s, {
      noPreview: ["admin"],
      idle: ["api"],
    });
    expect(r.code).toBe(0);
    expect(r.events).toEqual(["web:T1 --after-setup --no-open --json"]);
    const out = r.io.out.join("\n");
    expect(out).toContain("core：飛ばしました");
    expect(out).toContain("admin：飛ばしました");
    expect(out).toContain("api：飛ばしました");
  });

  it("前の子が答えるまで次を流さず、URL をワークスペースのフォルダのタブに開く", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s);
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.split(":")[0])).toEqual([
      "web",
      "admin",
      "api",
    ]);
    expect(r.tabs.map((t) => t.url)).toEqual([
      "http://web.test/",
      "http://admin.test/",
      "http://api.test/",
    ]);
    for (const t of r.tabs)
      expect(t.worktree).toBe((await import("node:fs")).realpathSync(s.dir));
  });

  it("フォルダに開けなければ警告を出して各アプリの worktree に開く", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s, {
      dirTabFails: true,
    });
    expect(r.code).toBe(0);
    expect(r.io.err.join("\n")).toContain("警告");
    expect(r.tabs.map((t) => t.worktree)).toEqual([
      "/wt/web",
      "/wt/admin",
      "/wt/api",
    ]);
  });

  it("1つの子が落ちても残りを流し、終了コード1で --json に子ごとの結果を出す", async () => {
    const s = await grouped();
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--json"],
      s,
      {
        failing: ["admin"],
      },
    );
    expect(r.code).toBe(1);
    expect(r.events).toHaveLength(3);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; url: string | null; result: string }[];
    };
    expect(data.repos.map((x) => [x.name, x.url, x.result])).toEqual([
      ["core", null, "skipped"],
      ["web", "http://web.test/", "opened"],
      ["admin", null, "failed"],
      ["api", "http://api.test/", "opened"],
    ]);
  });

  it("--stop は子の preview --stop を逆の順に流す", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--stop"], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "api:T1 --stop",
      "admin:T1 --stop",
      "web:T1 --stop",
    ]);
  });

  it("--background は背景の子を1回起こしてすぐ戻り、ログの場所を案内する", async () => {
    const s = await grouped();
    const state = tempDir("orca-flow-state-");
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--background"],
      s,
      {},
      { XDG_STATE_HOME: state },
    );
    expect(r.code).toBe(0);
    expect(r.launches).toHaveLength(1);
    const launch = r.launches[0]!.join("\n");
    expect(launch).toContain(`"workspace", "--preview", "${GROUP_BRANCH}"`);
    expect(launch).toContain(
      path.join(state, "orca-flow", "workspace-preview", "T1.log"),
    );
    expect(r.events).toEqual([]);
  });

  it("ターミナルの出力は標準出力・標準エラーに写さない", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s, {
      failing: ["web"],
    });
    const all = [...r.io.out, ...r.io.err].join("\n");
    expect(all).toContain("起動しませんでした");
    expect(all).not.toContain("詳細");
  });

  it("--stop は設定なし・記録なしの子と作業中でない・記録なしの子を飛ばし、全体は終了コード0", async () => {
    const s = await grouped();
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--stop"],
      s,
      {
        noPreview: ["admin"],
        idle: ["api"],
      },
    );
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "api:T1 --stop",
      "admin:T1 --stop",
      "web:T1 --stop",
    ]);
    const out = r.io.out.join("\n");
    expect(out).toContain("admin：飛ばしました");
    expect(out).toContain("api：飛ばしました");
    expect(out).toContain("web：止めました");
    expect(r.io.err).toEqual([]);
  });

  it("--stop は記録が残った子（設定なし、または作業中でない）にも流して止める", async () => {
    const s = await grouped();
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--stop", "--json"],
      s,
      {
        noPreview: ["admin"],
        idle: ["api"],
        records: ["admin", "api"],
      },
    );
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "api:T1 --stop",
      "admin:T1 --stop",
      "web:T1 --stop",
    ]);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; result: string }[];
    };
    expect(data.repos.map((x) => [x.name, x.result])).toEqual([
      ["api", "stopped"],
      ["admin", "stopped"],
      ["web", "stopped"],
      ["core", "skipped"],
    ]);
  });

  it("--stop は止めるものなし以外の失敗を failed にし、全体は終了コード1", async () => {
    const s = await grouped();
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--stop"],
      s,
      {
        stopFails: { admin: { code: 1, stderr: "orca-flow: 別の失敗" } },
      },
    );
    expect(r.code).toBe(1);
    expect(r.events).toHaveLength(3);
    expect(r.io.err.join("\n")).toContain(
      "admin：止められませんでした（orca-flow: 別の失敗）",
    );
  });

  it("子が先に警告を出して落ちても、orca-flow: の最後の行を理由にする", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s, {
      failing: ["web"],
      failure: { stderr: "警告：古い設定です\norca-flow: 本当の理由\n詳細" },
    });
    const err = r.io.err.join("\n");
    expect(err).toContain("orca-flow: 本当の理由");
    expect(err).not.toContain("警告：古い設定");
  });

  // 背景のログには親の stdout/stderr がそのまま書かれる
  it.each([
    ["stderr の2行目以降", { stderr: `起動しませんでした\n${SECRET}` }],
    [
      "stderr が空で stdout に秘密がある",
      { stderr: "", stdout: `${SECRET}\n`, code: 3 },
    ],
    ["警告の後の2行目以降", { stderr: `警告：x\norca-flow: 理由\n${SECRET}` }],
  ])(
    "背景のログ（＝親の標準出力・標準エラー）にターミナルの出力と子の秘密が写らない：%s",
    async (_name, failure) => {
      const s = await grouped();
      const r = await call(["workspace", "--preview", GROUP_BRANCH], s, {
        failing: ["web"],
        failure,
      });
      const all = [...r.io.out, ...r.io.err].join("\n");
      expect(all).not.toContain("secret");
      expect(all).not.toContain("TOKEN");
    },
  );

  it("背景のログ（＝親の標準出力・標準エラー）に成功した子の JSON の余分な欄とターミナルの出力が写らない", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s);
    expect(r.code).toBe(0);
    const all = [...r.io.out, ...r.io.err].join("\n");
    expect(all).not.toContain("secret");
  });

  it("ブランチ名の形が違えば終了コード1", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview", "x y"], s);
    expect(r.code).toBe(1);
  });
});

describe("workspace --preview の組の外", () => {
  it("記録のないアプリの子は、作業中で設定があっても preview を流さずタブも開かず、組の外として飛ばす", async () => {
    const s = await grouped({ admin: null });
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s);
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.split(":")[0])).toEqual(["web", "api"]);
    expect(r.tabs.map((t) => t.url)).toEqual([
      "http://web.test/",
      "http://api.test/",
    ]);
    expect(r.io.out.join("\n")).toContain("admin：飛ばしました（組の外");
  });

  it("--json では組の外の子は skipped で url が null", async () => {
    const s = await grouped({ admin: null });
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: {
        name: string;
        url: string | null;
        result: string;
        reason: string;
      }[];
    };
    const admin = data.repos.find((x) => x.name === "admin")!;
    expect([admin.url, admin.result]).toEqual([null, "skipped"]);
    expect(admin.reason).toContain("組の外");
  });

  it("記録が壊れた子は failed になり、残りの子は流れ、全体は終了コード1", async () => {
    const s = await grouped({ admin: "{broken" });
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
    expect(r.code).toBe(1);
    expect(r.events.map((e) => e.split(":")[0])).toEqual(["web", "api"]);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; result: string }[];
    };
    expect(data.repos.map((x) => [x.name, x.result])).toEqual([
      ["core", "skipped"],
      ["web", "opened"],
      ["admin", "failed"],
      ["api", "opened"],
    ]);
  });

  it("記録が壊れていても、作業中でない子は failed にならず作業中でない理由で飛ばす", async () => {
    const s = await grouped({ admin: "{broken" });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--json"],
      s,
      {
        idle: ["admin"],
      },
    );
    expect(r.code).toBe(0);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; result: string; reason: string | null }[];
    };
    const admin = data.repos.find((x) => x.name === "admin")!;
    expect(admin.result).toBe("skipped");
    expect(admin.reason).toContain("作業中ではありません");
  });

  it("記録が壊れていても、preview の設定がない子は failed にならず設定なしの理由で飛ばす", async () => {
    const s = await grouped({ admin: "{broken" });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--json"],
      s,
      {
        noPreview: ["admin"],
      },
    );
    expect(r.code).toBe(0);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; result: string; reason: string | null }[];
    };
    const admin = data.repos.find((x) => x.name === "admin")!;
    expect(admin.result).toBe("skipped");
    expect(admin.reason).toContain("preview の設定がありません");
  });

  it("記録のない子が作業中でなければ、理由は組の外でなく作業中でない", async () => {
    const s = await grouped({ admin: null });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--json"],
      s,
      {
        idle: ["admin"],
      },
    );
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; reason: string | null }[];
    };
    expect(data.repos.find((x) => x.name === "admin")!.reason).toContain(
      "作業中ではありません",
    );
  });

  it("--stop は記録のない子に preview --stop を流さず、組の外として飛ばす", async () => {
    const s = await grouped({ admin: null });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--stop", "--json"],
      s,
    );
    expect(r.code).toBe(0);
    expect(r.events).toEqual(["api:T1 --stop", "web:T1 --stop"]);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; result: string; reason: string | null }[];
    };
    const admin = data.repos.find((x) => x.name === "admin")!;
    expect(admin.result).toBe("skipped");
    expect(admin.reason).toContain("組の外");
  });

  it("--stop で記録が壊れた子は failed になり、残りは流れる", async () => {
    const s = await grouped({ admin: "{broken" });
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--stop"], s);
    expect(r.code).toBe(1);
    expect(r.events).toEqual(["api:T1 --stop", "web:T1 --stop"]);
  });
});

describe("previewLogPath", () => {
  const tail = path.join("orca-flow", "workspace-preview", "T1.log");

  it("XDG_STATE_HOME が絶対パスならその下", () => {
    expect(previewLogPath({ XDG_STATE_HOME: "/x/state" }, "T1")).toBe(
      path.join("/x/state", tail),
    );
  });

  it("XDG_STATE_HOME がなければ HOME の下の .local/state", () => {
    expect(previewLogPath({ HOME: "/h" }, "T1")).toBe(
      path.join("/h", ".local", "state", tail),
    );
  });

  it("XDG_STATE_HOME が相対パスなら無視して HOME", () => {
    expect(
      previewLogPath({ XDG_STATE_HOME: "rel/state", HOME: "/h" }, "T1"),
    ).toBe(path.join("/h", ".local", "state", tail));
  });

  it("USERPROFILE だけでもよい", () => {
    expect(previewLogPath({ USERPROFILE: "/u" }, "T1")).toBe(
      path.join("/u", ".local", "state", tail),
    );
  });

  it("HOME も USERPROFILE もなければ終了コード1の FlowError", () => {
    expect(() => previewLogPath({}, "T1")).toThrow(
      expect.objectContaining({ code: 1 }),
    );
  });
});

describe("workspace --preview（伴う記録）", () => {
  it("共通がなくても伴う記録に載ったアプリは立ち、載らないアプリは組の外になる", async () => {
    const s = await groupedCompanion();
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s, {
      idle: ["e2e-tests"],
    });
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.split(":")[0])).toEqual(["web"]);
    expect(r.io.out.join("\n")).toContain("admin：飛ばしました（組の外です");
  });

  it("伴う記録が壊れていれば、その子は落ちたになる", async () => {
    const s = await groupedCompanion("{broken");
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s, {
      idle: ["e2e-tests"],
    });
    expect(r.code).toBe(1);
    expect(r.io.err.join("\n")).toContain("web：失敗しました");
  });
});

describe("workspace --preview --base", () => {
  it("組のアプリだけに子の preview --base --no-open --json を1つずつ流し、タブは開かない", async () => {
    const s = await grouped({ admin: null });
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--base"], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "web:T1 --base --no-open --json",
      "api:T1 --base --no-open --json",
    ]);
    expect(r.tabs).toEqual([]);
    const out = r.io.out.join("\n");
    expect(out).toContain("web：前の画面 http://web.test/");
    expect(out).toContain("admin：飛ばしました");
  });

  it("--json に子ごとの前の画面の URL が出て、子が落ちたら終了コード1", async () => {
    const s = await grouped({ admin: null });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--json"],
      s,
      { failing: ["api"] },
    );
    expect(r.code).toBe(1);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; url: string | null; result: string }[];
    };
    expect(
      data.repos
        .filter((x) => x.name !== "core")
        .map((x) => [x.name, x.url, x.result]),
    ).toEqual([
      ["web", "http://web.test/", "started"],
      ["admin", null, "skipped"],
      ["api", null, "failed"],
    ]);
  });

  it("--stop は子の preview --base --stop を逆の順に流す", async () => {
    const s = await grouped({ admin: null });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--stop"],
      s,
    );
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "api:T1 --base --stop --json",
      "web:T1 --base --stop --json",
    ]);
  });

  it("--stop は前の画面のないアプリを止めたことにせず飛ばす", async () => {
    const s = await grouped({ admin: null });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--stop", "--json"],
      s,
      { noBase: ["api"] },
    );
    expect(r.code).toBe(0);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; result: string; reason: string | null }[];
    };
    const row = (n: string) => data.repos.find((x) => x.name === n)!;
    expect(row("web").result).toBe("stopped");
    expect([row("api").result, row("api").reason]).toEqual([
      "skipped",
      "前の画面がありません",
    ]);
  });

  it("--stop は記録がなくても、残りかすか作業ツリーを片づけたなら止めたことにする", async () => {
    const s = await grouped({ admin: null });
    const gone = {
      id: "T1",
      base: true,
      hadRecord: false,
      hadLeftover: false,
      ranDown: false,
      closedTerminal: false,
      removedWorktree: false,
    };
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--stop", "--json"],
      s,
      {
        baseStop: {
          api: { ...gone, hadLeftover: true },
          web: { ...gone, removedWorktree: true },
        },
      },
    );
    expect(r.code).toBe(0);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; result: string }[];
    };
    const row = (n: string) => data.repos.find((x) => x.name === n)!;
    expect([row("api").result, row("web").result]).toEqual([
      "stopped",
      "stopped",
    ]);
  });

  it("--stop は子の答えが読めないときは止めたものとして扱う", async () => {
    const s = await grouped({ admin: null });
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--stop", "--json"],
      s,
      { baseStop: { api: "読めない出力" } },
    );
    expect(r.code).toBe(0);
    const data = JSON.parse(r.io.out.join("\n")) as {
      repos: { name: string; result: string }[];
    };
    expect(data.repos.find((x) => x.name === "api")!.result).toBe("stopped");
  });

  it("--background は --base を背景の子に渡し、タスクのプレビューとは別のログに書く", async () => {
    const s = await grouped();
    const state = tempDir("orca-flow-state-");
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--background"],
      s,
      {},
      { XDG_STATE_HOME: state },
    );
    expect(r.code).toBe(0);
    expect(r.launches).toHaveLength(1);
    const launch = r.launches[0]!.join("\n");
    expect(launch).toContain(
      `"workspace", "--preview", "${GROUP_BRANCH}", "--base"`,
    );
    expect(launch).toContain(
      path.join(state, "orca-flow", "workspace-preview-base", "T1.log"),
    );
    expect(r.events).toEqual([]);
  });
});

/** 子の名前のリポジトリにブランチを作る */
async function branchIn(setup: Setup, name: string, branch: string) {
  const raw = JSON.parse(
    await readFile(path.join(setup.dir, "orca-flow-workspace.json"), "utf8"),
  ) as { repos: { name: string; path: string }[] };
  git(raw.repos.find((r) => r.name === name)!.path, "branch", branch);
}

/** 子の名前のリポジトリに、タスクのブランチ名つきのまたぐ依存の記録（T1）を置く */
async function recordWithBranch(
  setup: Setup,
  name: string,
  taskBranch: string,
) {
  const raw = JSON.parse(
    await readFile(path.join(setup.dir, "orca-flow-workspace.json"), "utf8"),
  ) as { repos: { name: string; path: string }[] };
  const app = raw.repos.find((r) => r.name === name)!.path;
  const core = raw.repos.find((r) => r.name === "core")!.path;
  const common = git(
    app,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).trim();
  await writeCrossDependsAt(
    common,
    "T1",
    [
      {
        name: "core",
        path: realpathSync(core),
        package: "@demo/core",
        version: "1.0.0",
        ids: ["T1"],
      },
    ],
    new Date("2026-01-01T00:00:00.000Z"),
    taskBranch,
  );
}

const GROUP_BRANCH = "task/T1-member-order-limit";
const OTHER_BRANCH = "task/T1-member-export";

/** 記録のない共通のないブランチの組（web・admin）と、番号だけ同じ api */
async function branchGroup(): Promise<Setup> {
  const s = workspace({ web: null, admin: null });
  await branchIn(s, "web", GROUP_BRANCH);
  await branchIn(s, "admin", GROUP_BRANCH);
  await branchIn(s, "api", OTHER_BRANCH);
  return s;
}

/** 組のブランチを web だけに置いたワークスペース。ほかのアプリは記録で組に当たる */
async function grouped(
  records: Record<string, string | null> = {},
): Promise<Setup> {
  const s = workspace(records);
  await branchIn(s, "web", GROUP_BRANCH);
  return s;
}

/** 組のブランチを伴う記録の持ち主（e2e-tests）に置いたワークスペース。web は伴う記録で組に当たる */
async function groupedCompanion(recordText?: string): Promise<Setup> {
  const s = companionWorkspace(recordText);
  await branchIn(s, "e2e-tests", GROUP_BRANCH);
  return s;
}

describe("workspace --preview（ブランチ名）", () => {
  it("記録のない共通のないブランチのアプリも組として立て、番号だけ同じアプリは組の外として飛ばす", async () => {
    const s = await branchGroup();
    const r = await call(["workspace", "--preview", GROUP_BRANCH, "--json"], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "web:T1 --after-setup --no-open --json",
      "admin:T1 --after-setup --no-open --json",
    ]);
    const data = JSON.parse(r.io.out.join("\n")) as {
      id: string;
      repos: { name: string; result: string; reason: string | null }[];
    };
    expect(data.id).toBe("T1");
    const api = data.repos.find((x) => x.name === "api")!;
    expect(api.result).toBe("skipped");
    expect(api.reason).toContain("組の外");
    expect(api.reason).toContain(OTHER_BRANCH);
  });

  it("--stop と --base も同じ選び方をする", async () => {
    const s = await branchGroup();
    const stop = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--stop"],
      s,
    );
    expect(stop.code).toBe(0);
    expect(stop.events).toEqual(["admin:T1 --stop", "web:T1 --stop"]);
    expect(stop.io.out.join("\n")).toContain("api：飛ばしました（組の外");
    const base = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base"],
      s,
    );
    expect(base.code).toBe(0);
    expect(base.events).toEqual([
      "web:T1 --base --no-open --json",
      "admin:T1 --base --no-open --json",
    ]);
    const baseStop = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--stop"],
      s,
    );
    expect(baseStop.events).toEqual([
      "admin:T1 --base --stop --json",
      "web:T1 --base --stop --json",
    ]);
  });

  it("記録があっても、短い名前の違うブランチしかないアプリは組の外", async () => {
    const s = workspace();
    await branchIn(s, "web", GROUP_BRANCH);
    await branchIn(s, "api", OTHER_BRANCH);
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s);
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.split(":")[0])).toEqual(["web", "admin"]);
  });

  it("--background はブランチ名を背景の子に渡し、ログは ID の場所のまま", async () => {
    const s = await branchGroup();
    const state = tempDir("orca-flow-state-");
    const r = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--background"],
      s,
      {},
      { XDG_STATE_HOME: state },
    );
    expect(r.code).toBe(0);
    expect(r.launches).toHaveLength(1);
    const launch = r.launches[0]!.join("\n");
    expect(launch).toContain(`"workspace", "--preview", "${GROUP_BRANCH}"`);
    expect(launch).toContain(
      path.join(state, "orca-flow", "workspace-preview", "T1.log"),
    );
  });

  it("組のブランチを消したあとも、ブランチ名の --stop は記録で組に当たるアプリだけを止め、番号だけ同じアプリは止めない", async () => {
    const s = workspace({ api: null });
    await branchIn(s, "api", OTHER_BRANCH);
    const stop = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--stop"],
      s,
    );
    expect(stop.code).toBe(0);
    expect(stop.events).toEqual(["admin:T1 --stop", "web:T1 --stop"]);
    const out = stop.io.out.join("\n");
    expect(out).toContain(`ブランチ ${GROUP_BRANCH} はどのアプリの子にもない`);
    expect(out).toContain("api：飛ばしました（組の外");
    const baseStop = await call(
      ["workspace", "--preview", GROUP_BRANCH, "--base", "--stop"],
      s,
    );
    expect(baseStop.code).toBe(0);
    expect(baseStop.events).toEqual([
      "admin:T1 --base --stop --json",
      "web:T1 --base --stop --json",
    ]);
  });

  it("組のブランチがないアプリは、記録のタスクのブランチが組のブランチ名と違えば --stop で止めず組の外と出し、同じなら止める", async () => {
    const s = workspace({ web: null, admin: null, api: null });
    await recordWithBranch(s, "web", GROUP_BRANCH);
    await recordWithBranch(s, "admin", OTHER_BRANCH);
    for (const extra of [["--stop"], ["--base", "--stop"]]) {
      const r = await call(
        ["workspace", "--preview", GROUP_BRANCH, ...extra],
        s,
      );
      expect(r.code).toBe(0);
      expect(r.events.map((e) => e.split(":")[0])).toEqual(["web"]);
      const out = r.io.out.join("\n");
      expect(out).toContain(
        `admin：飛ばしました（組の外です（記録のタスクのブランチ ${OTHER_BRANCH} は組のブランチ名と違います））`,
      );
      expect(out).toContain("api：飛ばしました（組の外");
    }
  });

  it("組のブランチがないアプリは、記録のタスクのブランチが組のブランチ名と違えば立てず、同じなら立てる", async () => {
    const s = workspace({ web: null, admin: null, api: null });
    await branchIn(s, "api", GROUP_BRANCH);
    await recordWithBranch(s, "web", GROUP_BRANCH);
    await recordWithBranch(s, "admin", OTHER_BRANCH);
    const r = await call(["workspace", "--preview", GROUP_BRANCH], s);
    expect(r.code).toBe(0);
    expect(r.events).toEqual([
      "web:T1 --after-setup --no-open --json",
      "api:T1 --after-setup --no-open --json",
    ]);
    expect(r.io.out.join("\n")).toContain(
      `admin：飛ばしました（組の外です（記録のタスクのブランチ ${OTHER_BRANCH} は組のブランチ名と違います））`,
    );
  });

  it("ブランチ名の形が外れる・どのアプリにもない引数は1で何も流さない", async () => {
    const s = await branchGroup();
    for (const target of [
      "feature/order-limit",
      "task/T1-nothing",
      "task/T1-",
    ]) {
      for (const extra of [[], ["--stop"], ["--background"]]) {
        const r = await call(["workspace", "--preview", target, ...extra], s);
        expect(r.code).toBe(1);
        expect(r.events).toEqual([]);
        expect(r.launches).toEqual([]);
      }
    }
  });
});

describe("workspace --preview（ID で打つと止まる）", () => {
  const FLAGS = [[], ["--stop"], ["--background"], ["--base"]];

  it("引数がなければ1で、ブランチ名で打つ使い方を出す", async () => {
    const s = await grouped();
    const r = await call(["workspace", "--preview"], s);
    expect(r.code).toBe(1);
    const err = r.io.err.join("\n");
    expect(err).toContain("orca-flow workspace --preview 〈ブランチ名〉");
    expect(err).toContain("ID では打てません");
    expect(err).not.toContain("ブランチ名も受けます");
  });

  it("短い名前がそろっていても、旗なし・--stop・--background・--base のどれも1で、子の preview も背景も流さず、候補と打ち直しの1行を同じ旗つきで出す", async () => {
    const s = await grouped({ web: null });
    await branchIn(s, "admin", GROUP_BRANCH);
    for (const extra of FLAGS) {
      const r = await call(["workspace", "--preview", "T1", ...extra], s);
      expect(r.code).toBe(1);
      expect(r.events).toEqual([]);
      expect(r.launches).toEqual([]);
      const err = r.io.err.join("\n");
      expect(err).toContain(`web：${GROUP_BRANCH}`);
      expect(err).toContain(`admin：${GROUP_BRANCH}`);
      expect(err).not.toContain("api：");
      expect(err).toContain(
        `ブランチ名で打ち直してください（例：orca-flow workspace --preview ${GROUP_BRANCH}${extra.map((e) => ` ${e}`).join("")}）`,
      );
    }
  });

  it("短い名前が混ざっても1で、子ごとの候補と打ち直しの1行を出す", async () => {
    const s = await branchGroup();
    for (const extra of FLAGS) {
      const r = await call(["workspace", "--preview", "T1", ...extra], s);
      expect(r.code).toBe(1);
      expect(r.events).toEqual([]);
      expect(r.launches).toEqual([]);
      const err = r.io.err.join("\n");
      expect(err).toContain(`web：${GROUP_BRANCH}`);
      expect(err).toContain(`admin：${GROUP_BRANCH}`);
      expect(err).toContain(`api：${OTHER_BRANCH}`);
      expect(err).toContain(
        `ブランチ名で打ち直してください（例：orca-flow workspace --preview ${GROUP_BRANCH}${extra.map((e) => ` ${e}`).join("")}）`,
      );
    }
  });

  it("どのアプリの子にも ID のブランチがなければ、記録で組に当たる子があっても1で、ブランチ名で打つよう案内し例の行を出さない", async () => {
    const s = workspace();
    for (const extra of FLAGS) {
      const r = await call(["workspace", "--preview", "T1", ...extra], s);
      expect(r.code).toBe(1);
      expect(r.events).toEqual([]);
      expect(r.launches).toEqual([]);
      const err = r.io.err.join("\n");
      expect(err).toContain("ブランチ名");
      expect(err).not.toContain("例：");
      expect(err).not.toContain("orca-flow workspace --preview");
    }
  });

  it("組のブランチを消したあと番号だけ同じ別のタスクのブランチしか残っていなければ、ID の --stop は1で何も止めず、条件つきの例と注意を出す", async () => {
    const s = workspace({ api: null });
    await branchIn(s, "api", OTHER_BRANCH);
    const r = await call(["workspace", "--preview", "T1", "--stop"], s);
    expect(r.code).toBe(1);
    expect(r.events).toEqual([]);
    expect(r.launches).toEqual([]);
    const lines = r.io.err.join("\n").split("\n");
    expect(lines.some((l) => l.endsWith(`api：${OTHER_BRANCH}`))).toBe(true);
    expect(
      lines.some((l) =>
        l.endsWith(
          `候補が組のブランチなら、ブランチ名で打ち直してください（例：orca-flow workspace --preview ${OTHER_BRANCH} --stop）`,
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.endsWith(
          "組のブランチを消したあとなら、候補は番号だけ同じ別のタスクのものかもしれません。組のブランチ名で打ってください",
        ),
      ),
    ).toBe(true);
  });
});
