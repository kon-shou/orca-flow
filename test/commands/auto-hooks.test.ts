import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import {
  autoDir,
  newRecord,
  readAuto,
  withTurn,
  writeAuto,
} from "../../src/lib/auto.ts";
import { currentBootAt } from "../../src/lib/lock.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";
import { writeFile, mkdir } from "node:fs/promises";

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "100";
  process.env[VERIFY_INTERVAL_ENV] = "20";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

const T0 = new Date("2026-01-01T00:00:00.000Z");
const common = (root: string) => path.join(root, ".git");
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe("new --auto", () => {
  it("作れたときに記録を作っておまかせにし、出力と --json に入れる", async () => {
    const root = await makeRepo();
    const orca = fakeOrca();
    const r = await runCli(
      ["new", "--title", "買い物", "--slug", "shop", "--id", "T12", "--auto"],
      { cwd: root, runner: orca.runner },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("おまかせ");
    expect(await readAuto(common(root), "T12")).toMatchObject({
      auto: true,
      turn: null,
      decisions: [],
    });
    const j = await runCli(
      [
        "new",
        "--title",
        "車",
        "--slug",
        "cart",
        "--id",
        "T13",
        "--auto",
        "--json",
      ],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(JSON.parse(j.out).auto).toBe(true);
  });

  it("--auto がなければ記録を作らず、出力にも出さない", async () => {
    const root = await makeRepo();
    const r = await runCli(
      ["new", "--title", "買い物", "--slug", "shop", "--id", "T12"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("おまかせ");
    expect(await exists(autoDir(common(root)))).toBe(false);
  });

  it("おまかせを書けなくても作成は成功し、警告を出す", async () => {
    const root = await makeRepo();
    await mkdir(path.join(common(root), "orca-flow"), { recursive: true });
    await writeFile(autoDir(common(root)), "ファイル");
    const r = await runCli(
      [
        "new",
        "--title",
        "買い物",
        "--slug",
        "shop",
        "--id",
        "T12",
        "--auto",
        "--json",
      ],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).auto).toBeUndefined();
    expect(r.err).toContain("auto on T12");
  });

  it("--auto なしで同じ ID の古いおまかせが残っていれば外す", async () => {
    const root = await makeRepo();
    await writeAuto(common(root), newRecord("T12", T0));
    const r = await runCli(
      ["new", "--title", "買い物", "--slug", "shop", "--id", "T12"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("おまかせ：");
    expect(await readAuto(common(root), "T12")).toMatchObject({
      auto: false,
      offReason: "新しいタスクが同じ ID を使った",
    });
  });

  it("作れなかったときは記録を作らない", async () => {
    const root = await makeRepo();
    const orca = fakeOrca();
    orca.unavailable = true;
    const r = await runCli(
      ["new", "--title", "買い物", "--slug", "shop", "--id", "T12", "--auto"],
      { cwd: root, runner: orca.runner },
    );
    expect(r.code).not.toBe(0);
    expect(await exists(autoDir(common(root)))).toBe(false);
  });
});

describe("status の番", () => {
  const status = (cwd: string, state: string) =>
    runCli(["status", state], { cwd, runner: fakeOrca().runner });

  it("おまかせのとき spec-review は承認の番、integrate-wait は統合の番を立てて一行足す", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeAuto(common(root), newRecord("T12", T0));
    const a = await status(wt.path, "spec-review");
    expect(a.code).toBe(0);
    expect(a.out).toContain("おまかせ");
    expect((await readAuto(common(root), "T12"))!.turn).toMatchObject({
      kind: "approve",
      picked: false,
    });
    const b = await status(wt.path, "integrate-wait");
    expect(b.out).toContain("おまかせ");
    expect((await readAuto(common(root), "T12"))!.turn!.kind).toBe("integrate");
  });

  it("カードを更新できないときは番を立てず、おまかせの行も出さない", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeAuto(common(root), newRecord("T12", T0));
    const orca = fakeOrca();
    orca.unavailable = true;
    const r = await runCli(["status", "spec-review"], {
      cwd: wt.path,
      runner: orca.runner,
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("おまかせ");
    expect((await readAuto(common(root), "T12"))!.turn).toBeNull();
  });

  it("拾われた承認の番があっても integrate-wait で統合の番を新しく立てる", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const rec = withTurn(newRecord("T12", T0), "approve", T0);
    rec.turn!.picked = true;
    await writeAuto(common(root), rec);
    await status(wt.path, "integrate-wait");
    expect((await readAuto(common(root), "T12"))!.turn).toMatchObject({
      kind: "integrate",
      picked: false,
    });
  });

  it("ほかの状態にすると、まだ拾われていない番を消す。拾われた番は残る", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeAuto(
      common(root),
      withTurn(newRecord("T12", T0), "approve", T0),
    );
    const r = await status(wt.path, "working");
    expect(r.out).not.toContain("おまかせ");
    expect((await readAuto(common(root), "T12"))!.turn).toBeNull();
    const picked = withTurn(newRecord("T12", T0), "integrate", T0);
    picked.turn!.picked = true;
    await writeAuto(common(root), picked);
    await status(wt.path, "question");
    expect((await readAuto(common(root), "T12"))!.turn!.picked).toBe(true);
  });

  it("おまかせを外したタスクと記録のないタスクでは番を立てず、ファイルも作らない", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    const r = await status(wt.path, "spec-review");
    expect(r.out).not.toContain("おまかせ");
    expect(r.out).toBe(
      "T12 のカードを spec-review（設計書のレビュー待ち）にしました",
    );
    expect(await exists(autoDir(common(root)))).toBe(false);
    const off = newRecord("T12", T0);
    off.auto = false;
    await writeAuto(common(root), off);
    await status(wt.path, "integrate-wait");
    expect((await readAuto(common(root), "T12"))!.turn).toBeNull();
    expect(await readdir(autoDir(common(root)))).toEqual(["T12.json"]);
  });
});

describe("context の一言", () => {
  const ctx = (cwd: string) =>
    runCli(["context"], { cwd, runner: fakeOrca().runner });

  it("作業中のおまかせのタスクがあり待ち受けがなければ一言を足す", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    const before = await ctx(root);
    expect(before.out).not.toContain("/orca-flow:auto");
    await writeAuto(common(root), newRecord("T12", T0));
    const after = await ctx(root);
    expect(after.out).toContain("/orca-flow:auto で待ち受けを始め直す");
    expect(after.out).toContain("T12");
    // 死んだプロセスのロックは、待ち受けが動いているとみなさない
    await mkdir(autoDir(common(root)), { recursive: true });
    await writeFile(
      path.join(autoDir(common(root)), "wait.lock"),
      "999999999 0\n",
    );
    expect((await ctx(root)).out).toContain(
      "/orca-flow:auto で待ち受けを始め直す",
    );
  });

  it("待ち受けが動いているとき、おまかせを外したとき、作業中でないときは足さない", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T12", "shop");
    await writeAuto(common(root), newRecord("T12", T0));
    await writeAuto(common(root), newRecord("T99", T0));
    await mkdir(autoDir(common(root)), { recursive: true });
    await writeFile(
      path.join(autoDir(common(root)), "wait.lock"),
      `${process.pid} ${currentBootAt()}\n`,
    );
    expect((await ctx(root)).out).not.toContain("/orca-flow:auto");
    const off = newRecord("T12", T0);
    off.auto = false;
    await writeAuto(common(root), off);
    await writeFile(
      path.join(autoDir(common(root)), "wait.lock"),
      "999999999 0\n",
    );
    // T12 は外れ、T99 は作業中でないので、一言そのものが出ない
    expect((await ctx(root)).out).not.toContain("/orca-flow:auto");
  });

  it("作業中でないおまかせのタスクだけがあるときは足さない", async () => {
    const root = await makeRepo();
    // おまかせでない作業中のタスクを置き、作業中のタスクで絞る所まで通す
    await addTaskWorktree(root, "T12", "shop");
    await writeAuto(common(root), newRecord("T99", T0));
    expect((await ctx(root)).out).not.toContain("/orca-flow:auto");
  });

  it("タスク長の場所では足さない", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeAuto(common(root), newRecord("T12", T0));
    expect((await ctx(wt.path)).out).not.toContain("/orca-flow:auto");
  });
});

void main;
