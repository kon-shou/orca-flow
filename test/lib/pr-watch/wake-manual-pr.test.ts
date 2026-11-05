import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../../src/commands/pr-watch.ts";
import { readState } from "../../../src/lib/pr-watch/store.ts";
import { writePushRecord } from "../../../src/lib/finish.ts";
import { testRunner } from "../../helpers/runner.ts";
import { addTaskWorktree, git } from "../../helpers/repo.ts";
import {
  SECRET_MARK,
  comments,
  harness,
  taskWithRecord,
  type FakePr,
  type Harness,
} from "./helpers.ts";

const round = (h: Harness) => run(h.ctx(["--root", h.root]));
const background = (h: Harness) => run(h.ctx(["background", "--root", h.root]));
const sends = (h: Harness) => h.orca.callsOf("terminal", "send");
const launches = (h: Harness) => h.orca.callsOf("agent", "launch");
const MANUAL = "（起こしません：手で開いた PR です）";

let tick = 0;
function review(pr: FakePr) {
  tick++;
  pr.updatedAt = `2026-11-04T03:${String(tick % 60).padStart(2, "0")}:00Z`;
  pr.reviews.push({ id: `r${tick}`, author: "alice", body: SECRET_MARK });
}

/** push の記録を書かずに、worktree と偽物の PR だけを置く（初めての回を済ませる） */
async function manualTask(h: Harness, id: string, n: number) {
  const wt = await addTaskWorktree(h.root, id, "x", {
    [`src/${id}.ts`]: "a\n",
  });
  const head = await git(wt.path, "rev-parse", "HEAD");
  const pr = h.gh.add({ number: n, branch: wt.branch, head });
  await round(h);
  return { wt, pr };
}

describe("手で開いた PR は起こさない", () => {
  it("push の記録がないタスクの PR にレビューが付いても、送らず立てず、待ちの起こしも残らない", async () => {
    const h = await harness();
    const { pr } = await manualTask(h, "T07", 7);
    review(pr);
    await round(h);
    const result = await background(h);
    expect(result.code).toBe(0);
    expect(sends(h)).toEqual([]);
    expect(launches(h)).toEqual([]);
    const state = await readState(h.dir);
    expect(state.wakes["7"]).toBeUndefined();
    expect(state.launched).toEqual({});
  });

  it("push の記録の PR が別の番号なら、その番号でない PR にレビューが付いても起こさない", async () => {
    const h = await harness();
    const { wt, head } = await taskWithRecord(h, "T07", 7);
    const other = h.gh.add({ number: 9, branch: wt.branch, head });
    await round(h);
    review(other);
    await round(h);
    await background(h);
    expect(sends(h)).toEqual([]);
    expect(launches(h)).toEqual([]);
    expect((await readState(h.dir)).wakes["9"]).toBeUndefined();
  });

  it.each([
    ["pr のキーがない", {}],
    ["pr が null", { pr: null }],
  ])(
    "push の記録に PR がない（%s）タスクの手で開いた PR は起こさない",
    async (_name, extra) => {
      const h = await harness();
      const wt = await addTaskWorktree(h.root, "T07", "x", {
        "src/T07.ts": "a\n",
      });
      const head = await git(wt.path, "rev-parse", "HEAD");
      await writePushRecord(testRunner, h.root, "T07", {
        id: "T07",
        branch: wt.branch,
        base: "main",
        pushedHead: head,
        pushedAt: "2026-11-04T00:00:00Z",
        ...extra,
      } as Parameters<typeof writePushRecord>[3]);
      const pr = h.gh.add({ number: 7, branch: wt.branch, head });
      await round(h);
      review(pr);
      await round(h);
      await background(h);
      expect(sends(h)).toEqual([]);
      expect(launches(h)).toEqual([]);
      expect((await readState(h.dir)).wakes["7"]).toBeUndefined();
      expect(comments(h.orca).at(-1)!.endsWith(MANUAL)).toBe(true);
    },
  );

  it("記録の PR と同じ番号なら、今までどおり起こす", async () => {
    const h = await harness();
    const { wt, head } = await taskWithRecord(h, "T07", 7);
    const pr = h.gh.add({ number: 7, branch: wt.branch, head });
    await round(h);
    review(pr);
    await round(h);
    await background(h);
    expect(launches(h)).toHaveLength(1);
  });

  it("捨てたとき、カードの一言の最後に固定の文が付き、他人の文章は入らない", async () => {
    const h = await harness();
    const { pr } = await manualTask(h, "T07", 7);
    review(pr);
    await round(h);
    await background(h);
    const last = comments(h.orca).at(-1)!;
    expect(last.endsWith(MANUAL)).toBe(true);
    expect(JSON.stringify(h.orca.calls)).not.toContain(SECRET_MARK);
    const text = await readFile(path.join(h.dir, "state.json"), "utf8");
    expect(text).not.toContain(SECRET_MARK);
  });

  it("捨てたとき、ほかに待ちの起こしがなければ、見張りが立てた会話の記録も消える", async () => {
    const h = await harness();
    const { pr } = await manualTask(h, "T07", 7);
    review(pr);
    await round(h);
    // 見張りが立てた会話の記録だけが残っている状態にする（待ちは pending のまま）
    const { updateState } = await import("../../../src/lib/pr-watch/store.ts");
    await updateState(h.dir, (st) => {
      st.launched["T07"] = {
        taskId: "T07",
        worktreePath: "/nowhere",
        at: "2026-11-04T00:00:00Z",
      };
    });
    await background(h);
    expect((await readState(h.dir)).launched).toEqual({});
    expect(launches(h)).toEqual([]);
  });
});
