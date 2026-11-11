import { stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { mergeSubject } from "../../src/lib/merge-subject.ts";
import {
  readStartAfter,
  writeStartAfterAt,
} from "../../src/lib/start-after.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

async function setup() {
  const root = await makeRepo({ maxActiveTasks: 6 });
  await addTaskWorktree(root, "T01", "front", { "front.txt": "前\n" });
  await addTaskWorktree(root, "T02", "side");
  // T03 は統合済み
  await git(
    root,
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    mergeSubject(DEFAULT_CONFIG.integratorName, "T03"),
  );
  return { root };
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const newArgs = (...extra: string[]) => [
  "new",
  "--title",
  "後ろ",
  "--slug",
  "back",
  "--id",
  "T05",
  ...extra,
];

describe("new --start-after：前を待つ印", () => {
  it("乗せた先は実装完了、ほかの同じリポジトリの前は入った、で書く", async () => {
    const { root } = await setup();
    const orca = fakeOrca();
    const r = await runCli(
      [
        ...newArgs("--start-after", "T01,T02、T03", "--stack-on", "T01"),
        "--json",
      ],
      { cwd: root, runner: orca.runner },
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const record = await readStartAfter(testRunner, root, "T05");
    expect(record).toMatchObject({
      id: "T05",
      after: [
        { id: "T01", repo: null, wait: "implemented" },
        { id: "T02", repo: null, wait: "merged" },
        { id: "T03", repo: null, wait: "merged" },
      ],
    });
    expect(JSON.parse(r.out).startAfter).toEqual(record!.after);
  });

  it("乗せずに渡せば、同じリポジトリの前は全部入った", async () => {
    const { root } = await setup();
    const r = await runCli(newArgs("--start-after", "T01"), {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("前を待つ：T01（入る）");
    expect((await readStartAfter(testRunner, root, "T05"))!.after).toEqual([
      { id: "T01", repo: null, wait: "merged" },
    ]);
  });

  it("渡さなければ、同じ ID の古い印を消す", async () => {
    const { root } = await setup();
    await writeStartAfterAt(
      path.join(root, ".git"),
      "T05",
      [{ id: "T01", repo: null, wait: "merged" }],
      new Date(),
    );
    const r = await runCli(newArgs(), { cwd: root, runner: fakeOrca().runner });
    expect(r.code).toBe(0);
    expect(await readStartAfter(testRunner, root, "T05")).toBeNull();
  });

  it("ほかのリポジトリの前は、名前と実のパスつきの実装完了で書く", async () => {
    const { root } = await setup();
    const core = await makeRepo({ idPrefix: "C" });
    await addTaskWorktree(core, "C3", "base");
    const json = JSON.stringify([
      { name: "demo-core", path: core, ids: ["C3"] },
    ]);
    const r = await runCli(
      newArgs("--start-after", "T02", "--start-after-json", json),
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect((await readStartAfter(testRunner, root, "T05"))!.after).toEqual([
      { id: "T02", repo: null, wait: "merged" },
      {
        id: "C3",
        repo: { name: "demo-core", path: core },
        wait: "implemented",
      },
    ]);
  });
});

describe("new --start-after の外れ", () => {
  async function refused(extra: string[], message: RegExp) {
    const { root } = await setup();
    const orca = fakeOrca();
    const r = await runCli(newArgs(...extra), {
      cwd: root,
      runner: orca.runner,
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(message);
    expect(orca.callsOf("worktree", "create")).toHaveLength(0);
    expect(await exists(path.join(path.dirname(root), "T05-back"))).toBe(false);
    expect(
      await exists(
        path.join(root, ".git", "orca-flow", "start-after", "T05.json"),
      ),
    ).toBe(false);
    expect(
      await exists(path.join(root, ".git", "orca-flow", "depends", "T05.json")),
    ).toBe(false);
    return root;
  }

  it("ID の形が外れていれば止める", async () => {
    await refused(["--start-after", "X1"], /--start-after の ID の形/);
  });

  it("自分の ID は止める", async () => {
    await refused(["--start-after", "T05"], /自分の ID/);
  });

  it("作業中でも統合済みでもない ID は止める", async () => {
    await refused(["--start-after", "T01,T09"], /T09 はこのリポジトリの作業中/);
  });

  it("--start-after-json の形が外れていれば止める", async () => {
    await refused(["--start-after-json", "{"], /--start-after-json/);
    await refused(
      [
        "--start-after-json",
        JSON.stringify([{ name: "x", path: "rel", ids: ["C1"] }]),
      ],
      /--start-after-json の形が違います/,
    );
  });

  it("--start-after-json が自分のリポジトリを指せば止める", async () => {
    const root = await makeRepo();
    const orca = fakeOrca();
    const r = await runCli(
      newArgs(
        "--start-after-json",
        JSON.stringify([{ name: "self", path: root, ids: ["T01"] }]),
      ),
      { cwd: root, runner: orca.runner },
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/自分と同じリポジトリ/);
    expect(orca.callsOf("worktree", "create")).toHaveLength(0);
  });

  it("ほかのリポジトリで作業中でも統合済みでもない ID は止める", async () => {
    const core = await makeRepo({ idPrefix: "C" });
    await refused(
      [
        "--start-after-json",
        JSON.stringify([{ name: "demo-core", path: core, ids: ["C9"] }]),
      ],
      /demo-core:C9 は demo-core の作業中/,
    );
  });
});
