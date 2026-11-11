import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCompanionAt } from "../../src/lib/companion.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { previewDeps, writePreviewRecord } from "../../src/lib/preview.ts";
import { TAIL_LINES, VERIFY_TIMEOUT_MS } from "../../src/lib/verified.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import { runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

const ID = "T12";
const URL_WEB = "http://127.0.0.1:5173/";

interface Fixture {
  wt: string;
  appRoot: string;
  e2eCommon: string;
  appCommon: string;
  shells: { command: string; cwd: string | undefined }[];
  timeouts: (number | undefined)[];
  runner: Runner;
  shellResult: {
    code: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  };
}

async function commonOf(dir: string) {
  return (
    await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();
}

/** 伴う記録・preview の記録・段の記録を置く。opts で欠けさせる */
async function fixture(
  opts: {
    companion?: boolean;
    preview?: boolean;
    implemented?: boolean;
    command?: string;
    apps?: { name: string }[];
  } = {},
): Promise<Fixture> {
  const e2eRoot = await makeRepo({});
  const wt = await addTaskWorktree(e2eRoot, ID, "e2e");
  const appRoot = realpathSync(await makeRepo({}));
  const e2eCommon = await commonOf(e2eRoot);
  const appCommon = await commonOf(appRoot);
  if (opts.companion !== false)
    await writeCompanionAt(
      e2eCommon,
      ID,
      {
        command: opts.command ?? "run-e2e --base {previewUrl:web}",
        apps: (opts.apps ?? [{ name: "web" }]).map((a) => ({
          name: a.name,
          path: appRoot,
        })),
      },
      new Date(),
    );
  if (opts.preview !== false)
    await writePreviewRecord(appCommon, {
      id: ID,
      worktree: appRoot,
      terminal: "term_1",
      url: URL_WEB,
      at: "2026-01-01T00:00:00.000Z",
    });
  if (opts.implemented !== false)
    await appendStage(appCommon, ID, {
      at: "2026-01-01T00:00:00.000Z",
      state: "integrate-wait",
      note: null,
      command: "status",
    });
  const f: Fixture = {
    wt: wt.path,
    appRoot,
    e2eCommon,
    appCommon,
    shells: [],
    timeouts: [],
    shellResult: { code: 0, stdout: "", stderr: "" },
    runner: async (cmd, args, o) => {
      if (cmd === "sh" && args[0] === "-c") {
        f.shells.push({ command: args[1]!, cwd: o?.cwd });
        f.timeouts.push(o?.timeoutMs);
        return { timedOut: false, ...f.shellResult };
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

describe("e2e", () => {
  it("そろっていれば、印を引用した URL とテストの指定を埋めて worktree で流し、通れば0", async () => {
    const f = await fixture();
    answering();
    const r = await call(f, ["--", "tests/a b.spec.ts", "it's"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(f.shells).toEqual([
      {
        command: `run-e2e --base '${URL_WEB}' 'tests/a b.spec.ts' 'it'\\''s'`,
        cwd: realpathSync(f.wt),
      },
    ]);
  });

  it("落ちたら1で、verify と同じ時間切れを渡し、最後の行だけ秘密を伏せて標準エラーに出す", async () => {
    const f = await fixture();
    answering();
    const lines = Array.from({ length: TAIL_LINES + 5 }, (_, i) => `line-${i}`);
    f.shellResult = {
      code: 1,
      stdout: "",
      stderr: `${lines.join("\n")}\nfailed with ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD`,
    };
    const r = await call(f, []);
    expect(r.code).toBe(1);
    expect(f.timeouts).toEqual([VERIFY_TIMEOUT_MS]);
    expect(r.err).toContain("落ちました");
    expect(r.err).toContain("failed with");
    expect(r.err).toContain(`line-${lines.length - 1}`);
    expect(r.err).not.toContain("line-0\n");
    expect(r.err).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
  });

  it("時間切れなら1で、時間内に終わらなかったと出す", async () => {
    const f = await fixture();
    answering();
    f.shellResult = { code: 0, stdout: "", stderr: "", timedOut: true };
    const r = await call(f, []);
    expect(r.code).toBe(1);
    expect(r.err).toContain("時間内に終わりませんでした");
  });

  it("--json で落ちたら result は failed", async () => {
    const f = await fixture();
    answering();
    f.shellResult = { code: 1, stdout: "", stderr: "boom" };
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as { result: string }).result).toBe("failed");
  });

  it("伴う記録が壊れていれば流さず1", async () => {
    const f = await fixture();
    answering();
    const file = path.join(f.e2eCommon, "orca-flow", "companion", `${ID}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{broken");
    const r = await call(f, []);
    expect(r.code).toBe(1);
    expect(f.shells).toEqual([]);
  });

  it("--json は id・result・apps・reasons を出す", async () => {
    const f = await fixture();
    answering();
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: ID,
      result: "passed",
      apps: [{ name: "web", url: URL_WEB, answered: true, implemented: true }],
      reasons: [],
    });
  });

  const notRun = async (f: Fixture, expected: string) => {
    const r = await call(f, ["--json"]);
    expect(r.code).toBe(2);
    expect(f.shells).toEqual([]);
    const data = JSON.parse(r.out) as { result: string; reasons: string[] };
    expect(data.result).toBe("not-run");
    expect(data.reasons.join("\n")).toContain(expected);
  };

  it("伴う記録がなければ流さず2", async () => {
    const f = await fixture({ companion: false });
    answering();
    await notRun(f, "伴う記録がありません");
  });

  it("preview の記録がなければ流さず2", async () => {
    const f = await fixture({ preview: false });
    answering();
    await notRun(f, `workspace --preview task/${ID}-e2e を流してください`);
    const r = await call(f, []);
    expect(r.err).toContain(`workspace --preview task/${ID}-e2e`);
    expect(r.err).not.toContain(`workspace --preview ${ID}`);
  });

  it("URL が答えないときの次の手もブランチ名で打つ形", async () => {
    const f = await fixture();
    answering(false);
    const r = await call(f, []);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`workspace --preview task/${ID}-e2e を流し直して`);
    expect(r.err).not.toContain(`workspace --preview ${ID}`);
  });

  it("URL が答えなければ流さず2", async () => {
    const f = await fixture();
    answering(false);
    await notRun(f, "答えません");
  });

  it("integrate-wait の行がなければ流さず2", async () => {
    const f = await fixture({ implemented: false });
    answering();
    await notRun(f, "integrate-wait");
  });

  it("印の名前が記録になければ流さず2", async () => {
    const f = await fixture();
    answering();
    const file = path.join(f.e2eCommon, "orca-flow", "companion", `${ID}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        id: ID,
        at: "2026-01-01T00:00:00.000Z",
        command: "run {previewUrl:web}",
        apps: [{ name: "other", path: f.appRoot }],
      }),
    );
    await notRun(f, "{previewUrl:web}");
  });

  describe("--wait", () => {
    it("そろっていれば流さず0", async () => {
      const f = await fixture();
      answering();
      const r = await call(f, ["--wait"]);
      expect(r.code).toBe(0);
      expect(f.shells).toEqual([]);
    });

    it("伴う記録がなければ2", async () => {
      const f = await fixture({ companion: false });
      const r = await call(f, ["--wait"]);
      expect(r.code).toBe(2);
    });

    it("そろうまで1分おきに見て、そろったら0", async () => {
      const f = await fixture({ implemented: false });
      answering();
      let now = 0;
      const sleeps: number[] = [];
      previewDeps.clock = () => now;
      previewDeps.sleep = async (ms) => {
        sleeps.push(ms);
        now += ms;
        if (sleeps.length === 2)
          await appendStage(f.appCommon, ID, {
            at: "2026-01-02T00:00:00.000Z",
            state: "integrate-wait",
            note: null,
            command: "status",
          });
      };
      const r = await call(f, ["--wait"]);
      expect(r.code).toBe(0);
      expect(sleeps).toEqual([60_000, 60_000]);
      expect(f.shells).toEqual([]);
    });

    it("24時間でそろわなければ2", async () => {
      const f = await fixture({ implemented: false });
      answering();
      let now = 0;
      let sleeps = 0;
      previewDeps.clock = () => now;
      previewDeps.sleep = async () => {
        sleeps += 1;
        now += sleeps === 1 ? 24 * 60 * 60_000 - 60_000 : 60_000;
      };
      const r = await call(f, ["--wait"]);
      expect(r.code).toBe(2);
      expect(sleeps).toBe(2);
      expect(r.err).toContain("24時間");
    });
  });
});
