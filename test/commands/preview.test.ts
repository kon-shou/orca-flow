import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { main } from "../../src/cli.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import { noStopTargetMessage, previewDeps } from "../../src/lib/preview.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const SAVED = { ...previewDeps };

/** 偽の時計：sleep が時計を進めるので、待ちは実時間を使わない */
let now = 0;
function fakeTime() {
  now = 0;
  previewDeps.clock = () => now;
  previewDeps.sleep = async (ms) => {
    now += ms;
  };
  previewDeps.pollMs = 1_000;
}

interface Preview {
  runner: Runner;
  orcaCalls: string[][];
  /** ターミナルごとの出力 */
  output: Map<string, string[]>;
  alive: Set<string>;
  sent: string[];
  downRuns: { command: string; cwd: string | undefined }[];
  downCode: number;
  sendFails: boolean;
  downTimedOut: boolean;
}

/** orca のターミナル・タブは偽物、git は本物、down などのシェルは記録だけ */
function preview(): Preview {
  const base = fakeOrca();
  const state: Preview = {
    runner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    orcaCalls: [],
    output: new Map(),
    alive: new Set(),
    sent: [],
    downRuns: [],
    downCode: 0,
    sendFails: false,
    downTimedOut: false,
  };
  const ok = (result: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, result }),
    stderr: "",
    timedOut: false,
  });
  const val = (args: readonly string[], name: string) =>
    args[args.indexOf(name) + 1] ?? "";
  let n = 0;
  state.runner = async (cmd, args, opts) => {
    if (cmd === "sh" && args[0] === "-c") {
      state.downRuns.push({ command: args[1]!, cwd: opts?.cwd });
      return {
        code: state.downCode,
        stdout: "",
        stderr: "",
        timedOut: state.downTimedOut,
      };
    }
    if (cmd !== "orca") return base.runner(cmd, args, opts);
    const plain = args.filter((a) => a !== "--json");
    state.orcaCalls.push(plain);
    const [group, action] = plain;
    if (group === "terminal" && action === "create") {
      const handle = `term_${++n}`;
      state.alive.add(handle);
      state.output.set(handle, []);
      return ok({ terminal: { handle } });
    }
    if (group === "terminal" && action === "send") {
      if (state.sendFails)
        return {
          code: 1,
          stdout: JSON.stringify({ ok: false, error: { message: "x" } }),
          stderr: "",
          timedOut: false,
        };
      state.sent.push(val(plain, "--text"));
      return ok({});
    }
    if (group === "terminal" && action === "read") {
      const lines = state.output.get(val(plain, "--terminal")) ?? [];
      return ok({ terminal: { tail: lines } });
    }
    if (group === "terminal" && action === "list") {
      const wt = val(plain, "--worktree").replace(/^path:/, "");
      return ok({
        terminals: [...state.alive].map((handle) => ({
          handle,
          worktreePath: wt,
          title: "preview",
          connected: true,
          writable: true,
          orphaned: false,
        })),
      });
    }
    if (group === "terminal" && action === "close") {
      state.alive.delete(val(plain, "--terminal"));
      return ok({ closed: true });
    }
    if (group === "tab" && action === "create") return ok({});
    return base.runner(cmd, args, opts);
  };
  return state;
}

const answering = (answers: boolean | string[] = true) => {
  const seen: string[] = [];
  previewDeps.fetch = (async (url: string) => {
    seen.push(String(url));
    if (answers === false) throw new Error("refused");
    return { status: 200, body: null };
  }) as unknown as typeof fetch;
  return seen;
};

async function setup(preview: Record<string, unknown> | null) {
  const root = await makeRepo({ idPrefix: "T", preview });
  const wt = await addTaskWorktree(root, "T7", "shop");
  const common = path.join(root, ".git");
  return { root, wt, common };
}
const recordFile = (common: string) =>
  path.join(common, "orca-flow", "preview", "T7.json");
const run = (cwd: string, p: Preview, ...argv: string[]) =>
  runCli(["preview", ...argv], { cwd, runner: p.runner });

beforeEach(fakeTime);
afterEach(() => Object.assign(previewDeps, SAVED));

describe("preview：起動", () => {
  it("ターミナルを作り、起動のコマンドを送り、出力の URL でブラウザのタブを開く", async () => {
    const { root, wt, common } = await setup({ up: "make dev" });
    const p = preview();
    const seen = answering();
    // 送ったあとに出力が出る形：作ったターミナルの出力にあらかじめ置く
    const original = p.runner;
    p.runner = async (cmd, args, opts) => {
      const r = await original(cmd, args, opts);
      if (cmd === "orca" && args.includes("create") && args[0] === "terminal")
        p.output.set("term_1", [
          "$ make dev",
          "ORCA_FLOW_URL=http://localhost:1111/old",
          "ORCA_FLOW_URL=http://localhost:5173/app",
        ]);
      return r;
    };
    const result = await run(root, p, "T7");
    expect(result.code).toBe(0);
    expect(p.sent).toEqual(["make dev"]);
    expect(
      p.orcaCalls.find((c) => c[0] === "terminal" && c[1] === "create"),
    ).toContain(`path:${wt.path}`);
    expect(seen).toEqual(["http://localhost:5173/app"]);
    expect(p.orcaCalls.find((c) => c[0] === "tab")).toEqual([
      "tab",
      "create",
      "--url",
      "http://localhost:5173/app",
      "--worktree",
      `path:${wt.path}`,
    ]);
    const record = JSON.parse(await readFile(recordFile(common), "utf8"));
    expect(record).toMatchObject({
      id: "T7",
      terminal: "term_1",
      url: "http://localhost:5173/app",
    });
    expect(result.out).toContain("http://localhost:5173/app");
  });

  it("どのタブ（タスクの worktree）から打っても動く", async () => {
    const { wt } = await setup({ up: "make dev", url: "http://localhost:80" });
    const p = preview();
    answering();
    const result = await run(wt.path, p, "T7");
    expect(result.code).toBe(0);
  });

  it("設定の url があれば、出力を読まずにその URL を開く", async () => {
    const { root, wt } = await setup({
      up: "make dev",
      url: "http://localhost:8080/",
    });
    const p = preview();
    const seen = answering();
    const result = await run(root, p, "T7");
    expect(result.code).toBe(0);
    expect(
      p.orcaCalls.some((c) => c[0] === "terminal" && c[1] === "read"),
    ).toBe(false);
    expect(seen).toEqual(["http://localhost:8080/"]);
    expect(p.orcaCalls.find((c) => c[0] === "tab")).toContain(
      "http://localhost:8080/",
    );
    expect(p.orcaCalls.find((c) => c[0] === "tab")).toContain(
      `path:${wt.path}`,
    );
  });

  it("URL が出ないまま時間を過ぎると終了コード1で、ターミナルを閉じず記録を残す", async () => {
    const { root, common } = await setup({ up: "make dev", timeoutSeconds: 3 });
    const p = preview();
    answering();
    const result = await run(root, p, "T7");
    expect(result.code).toBe(1);
    expect(result.err).toContain("--stop");
    expect(now).toBeGreaterThanOrEqual(3_000);
    expect(now).toBeLessThanOrEqual(3_000 + 1_000);
    expect(
      p.orcaCalls.some((c) => c[0] === "terminal" && c[1] === "close"),
    ).toBe(false);
    expect(p.orcaCalls.some((c) => c[0] === "tab")).toBe(false);
    const record = JSON.parse(await readFile(recordFile(common), "utf8"));
    expect(record.terminal).toBe("term_1");
    expect(record.url).toBeUndefined();
  });

  it("URL は出ても答えないまま時間を過ぎると終了コード1（記録は残る）", async () => {
    const { root, common } = await setup({
      up: "make dev",
      url: "http://localhost:9",
      timeoutSeconds: 2,
    });
    const p = preview();
    answering(false);
    const result = await run(root, p, "T7");
    expect(result.code).toBe(1);
    expect(now).toBeGreaterThanOrEqual(2_000);
    expect(now).toBeLessThanOrEqual(2_000 + 1_000);
    await expect(readFile(recordFile(common), "utf8")).resolves.toContain(
      "term_1",
    );
  });

  it("記録があり、ターミナルが生きているときは、起動のコマンドを送らずタブだけ開く", async () => {
    const { root, wt, common } = await setup({ up: "make dev" });
    const p = preview();
    answering();
    p.alive.add("term_old");
    await mkdir(path.dirname(recordFile(common)), { recursive: true });
    await writeFile(
      recordFile(common),
      JSON.stringify({
        id: "T7",
        worktree: wt.path,
        terminal: "term_old",
        url: "http://localhost:3000",
        at: "2026-11-05T00:00:00.000Z",
      }),
    );
    const result = await run(root, p, "T7");
    expect(result.code).toBe(0);
    expect(p.sent).toEqual([]);
    expect(
      p.orcaCalls.some((c) => c[0] === "terminal" && c[1] === "create"),
    ).toBe(false);
    expect(p.orcaCalls.find((c) => c[0] === "tab")).toContain(
      "http://localhost:3000",
    );
  });

  it("記録のターミナルがもうないときは、記録を捨てて起動し直す", async () => {
    const { root, wt, common } = await setup({
      up: "make dev",
      url: "http://localhost:3000",
    });
    const p = preview();
    answering();
    await mkdir(path.dirname(recordFile(common)), { recursive: true });
    await writeFile(
      recordFile(common),
      JSON.stringify({
        id: "T7",
        worktree: wt.path,
        terminal: "term_gone",
        at: "2026-11-05T00:00:00.000Z",
      }),
    );
    const result = await run(root, p, "T7");
    expect(result.code).toBe(0);
    expect(p.sent).toEqual(["make dev"]);
    const record = JSON.parse(await readFile(recordFile(common), "utf8"));
    expect(record.terminal).toBe("term_1");
  });

  it("ターミナルの出力は、秘密らしい行があっても標準出力・標準エラーに出ない", async () => {
    const { root } = await setup({ up: "make dev", timeoutSeconds: 2 });
    const p = preview();
    answering();
    const original = p.runner;
    p.runner = async (cmd, args, opts) => {
      const r = await original(cmd, args, opts);
      if (cmd === "orca" && args[0] === "terminal" && args[1] === "create")
        p.output.set("term_1", [
          "DB_PASSWORD=hunter2-secret",
          "ORCA_FLOW_URL=ftp://secret-host/",
        ]);
      return r;
    };
    const timedOut = await run(root, p, "T7");
    expect(timedOut.code).toBe(1);
    expect(timedOut.out + timedOut.err).not.toContain("hunter2");
    expect(timedOut.out + timedOut.err).not.toContain("secret-host");

    const q = preview();
    const original2 = q.runner;
    q.runner = async (cmd, args, opts) => {
      const r = await original2(cmd, args, opts);
      if (cmd === "orca" && args[0] === "terminal" && args[1] === "create")
        q.output.set("term_1", [
          "TOKEN=abc-secret-token",
          "ORCA_FLOW_URL=http://localhost:1234",
        ]);
      return r;
    };
    const ok = await run(root, q, "T7");
    expect(ok.code).toBe(0);
    expect(ok.out + ok.err).not.toContain("secret-token");
  });

  it("色づけの制御文字の入った URL の行は使わず、標準出力に ESC を出さない", async () => {
    const { root } = await setup({ up: "make dev", timeoutSeconds: 2 });
    const p = preview();
    const seen = answering();
    const original = p.runner;
    p.runner = async (cmd, args, opts) => {
      const r = await original(cmd, args, opts);
      if (cmd === "orca" && args[0] === "terminal" && args[1] === "create")
        p.output.set("term_1", [
          "ORCA_FLOW_URL=http://localhost:3000\x1b[0m",
          "ORCA_FLOW_URL=http://localhost:3000/\x1b]52;c;AAAA\x07",
        ]);
      return r;
    };
    const result = await run(root, p, "T7");
    expect(result.code).toBe(1);
    expect(seen).toEqual([]);
    expect(p.orcaCalls.some((c) => c[0] === "tab")).toBe(false);
    expect(result.out + result.err).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  it("待つ間に記録が消えたら、記録を書き戻さず、タブも開かない", async () => {
    const { root, common } = await setup({
      up: "make dev",
      url: "http://localhost:8080/",
    });
    const p = preview();
    previewDeps.fetch = (async () => {
      await rm(recordFile(common), { force: true });
      return { status: 200, body: null };
    }) as unknown as typeof fetch;
    const result = await run(root, p, "T7");
    expect(result.code).toBe(1);
    expect(result.err).toContain("止められた");
    expect(p.orcaCalls.some((c) => c[0] === "tab")).toBe(false);
    await expect(readFile(recordFile(common), "utf8")).rejects.toThrow();
  });

  it("待つ間に記録が別の起動に置き換わったら、上書きせず、タブも開かない", async () => {
    const { root, wt, common } = await setup({
      up: "make dev",
      url: "http://localhost:8080/",
    });
    const p = preview();
    previewDeps.fetch = (async () => {
      await writeFile(
        recordFile(common),
        JSON.stringify({
          id: "T7",
          worktree: wt.path,
          terminal: "term_new",
          at: "2026-11-05T00:00:00.000Z",
        }),
      );
      return { status: 200, body: null };
    }) as unknown as typeof fetch;
    const result = await run(root, p, "T7");
    expect(result.code).toBe(1);
    expect(result.err).toContain("置き換わった");
    expect(p.orcaCalls.some((c) => c[0] === "tab")).toBe(false);
    const record = JSON.parse(await readFile(recordFile(common), "utf8"));
    expect(record.terminal).toBe("term_new");
    expect(record.url).toBeUndefined();
  });

  it("共通の枝の取り込みが古いときは、起動の前に警告を出し、起動は続く", async () => {
    const dep = await makeRepo({ idPrefix: "S" });
    const depCommon = path.join(dep, ".git");
    await mkdir(path.join(depCommon, "orca-flow/branch-push"), {
      recursive: true,
    });
    await writeFile(
      path.join(depCommon, "orca-flow/branch-push/S5.json"),
      JSON.stringify({
        id: "S5",
        branch: "task/S5-core-kit",
        at: "2026-11-04T00:00:00.000Z",
        pushedHead: "0123456789abcdef0123456789abcdef01234567",
        pushedAt: "2026-11-04T01:00:00.000Z",
      }),
    );
    const root = await makeRepo({
      idPrefix: "T",
      preview: { up: "make dev", url: "http://localhost:80" },
    });
    const wt = await addTaskWorktree(root, "T7", "shop", {
      "composer.lock":
        '{"packages":[{"name":"acme/core-kit","version":"dev-task/S5-core-kit","source":{"reference":"fedcba9876543210fedcba9876543210fedcba98"}}]}\n',
    });
    const dir = path.join(root, ".git", "orca-flow", "cross-depends");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "T7.json"),
      JSON.stringify({
        id: "T7",
        at: "2026-11-04T00:00:00.000Z",
        repos: [
          {
            name: "core-kit",
            path: dep,
            package: "acme/core-kit",
            branch: "task/S5-core-kit",
            branchCommand:
              "composer require acme/core-kit:dev-task/S5-core-kit",
            bumpCommand: "composer require acme/core-kit:^1.4",
            ids: ["S5"],
          },
        ],
      }),
    );
    const p = preview();
    answering();
    // 警告と、ターミナルの作成・送信を、起きた順に1つの列へ積む
    const events: string[] = [];
    const inner = p.runner;
    p.runner = async (cmd, args, opts) => {
      if (cmd === "orca" && args[0] === "terminal")
        events.push(`orca ${args[1]}`);
      return inner(cmd, args, opts);
    };
    const err: string[] = [];
    const code = await main(["preview", "T7"], {
      cwd: wt.path,
      runner: p.runner,
      stdout: () => {},
      stderr: (t) => {
        err.push(t);
        events.push(t.includes("取り込み直す") ? "warn" : "other");
      },
    });
    expect(code).toBe(0);
    expect(err.join("\n")).toContain("警告");
    expect(p.sent).toEqual(["make dev"]);
    expect(events.indexOf("warn")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("warn")).toBeLessThan(events.indexOf("orca create"));
    expect(events.indexOf("orca create")).toBeLessThan(
      events.indexOf("orca send"),
    );
  });
});

describe("preview：エラー", () => {
  it("preview が null なら終了コード2で、統括役が足すと伝える", async () => {
    const { root } = await setup(null);
    const result = await run(root, preview(), "T7");
    expect(result.code).toBe(2);
    expect(result.err).toContain("統括役");
    expect(result.err).toContain("preview");
  });

  it("作業中でない ID は終了コード1", async () => {
    const { root } = await setup({ up: "make dev" });
    const result = await run(root, preview(), "T99");
    expect(result.code).toBe(1);
    expect(result.err).toContain("T99");
  });

  it("ID がないときは使い方を出して終了コード1", async () => {
    const { root } = await setup({ up: "make dev" });
    const result = await run(root, preview());
    expect(result.code).toBe(1);
    expect(result.err).toContain("使い方");
  });

  it("起動のコマンドを送れなかったら、作ったターミナルを閉じて記録を残さない", async () => {
    const { root, common } = await setup({ up: "make dev" });
    const p = preview();
    p.sendFails = true;
    const result = await run(root, p, "T7");
    expect(result.code).toBe(1);
    expect(p.alive.size).toBe(0);
    await expect(readFile(recordFile(common), "utf8")).rejects.toThrow();
  });
});

describe("preview --stop", () => {
  async function started(config: Record<string, unknown>) {
    const s = await setup(config);
    const p = preview();
    answering();
    p.alive.add("term_other");
    await run(s.root, p, "T7");
    return { ...s, p };
  }

  it("down を worktree で流し、記録のターミナルだけを閉じ、記録を消す", async () => {
    const { root, wt, common, p } = await started({
      up: "make dev",
      down: "make down",
      url: "http://localhost:80",
    });
    p.orcaCalls.length = 0;
    const result = await run(root, p, "T7", "--stop");
    expect(result.code).toBe(0);
    expect(p.downRuns).toEqual([{ command: "make down", cwd: wt.path }]);
    const closes = p.orcaCalls.filter(
      (c) => c[0] === "terminal" && c[1] === "close",
    );
    expect(closes).toEqual([["terminal", "close", "--terminal", "term_1"]]);
    expect(p.alive.has("term_other")).toBe(true);
    await expect(readFile(recordFile(common), "utf8")).rejects.toThrow();
  });

  it("記録も down もなければ何もせず終了コード0", async () => {
    const { root } = await setup({ up: "make dev" });
    const p = preview();
    const result = await run(root, p, "T7", "--stop");
    expect(result.code).toBe(0);
    expect(p.downRuns).toEqual([]);
    expect(p.orcaCalls.some((c) => c[0] === "terminal")).toBe(false);
  });

  it("down が失敗したら終了コード1で、記録とターミナルを残す", async () => {
    const { root, common, p } = await started({
      up: "make dev",
      down: "make down",
      url: "http://localhost:80",
    });
    p.downCode = 2;
    const result = await run(root, p, "T7", "--stop");
    expect(result.code).toBe(1);
    expect(p.alive.has("term_1")).toBe(true);
    await expect(readFile(recordFile(common), "utf8")).resolves.toContain(
      "term_1",
    );
  });

  it("preview が null で記録もなければ、終了コード2", async () => {
    const { root } = await setup(null);
    const result = await run(root, preview(), "T7", "--stop");
    expect(result.code).toBe(2);
    expect(result.err).toContain("統括役");
  });

  it("作業中でない ID で記録もなければ、終了コード1で止めるものなしの文を出す（親の組の --stop がこの文で見分ける）", async () => {
    const { root } = await setup({ up: "make dev", down: "make down" });
    const p = preview();
    const result = await run(root, p, "T8", "--stop");
    expect(result.code).toBe(1);
    expect(result.err).toContain(noStopTargetMessage("T8"));
    expect(p.downRuns).toEqual([]);
  });

  it("作業中でない ID でも、記録があれば記録の worktree で止めて記録を消す", async () => {
    const { root, wt, common } = await setup({
      up: "make dev",
      down: "make down",
    });
    const p = preview();
    p.alive.add("term_old");
    const file = path.join(common, "orca-flow", "preview", "T99.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        id: "T99",
        worktree: wt.path,
        terminal: "term_old",
        at: "2026-11-05T00:00:00.000Z",
      }),
    );
    const result = await run(root, p, "T99", "--stop");
    expect(result.code).toBe(0);
    expect(p.downRuns).toEqual([{ command: "make down", cwd: wt.path }]);
    expect(
      p.orcaCalls.filter((c) => c[0] === "terminal" && c[1] === "close"),
    ).toEqual([["terminal", "close", "--terminal", "term_old"]]);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("down はあるが記録がないときは、down だけ流す", async () => {
    const { root, wt } = await setup({ up: "make dev", down: "make down" });
    const p = preview();
    const result = await run(root, p, "T7", "--stop");
    expect(result.code).toBe(0);
    expect(p.downRuns).toEqual([{ command: "make down", cwd: wt.path }]);
    expect(p.orcaCalls.some((c) => c[0] === "terminal")).toBe(false);
  });

  it("down が時間切れなら終了コード1で、記録とターミナルを残す", async () => {
    const { root, common, p } = await started({
      up: "make dev",
      down: "make down",
      url: "http://localhost:80",
    });
    p.downTimedOut = true;
    const result = await run(root, p, "T7", "--stop");
    expect(result.code).toBe(1);
    expect(result.err).toContain("時間内");
    expect(p.alive.has("term_1")).toBe(true);
    await expect(readFile(recordFile(common), "utf8")).resolves.toContain(
      "term_1",
    );
  });

  it("down が失敗したときのメッセージに、記録のパスと --stop のやり直しを添える", async () => {
    const { root, common, p } = await started({
      up: "make dev",
      down: "make down",
      url: "http://localhost:80",
    });
    p.downCode = 127;
    const result = await run(root, p, "T7", "--stop");
    expect(result.code).toBe(1);
    expect(result.err).toContain(recordFile(common));
    expect(result.err).toContain("--stop");
  });

  it("記録の worktree がもうないときは、down を流さず警告し、ターミナルを閉じて記録を消す", async () => {
    const { root, common, p } = await started({
      up: "make dev",
      down: "make down",
      url: "http://localhost:80",
    });
    const file = recordFile(common);
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({ ...record, worktree: path.join(root, "no-such-dir") }),
    );
    const result = await run(root, p, "T7", "--stop");
    expect(result.code).toBe(0);
    expect(p.downRuns).toEqual([]);
    expect(result.err).toContain("警告");
    expect(result.err).toContain("手で止めて");
    expect(p.alive.has("term_1")).toBe(false);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });
});

describe("preview：setup の終わりを待つ・タブを開かない・立て直しの子", () => {
  const stage = (common: string, command: string) =>
    appendStage(common, "T7", {
      at: "2026-01-01T00:00:00.000Z",
      state: "working",
      note: null,
      command,
    });

  it("--after-setup は status の行が出るまで立てず、出たら立てる", async () => {
    const { root, common } = await setup({
      up: "make dev",
      url: "http://localhost:80",
    });
    const p = preview();
    answering();
    await stage(common, "new");
    const sleep = previewDeps.sleep;
    previewDeps.sleep = async (ms) => {
      await sleep(ms);
      if (now === 3_000) {
        expect(p.sent).toEqual([]);
        await stage(common, "status");
      }
    };
    const result = await run(root, p, "T7", "--after-setup");
    expect(result.code).toBe(0);
    expect(now).toBe(3_000);
    expect(p.sent).toEqual(["make dev"]);
  });

  it("--after-setup は 30 分たっても status が出なければ、立てずに終了コード1", async () => {
    const { root } = await setup({
      up: "make dev",
      url: "http://localhost:80",
    });
    const p = preview();
    answering();
    const result = await run(root, p, "T7", "--after-setup");
    expect(result.code).toBe(1);
    expect(now).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(now).toBeLessThanOrEqual(30 * 60 * 1000 + previewDeps.pollMs);
    expect(result.err).toContain("30 分");
    expect(p.sent).toEqual([]);
    expect(
      p.orcaCalls.some((c) => c[0] === "terminal" && c[1] === "create"),
    ).toBe(false);
  });

  it("--no-open はタブを開かず、--json の答えに URL がある", async () => {
    const { root } = await setup({
      up: "make dev",
      url: "http://localhost:8080/",
    });
    const p = preview();
    answering();
    const result = await run(root, p, "T7", "--no-open", "--json");
    expect(result.code).toBe(0);
    expect(p.orcaCalls.some((c) => c[0] === "tab")).toBe(false);
    expect(JSON.parse(result.out)).toMatchObject({
      id: "T7",
      url: "http://localhost:8080/",
    });
  });

  it("立て直しの子は、止めてから同じに立て直し、タブを開かない", async () => {
    const { root, wt } = await setup({
      up: "make dev",
      down: "make down",
      url: "http://localhost:80",
    });
    const p = preview();
    answering();
    expect((await run(root, p, "T7")).code).toBe(0);
    p.orcaCalls.length = 0;
    const result = await run(root, p, "T7", "--restart-now");
    expect(result.code).toBe(0);
    expect(p.downRuns).toEqual([{ command: "make down", cwd: wt.path }]);
    const kinds = p.orcaCalls.map((c) => `${c[0]} ${c[1]}`);
    expect(kinds).toContain("terminal close");
    expect(kinds).toContain("terminal create");
    expect(kinds.indexOf("terminal close")).toBeLessThan(
      kinds.indexOf("terminal create"),
    );
    expect(p.sent).toEqual(["make dev", "make dev"]);
    expect(kinds).not.toContain("tab create");
  });

  it("--stop と --restart は同時に使えない", async () => {
    const { root } = await setup({ up: "make dev" });
    const result = await run(root, preview(), "T7", "--stop", "--restart");
    expect(result.code).toBe(1);
  });
});
