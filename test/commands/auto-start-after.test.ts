import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { startAfterLine } from "../../src/commands/status.ts";
import {
  autoDir,
  newRecord,
  readAuto,
  withOff,
  withTurn,
  writeAuto,
} from "../../src/lib/auto.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { currentBootAt } from "../../src/lib/lock.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import {
  startAfterFile,
  writeStartAfterAt,
  type StartAfterEntry,
  type StartAfterReadiness,
} from "../../src/lib/start-after.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const common = (root: string) => path.join(root, ".git");
const fast = { ORCA_FLOW_AUTO_POLL_MS: "5", ORCA_FLOW_AUTO_MAX_WAIT_MS: "60" };

async function cli(
  argv: string[],
  cwd: string,
  env: Record<string, string> | null = null,
  runner: Runner = fakeOrca().runner,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd,
    runner,
    env: { ...process.env, ...(env ?? {}) },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    // 待ち受けは時計が進まないと終わらないので、env を渡すときだけ本物の時計にする
    ...(env ? {} : { now: () => T0 }),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

let tick = 0;
async function stage(
  root: string,
  id: string,
  state: string,
  command = state === "designing" ? "new" : "status",
) {
  await appendStage(common(root), id, {
    at: new Date(T0.getTime() - 3600_000 + ++tick * 1000).toISOString(),
    state,
    note: null,
    command,
  });
}

/** worktree list に指定のカードの文を返す偽の Orca */
function orcaWith(comments: Record<string, string>) {
  const orca = fakeOrca();
  const inner = orca.runner;
  orca.runner = async (cmd, args, opts) => {
    if (cmd === "orca" && args[0] === "worktree" && args[1] === "list")
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: {
            worktrees: Object.entries(comments).map(([p, comment]) => ({
              id: p,
              path: p,
              comment,
            })),
          },
        }),
        stderr: "",
        timedOut: false,
      };
    return inner(cmd, args, opts);
  };
  return orca;
}

const exists = async (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const after: StartAfterEntry[] = [
  { id: "T01", repo: null, wait: "implemented" },
];

/** 前 T01 と、T01 を待つ印のある後ろ T05 が作業中のリポジトリ */
async function setup(options: { ready: boolean; specReview?: boolean }) {
  const root = await makeRepo();
  await addTaskWorktree(root, "T01", "first");
  const wt = await addTaskWorktree(root, "T05", "second");
  await writeStartAfterAt(common(root), "T05", after, T0);
  await stage(root, "T01", "designing");
  await stage(root, "T01", options.ready ? "integrate-wait" : "working");
  await stage(root, "T05", "designing");
  if (options.specReview ?? true) await stage(root, "T05", "spec-review");
  return { root, wt: wt.path };
}

describe("auto wait と前を待つ印", () => {
  it("前が整い spec-review の印のあるタスクに承認の番を立てて拾う", async () => {
    const { root } = await setup({ ready: true });
    const r = await cli(["auto", "wait", "--json"], root, fast);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).turn).toMatchObject({
      id: "T05",
      kind: "approve",
    });
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: true,
      approveOnly: true,
      turn: { kind: "approve", picked: true },
    });
  });

  it.each([
    ["前が整っていない", { ready: false }],
    ["spec-review でない", { ready: true, specReview: false }],
  ])("%sなら番を立てず、印が残る間は時間切れまで待つ", async (_l, opts) => {
    const { root } = await setup(opts);
    const r = await cli(["auto", "wait", "--json"], root, fast);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ turn: null });
    expect(await readAuto(common(root), "T05")).toBeNull();
  });

  it("番を立て済みなら立て直さない", async () => {
    const { root } = await setup({ ready: true });
    const done = withTurn(newRecord("T05", T0, true), "approve", T0);
    done.turn!.picked = true;
    await writeAuto(common(root), done);
    const r = await cli(["auto", "wait", "--json"], root, fast);
    expect(JSON.parse(r.out)).toEqual({ turn: null });
    expect((await readAuto(common(root), "T05"))!.turn).toEqual(done.turn);
  });

  it("印のあるタスクだけが残っていると、番がなくてもすぐには終わらない", async () => {
    const { root } = await setup({ ready: false });
    const started = Date.now();
    const r = await cli(["auto", "wait", "--json"], root, {
      ORCA_FLOW_AUTO_POLL_MS: "5",
      ORCA_FLOW_AUTO_MAX_WAIT_MS: "200",
    });
    expect(JSON.parse(r.out)).toEqual({ turn: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});

describe("status と前を待つ印", () => {
  it("承認だけのおまかせは integrate-wait にしても統合の番を立てない", async () => {
    const { root, wt } = await setup({ ready: true });
    await writeAuto(common(root), newRecord("T05", T0, true));
    const r = await cli(["status", "integrate-wait"], wt);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("おまかせ：");
    expect((await readAuto(common(root), "T05"))!.turn).toBeNull();
    // 古い（欄のない）おまかせは今までどおり統合の番を立てる
    await writeAuto(common(root), newRecord("T05", T0));
    await cli(["status", "integrate-wait"], wt);
    expect((await readAuto(common(root), "T05"))!.turn!.kind).toBe("integrate");
  });

  it("前が整っていない印があれば、spec-review でも番を立てず、待っている1行を出す（もとからおまかせでも）", async () => {
    const { root, wt } = await setup({ ready: false, specReview: false });
    await writeAuto(common(root), newRecord("T05", T0));
    const r = await cli(["status", "spec-review"], wt);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    const line = lines.find((l) => l.startsWith("前の実装完了を待っています"));
    expect(line).toBeDefined();
    expect(line).toContain("T01");
    expect(line).toContain("/orca-flow:auto");
    expect(r.out).not.toContain("おまかせ：");
    expect((await readAuto(common(root), "T05"))!.turn).toBeNull();
    const json = await cli(["status", "spec-review", "--json"], wt);
    expect(JSON.parse(json.out).startAfter).toMatchObject({ ready: false });
  });

  it("前が整っていれば、おまかせのタスクに承認の番を立て、待っている1行は出さない", async () => {
    const { root, wt } = await setup({ ready: true, specReview: false });
    await writeAuto(common(root), newRecord("T05", T0));
    const r = await cli(["status", "spec-review"], wt);
    expect(r.out).not.toContain("前の実装完了を待っています");
    expect((await readAuto(common(root), "T05"))!.turn!.kind).toBe("approve");
  });

  it("印のないタスクには待っている1行を出さない", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const r = await cli(["status", "spec-review"], wt.path);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("前の実装完了を待っています");
  });
});

describe("auto の一覧・show・off と前を待つ印", () => {
  it("一覧に前を待つタスクと前ごとの整い具合が出る", async () => {
    const { root } = await setup({ ready: false });
    const r = await cli(["auto"], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("前を待つタスク：");
    expect(r.out).toContain("T05：作業中・前を待っています");
    expect(r.out).toContain("T01（実装完了を待つ：");
    const json = JSON.parse((await cli(["auto", "--json"], root)).out);
    expect(json.startAfter).toMatchObject([
      {
        id: "T05",
        active: true,
        ready: false,
        entries: [{ label: "T01", ready: false }],
      },
    ]);
    await writeAuto(common(root), newRecord("T05", T0, true));
    expect((await cli(["auto"], root)).out).toContain(
      "T05：承認だけのおまかせ",
    );
  });

  it("show は記録がなくても印があれば前ごとの整い具合を出す", async () => {
    const { root } = await setup({ ready: true });
    const r = await cli(["auto", "show", "T05"], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("前が整いました");
    expect(r.out).toContain("T01（実装完了を待つ：");
    const json = JSON.parse(
      (await cli(["auto", "show", "T05", "--json"], root)).out,
    );
    expect(json.startAfter).toMatchObject({ ready: true });
    expect((await cli(["auto", "show", "T06"], root)).code).toBe(1);
  });

  it("off は印を残し、印だけのタスクには外した形の記録を書いて、待ち受けに番を立てさせない", async () => {
    const { root } = await setup({ ready: true });
    const r = await cli(
      ["auto", "off", "T05", "--reason", "人が確かめる"],
      root,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "自動の承認を止めました（前を待つ印は残します）：T05",
    );
    expect(r.out).not.toContain("外すおまかせのタスクはありません");
    expect(await exists(startAfterFile(common(root), "T05"))).toBe(true);
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: false,
      approveOnly: true,
      turn: null,
      offReason: "人が確かめる",
      offAt: T0.toISOString(),
    });
    const w = await cli(["auto", "wait", "--json"], root, fast);
    expect(JSON.parse(w.out)).toEqual({ turn: null });
    expect((await readAuto(common(root), "T05"))!.turn).toBeNull();
  });

  it("一覧は、おまかせを外した印のタスクに外してあることと approve の抜け方を添える", async () => {
    const { root } = await setup({ ready: true });
    const before = await cli(["auto"], root);
    expect(before.out).toContain("T05：作業中・前が整いました");
    expect(before.out).not.toContain("おまかせを外してあります");
    await cli(["auto", "off", "T05"], root);
    const r = await cli(["auto"], root);
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.startsWith("T05：作業中"));
    expect(line).toContain("前が整いました");
    expect(line).toContain(
      "おまかせを外してあります（/orca-flow:approve で承認）",
    );
    const json = JSON.parse((await cli(["auto", "--json"], root)).out);
    expect(json.startAfter).toMatchObject([{ id: "T05", off: true }]);
  });

  it("一覧は、spec-review のあとに承認したタスクには添え書きを出さず、spec-review を出し直したらまた出す", async () => {
    const { root } = await setup({ ready: true });
    await cli(["auto", "off", "T05"], root);
    await stage(root, "T05", "working", "approve");
    const approved = await cli(["auto"], root);
    expect(approved.code).toBe(0);
    const line = approved.out
      .split("\n")
      .find((l) => l.startsWith("T05：作業中"));
    expect(line).toContain("前が整いました");
    expect(line).not.toContain("おまかせを外してあります");
    expect(line).not.toContain("/orca-flow:approve");
    const json = JSON.parse((await cli(["auto", "--json"], root)).out);
    expect(json.startAfter).toMatchObject([{ id: "T05", off: true }]);

    await stage(root, "T05", "spec-review");
    const again = await cli(["auto"], root);
    expect(
      again.out.split("\n").find((l) => l.startsWith("T05：作業中")),
    ).toContain("おまかせを外してあります（/orca-flow:approve で承認）");
  });

  it("一覧は、作業中でない印のタスクには、おまかせを外してあっても添え書きを出さない", async () => {
    const { root } = await setup({ ready: true });
    await writeStartAfterAt(common(root), "T07", after, T0);
    await stage(root, "T07", "designing");
    await stage(root, "T07", "spec-review");
    await writeAuto(
      common(root),
      withOff(newRecord("T07", T0, true), null, T0),
    );
    const r = await cli(["auto"], root);
    expect(r.code).toBe(0);
    const line = r.out
      .split("\n")
      .find((l) => l.startsWith("T07：作業中ではありません"));
    expect(line).toBeDefined();
    expect(line).not.toContain("おまかせを外してあります");
    expect(line).not.toContain("/orca-flow:approve");
    const json = JSON.parse((await cli(["auto", "--json"], root)).out);
    expect(
      json.startAfter.find((t: { id: string }) => t.id === "T07"),
    ).toMatchObject({ active: false, off: true });
  });

  it("off は記録と印のあるタスクの記録を外し、印は残す", async () => {
    const { root } = await setup({ ready: true });
    await writeAuto(common(root), newRecord("T05", T0, true));
    const r = await cli(["auto", "off", "T05", "--json"], root);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      off: ["T05"],
      startAfterStopped: ["T05"],
    });
    expect(await exists(startAfterFile(common(root), "T05"))).toBe(true);
    expect((await readAuto(common(root), "T05"))!.auto).toBe(false);
    const w = await cli(["auto", "wait", "--json"], root, fast);
    expect(JSON.parse(w.out)).toEqual({ turn: null });
  });

  it("off --all は記録を外し、印だけの作業中のタスクにも外した形の記録を書く（印は残す）", async () => {
    const { root } = await setup({ ready: true });
    await addTaskWorktree(root, "T06", "third");
    await writeStartAfterAt(common(root), "T06", after, T0);
    await stage(root, "T06", "designing");
    await stage(root, "T06", "spec-review");
    await writeAuto(common(root), newRecord("T06", T0, true));
    // 作業中でない印は触らない
    await writeStartAfterAt(common(root), "T07", after, T0);
    const r = await cli(["auto", "off", "--all"], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("おまかせを外しました：T06");
    expect(r.out).toContain(
      "自動の承認を止めました（前を待つ印は残します）：T05、T06",
    );
    for (const id of ["T05", "T06", "T07"])
      expect(await exists(startAfterFile(common(root), id))).toBe(true);
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: false,
      approveOnly: true,
    });
    expect((await readAuto(common(root), "T06"))!.auto).toBe(false);
    expect(await readAuto(common(root), "T07")).toBeNull();
    const w = await cli(["auto", "wait", "--json"], root, fast);
    expect(JSON.parse(w.out)).toEqual({ turn: null });
    expect((await readAuto(common(root), "T05"))!.turn).toBeNull();
    expect((await readAuto(common(root), "T06"))!.turn).toBeNull();
  });
});

describe("auto on と前を待つ印", () => {
  it("承認だけのおまかせは、統合待ちのカードでも統合の番を立てず、承認だけのまま残す", async () => {
    const { root, wt } = await setup({ ready: true });
    await writeAuto(
      common(root),
      withOff(newRecord("T05", T0, true), null, T0),
    );
    const orca = orcaWith({ [wt]: "統合待ち：docs/reports/T05.md" });
    const r = await cli(["auto", "on", "T05"], root, null, orca.runner);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "承認だけのおまかせなので統合の番は立てません。統合は /orca-flow:integrate で",
    );
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: true,
      approveOnly: true,
      turn: null,
    });
  });

  it("設計書のレビュー待ちで前が整っていなければ、おまかせにするが承認の番は立てない", async () => {
    const { root, wt } = await setup({ ready: false });
    const orca = orcaWith({ [wt]: "設計書のレビュー待ち" });
    const r = await cli(["auto", "on", "T05"], root, null, orca.runner);
    expect(r.code).toBe(0);
    const line = r.out
      .split("\n")
      .find((l) => l.startsWith("前の実装完了を待っています"));
    expect(line).toContain("T01");
    expect(line).toContain("前が整ったら待ち受けが番を立てます");
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: true,
      turn: null,
    });
  });

  it("設計書のレビュー待ちで印が壊れていれば、記録の場所と今承認できることを出し、番は立てない", async () => {
    const { root, wt } = await setup({ ready: true });
    const file = startAfterFile(common(root), "T05");
    await writeFile(file, "{");
    const orca = orcaWith({ [wt]: "設計書のレビュー待ち" });
    const r = await cli(["auto", "on", "T05"], root, null, orca.runner);
    expect(r.code).toBe(0);
    expect(r.out).toContain(file);
    expect(r.out).toContain("/orca-flow:approve で今承認できます");
    expect(r.out).not.toContain("待ち受けが番を立てます");
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: true,
      turn: null,
    });
  });

  it("設計書のレビュー待ちで前が読めなければ、記録の場所と今承認できることを出し、番は立てない", async () => {
    const { root, wt } = await setup({ ready: true });
    await writeStartAfterAt(
      common(root),
      "T05",
      [
        { id: "T01", repo: null, wait: "implemented" },
        {
          id: "T02",
          repo: { name: "gone", path: path.join(root, "no-such-repo") },
          wait: "implemented",
        },
      ],
      T0,
    );
    const orca = orcaWith({ [wt]: "設計書のレビュー待ち" });
    const r = await cli(["auto", "on", "T05"], root, null, orca.runner);
    expect(r.code).toBe(0);
    expect(r.out).toContain(startAfterFile(common(root), "T05"));
    expect(r.out).toContain("/orca-flow:approve で今承認できます");
    expect(r.out).not.toContain("待ち受けが番を立てます");
    expect((await readAuto(common(root), "T05"))!.turn).toBeNull();
  });

  it("設計書のレビュー待ちで前が整っていれば、今までどおり承認の番を立てる", async () => {
    const { root, wt } = await setup({ ready: true });
    const orca = orcaWith({ [wt]: "設計書のレビュー待ち" });
    const r = await cli(["auto", "on", "T05"], root, null, orca.runner);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("前の実装完了を待っています");
    expect((await readAuto(common(root), "T05"))!.turn!.kind).toBe("approve");
  });
});

describe("status spec-review の前を待つ1行", () => {
  const lineOf = (out: string, head: string) =>
    out.split("\n").find((l) => l.startsWith(head));

  it("印があっておまかせの記録がなければ、待っている1行を出し、記録を作らない", async () => {
    const { root, wt } = await setup({ ready: false, specReview: false });
    const r = await cli(["status", "spec-review"], wt);
    expect(r.code).toBe(0);
    const line = lineOf(r.out, "前の実装完了を待っています");
    expect(line).toContain(
      "承認は、前が整ったあと統括役の待ち受け（/orca-flow:auto）が番を立てて進めます",
    );
    expect(await readAuto(common(root), "T05")).toBeNull();
  });

  it("先の承認がなく、前が読めて、おまかせを外していなければ、先に承認できることを添える", async () => {
    const { root, wt } = await setup({ ready: false, specReview: false });
    const r = await cli(["status", "spec-review"], wt);
    expect(lineOf(r.out, "前の実装完了を待っています")).toContain(
      "/orca-flow:approve で先に承認しておけます",
    );
    await writeAuto(
      common(root),
      withOff(newRecord("T05", T0, true), null, T0),
    );
    const off = await cli(["status", "spec-review"], wt);
    expect(lineOf(off.out, "前の実装完了を待っています")).not.toContain(
      "先に承認しておけます",
    );
    await writeFile(startAfterFile(common(root), "T05"), "{");
    await writeAuto(common(root), newRecord("T05", T0, true));
    const broken = await cli(["status", "spec-review"], wt);
    expect(lineOf(broken.out, "前の実装完了を待っています")).not.toContain(
      "先に承認しておけます",
    );
  });

  it("印が壊れていれば、記録の場所と approve の抜け方を添え、待ち受けが進めるとは言わない", async () => {
    const { root, wt } = await setup({ ready: false, specReview: false });
    const file = startAfterFile(common(root), "T05");
    await writeFile(file, "{");
    const r = await cli(["status", "spec-review"], wt);
    const line = lineOf(r.out, "前の実装完了を待っています");
    expect(line).toContain(file);
    expect(line).toContain(
      "/orca-flow:approve で今承認できます（approve が前を待つかを聞きます）",
    );
    expect(line).not.toContain("番を立てて進めます");
  });

  it("前が読めなければ、記録の場所と approve の抜け方を添える", async () => {
    const { root, wt } = await setup({ ready: false, specReview: false });
    await writeStartAfterAt(
      common(root),
      "T05",
      [
        {
          id: "T01",
          repo: { name: "gone", path: path.join(root, "no-such-repo") },
          wait: "implemented",
        },
      ],
      T0,
    );
    const r = await cli(["status", "spec-review"], wt);
    const line = lineOf(r.out, "前の実装完了を待っています");
    expect(line).toContain("読めません");
    expect(line).toContain(startAfterFile(common(root), "T05"));
    expect(line).toContain("/orca-flow:approve で今承認できます");
    expect(line).not.toContain("番を立てて進めます");
  });

  it("前が読めないかは理由の文でなく真偽で見分ける", () => {
    const file = "/abs/start-after/T05.json";
    const readiness = (unreadable: boolean, reason: string) =>
      ({
        ready: false,
        problem: null,
        entries: [
          {
            entry: { id: "T01", repo: null, wait: "implemented" },
            label: "T01",
            ready: false,
            unreadable,
            reason,
          },
        ],
      }) satisfies StartAfterReadiness;
    const lost = startAfterLine(
      readiness(true, "別の言い方で失敗を伝える文"),
      file,
      false,
    );
    expect(lost).toContain(`記録：${file}`);
    expect(lost).toContain("/orca-flow:approve で今承認できます");
    expect(lost).not.toContain("番を立てて進めます");
    const waiting = startAfterLine(
      readiness(false, "読めません（と書いてあるだけ）"),
      file,
      false,
    );
    expect(waiting).not.toContain(file);
    expect(waiting).not.toContain("/orca-flow:approve で今承認できます");
    expect(waiting).toContain("番を立てて進めます");
  });

  it("おまかせを外してあれば、前が整ったら approve で承認すると伝える", async () => {
    const { root, wt } = await setup({ ready: false, specReview: false });
    await writeAuto(
      common(root),
      withOff(newRecord("T05", T0, true), null, T0),
    );
    const r = await cli(["status", "spec-review"], wt);
    const line = lineOf(r.out, "前の実装完了を待っています");
    expect(line).toContain(
      "おまかせを外してあるので、前が整ったら /orca-flow:approve で承認します",
    );
    expect(line).not.toContain("番を立てて進めます");
  });

  it("前が整っていれば「前が整っています」で始まる1行を出す", async () => {
    const { root, wt } = await setup({ ready: true, specReview: false });
    const r = await cli(["status", "spec-review"], wt);
    expect(lineOf(r.out, "前が整っています")).toBe(
      "前が整っています（T01（実装完了を待つ：統合待ちになりました））。承認は、統括役の待ち受け（/orca-flow:auto）が番を立てて進めます",
    );
    expect(r.out).not.toContain("前の実装完了を待っています");

    await writeAuto(
      common(root),
      withOff(newRecord("T05", T0, true), null, T0),
    );
    const off = await cli(["status", "spec-review"], wt);
    expect(lineOf(off.out, "前が整っています")).toBe(
      "前が整っています（T01（実装完了を待つ：統合待ちになりました））。おまかせを外してあるので、/orca-flow:approve で承認します",
    );
  });
});

describe("context と前を待つ印", () => {
  const ctx = (cwd: string) => cli(["context"], cwd, null, fakeOrca().runner);

  it("前を待つタスクがあり待ち受けが動いていなければ /orca-flow:auto を勧める", async () => {
    const { root } = await setup({ ready: false });
    const r = await ctx(root);
    expect(r.out).toContain("前を待つタスク（T05）");
    expect(r.out).toContain("/orca-flow:auto");
    await mkdir(autoDir(common(root)), { recursive: true });
    await writeFile(
      path.join(autoDir(common(root)), "wait.lock"),
      `${process.pid} ${currentBootAt()}\n`,
    );
    expect((await ctx(root)).out).not.toContain("/orca-flow:auto");
  });

  it("承認が済んだ承認だけのおまかせのタスクしかなければ勧めない（ふつうのおまかせは勧める）", async () => {
    const { root } = await setup({ ready: true });
    await stage(root, "T05", "working", "approve");
    const picked = withTurn(newRecord("T05", T0, true), "approve", T0);
    picked.turn!.picked = true;
    await writeAuto(common(root), picked);
    expect((await ctx(root)).out).not.toContain("/orca-flow:auto");
    await writeAuto(common(root), newRecord("T05", T0));
    expect((await ctx(root)).out).toContain("/orca-flow:auto");
  });

  it("印がなければ勧めない", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    expect((await ctx(root)).out).not.toContain("/orca-flow:auto");
  });
});
