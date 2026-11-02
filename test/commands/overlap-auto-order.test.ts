import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { currentBootAt } from "../../src/lib/main-check.ts";
import {
  mergeOrderFile,
  mergeOrderLockFile,
  readMergeOrder,
  writeMergeOrder,
  type MergeOrder,
} from "../../src/lib/merge-order.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const item = (id: string) => ({ id, integrated: false, mergeCommit: null });
const chain = (...ids: string[]): MergeOrder["chains"][number] => ids.map(item);
const ids = (order: MergeOrder) => order.chains.map((c) => c.map((i) => i.id));

const WARNING = (c: string) =>
  `警告（マージの順）：重なるので、マージの順に足しました：${c}。順を変えるときは統括役のタブで orca-flow order`;

/** T01..T04 を作る。T01・T03・T04 は src/a/ の下、T02 は src/a/b を書く設計書（まだコミットしない） */
async function setup(config: Record<string, unknown> = {}) {
  const root = await makeRepo({
    progress: { file: "docs/progress.md" },
    ...config,
  });
  const wts: Record<string, string> = {};
  const dirs: Record<string, string> = {
    T01: "src/a/",
    T03: "src/a/c/",
    T04: "src/a/d/",
  };
  for (const [id, dir] of Object.entries(dirs))
    wts[id] = (
      await addTaskWorktree(root, id, id.toLowerCase(), {
        [`docs/tasks/${id}.md`]: specDoc(id, { allowed: [dir] }),
      })
    ).path;
  wts.T02 = (await addTaskWorktree(root, "T02", "t02")).path;
  await writeFiles(wts.T02, {
    "docs/tasks/T02.md": specDoc("T02", { allowed: ["src/a/b"] }),
  });
  return { root, wts };
}

const overlap = (
  cwd: string,
  id = "T02",
  orca = fakeOrca(),
  extra: string[] = [],
) =>
  runCli(["overlap", id, ...extra], { cwd, runner: orca.runner }).then((r) => ({
    ...r,
    orca,
  }));

const readOrder = (root: string) => readMergeOrder(testRunner, root);

describe("overlap：自動で順に足す", () => {
  it("鎖にいない相手が1つなら [相手, 自分] の鎖を作り、警告・印・未読の印を出して終了コード0", async () => {
    const { root, wts } = await setup();
    // T02(src/a/b) は T01(src/a/) とだけ重なる
    const r = await overlap(wts.T02!, "T02", fakeOrca(), ["--json"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(WARNING("T01 → T02"));
    const order = await readOrder(root);
    expect(ids(order)).toEqual([["T01", "T02"]]);
    expect(order.chains[0]![0]!.auto).toBeUndefined();
    expect(order.chains[0]![1]!.auto?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const data = JSON.parse(r.out);
    expect(data.autoOrder).toMatchObject({
      added: true,
      chain: ["T01", "T02"],
      reason: null,
    });
    expect(data.autoOrder.at).toBe(order.chains[0]![1]!.auto!.at);
    expect(data.problems).toEqual([]);
    // 統括役のタブ（メインの作業ツリー）のカードに未読の印だけ
    const sets = r.orca.callsOf("worktree", "set");
    expect(sets).toHaveLength(1);
    expect(sets[0]).toEqual([
      "worktree",
      "set",
      "--worktree",
      `path:${root}`,
      "--unread",
    ]);
  });

  it("警告のあと、同じ鎖の相手の警告（前後つき）も出る", async () => {
    const { wts } = await setup();
    const r = await overlap(wts.T02!);
    expect(r.code).toBe(0);
    const lines = r.err.split("\n");
    const a = lines.findIndex((l) =>
      l.includes("重なるので、マージの順に足しました"),
    );
    const b = lines.findIndex((l) => /マージの順では T02 は T01 の後/.test(l));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  it("相手が鎖にいて自分がいなければ、その鎖の最後に足す", async () => {
    const { root, wts } = await setup();
    await writeMergeOrder(testRunner, root, { chains: [chain("T01", "T03")] });
    await writeFiles(wts.T02!, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["src/a/c/x"] }),
    });
    const r = await overlap(wts.T02!);
    expect(r.code).toBe(0);
    expect(ids(await readOrder(root))).toEqual([["T01", "T03", "T02"]]);
    expect(r.err).toContain(WARNING("T01 → T03 → T02"));
  });

  it("相手が2つで同じ鎖にいるときも、その鎖の最後に足す", async () => {
    const { root, wts } = await setup();
    // src/a/ 全体を書く T02 は T01・T03・T04 と重なる（3つとも同じ鎖）
    await writeMergeOrder(testRunner, root, {
      chains: [chain("T01", "T03", "T04")],
    });
    await writeFiles(wts.T02!, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["src/a/"] }),
    });
    const r = await overlap(wts.T02!);
    expect(r.code).toBe(0);
    expect(ids(await readOrder(root))).toEqual([["T01", "T03", "T04", "T02"]]);
  });

  it("タスクの worktree から足せるが、order の足す・外す・消すは終了コード2のまま", async () => {
    const { root, wts } = await setup();
    expect((await overlap(wts.T02!)).code).toBe(0);
    const run = (args: string[]) =>
      runCli(["order", ...args], { cwd: wts.T02!, runner: fakeOrca().runner });
    expect((await run(["T01,T02,T03"])).code).toBe(2);
    expect((await run(["--remove", "T01"])).code).toBe(2);
    expect((await run(["--clear"])).code).toBe(2);
    expect(ids(await readOrder(root))).toEqual([["T01", "T02"]]);
  });

  it("Orca に届かなくても終了コード0で、順は足してあり、警告が出る", async () => {
    const { root, wts } = await setup();
    const orca = fakeOrca();
    orca.unavailable = true;
    const r = await overlap(wts.T02!, "T02", orca);
    expect(r.code).toBe(0);
    expect(r.err).toContain("未読の印をつけられませんでした");
    expect(ids(await readOrder(root))).toEqual([["T01", "T02"]]);
  });

  it("autoOrderOnOverlap が false なら、今までどおり終了コード1で順のファイルを作らない", async () => {
    const { root, wts } = await setup({ autoOrderOnOverlap: false });
    const r = await overlap(wts.T02!);
    expect(r.code).toBe(1);
    expect(r.err).toContain("T01");
    expect(r.err).not.toContain("足せませんでした");
    expect(existsSync(await mergeOrderFile(testRunner, root))).toBe(false);
    expect(r.orca.callsOf("worktree", "set")).toEqual([]);
  });
});

describe("overlap：自動で決めきれないとき", () => {
  const refused = async (
    order: MergeOrder | null,
    allowed: string[],
    reason: string,
  ) => {
    const { root, wts } = await setup();
    if (order) await writeMergeOrder(testRunner, root, order);
    const file = await mergeOrderFile(testRunner, root);
    const before = existsSync(file) ? await readFile(file, "utf8") : null;
    await writeFiles(wts.T02!, {
      "docs/tasks/T02.md": specDoc("T02", { allowed }),
    });
    const r = await overlap(wts.T02!);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`マージの順には足せませんでした：`);
    expect(r.err).toContain(reason);
    expect(existsSync(file) ? await readFile(file, "utf8") : null).toBe(before);
    expect(r.orca.callsOf("worktree", "set")).toEqual([]);
  };

  it("自分がもう別の鎖にいる", async () => {
    await refused(
      { chains: [chain("T02", "T04")] },
      ["src/a/b", "src/a/c/"],
      "すでにマージの順",
    );
  });
  it("相手が別々の鎖にいる", async () => {
    await refused(
      { chains: [chain("T01", "T04"), chain("T03", "T09")] },
      ["src/a/c/", "src/a/d/"],
      "別々の鎖",
    );
  });
  it("鎖にいる相手といない相手が混ざる", async () => {
    await refused(
      { chains: [chain("T03", "T09")] },
      ["src/a/c/", "src/a/d/"],
      "混ざっています",
    );
  });
  it("鎖にいない相手が2つ以上", async () => {
    await refused(null, ["src/a/c/", "src/a/d/"], "2つ以上");
  });

  it("範囲の外・共有のファイル・書き込んでよい場所が空と重なりが一緒なら、順を足さず終了コード1", async () => {
    const { root, wts } = await setup();
    const file = await mergeOrderFile(testRunner, root);
    const cases: Record<string, string> = {
      note: specDoc("T02", { allowed: ["src/a/b（新規）"] }),
      shared: specDoc("T02", { allowed: ["src/a/b", "docs/"] }),
      outside: specDoc("T02", {
        allowed: ["src/a/b"],
        workers: [{ name: "担当A：本体", paths: ["src/a/b", "src/z/"] }],
      }),
      workers: specDoc("T02", {
        allowed: ["src/a/b"],
        workers: [
          { name: "担当A：本体", paths: ["src/a/b"] },
          { name: "担当B：別", paths: ["src/a/b/"] },
        ],
      }),
    };
    for (const [name, text] of Object.entries(cases)) {
      await writeFiles(wts.T02!, { "docs/tasks/T02.md": text });
      const r = await overlap(wts.T02!);
      expect(r.code, name).toBe(1);
      expect(r.err, name).not.toContain("足せませんでした");
      expect(existsSync(file), name).toBe(false);
    }
    await writeFiles(wts.T02!, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: [] }),
    });
    const empty = await overlap(wts.T02!);
    expect(empty.code).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});

describe("overlap：ID を確かめてから足す", () => {
  it("ID の形が違えば終了コード1で、順を書かない（../tasks/T02 で自分自身と重ねない）", async () => {
    const { root, wts } = await setup();
    const file = await mergeOrderFile(testRunner, root);
    for (const bad of ["../tasks/T02", "x12", "T02/", "T"]) {
      const r = await overlap(wts.T02!, bad);
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toContain("ID の形が違います");
      expect(existsSync(file), bad).toBe(false);
      expect(r.orca.callsOf("worktree", "set"), bad).toEqual([]);
    }
  });

  it("作業中でない ID の設計書は、重なっても順に足さず、理由を添えて終了コード1", async () => {
    const { root, wts } = await setup();
    await writeFiles(wts.T02!, {
      "docs/tasks/T09.md": specDoc("T09", { allowed: ["src/a/b"] }),
    });
    const r = await overlap(wts.T02!, "T09", fakeOrca(), ["--json"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("作業中のタスクではない");
    expect(existsSync(await mergeOrderFile(testRunner, root))).toBe(false);
    expect(r.orca.callsOf("worktree", "set")).toEqual([]);
    const data = JSON.parse(r.out);
    expect(data.autoOrder).toMatchObject({ added: false, chain: null });
  });
});

describe("overlap：同時に流す・ロック", () => {
  it("別の worktree の2つのタスクが同時に足しても、順のファイルは読めて両方が残る", async () => {
    const root = await makeRepo();
    const t1 = await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": specDoc("T01", { allowed: ["src/a/"] }),
    });
    void t1;
    const t2 = await addTaskWorktree(root, "T02", "b");
    const t3 = await addTaskWorktree(root, "T03", "c");
    await writeFiles(t2.path, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["src/a/x"] }),
    });
    await writeFiles(t3.path, {
      "docs/tasks/T03.md": specDoc("T03", { allowed: ["src/a/y"] }),
    });
    const [r2, r3] = await Promise.all([
      overlap(t2.path, "T02"),
      overlap(t3.path, "T03"),
    ]);
    expect(r2.code).toBe(0);
    // T02 と T03 は互いに重ならないが、それぞれ T01 と重なる。2つ目は1つ目の鎖を見る
    expect(r3.code).toBe(0);
    const order = await readOrder(root);
    expect(order.chains).toHaveLength(1);
    const flat = order.chains[0]!.map((i) => i.id);
    expect(flat[0]).toBe("T01");
    expect([...flat].sort()).toEqual(["T01", "T02", "T03"]);
    JSON.parse(await readFile(await mergeOrderFile(testRunner, root), "utf8"));
    expect(existsSync(await mergeOrderLockFile(testRunner, root))).toBe(false);
  });

  it("overlap 自身が生きているロックが外れなければ、終了コード1で順を変えず、未読の印も送らない", async () => {
    const { root, wts } = await setup();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    const file = await mergeOrderFile(testRunner, root);
    const r = await overlap(wts.T02!);
    expect(r.code).toBe(1);
    expect(r.err).toContain("別の orca-flow");
    expect(r.err).toContain(lock);
    expect(existsSync(file)).toBe(false);
    expect(r.orca.callsOf("worktree", "set")).toEqual([]);
    expect(existsSync(lock)).toBe(true);
  });

  it("生きているロックが途中で外れれば、待ってから足せる", async () => {
    const { root, wts } = await setup();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    setTimeout(() => void rm(lock, { force: true }), 300);
    const r = await overlap(wts.T02!);
    expect(r.code).toBe(0);
    expect(ids(await readOrder(root))).toEqual([["T01", "T02"]]);
    expect(existsSync(lock)).toBe(false);
  });

  it("生きていないプロセスのロックは取り直して足せる", async () => {
    const { root, wts } = await setup();
    const lock = await mergeOrderLockFile(testRunner, root);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "2147483646 0\n");
    const r = await overlap(wts.T02!);
    expect(r.code).toBe(0);
    expect(ids(await readOrder(root))).toEqual([["T01", "T02"]]);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("order・active に出る自動の印", () => {
  it("order と active に「自動で足した」と時刻が出て、order で同じ鎖を足し直すと消える", async () => {
    const { root, wts } = await setup();
    expect((await overlap(wts.T02!)).code).toBe(0);
    const at = (await readOrder(root)).chains[0]![1]!.auto!.at;
    const run = (args: string[], cwd = root) =>
      runCli(args, { cwd, runner: fakeOrca().runner });

    const listed = await run(["order"]);
    expect(listed.out).toContain("T01 → T02");
    expect(listed.out).toContain(`自動で足した（T02 の overlap・${at}）`);

    const active = await run(["active"], wts.T02!);
    expect(active.out).toContain("マージの順：T01 → T02");
    expect(active.out).toContain(`自動で足した（T02 の overlap・${at}）`);
    const rows = JSON.parse((await run(["active", "--json"])).out);
    const row = rows.find((r: { id: string }) => r.id === "T02");
    expect(row.order).toEqual({
      chain: ["T01", "T02"],
      auto: [{ id: "T02", at }],
    });
    expect(rows.find((r: { id: string }) => r.id === "T03").order).toBeNull();

    expect((await run(["order", "T01,T02"])).code).toBe(0);
    expect((await run(["order"])).out).not.toContain("自動で足した");
    expect((await run(["active"])).out).not.toContain("自動で足した");
    expect((await run(["active"])).out).toContain("マージの順：T01 → T02");
    expect((await readOrder(root)).chains[0]!.some((i) => i.auto)).toBe(false);
  });
});
