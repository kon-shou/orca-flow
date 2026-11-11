import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCompanion, writeCompanionAt } from "../../src/lib/companion.ts";
import {
  dropCrossDepends,
  readCrossDepends,
  writeCrossDepends,
  type CrossDependsRepo,
} from "../../src/lib/cross-depends.ts";
import { realRunner } from "../../src/lib/exec.ts";
import { git, makeRepo } from "../init/helpers.ts";

const repo = (over: Partial<CrossDependsRepo> = {}): CrossDependsRepo => ({
  name: "core",
  path: "/tmp/core-main",
  package: "@demo/core",
  version: "1.0.0",
  ids: ["T1", "T2"],
  ...over,
});

const companionInput = {
  command: "run {previewUrl:web}",
  apps: [{ name: "web", path: "/tmp/web-main" }],
};

function setup() {
  const root = makeRepo();
  const common = git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).trim();
  return { root, common };
}

function put(common: string, kind: string, id: string, body: unknown) {
  const dir = path.join(common, "orca-flow", kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
}

describe("またぐ依存の記録のタスクのブランチ名", () => {
  it("書いたタスクのブランチ名を読む関数が返す", async () => {
    const { root } = setup();
    await writeCrossDepends(
      realRunner,
      root,
      "T1",
      [repo()],
      new Date(),
      "task/T1-order-limit",
    );
    const record = await readCrossDepends(realRunner, root, "T1");
    expect(record?.taskBranch).toBe("task/T1-order-limit");
    expect(record?.repos).toEqual([repo()]);
  });

  it("タスクのブランチ名のない古い記録も読め、taskBranch を返さない", async () => {
    const { root, common } = setup();
    put(common, "cross-depends", "T1", {
      id: "T1",
      at: "2026-01-01T00:00:00.000Z",
      repos: [repo()],
    });
    const record = await readCrossDepends(realRunner, root, "T1");
    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty("taskBranch");
  });

  it("タスクのブランチ名が文字列でない・空の記録は壊れた記録として終了コード1", async () => {
    for (const taskBranch of [1, ""]) {
      const { root, common } = setup();
      put(common, "cross-depends", "T1", {
        id: "T1",
        at: "2026-01-01T00:00:00.000Z",
        taskBranch,
        repos: [repo()],
      });
      await expect(
        readCrossDepends(realRunner, root, "T1"),
      ).rejects.toMatchObject({ code: 1 });
    }
  });

  it("依存を外して書き直しても、タスクのブランチ名を残す", async () => {
    const { root, common } = setup();
    await writeCrossDepends(
      realRunner,
      root,
      "T1",
      [repo()],
      new Date(),
      "task/T1-order-limit",
    );
    const left = await dropCrossDepends(realRunner, root, "T1", ["core:T2"]);
    expect(left?.taskBranch).toBe("task/T1-order-limit");
    const raw = JSON.parse(
      await readFile(
        path.join(common, "orca-flow", "cross-depends", "T1.json"),
        "utf8",
      ),
    );
    expect(raw.taskBranch).toBe("task/T1-order-limit");
    expect(raw.repos[0].ids).toEqual(["T1"]);
  });
});

describe("伴う記録のタスクのブランチ名", () => {
  it("書いたタスクのブランチ名を読む関数が返す", async () => {
    const { root, common } = setup();
    await writeCompanionAt(
      common,
      "T1",
      companionInput,
      new Date(),
      "task/T1-order-limit",
    );
    const record = await readCompanion(realRunner, root, "T1");
    expect(record?.taskBranch).toBe("task/T1-order-limit");
    expect(record?.apps).toEqual(companionInput.apps);
  });

  it("タスクのブランチ名のない古い記録も読め、taskBranch を返さない", async () => {
    const { root, common } = setup();
    put(common, "companion", "T1", {
      id: "T1",
      at: "2026-01-01T00:00:00.000Z",
      ...companionInput,
    });
    const record = await readCompanion(realRunner, root, "T1");
    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty("taskBranch");
  });

  it("タスクのブランチ名が文字列でない記録は壊れた記録として終了コード1", async () => {
    const { root, common } = setup();
    put(common, "companion", "T1", {
      id: "T1",
      at: "2026-01-01T00:00:00.000Z",
      taskBranch: 1,
      ...companionInput,
    });
    await expect(readCompanion(realRunner, root, "T1")).rejects.toMatchObject({
      code: 1,
    });
  });
});
