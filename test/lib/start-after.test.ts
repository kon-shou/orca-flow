import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { mergeSubject } from "../../src/lib/merge-subject.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import {
  checkStartAfter,
  listStartAfterIds,
  newStartAfterCache,
  parseStartAfterJson,
  readStartAfter,
  readStartAfterAt,
  removeStartAfterAt,
  resolveWorkspaceStartAfter,
  startAfterReadiness,
  writeStartAfterAt,
  type StartAfterRecord,
} from "../../src/lib/start-after.ts";
import { FlowError } from "../../src/types.ts";
import { git, makeRepo, tempDir } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const config = structuredClone(DEFAULT_CONFIG);
const T0 = new Date("2026-01-01T00:00:00.000Z");
const common = (root: string) => path.join(root, ".git");

let tick = 0;
async function stage(
  root: string,
  id: string,
  state: string,
  command = "status",
) {
  await appendStage(common(root), id, {
    at: new Date(T0.getTime() + ++tick * 1000).toISOString(),
    state,
    note: null,
    command,
  });
}

/** git の呼び出しを数える Runner */
function countingRunner() {
  const calls: string[][] = [];
  const runner: Runner = (cmd, args, opts) => {
    if (cmd === "git") calls.push([...args]);
    return testRunner(cmd, args, opts);
  };
  return { runner, calls };
}

const record = (after: StartAfterRecord["after"]): StartAfterRecord => ({
  id: "T05",
  at: T0.toISOString(),
  after,
});

describe("前を待つ印の記録", () => {
  it("前ごとに ID・リポジトリ・待つ条件を書き、読み、消せる", async () => {
    const root = await makeRepo();
    const other = await makeRepo();
    const after = [
      { id: "T01", repo: null, wait: "implemented" as const },
      { id: "T02", repo: null, wait: "merged" as const },
      {
        id: "C3",
        repo: { name: "demo-core", path: other },
        wait: "implemented" as const,
      },
    ];
    await writeStartAfterAt(common(root), "T05", after, T0);
    const file = path.join(
      common(root),
      "orca-flow",
      "start-after",
      "T05.json",
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      id: "T05",
      at: T0.toISOString(),
      after,
    });
    expect(await readStartAfter(testRunner, root, "T05")).toEqual({
      id: "T05",
      at: T0.toISOString(),
      after,
    });
    expect(await listStartAfterIds(common(root))).toEqual(["T05"]);
    expect(await removeStartAfterAt(common(root), "T05")).toBe(true);
    expect(await removeStartAfterAt(common(root), "T05")).toBe(false);
    expect(await readStartAfterAt(common(root), "T05")).toBeNull();
    expect(await listStartAfterIds(common(root))).toEqual([]);
  });

  it("空の並びを書くと記録を消す", async () => {
    const root = await makeRepo();
    await writeStartAfterAt(
      common(root),
      "T05",
      [{ id: "T01", repo: null, wait: "merged" }],
      T0,
    );
    await writeStartAfterAt(common(root), "T05", [], T0);
    expect(await readStartAfterAt(common(root), "T05")).toBeNull();
  });

  it("壊れた記録は FlowError(1)", async () => {
    const root = await makeRepo();
    const dir = path.join(common(root), "orca-flow", "start-after");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "T05.json"), "{");
    await expect(readStartAfterAt(common(root), "T05")).rejects.toBeInstanceOf(
      FlowError,
    );
    await writeFile(
      path.join(dir, "T05.json"),
      JSON.stringify({
        id: "T05",
        at: T0.toISOString(),
        after: [{ id: "T01", repo: null, wait: "someday" }],
      }),
    );
    await expect(readStartAfterAt(common(root), "T05")).rejects.toThrow(
      /壊れています/,
    );
  });

  it("壊れた記録の文は、記録の絶対パスを出す", async () => {
    const root = await makeRepo();
    const dir = path.join(common(root), "orca-flow", "start-after");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "T05.json"), "{");
    await expect(readStartAfterAt(common(root), "T05")).rejects.toThrow(
      path.join(dir, "T05.json"),
    );
  });
});

describe("--start-after-json の形", () => {
  it("名前・絶対パス・ID の並びを受け、ID の重なりを除く", () => {
    expect(
      parseStartAfterJson(
        JSON.stringify([
          { name: "demo-core", path: "/x/core", ids: ["C1", "C1", "C2"] },
        ]),
      ),
    ).toEqual([{ name: "demo-core", path: "/x/core", ids: ["C1", "C2"] }]);
  });

  it.each([
    ["JSON でない", "{"],
    ["並びでない", JSON.stringify({ name: "a" })],
    ["空", "[]"],
    ["名前の形", JSON.stringify([{ name: "A B", path: "/x", ids: ["C1"] }])],
    ["相対パス", JSON.stringify([{ name: "a", path: "x", ids: ["C1"] }])],
    ["ID の形", JSON.stringify([{ name: "a", path: "/x", ids: ["1"] }])],
    ["ID が空", JSON.stringify([{ name: "a", path: "/x", ids: [] }])],
    [
      "名前の重なり",
      JSON.stringify([
        { name: "a", path: "/x", ids: ["C1"] },
        { name: "a", path: "/y", ids: ["C2"] },
      ]),
    ],
    [
      "知らないキー",
      JSON.stringify([{ name: "a", path: "/x", ids: ["C1"], wait: "merged" }]),
    ],
  ])("%s は FlowError(1)", (_label, text) => {
    expect(() => parseStartAfterJson(text)).toThrow(FlowError);
  });
});

describe("整ったかの見分け", () => {
  it("実装完了は、段の記録に統合待ちの行があるかで分かれる", async () => {
    const root = await makeRepo();
    await stage(root, "T01", "designing", "new");
    await stage(root, "T01", "working");
    const rec = record([{ id: "T01", repo: null, wait: "implemented" }]);
    const before = await checkStartAfter(testRunner, root, config, rec);
    expect(before.ready).toBe(false);
    expect(before.entries[0]).toMatchObject({ label: "T01", ready: false });

    await appendStage(common(root), "T01", {
      at: "2026-01-02T00:00:00.000Z",
      state: "integrate-wait",
      note: null,
      command: "status",
    });
    await appendStage(common(root), "T01", {
      at: "2026-01-03T00:00:00.000Z",
      state: "working",
      note: null,
      command: "status",
    });
    const after = await checkStartAfter(testRunner, root, config, rec);
    expect(after.ready).toBe(true);
    expect(after.entries[0]!.ready).toBe(true);
  });

  it("同じ ID を new で使い直したら、その前の統合待ちは数えない", async () => {
    const root = await makeRepo();
    await appendStage(common(root), "T01", {
      at: "2026-01-01T00:00:00.000Z",
      state: "integrate-wait",
      note: null,
      command: "status",
    });
    await appendStage(common(root), "T01", {
      at: "2026-01-02T00:00:00.000Z",
      state: "designing",
      note: null,
      command: "new",
    });
    const r = await checkStartAfter(
      testRunner,
      root,
      config,
      record([{ id: "T01", repo: null, wait: "implemented" }]),
    );
    expect(r.ready).toBe(false);
  });

  it("入ったは、baseBranch に入ったかで分かれる（統合待ちの行では整わない）", async () => {
    const root = await makeRepo();
    await stage(root, "T02", "integrate-wait");
    const rec = record([{ id: "T02", repo: null, wait: "merged" }]);
    const before = await checkStartAfter(testRunner, root, config, rec);
    expect(before.ready).toBe(false);
    expect(before.entries[0]!.reason).toContain("main");

    await git(
      root,
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      mergeSubject(config.integratorName, "T02"),
    );
    const after = await checkStartAfter(testRunner, root, config, rec);
    expect(after.ready).toBe(true);
  });

  it("ほかのリポジトリの前は、そのリポジトリの段の記録で見る", async () => {
    const root = await makeRepo();
    const other = await makeRepo();
    const rec = record([
      {
        id: "C3",
        repo: { name: "demo-core", path: other },
        wait: "implemented",
      },
    ]);
    // 自分のリポジトリに同じ ID の統合待ちがあっても数えない
    await stage(root, "C3", "integrate-wait");
    const before = await checkStartAfter(testRunner, root, config, rec);
    expect(before.ready).toBe(false);
    expect(before.entries[0]!.label).toBe("demo-core:C3");

    await stage(other, "C3", "integrate-wait");
    const after = await checkStartAfter(testRunner, root, config, rec);
    expect(after.ready).toBe(true);
  });

  it("全部整ったときだけ整った", async () => {
    const root = await makeRepo();
    await stage(root, "T01", "integrate-wait");
    const r = await checkStartAfter(
      testRunner,
      root,
      config,
      record([
        { id: "T01", repo: null, wait: "implemented" },
        { id: "T02", repo: null, wait: "merged" },
      ]),
    );
    expect(r.ready).toBe(false);
    expect(r.entries.map((e) => e.ready)).toEqual([true, false]);
  });

  it("読めない前は整っていないとし、理由を返す", async () => {
    const root = await makeRepo();
    const gone = path.join(await tempDir(), "missing");
    const notRepo = await tempDir();
    const r = await checkStartAfter(
      testRunner,
      root,
      config,
      record([
        { id: "C1", repo: { name: "gone", path: gone }, wait: "implemented" },
        { id: "C2", repo: { name: "plain", path: notRepo }, wait: "merged" },
      ]),
    );
    expect(r.ready).toBe(false);
    expect(r.entries.every((e) => !e.ready)).toBe(true);
    expect(r.entries.every((e) => e.reason.startsWith("読めません"))).toBe(
      true,
    );
    expect(r.entries.map((e) => e.unreadable)).toEqual([true, true]);
  });

  it("読めない前だけが読めないの真偽を持ち、読めた前は偽", async () => {
    const root = await makeRepo();
    await stage(root, "T01", "integrate-wait");
    const gone = path.join(await tempDir(), "missing");
    const r = await checkStartAfter(
      testRunner,
      root,
      config,
      record([
        { id: "T01", repo: null, wait: "implemented" },
        { id: "T02", repo: null, wait: "implemented" },
        { id: "C1", repo: { name: "gone", path: gone }, wait: "implemented" },
      ]),
    );
    expect(r.entries.map((e) => [e.ready, e.unreadable])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
  });

  it("壊れた印は投げずに problem に理由を返し、印がなければ null", async () => {
    const root = await makeRepo();
    expect(
      await startAfterReadiness(testRunner, root, common(root), config, "T05"),
    ).toBeNull();
    const dir = path.join(common(root), "orca-flow", "start-after");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "T05.json"), "[]");
    const r = await startAfterReadiness(
      testRunner,
      root,
      common(root),
      config,
      "T05",
    );
    expect(r).toMatchObject({ ready: false, entries: [] });
    expect(r!.problem).toMatch(/壊れています/);
  });

  it("同じ入れ物を渡すと、ほかのリポジトリの共通ディレクトリを1回だけ求める", async () => {
    const root = await makeRepo();
    const other = await makeRepo();
    const rec = record([
      {
        id: "C3",
        repo: { name: "demo-core", path: other },
        wait: "implemented",
      },
      {
        id: "C4",
        repo: { name: "demo-core", path: other },
        wait: "implemented",
      },
    ]);
    const { runner, calls } = countingRunner();
    const cache = newStartAfterCache();
    await checkStartAfter(runner, root, config, rec, cache);
    await checkStartAfter(runner, root, config, rec, cache);
    const commonCalls = calls.filter((a) => a.includes("--git-common-dir"));
    expect(commonCalls).toHaveLength(1);
  });
});

describe("ワークスペースの --start-after の解き方", () => {
  const repos = [
    { name: "demo-core", path: "/w/core" },
    { name: "demo-app", path: "/w/app" },
  ];

  it("子と同じ名前は子の ID に、ほかは実のパスつきにする", () => {
    expect(
      resolveWorkspaceStartAfter(
        repos,
        "demo-app",
        "demo-core:C1,demo-app:A2,demo-core:C3,demo-core:C1",
      ),
    ).toEqual({
      same: ["A2"],
      json: [{ name: "demo-core", path: "/w/core", ids: ["C1", "C3"] }],
    });
  });

  it("知らない名前・形の外れは FlowError(1)", () => {
    expect(() =>
      resolveWorkspaceStartAfter(repos, "demo-app", "nobody:C1"),
    ).toThrow(/名前を知りません/);
    expect(() => resolveWorkspaceStartAfter(repos, "demo-app", "C1")).toThrow(
      /〈名前〉:〈ID〉/,
    );
    expect(() => resolveWorkspaceStartAfter(repos, "demo-app", "")).toThrow(
      FlowError,
    );
  });
});
