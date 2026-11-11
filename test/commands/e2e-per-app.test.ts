import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCompanion,
  writeCompanionAt,
  type CompanionInput,
} from "../../src/lib/companion.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { previewDeps, writePreviewRecord } from "../../src/lib/preview.ts";
import { writePreviewBaseRecord } from "../../src/lib/preview-base.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

const ID = "T12";
const URL: Record<string, string> = {
  "app-a": "http://127.0.0.1:5001/",
  "app-b": "http://127.0.0.1:5002/",
  constructor: "http://127.0.0.1:5003/",
};
const BASE_URL: Record<string, string> = {
  "app-a": "http://127.0.0.1:6001/",
  "app-b": "http://127.0.0.1:6002/",
  constructor: "http://127.0.0.1:6003/",
};

const COMMANDS = {
  "app-a": "run-a --base {previewUrl:app-a}",
  "app-b": "run-b --base {previewUrl:app-b} --a {previewUrl:app-a}",
};

interface Fixture {
  wt: string;
  roots: Record<string, string>;
  shells: { command: string; cwd: string | undefined }[];
  /** 頭の語ごとの終了コード */
  codes: Record<string, number>;
  runner: Runner;
}

const commonOf = async (dir: string) =>
  (
    await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();

async function fixture(
  opts: {
    command?: CompanionInput["command"];
    capture?: CompanionInput["capture"];
    /** 記録の apps の順 */
    apps?: string[];
    /** 実装がまだのアプリ */
    notImplemented?: string[];
  } = {},
): Promise<Fixture> {
  const e2eRoot = await makeRepo({});
  const wt = await addTaskWorktree(e2eRoot, ID, "e2e");
  const names = opts.apps ?? ["app-a", "app-b"];
  const roots: Record<string, string> = {};
  for (const n of names) roots[n] = realpathSync(await makeRepo({}));
  await writeCompanionAt(
    await commonOf(e2eRoot),
    ID,
    {
      command: opts.command ?? COMMANDS,
      apps: names.map((n) => ({ name: n, path: roots[n]! })),
      ...(opts.capture ? { capture: opts.capture } : {}),
    },
    new Date(),
  );
  for (const n of names) {
    const common = await commonOf(roots[n]!);
    await writePreviewRecord(common, {
      id: ID,
      worktree: roots[n]!,
      terminal: "term_1",
      url: URL[n]!,
      at: "2026-01-01T00:00:00.000Z",
    });
    await writePreviewBaseRecord(common, {
      id: ID,
      worktree: "/tmp/base",
      taskWorktree: wt.path,
      terminal: "term_2",
      commit: "abc",
      url: BASE_URL[n]!,
      at: "2026-01-01T00:00:00.000Z",
    });
    if (!opts.notImplemented?.includes(n))
      await appendStage(common, ID, {
        at: "2026-01-01T00:00:00.000Z",
        state: "integrate-wait",
        note: null,
        command: "status",
      });
  }
  let now = 1_700_000_000_000;
  previewDeps.clock = () => now;
  previewDeps.fetch = (async () =>
    new Response(null, { status: 200 })) as typeof fetch;
  const f: Fixture = {
    wt: wt.path,
    roots,
    shells: [],
    codes: {},
    runner: async (cmd, args, o) => {
      if (cmd === "sh" && args[0] === "-c") {
        const command = args[1]!;
        f.shells.push({ command, cwd: o?.cwd });
        now += 1000;
        if (command.includes("--video")) {
          const file = path.join(wt.path, "videos", `${now}.webm`);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, "x");
          await utimes(file, new Date(now), new Date(now));
        }
        now += 1000;
        return {
          code: f.codes[command.split(" ")[0]!] ?? 0,
          stdout: "",
          stderr: "boom",
          timedOut: false,
        };
      }
      return testRunner(cmd, args, o);
    },
  };
  return f;
}

const call = (f: Fixture, argv: string[]) =>
  runCli(["e2e", ID, ...argv], { cwd: f.wt, runner: f.runner });

const filled = (name: keyof typeof COMMANDS, ...tests: string[]) =>
  [
    COMMANDS[name]
      .replace("{previewUrl:app-a}", `'${URL["app-a"]}'`)
      .replace("{previewUrl:app-b}", `'${URL["app-b"]}'`),
    ...tests.map((t) => `'${t}'`),
  ].join(" ");

describe("e2e：アプリごとのコマンド", () => {
  it("記録の apps の順に1つずつ、E2E の worktree で流し、全部通れば0", async () => {
    const f = await fixture({ apps: ["app-b", "app-a"] });
    const r = await call(f, []);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const cwd = realpathSync(f.wt);
    expect(f.shells).toEqual([
      { command: filled("app-b"), cwd },
      { command: filled("app-a"), cwd },
    ]);
  });

  it("1つが落ちても残りを流して1。--json の runs にアプリごとの結果が入る", async () => {
    const f = await fixture();
    f.codes = { "run-a": 1 };
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(1);
    expect(f.shells.map((s) => s.command)).toEqual([
      filled("app-a"),
      filled("app-b"),
    ]);
    const data = JSON.parse(r.out) as Record<string, unknown>;
    expect(data.result).toBe("failed");
    expect(data.runs).toEqual([
      { app: "app-a", result: "failed" },
      { app: "app-b", result: "passed" },
    ]);
    expect(r.err).toContain("app-a");
    expect(r.err).toContain("落ちました");
  });

  it("全部通れば --json の runs は全部 passed", async () => {
    const f = await fixture();
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as Record<string, unknown>;
    expect(data.result).toBe("passed");
    expect(data.runs).toEqual([
      { app: "app-a", result: "passed" },
      { app: "app-b", result: "passed" },
    ]);
  });

  it("キーのないアプリのコマンドは流さない", async () => {
    const f = await fixture({ command: { "app-b": COMMANDS["app-b"] } });
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(0);
    expect(f.shells.map((s) => s.command)).toEqual([filled("app-b")]);
    expect((JSON.parse(r.out) as { runs: unknown }).runs).toEqual([
      { app: "app-b", result: "passed" },
    ]);
  });

  it("--app で選んだコマンドだけを流し、テストの指定はそのコマンドにだけ足す", async () => {
    const f = await fixture();
    const r = await call(f, ["--app", "app-b", "--", "tests/b.spec.ts"]);
    expect(r.code).toBe(0);
    expect(f.shells.map((s) => s.command)).toEqual([
      filled("app-b", "tests/b.spec.ts"),
    ]);
  });

  it("--app がキーにない名前なら流さず1", async () => {
    const f = await fixture({ command: { "app-a": COMMANDS["app-a"] } });
    for (const name of ["app-b", "nope"]) {
      const r = await call(f, ["--app", name]);
      expect(r.code, name).toBe(1);
      expect(r.err, name).toContain(name);
    }
    expect(f.shells).toEqual([]);
  });

  it("コマンドが2本以上でテストの指定があり --app がなければ流さず1", async () => {
    const f = await fixture();
    const r = await call(f, ["--", "tests/a.spec.ts"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--app");
    expect(f.shells).toEqual([]);
  });

  it("コマンドが1本ならテストの指定を --app なしで足せる", async () => {
    const f = await fixture({ command: { "app-a": COMMANDS["app-a"] } });
    const r = await call(f, ["--", "tests/a.spec.ts"]);
    expect(r.code).toBe(0);
    expect(f.shells.map((s) => s.command)).toEqual([
      filled("app-a", "tests/a.spec.ts"),
    ]);
  });

  it("記録のアプリの1つでもそろわなければ、--app で選んでも流さず2", async () => {
    const f = await fixture({ notImplemented: ["app-b"] });
    for (const argv of [[], ["--app", "app-a"]]) {
      const r = await call(f, ["--json", ...argv]);
      expect(r.code, argv.join(" ")).toBe(2);
      expect((JSON.parse(r.out) as { result: string }).result).toBe("not-run");
    }
    expect(f.shells).toEqual([]);
  });

  it("--app を --wait・--capture-clear と一緒に付けると何も流さず1", async () => {
    const f = await fixture();
    for (const argv of [
      ["--wait", "--app", "app-a"],
      ["--capture-clear", "--app", "app-a"],
    ]) {
      const r = await call(f, argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toContain("--app");
    }
    expect(f.shells).toEqual([]);
  });

  it("Object.prototype と同じ名前のアプリは、キーがなければ流さない", async () => {
    const command = {
      "app-b": "run-b {previewUrl:app-b} {previewUrl:constructor}",
    };
    const f = await fixture({ command, apps: ["constructor", "app-b"] });
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(0);
    expect(f.shells.map((s) => s.command)).toEqual([
      `run-b '${URL["app-b"]}' '${URL.constructor}'`,
    ]);
    expect((JSON.parse(r.out) as { runs: unknown }).runs).toEqual([
      { app: "app-b", result: "passed" },
    ]);
    const chosen = await call(f, ["--app", "constructor"]);
    expect(chosen.code).toBe(1);
    expect(chosen.err).toContain("constructor");
    expect(f.shells).toHaveLength(1);
  });

  it("印の名前のずれだけの記録は、オブジェクトでも流さず2で理由を出す", async () => {
    const f = await fixture();
    const common = await commonOf(f.wt);
    const file = path.join(common, "orca-flow", "companion", `${ID}.json`);
    await writeFile(
      file,
      JSON.stringify({
        id: ID,
        at: "2026-01-01T00:00:00.000Z",
        command: { "app-a": "run-a {previewUrl:app-a} {previewUrl:app-b}" },
        apps: [{ name: "app-a", path: f.roots["app-a"] }],
      }),
    );
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(2);
    expect(f.shells).toEqual([]);
    expect(
      (JSON.parse(r.out) as { reasons: string[] }).reasons.join("\n"),
    ).toContain("{previewUrl:app-b}");
  });
});

describe("e2e：文字列の記録はこれまでどおり", () => {
  const STRING = "run --base {previewUrl:app-a}";

  it("1本だけ流し、--json に runs を足さない", async () => {
    const f = await fixture({ command: STRING, apps: ["app-a"] });
    const r = await call(f, ["--json", "--", "tests/a.spec.ts"]);
    expect(r.code).toBe(0);
    expect(f.shells.map((s) => s.command)).toEqual([
      `run --base '${URL["app-a"]}' 'tests/a.spec.ts'`,
    ]);
    expect(Object.keys(JSON.parse(r.out) as object)).toEqual([
      "id",
      "result",
      "apps",
      "reasons",
    ]);
  });

  it("落ちたときの標準エラーの文は前と同じ", async () => {
    const f = await fixture({ command: STRING, apps: ["app-a"] });
    f.codes = { run: 1 };
    const r = await call(f, []);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${ID} の worktree で E2E が落ちました`);
  });

  it("時間切れの標準エラーの文も前と同じ", async () => {
    const f = await fixture({ command: STRING, apps: ["app-a"] });
    const runner: Runner = async (cmd, args, o) =>
      cmd === "sh" && args[0] === "-c"
        ? { code: 1, stdout: "", stderr: "", timedOut: true }
        : f.runner(cmd, args, o);
    const r = await runCli(["e2e", ID], { cwd: f.wt, runner });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `${ID} の worktree で E2E が時間内に終わりませんでした`,
    );
  });

  it("--app を --capture なしで付けると流さず1", async () => {
    const f = await fixture({ command: STRING, apps: ["app-a"] });
    const r = await call(f, ["--app", "app-a"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--app");
    expect(f.shells).toEqual([]);
  });
});

describe("e2e --capture：アプリごとの capture.command", () => {
  const capture = {
    command: {
      "app-a": "cap-a --video {previewUrl:app-a}",
      "app-b": "cap-b --video {previewUrl:app-b}",
    },
    output: "videos",
  };

  it("--app で選んだアプリのコマンドで前と後を流し、そのアプリの置き場に置く", async () => {
    const f = await fixture({ capture });
    const r = await call(f, ["--capture", "login", "--app", "app-b"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(f.shells.map((s) => s.command)).toEqual([
      `cap-b --video '${BASE_URL["app-b"]}'`,
      `cap-b --video '${URL["app-b"]}'`,
    ]);
    const dir = path.join(
      await commonOf(f.roots["app-b"]!),
      "orca-flow/e2e-captures",
      ID,
    );
    expect((await readdir(dir)).sort()).toEqual([
      "login-after.webm",
      "login-before.webm",
    ]);
  });

  it("選んだアプリのキーがなければ流さず1", async () => {
    const f = await fixture({
      capture: { ...capture, command: { "app-a": capture.command["app-a"] } },
    });
    const r = await call(f, ["--capture", "login", "--app", "app-b"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("app-b");
    expect(f.shells).toEqual([]);
  });

  it("Object.prototype と同じ名前のアプリを選んでも、キーがなければ流さず1", async () => {
    const f = await fixture({
      apps: ["constructor", "app-b"],
      command: { "app-b": "run-b {previewUrl:app-b}" },
      capture: { ...capture, command: { "app-b": capture.command["app-b"] } },
    });
    const r = await call(f, ["--capture", "login", "--app", "constructor"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("capture.command に constructor の分がありません");
    expect(f.shells).toEqual([]);
  });

  it("伴う記録に capture がなければ流さず2で、渡したアプリの分がないときも含むと書く", async () => {
    const f = await fixture();
    const r = await call(f, ["--capture", "login", "--app", "app-a"]);
    expect(r.code).toBe(2);
    expect(f.shells).toEqual([]);
    expect(r.err).toContain("capture がありません");
    expect(r.err).toContain("`--companion` で渡したアプリの分");
  });
});

describe("new --companion-json：アプリごとのコマンド", () => {
  it("オブジェクトの command を記録に書き、読み直せる", async () => {
    const root = await makeRepo();
    const value = {
      command: { "app-b": COMMANDS["app-b"] },
      apps: [
        { name: "app-a", path: "/tmp/app-a-main" },
        { name: "app-b", path: "/tmp/app-b-main" },
      ],
    };
    const r = await runCli(
      [
        "new",
        "--title",
        "a",
        "--slug",
        "a",
        "--companion-json",
        JSON.stringify(value),
      ],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.code).toBe(0);
    const file = path.join(
      await commonOf(root),
      "orca-flow/companion/T01.json",
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject(value);
    expect(await readCompanion(testRunner, root, "T01")).toMatchObject(value);
  });
});
