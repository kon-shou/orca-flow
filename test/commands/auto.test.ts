import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import {
  autoDir,
  autoSkillPath,
  newRecord,
  readAuto,
  withTurn,
  writeAuto,
} from "../../src/lib/auto.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { currentBootAt } from "../../src/lib/lock.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");

async function cli(
  argv: string[],
  cwd: string,
  runner: Runner = fakeOrca().runner,
  env: Record<string, string> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd,
    runner,
    env: { ...process.env, ...env },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    // 待ち受けは時計が進まないと終わらないので、env を渡すときだけ本物の時計にする
    ...(Object.keys(env).length > 0 ? {} : { now: () => T0 }),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
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

const common = (root: string) => path.join(root, ".git");
const fast = { ORCA_FLOW_AUTO_POLL_MS: "5", ORCA_FLOW_AUTO_MAX_WAIT_MS: "30" };

describe("auto on・off・log・show・一覧", () => {
  it("on は作業中のタスクをおまかせにし、作業中でない ID は終了コード1", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    const ok = await cli(["auto", "on", "T12"], root);
    expect(ok.code).toBe(0);
    expect(await readAuto(common(root), "T12")).toMatchObject({
      auto: true,
      turn: null,
    });
    const no = await cli(["auto", "on", "T99"], root);
    expect(no.code).toBe(1);
    expect(await readAuto(common(root), "T99")).toBeNull();
  });

  it("設計書のレビュー待ちのカードなら承認の番、統合待ちなら統合の番を立てる", async () => {
    const root = await makeRepo();
    const a = await addTaskWorktree(root, "T12", "shop");
    const b = await addTaskWorktree(root, "T13", "cart");
    const c = await addTaskWorktree(root, "T14", "pay");
    const orca = orcaWith({
      [a.path]: "設計書のレビュー待ち",
      [b.path]: "統合待ち：docs/reports/T13.md",
      [c.path]: "実装中",
    });
    for (const id of ["T12", "T13", "T14"])
      expect((await cli(["auto", "on", id], root, orca.runner)).code).toBe(0);
    expect((await readAuto(common(root), "T12"))!.turn).toMatchObject({
      kind: "approve",
      picked: false,
    });
    expect((await readAuto(common(root), "T13"))!.turn!.kind).toBe("integrate");
    expect((await readAuto(common(root), "T14"))!.turn).toBeNull();
  });

  it("PR が閉じられたカードのタスクに on をしても、統合の番は立たない", async () => {
    const root = await makeRepo();
    const a = await addTaskWorktree(root, "T12", "shop");
    const orca = orcaWith({ [a.path]: "PR が閉じられた：PR #7" });
    expect((await cli(["auto", "on", "T12"], root, orca.runner)).code).toBe(0);
    expect((await readAuto(common(root), "T12"))!.turn).toBeNull();
  });

  it("Orca に聞けなければ番を立てず警告する", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    const orca = fakeOrca();
    orca.unavailable = true;
    const r = await cli(["auto", "on", "T12"], root, orca.runner);
    expect(r.code).toBe(0);
    expect(r.err).toContain("警告");
    expect((await readAuto(common(root), "T12"))!.turn).toBeNull();
  });

  it("off は番を消して理由を残し、off --all はすべてを外す", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    await addTaskWorktree(root, "T13", "cart");
    await writeAuto(
      common(root),
      withTurn(newRecord("T12", T0), "approve", T0),
    );
    await writeAuto(common(root), newRecord("T13", T0));
    const one = await cli(
      ["auto", "off", "T12", "--reason", "テストが落ちた"],
      root,
    );
    expect(one.code).toBe(0);
    expect(await readAuto(common(root), "T12")).toMatchObject({
      auto: false,
      turn: null,
      offReason: "テストが落ちた",
    });
    expect((await readAuto(common(root), "T13"))!.auto).toBe(true);
    const all = await cli(["auto", "off", "--all"], root);
    expect(all.code).toBe(0);
    expect((await readAuto(common(root), "T13"))!.auto).toBe(false);
    expect((await cli(["auto", "off", "T77"], root)).code).toBe(1);
  });

  it("log は決めたことを時刻つきで足し、show が読める（統合済みでも）", async () => {
    const root = await makeRepo();
    await writeAuto(common(root), newRecord("T12", T0));
    expect(
      (await cli(["auto", "log", "T12", "推奨", "どおりにした"], root)).code,
    ).toBe(0);
    const shown = await cli(["auto", "show", "T12"], root);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("2026-01-01T00:00:00.000Z");
    expect(shown.out).toContain("推奨 どおりにした");
    expect((await cli(["auto", "show", "T12", "--json"], root)).out).toContain(
      '"decisions"',
    );
    expect((await cli(["auto", "show", "T55"], root)).code).toBe(1);
    expect((await cli(["auto", "log", "T55", "x"], root)).code).toBe(1);
    expect((await cli(["auto", "log", "T12"], root)).code).toBe(1);
  });

  it("on・off・log・wait はメインの作業ツリー以外では終了コード2、show と一覧はどこからでも", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeAuto(common(root), newRecord("T12", T0));
    for (const argv of [
      ["auto", "on", "T12"],
      ["auto", "off", "T12"],
      ["auto", "off", "--all"],
      ["auto", "log", "T12", "x"],
      ["auto", "wait"],
    ])
      expect((await cli(argv, wt.path)).code, argv.join(" ")).toBe(2);
    expect((await readAuto(common(root), "T12"))!.auto).toBe(true);
    expect((await cli(["auto", "show", "T12"], wt.path)).code).toBe(0);
    expect((await cli(["auto"], wt.path)).code).toBe(0);
  });

  it("一覧は番と待ち受けの様子を出す（--json もある）", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    expect((await cli(["auto"], root)).out).toContain(
      "おまかせのタスクはありません",
    );
    await writeAuto(
      common(root),
      withTurn(newRecord("T12", T0), "approve", T0),
    );
    const r = await cli(["auto"], root);
    expect(r.out).toContain("待ち受け：動いていません");
    expect(r.out).toContain("T12");
    expect(r.out).toContain("承認の番");
    const json = JSON.parse((await cli(["auto", "--json"], root)).out) as {
      waiting: { running: boolean };
      tasks: { id: string; active: boolean }[];
    };
    expect(json.waiting.running).toBe(false);
    expect(json.tasks).toMatchObject([{ id: "T12", active: true }]);
  });

  it("知らない使い方は終了コード1", async () => {
    const root = await makeRepo();
    expect((await cli(["auto", "nope"], root)).code).toBe(1);
    expect((await cli(["auto", "on"], root)).code).toBe(1);
    expect(
      (await cli(["auto", "show", "T12", "--reason", "x"], root)).code,
    ).toBe(1);
  });
});

describe("auto wait", () => {
  it("立っている番を古い順に1つ拾い、auto のスキルのパスを出し、二度は返さない", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    await addTaskWorktree(root, "T13", "cart");
    await writeAuto(
      common(root),
      withTurn(
        newRecord("T12", T0),
        "integrate",
        new Date(T0.getTime() + 1000),
      ),
    );
    await writeAuto(
      common(root),
      withTurn(newRecord("T13", T0), "approve", T0),
    );
    const first = await cli(["auto", "wait"], root, undefined, fast);
    expect(first.code).toBe(0);
    expect(first.out).toContain("T13");
    expect(first.out).toContain("承認");
    expect(first.out).toContain(autoSkillPath());
    await access(autoSkillPath());
    expect(autoSkillPath()).toBe(
      path.resolve(import.meta.dirname, "../../skills/auto/SKILL.md"),
    );
    const second = await cli(["auto", "wait", "--json"], root, undefined, fast);
    expect(JSON.parse(second.out).turn).toMatchObject({
      id: "T12",
      kind: "integrate",
    });
    const third = await cli(["auto", "wait", "--json"], root, undefined, fast);
    expect(third.code).toBe(0);
    expect(JSON.parse(third.out)).toEqual({ turn: null });
    // ロックは放されている
    expect(
      (
        await readFile(path.join(autoDir(common(root)), "T12.json"), "utf8")
      ).includes('"picked": true'),
    ).toBe(true);
    expect((await cli(["auto", "wait"], root, undefined, fast)).code).toBe(0);
  });

  it("おまかせのタスクがなければ番なしで終了コード0", async () => {
    const root = await makeRepo();
    const r = await cli(["auto", "wait", "--json"], root, undefined, fast);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ turn: null });
  });

  it("番がなくても時間切れで拾わず終了コード0", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    await writeAuto(common(root), newRecord("T12", T0));
    const r = await cli(["auto", "wait", "--json"], root, undefined, {
      ORCA_FLOW_AUTO_POLL_MS: "5",
      ORCA_FLOW_AUTO_MAX_WAIT_MS: "0",
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ turn: null });
  });

  it("生きているほかの待ち受けがあれば終了コード2、死んだプロセスのロックは取り直す", async () => {
    const root = await makeRepo();
    await mkdir(autoDir(common(root)), { recursive: true });
    const lock = path.join(autoDir(common(root)), "wait.lock");
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    const held = await cli(["auto", "wait"], root, undefined, fast);
    expect(held.code).toBe(2);
    expect(await readFile(lock, "utf8")).toContain(String(process.pid));
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    await writeFile(lock, `${dead} ${currentBootAt()}\n`);
    const taken = await cli(["auto", "wait"], root, undefined, fast);
    expect(taken.code).toBe(0);
  });
});

describe("auto の一覧の添え書き", () => {
  it("拾われた番には、進んでいなければ auto on で立て直せると添える", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    const rec = withTurn(newRecord("T12", T0), "approve", T0);
    rec.turn!.picked = true;
    await writeAuto(path.join(root, ".git"), rec);
    const r = await cli(["auto"], root);
    expect(r.out).toContain("拾われました");
    expect(r.out).toContain("orca-flow auto on T12");
    const w = withTurn(newRecord("T12", T0), "approve", T0);
    await writeAuto(path.join(root, ".git"), w);
    expect((await cli(["auto"], root)).out).not.toContain("auto on T12");
  });
});
