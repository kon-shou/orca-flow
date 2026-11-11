import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { previewDeps } from "../../src/lib/preview.ts";
import { previewBaseWorktreeDir } from "../../src/lib/preview-base.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, tempDir } from "../helpers/repo.ts";

const SAVED = { ...previewDeps };
let now = 0;
beforeEach(() => {
  now = 0;
  previewDeps.clock = () => now;
  previewDeps.sleep = async (ms) => {
    now += ms;
  };
  previewDeps.pollMs = 1_000;
});
afterEach(() => Object.assign(previewDeps, SAVED));

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

interface Harness {
  runner: Runner;
  orcaCalls: string[][];
  sent: { handle: string; text: string }[];
  downs: { command: string; cwd: string | undefined }[];
  alive: Set<string>;
  /** ターミナルを作ったときに出す出力 */
  outputLines: string[];
  downCode: number;
}

function harness(): Harness {
  const base = fakeOrca();
  const state: Harness = {
    runner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    orcaCalls: [],
    sent: [],
    downs: [],
    alive: new Set(),
    outputLines: ["ORCA_FLOW_URL=http://localhost:5174/"],
    downCode: 0,
  };
  const ok = (result: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, result }),
    stderr: "",
    timedOut: false,
  });
  const val = (args: readonly string[], name: string) =>
    args[args.indexOf(name) + 1] ?? "";
  const output = new Map<string, string[]>();
  let n = 0;
  state.runner = async (cmd, args, opts) => {
    if (cmd === "sh" && args[0] === "-c") {
      state.downs.push({ command: args[1]!, cwd: opts?.cwd });
      return {
        code: state.downCode,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    }
    if (cmd !== "orca") return base.runner(cmd, args, opts);
    const plain = args.filter((a) => a !== "--json");
    state.orcaCalls.push(plain);
    const [group, action] = plain;
    if (group === "terminal" && action === "create") {
      const handle = `term_${++n}`;
      state.alive.add(handle);
      output.set(handle, state.outputLines);
      return ok({ terminal: { handle } });
    }
    if (group === "terminal" && action === "send") {
      state.sent.push({
        handle: val(plain, "--terminal"),
        text: val(plain, "--text"),
      });
      return ok({});
    }
    if (group === "terminal" && action === "read")
      return ok({
        terminal: { tail: output.get(val(plain, "--terminal")) ?? [] },
      });
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
    return base.runner(cmd, args, opts);
  };
  return state;
}

const answering = (answers = true) => {
  const seen: string[] = [];
  previewDeps.fetch = (async (url: string) => {
    seen.push(String(url));
    if (!answers) throw new Error("refused");
    return { status: 200, body: null };
  }) as unknown as typeof fetch;
  return seen;
};

async function setup(
  preview: Record<string, unknown> | null = {
    up: "make dev",
    down: "make down",
  },
  files: Record<string, string> = {},
) {
  const root = await makeRepo({ idPrefix: "T", preview }, files);
  const wt = await addTaskWorktree(root, "T7", "shop", {
    "feature.txt": "x\n",
  });
  // 分かれたあとに baseBranch が進んでも、前の画面は分かれ目に立つ
  const fork = await git(root, "rev-parse", "main");
  await writeFile(path.join(root, "later.txt"), "later\n");
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", "later");
  const state = await tempDir("orca-flow-state-");
  const common = path.join(root, ".git");
  return { root, wt, fork, state, common };
}

async function run(
  s: { root: string; state: string },
  h: Harness,
  ...argv: string[]
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["preview", "T7", "--base", ...argv], {
    cwd: s.root,
    runner: h.runner,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
    env: { ...process.env, XDG_STATE_HOME: s.state },
  } as never);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const recordFile = (common: string) =>
  path.join(common, "orca-flow", "preview-base", "T7.json");
const baseDir = (s: { state: string; common: string }) =>
  previewBaseWorktreeDir({ XDG_STATE_HOME: s.state }, s.common, "T7");

describe("preview --base：起動", () => {
  it("分かれ目に切り離しの作業ツリーを作り、setup.sh を流し、そこへ移ってから up を送り、記録を書く", async () => {
    const s = await setup(undefined, {
      ".orca-flow/setup.sh": "touch setup-ran\n",
    });
    const h = harness();
    answering();
    const r = await run(s, h, "--no-open", "--json");
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as Record<string, unknown>;
    expect(data).toMatchObject({
      id: "T7",
      url: "http://localhost:5174/",
      started: true,
      commit: s.fork,
    });
    const dir = data.worktree as string;
    expect(dir.startsWith(s.state)).toBe(true);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(s.fork);
    expect(await git(dir, "branch", "--show-current")).toBe("");
    expect(await exists(path.join(dir, "setup-ran"))).toBe(true);
    expect(await exists(path.join(dir, "later.txt"))).toBe(false);
    expect(h.sent.map((x) => x.text)).toEqual([`cd '${dir}'`, "make dev"]);
    expect(
      h.orcaCalls.find((c) => c[0] === "terminal" && c[1] === "create"),
    ).toContain(`path:${s.wt.path}`);
    expect(h.orcaCalls.some((c) => c[0] === "tab")).toBe(false);
    const create = h.orcaCalls.find(
      (c) => c[0] === "terminal" && c[1] === "create",
    )!;
    expect(create[create.indexOf("--title") + 1]).toBe("preview-base");
    const record = JSON.parse(await readFile(recordFile(s.common), "utf8"));
    expect(record).toEqual({
      id: "T7",
      worktree: dir,
      taskWorktree: s.wt.path,
      terminal: "term_1",
      commit: s.fork,
      url: "http://localhost:5174/",
      at: expect.any(String),
    });
  });

  it("--no-open がなければ、タスクの worktree のタブに前の画面を開く", async () => {
    const s = await setup();
    const h = harness();
    answering();
    const r = await run(s, h);
    expect(r.code).toBe(0);
    expect(h.orcaCalls.find((c) => c[0] === "tab")).toContain(
      "http://localhost:5174/",
    );
  });

  it("設定の url が固定なら、何も立てずに終了コード2", async () => {
    const s = await setup({ up: "make dev", url: "http://localhost:8080/" });
    const h = harness();
    answering();
    const r = await run(s, h);
    expect(r.code).toBe(2);
    expect(r.err).toContain("固定");
    expect(await exists(baseDir(s))).toBe(false);
    expect(h.orcaCalls.some((c) => c[0] === "terminal")).toBe(false);
  });

  it("読んだ URL がタスクのプレビューと同じなら、止めて終了コード1", async () => {
    const s = await setup();
    const h = harness();
    answering();
    await mkdir(path.join(s.common, "orca-flow", "preview"), {
      recursive: true,
    });
    await writeFile(
      path.join(s.common, "orca-flow", "preview", "T7.json"),
      JSON.stringify({
        id: "T7",
        worktree: s.wt.path,
        terminal: "term_task",
        url: "http://localhost:5174/",
        at: "2026-11-05T00:00:00.000Z",
      }),
    );
    const r = await run(s, h, "--no-open");
    expect(r.code).toBe(1);
    expect(r.err).toContain("同じ");
    expect(await exists(recordFile(s.common))).toBe(false);
    expect(await exists(baseDir(s))).toBe(false);
    expect(h.alive.size).toBe(0);
    expect(h.downs.map((d) => d.command)).toEqual(["make down"]);
  });

  it("setup.sh が落ちたら、作業ツリーを消して終了コード1（ターミナルは作らず、出力も写さない）", async () => {
    const s = await setup(undefined, {
      ".orca-flow/setup.sh": "echo leaked-secret-value; exit 3\n",
    });
    const h = harness();
    answering();
    const r = await run(s, h, "--no-open");
    expect(r.code).toBe(1);
    expect(r.err).toContain("setup.sh");
    expect(r.out + r.err).not.toContain("leaked-secret-value");
    expect(await exists(baseDir(s))).toBe(false);
    expect(await exists(recordFile(s.common))).toBe(false);
    expect(h.orcaCalls.some((c) => c[0] === "terminal")).toBe(false);
    expect(await git(s.root, "worktree", "list")).not.toContain("preview-base");
  });

  it("答えないまま時間を過ぎたら終了コード1で、記録と作業ツリーを残す", async () => {
    const s = await setup({ up: "make dev", timeoutSeconds: 2 });
    const h = harness();
    answering(false);
    const r = await run(s, h, "--no-open");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--base --stop");
    expect(await exists(recordFile(s.common))).toBe(true);
    expect(await exists(baseDir(s))).toBe(true);
  });

  it("動いている記録があれば、作り直さず送り直さない", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await run(s, h, "--no-open")).code).toBe(0);
    const again = await run(s, h, "--no-open", "--json");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).started).toBe(false);
    expect(h.sent).toHaveLength(2);
  });

  it("--restart などとは一緒に使えない", async () => {
    const s = await setup();
    const h = harness();
    const seen = answering();
    for (const flag of ["--restart", "--after-setup"]) {
      const r = await run(s, h, flag);
      expect(r.code).toBe(1);
      expect(r.err).toContain("使い方：orca-flow preview");
    }
    expect(h.orcaCalls).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("preview --base --stop", () => {
  it("down・ターミナル・作業ツリー・記録を片づける", async () => {
    const s = await setup();
    const h = harness();
    answering();
    await run(s, h, "--no-open");
    const dir = baseDir(s);
    const real = await realDir(dir);
    const r = await run(s, h, "--stop");
    expect(r.code).toBe(0);
    expect(h.downs).toEqual([{ command: "make down", cwd: real }]);
    expect(h.alive.size).toBe(0);
    expect(await exists(dir)).toBe(false);
    expect(await exists(recordFile(s.common))).toBe(false);
    expect(await git(s.root, "worktree", "list")).not.toContain("preview-base");
  });

  it("記録も置き場もなければ、何もせず終了コード0", async () => {
    const s = await setup();
    const h = harness();
    const r = await run(s, h, "--stop");
    expect(r.code).toBe(0);
    expect(h.downs).toEqual([]);
    expect(h.orcaCalls.some((c) => c[0] === "terminal")).toBe(false);
  });

  it("壊れた記録は警告して消し、置き場を片づける", async () => {
    const s = await setup();
    const h = harness();
    await mkdir(path.dirname(recordFile(s.common)), { recursive: true });
    await writeFile(recordFile(s.common), "{壊れ");
    const r = await run(s, h, "--stop");
    expect(r.code).toBe(0);
    expect(r.err).toContain("壊れ");
    expect(await exists(recordFile(s.common))).toBe(false);
  });

  it("記録が置き場の外（メインのチェックアウトなど）を指していても、消さず down も流さず警告する", async () => {
    const s = await setup();
    const h = harness();
    await mkdir(path.dirname(recordFile(s.common)), { recursive: true });
    for (const target of [s.root, s.wt.path]) {
      await writeFile(
        recordFile(s.common),
        JSON.stringify({
          id: "T7",
          worktree: target,
          taskWorktree: s.wt.path,
          terminal: "term_x",
          commit: s.fork,
          at: "2026-11-05T00:00:00.000Z",
        }),
      );
      const r = await run(s, h, "--stop");
      expect(r.code).toBe(0);
      expect(r.err).toContain("置き場の外");
      expect(await exists(path.join(target, ".git"))).toBe(true);
      expect(
        await exists(
          path.join(target, target === s.root ? "later.txt" : "feature.txt"),
        ),
      ).toBe(true);
      expect(h.downs).toEqual([]);
      expect(await exists(recordFile(s.common))).toBe(false);
    }
    expect(await git(s.root, "worktree", "list")).toContain(s.wt.path);
  });

  it("起動のとき、死んだ記録の作業ツリーが置き場の外・存在しない名前でも、そのフォルダもタスクの作業ツリーも消さず警告する", async () => {
    const s = await setup();
    const outside = await tempDir("orca-flow-outside-");
    await writeFile(path.join(outside, "keep.txt"), "x\n");
    await mkdir(path.dirname(recordFile(s.common)), { recursive: true });
    for (const target of [outside, path.basename(s.wt.path)]) {
      const h = harness();
      answering();
      await writeFile(
        recordFile(s.common),
        JSON.stringify({
          id: "T7",
          worktree: target,
          taskWorktree: s.wt.path,
          terminal: "term_dead",
          commit: s.fork,
          at: "2026-11-05T00:00:00.000Z",
        }),
      );
      const r = await run(s, h, "--no-open");
      expect(r.code).toBe(0);
      if (target === outside) expect(r.err).toContain("置き場の外");
      expect(await exists(path.join(outside, "keep.txt"))).toBe(true);
      expect(await exists(path.join(s.wt.path, "feature.txt"))).toBe(true);
      expect(await git(s.root, "worktree", "list")).toContain(s.wt.path);
      await run(s, h, "--stop");
    }
  });

  it("作業ツリーのフォルダが git の外で消えても、--stop が git の登録を片づけ、次の起動が通る", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await run(s, h, "--no-open")).code).toBe(0);
    const dir = baseDir(s);
    await rm(dir, { recursive: true, force: true });
    const stop = await run(s, h, "--stop");
    expect(stop.code).toBe(0);
    expect(await exists(recordFile(s.common))).toBe(false);
    expect(await git(s.root, "worktree", "list")).not.toContain("preview-base");
    const again = await run(s, h, "--no-open", "--json");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({
      started: true,
      commit: s.fork,
    });
    expect(await git(dir, "rev-parse", "HEAD")).toBe(s.fork);
  });

  it("記録もなくフォルダだけ消えたときも、次の起動が git の登録を片づけて通る", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await run(s, h, "--no-open")).code).toBe(0);
    const dir = baseDir(s);
    await rm(dir, { recursive: true, force: true });
    await rm(recordFile(s.common), { force: true });
    h.alive.clear();
    expect((await run(s, h, "--stop")).code).toBe(0);
    const again = await run(s, h, "--no-open", "--json");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).started).toBe(true);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(s.fork);
  });

  it("記録が残ったままフォルダが消え、ターミナルも死んでいれば、起動がそのまま立て直す", async () => {
    const s = await setup();
    const h = harness();
    answering();
    expect((await run(s, h, "--no-open")).code).toBe(0);
    const dir = baseDir(s);
    await rm(dir, { recursive: true, force: true });
    h.alive.clear();
    const again = await run(s, h, "--no-open", "--json");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).started).toBe(true);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(s.fork);
  });

  it("down が落ちたら終了コード1で、記録を残す", async () => {
    const s = await setup();
    const h = harness();
    answering();
    await run(s, h, "--no-open");
    h.downCode = 4;
    const r = await run(s, h, "--stop");
    expect(r.code).toBe(1);
    expect(await exists(recordFile(s.common))).toBe(true);
  });
});

async function realDir(dir: string): Promise<string> {
  return (await import("node:fs/promises")).realpath(dir);
}
