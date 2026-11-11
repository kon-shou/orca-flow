import { realpathSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCompanionAt } from "../../src/lib/companion.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { previewDeps, writePreviewRecord } from "../../src/lib/preview.ts";
import { writePreviewBaseRecord } from "../../src/lib/preview-base.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import { runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

const ID = "T12";
const URL_WEB = "http://127.0.0.1:5173/";
const URL_BASE = "http://127.0.0.1:5174/";

type Write = { name: string; size?: number } | null;

interface Fixture {
  wt: string;
  appRoot: string;
  roots: Record<string, string>;
  appCommon: string;
  shells: string[];
  /** 流した順に、その回に書く録画（null は書かない） */
  plan: { code: number; writes: Write[]; output?: string }[];
  runner: Runner;
}

const commonOf = async (dir: string) =>
  (
    await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();

async function fixture(
  opts: {
    capture?: boolean;
    base?: "none" | "ok" | "no-url" | "broken";
    apps?: string[];
  } = {},
): Promise<Fixture> {
  const e2eRoot = await makeRepo({});
  const wt = await addTaskWorktree(e2eRoot, ID, "e2e");
  const e2eCommon = await commonOf(e2eRoot);
  const names = opts.apps ?? ["web"];
  const roots: Record<string, string> = {};
  for (const n of names) roots[n] = realpathSync(await makeRepo({}));
  const appRoot = roots[names[0]!]!;
  const appCommon = await commonOf(appRoot);
  await writeCompanionAt(
    e2eCommon,
    ID,
    {
      command: "run --base {previewUrl:web}",
      apps: names.map((n) => ({ name: n, path: roots[n]! })),
      ...(opts.capture === false
        ? {}
        : {
            capture: {
              command: "run --video --base {previewUrl:web}",
              output: "videos",
            },
          }),
    },
    new Date(),
  );
  for (const n of names) {
    const common = await commonOf(roots[n]!);
    await writePreviewRecord(common, {
      id: ID,
      worktree: roots[n]!,
      terminal: "term_1",
      url: URL_WEB,
      at: "2026-01-01T00:00:00.000Z",
    });
    await appendStage(common, ID, {
      at: "2026-01-01T00:00:00.000Z",
      state: "integrate-wait",
      note: null,
      command: "status",
    });
    if ((opts.base ?? "ok") === "ok" || opts.base === "no-url")
      await writePreviewBaseRecord(common, {
        id: ID,
        worktree: "/tmp/base",
        taskWorktree: wt.path,
        terminal: "term_2",
        commit: "abc",
        ...(opts.base === "no-url" ? {} : { url: URL_BASE }),
        at: "2026-01-01T00:00:00.000Z",
      });
    if (opts.base === "broken") {
      const dir = path.join(common, "orca-flow/preview-base");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${ID}.json`), "{broken");
    }
  }
  let now = 1_700_000_000_000;
  previewDeps.clock = () => now;
  const f: Fixture = {
    wt: wt.path,
    appRoot,
    roots,
    appCommon,
    shells: [],
    plan: [],
    runner: async (cmd, args, o) => {
      if (cmd === "sh" && args[0] === "-c") {
        f.shells.push(args[1]!);
        const step = f.plan[f.shells.length - 1] ?? { code: 0, writes: [] };
        now += 1000;
        for (const w of step.writes) {
          if (w === null) continue;
          const file = path.join(wt.path, "videos", w.name);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, Buffer.alloc(w.size ?? 4, "x"));
          await utimes(file, new Date(now), new Date(now));
        }
        now += 1000;
        return {
          code: step.code,
          stdout: step.output ?? "",
          stderr: "",
          timedOut: false,
        };
      }
      return testRunner(cmd, args, o);
    },
  };
  return f;
}

const answering = (ok = true) => {
  previewDeps.fetch = (async () =>
    new Response(null, { status: ok ? 200 : 503 })) as typeof fetch;
};
const call = (f: Fixture, argv: string[]) =>
  runCli(["e2e", ID, ...argv], { cwd: f.wt, runner: f.runner });

const placedDir = (f: Fixture) =>
  path.join(f.appCommon, "orca-flow/e2e-captures", ID);
const listPlaced = async (f: Fixture) =>
  (await readdir(placedDir(f)).catch(() => [])).sort();

describe("e2e --capture", () => {
  it("前の画面の URL と後の URL で1回ずつ流し、録画を決めた名前で置く", async () => {
    const f = await fixture();
    answering();
    f.plan = [
      { code: 0, writes: [{ name: "a.webm" }] },
      { code: 0, writes: [{ name: "b.mp4" }] },
    ];
    const r = await call(f, ["--capture", "login", "--", "tests/a.spec.ts"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(f.shells).toEqual([
      `run --video --base '${URL_BASE}' 'tests/a.spec.ts'`,
      `run --video --base '${URL_WEB}' 'tests/a.spec.ts'`,
    ]);
    expect(await listPlaced(f)).toEqual([
      "login-after.mp4",
      "login-before.webm",
    ]);
  });

  it("同じ流れは上書きし、古い拡張子のファイルを残さない", async () => {
    const f = await fixture();
    answering();
    f.plan = [
      { code: 0, writes: [{ name: "a.webm", size: 4 }] },
      { code: 0, writes: [{ name: "b.webm", size: 4 }] },
      { code: 0, writes: [{ name: "a.gif", size: 6 }] },
      { code: 0, writes: [{ name: "b.gif", size: 6 }] },
    ];
    await call(f, ["--capture", "login"]);
    await call(f, ["--capture", "login"]);
    expect(await listPlaced(f)).toEqual([
      "login-after.gif",
      "login-before.gif",
    ]);
  });

  it("前の画面で落ちても録画があれば置く", async () => {
    const f = await fixture();
    answering();
    f.plan = [
      { code: 1, writes: [{ name: "a.webm" }] },
      { code: 0, writes: [{ name: "b.webm" }] },
    ];
    const r = await call(f, ["--capture", "login"]);
    expect(r.code).toBe(0);
    expect(await listPlaced(f)).toHaveLength(2);
  });

  it("後の画面で落ちたら、どちらも置かず1。出力は伏せた末尾だけ", async () => {
    const f = await fixture();
    answering();
    f.plan = [
      { code: 0, writes: [{ name: "a.webm" }] },
      {
        code: 1,
        writes: [{ name: "b.webm" }],
        output: "boom\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    ];
    const r = await call(f, ["--capture", "login"]);
    expect(r.code).toBe(1);
    expect(await listPlaced(f)).toEqual([]);
    expect(r.err).toContain("boom");
    expect(r.err).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.out).not.toContain("boom");
  });

  it("録画が0個・2個以上・大きすぎるときは置かず1", async () => {
    for (const [before, after, expected] of [
      [[], [{ name: "b.webm" }], "0個"],
      [[{ name: "a.webm" }, { name: "a2.mp4" }], [{ name: "b.webm" }], "2個"],
      [[{ name: "a.webm" }], [], "0個"],
      [
        [{ name: "a.webm" }],
        [{ name: "b.webm", size: 10_000_001 }],
        "大きすぎます",
      ],
      [
        [{ name: "a.webm", size: 10_000_001 }],
        [{ name: "b.webm" }],
        "大きすぎます",
      ],
    ] as const) {
      const f = await fixture();
      answering();
      f.plan = [
        { code: 0, writes: [...before] },
        { code: 0, writes: [...after] },
      ];
      const r = await call(f, ["--capture", "login"]);
      expect(r.code, expected).toBe(1);
      expect(r.err).toContain(expected);
      expect(await listPlaced(f)).toEqual([]);
    }
  });

  it("録画の数の誤りの文は「前の画面の録画が0個」「後の画面の録画が0個」と読める", async () => {
    for (const [plan, expected] of [
      [[[], [{ name: "b.webm" }]], "前の画面の録画が0個"],
      [[[{ name: "a.webm" }], []], "後の画面の録画が0個"],
    ] as const) {
      const f = await fixture();
      answering();
      f.plan = plan.map((writes) => ({ code: 0, writes: [...writes] }));
      const r = await call(f, ["--capture", "login"]);
      expect(r.err).toContain(expected);
      expect(r.err).not.toContain("のの");
    }
  });

  it("上限ちょうどの大きさは置ける", async () => {
    const f = await fixture();
    answering();
    f.plan = [
      { code: 0, writes: [{ name: "a.webm", size: 10_000_000 }] },
      { code: 0, writes: [{ name: "b.webm" }] },
    ];
    const r = await call(f, ["--capture", "login"]);
    expect(r.code).toBe(0);
    expect(
      (await stat(path.join(placedDir(f), "login-before.webm"))).size,
    ).toBe(10_000_000);
  });

  it("前の画面の記録がない・URL がまだ・壊れている・答えない・capture がないときは流さず2", async () => {
    for (const [opts, expected] of [
      [{ base: "none" }, "前の画面の記録がありません"],
      [{ base: "no-url" }, "URL がまだ分かりません"],
      [{ base: "broken" }, "壊れています"],
      [{ capture: false }, "capture がありません"],
    ] as const) {
      const f = await fixture(opts);
      answering();
      const r = await call(f, ["--capture", "login", "--json"]);
      expect(r.code, expected).toBe(2);
      expect(f.shells).toEqual([]);
      expect(r.err).toContain(expected);
    }
    const f = await fixture();
    previewDeps.fetch = (async (url: string) =>
      new Response(null, {
        status: String(url).includes("5174") ? 503 : 200,
      })) as typeof fetch;
    const r = await call(f, ["--capture", "login"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("前の画面が答えません");
    expect(r.err).toContain(`workspace --preview task/${ID}-e2e --base`);
    expect(r.err).not.toContain(`workspace --preview ${ID}`);
    expect(f.shells).toEqual([]);
  });

  it("流れの名前の形が外れたら流さず1", async () => {
    const f = await fixture();
    answering();
    for (const bad of [
      "Login",
      "a_b",
      "",
      "x".repeat(41),
      "../x",
      "a/b",
      "--wait",
      "-",
    ]) {
      const r = await call(f, ["--capture", bad]);
      expect(r.code, bad).toBe(1);
      expect(f.shells, bad).toEqual([]);
      expect(r.err, bad).toContain("流れの名前は");
    }
  });

  it("アプリが2つ以上なら --app が要る", async () => {
    const g = await fixture({ apps: ["web", "admin"] });
    answering();
    const r = await call(g, ["--capture", "login"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--app");
    expect(g.shells).toEqual([]);
  });

  it("--app で選んだアプリの置き場に置く", async () => {
    const f = await fixture({ apps: ["web", "admin"] });
    answering();
    f.plan = [
      { code: 0, writes: [{ name: "a.webm" }] },
      { code: 0, writes: [{ name: "b.webm" }] },
    ];
    const r = await call(f, ["--capture", "login", "--app", "admin"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(await listPlaced(f)).toEqual([]);
    const adminCommon = await commonOf(f.roots.admin!);
    expect(
      (
        await readdir(path.join(adminCommon, "orca-flow/e2e-captures", ID))
      ).sort(),
    ).toEqual(["login-after.webm", "login-before.webm"]);

    const shells = f.shells.length;
    const bad = await call(f, ["--capture", "login", "--app", "nope"]);
    expect(bad.code).toBe(1);
    expect(f.shells).toHaveLength(shells);
    expect(bad.err).toContain("nope");
    expect(bad.err).toContain("記録");
  });

  it("前の画面で落ちて録画がないときは、落ちた理由の伏せた末尾を出して1", async () => {
    const f = await fixture();
    answering();
    f.plan = [
      {
        code: 1,
        writes: [],
        output: "boom\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    ];
    const r = await call(f, ["--capture", "login"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("前の画面の E2E が落ちました");
    expect(r.err).toContain("boom");
    expect(r.err).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.err).toContain("前の画面の録画が0個");
    expect(f.shells).toHaveLength(1);
  });

  it("流す前からあった録画は拾わない", async () => {
    const f = await fixture();
    answering();
    const old = path.join(f.wt, "videos/old.webm");
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, "old");
    await utimes(old, new Date(1000), new Date(1000));
    f.plan = [
      { code: 0, writes: [{ name: "a.webm" }] },
      { code: 0, writes: [{ name: "b.webm" }] },
    ];
    const r = await call(f, ["--capture", "login"]);
    expect(r.code).toBe(0);
    expect(
      await readFile(path.join(placedDir(f), "login-before.webm"), "utf8"),
    ).toBe("xxxx");
  });

  it("E2E の出力は標準出力にも --json にも写さない", async () => {
    const f = await fixture();
    answering();
    f.plan = [
      { code: 0, writes: [{ name: "a.webm" }], output: "SECRET-LINE" },
      { code: 0, writes: [{ name: "b.webm" }], output: "SECRET-LINE" },
    ];
    const r = await call(f, ["--capture", "login", "--json"]);
    expect(r.out).not.toContain("SECRET-LINE");
    expect(r.err).not.toContain("SECRET-LINE");
  });
});

describe("e2e --capture-clear", () => {
  it("各アプリの置き場を消し、置き場がなくても0", async () => {
    const f = await fixture();
    answering();
    f.plan = [
      { code: 0, writes: [{ name: "a.webm" }] },
      { code: 0, writes: [{ name: "b.webm" }] },
    ];
    await call(f, ["--capture", "login"]);
    expect(await listPlaced(f)).toHaveLength(2);
    expect((await call(f, ["--capture-clear"])).code).toBe(0);
    expect(await listPlaced(f)).toEqual([]);
    expect((await call(f, ["--capture-clear"])).code).toBe(0);
    expect(f.shells).toHaveLength(2);
  });
});

describe("e2e --wait --base", () => {
  it("前の画面が答えるまで待ち、そろったら0", async () => {
    const f = await fixture({ base: "none" });
    answering();
    let now = 0;
    let sleeps = 0;
    previewDeps.clock = () => now;
    previewDeps.sleep = async (ms) => {
      sleeps += 1;
      now += ms;
      if (sleeps === 2)
        await writePreviewBaseRecord(f.appCommon, {
          id: ID,
          worktree: "/tmp/base",
          taskWorktree: f.wt,
          terminal: "term_2",
          commit: "abc",
          url: URL_BASE,
          at: "2026-01-01T00:00:00.000Z",
        });
    };
    const r = await call(f, ["--wait", "--base"]);
    expect(r.code).toBe(0);
    expect(sleeps).toBe(2);
    expect(f.shells).toEqual([]);
  });

  it("--base なしの --wait は前の画面を待たない。--base は --wait なしでは使えない", async () => {
    const f = await fixture({ base: "none" });
    answering();
    expect((await call(f, ["--wait"])).code).toBe(0);
    expect((await call(f, ["--base"])).code).toBe(1);
  });
});

describe("e2e --json のキー", () => {
  it("capture の設定があれば、アプリごとの baseUrl・baseAnswered と全体の capture が出る", async () => {
    const f = await fixture();
    answering();
    const r = await call(f, ["--wait", "--base", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({
      capture: true,
      apps: [{ name: "web", baseUrl: URL_BASE, baseAnswered: true }],
    });
  });

  it("前の画面が答えなければ baseAnswered は false で理由が出る", async () => {
    const f = await fixture({ base: "none" });
    answering();
    let now = 0;
    previewDeps.clock = () => now;
    previewDeps.sleep = async () => {
      now += 24 * 60 * 60_000;
    };
    const r = await call(f, ["--wait", "--base", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({
      capture: true,
      apps: [{ baseUrl: null, baseAnswered: false }],
    });
  });
});
