import { describe, expect, it } from "vitest";
import {
  approvedHeadOf,
  failureCode,
  findMissingTasks,
} from "../../src/lib/merge-check.ts";
import { writeDependsAt } from "../../src/lib/depends.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import { writeMergeOrder } from "../../src/lib/merge-order.ts";
import type { OutboxItem } from "../../src/lib/outbox.ts";
import { git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";
import path from "node:path";

const item = (
  id: string,
  kind: OutboxItem["kind"],
  version: number,
  state: OutboxItem["state"],
  head: string,
): OutboxItem => ({ id, kind, version, state, head }) as unknown as OutboxItem;

describe("承認した先頭（approvedHeadOf）", () => {
  it("送った push の案の最後の先頭。積んだだけ・取り下げた案・push 以外は使わない", () => {
    const items = [
      item("push-v1", "push", 1, "sent", "1".repeat(40)),
      item("push-v2", "push", 2, "sent", "2".repeat(40)),
      item("push-v3", "push", 3, "queued", "3".repeat(40)),
      item("pr-create-v1", "pr-create", 1, "sent", "4".repeat(40)),
    ];
    expect(approvedHeadOf(items)).toBe("2".repeat(40));
    expect(approvedHeadOf(items.slice(2))).toBeNull();
    expect(approvedHeadOf([])).toBeNull();
  });
});

describe("入っていないタスク（findMissingTasks）", () => {
  it("依存の記録と順の前のタスクのうち、ref に入っていないものを抜け方つきで返す。重複は依存として数える", async () => {
    const root = await makeRepo({});
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "統括役: T01 をマージする",
    );
    const common = path.join(root, ".git");
    await writeDependsAt(common, "T05", ["T01", "T02"], new Date());
    await writeMergeOrder(testRunner, root, {
      chains: [
        [
          { id: "T02", integrated: false, mergeCommit: null },
          { id: "T03", integrated: false, mergeCommit: null },
          { id: "T05", integrated: false, mergeCommit: null },
        ],
      ],
    });
    const missing = await findMissingTasks(
      testRunner,
      root,
      { integratorName: "統括役" },
      "T05",
      "main",
    );
    expect(missing).toEqual([
      { id: "T02", via: "depend" },
      { id: "T03", via: "order" },
    ]);
  });

  it("push の記録（PR）があってマージのコミットがない依存先は pending の印がつく", async () => {
    const root = await makeRepo({});
    await writeDependsAt(
      path.join(root, ".git"),
      "T05",
      ["T01", "T02"],
      new Date(),
    );
    await writePushRecord(testRunner, root, "T01", {
      id: "T01",
      branch: "task/T01",
      base: "main",
      pushedHead: "8".repeat(40),
      pushedAt: "2026-11-04T00:00:00Z",
      pr: { number: 5, url: "https://github.com/o/r/pull/5" },
    });
    const missing = await findMissingTasks(
      testRunner,
      root,
      { integratorName: "統括役" },
      "T05",
      "main",
    );
    expect(missing).toEqual([
      { id: "T01", via: "depend", pending: true },
      { id: "T02", via: "depend" },
    ]);
  });

  it("ref を読めなければ「入っていない」と言わず FlowError(1)", async () => {
    const root = await makeRepo({});
    await writeDependsAt(path.join(root, ".git"), "T05", ["T01"], new Date());
    await expect(
      findMissingTasks(
        testRunner,
        root,
        { integratorName: "統括役" },
        "T05",
        "origin/main",
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
});

describe("終了コード（failureCode）", () => {
  it("依存・push なしの2が優先される", () => {
    const f = (code: 1 | 2) => ({ kind: "head" as const, code, message: "" });
    expect(failureCode([f(1), f(2)])).toBe(2);
    expect(failureCode([f(1)])).toBe(1);
  });
});
