import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireWaitLock,
  autoDir,
  listAuto,
  newRecord,
  readAuto,
  waitForTurn,
  waitState,
  withOff,
  withTurn,
  writeAuto,
  type WaitDeps,
} from "../../src/lib/auto.ts";
import { currentBootAt } from "../../src/lib/lock.ts";
import { tempDir } from "../helpers/repo.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");

/** 死んだプロセスの番号 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

describe("記録", () => {
  it("書いて読み、壊れた・ないものは null、一時ファイルを残さない", async () => {
    const common = await tempDir();
    expect(await readAuto(common, "T12")).toBeNull();
    const record = withTurn(newRecord("T12", T0), "approve", T0);
    await writeAuto(common, record);
    expect(await readAuto(common, "T12")).toEqual(record);
    expect(await readdir(autoDir(common))).toEqual(["T12.json"]);
    await writeFile(path.join(autoDir(common), "T13.json"), "{壊れ");
    expect(await readAuto(common, "T13")).toBeNull();
    expect((await listAuto(common)).map((r) => r.id)).toEqual(["T12"]);
  });

  it("ID の形が悪ければ読めず、書けない", async () => {
    const common = await tempDir();
    expect(await readAuto(common, "../x")).toBeNull();
    await expect(writeAuto(common, newRecord("../x", T0))).rejects.toThrow();
  });

  it("off は番を消して理由を残す", () => {
    const off = withOff(
      withTurn(newRecord("T12", T0), "integrate", T0),
      "落ちた",
      T0,
    );
    expect(off).toMatchObject({ auto: false, turn: null, offReason: "落ちた" });
  });
});

describe("ロック", () => {
  it("取れて、二重には取れず、放すと取り直せる", async () => {
    const common = await tempDir();
    const a = await acquireWaitLock(common);
    expect(a.kind).toBe("acquired");
    expect(await waitState(common)).toEqual({
      running: true,
      pid: process.pid,
    });
    expect((await acquireWaitLock(common)).kind).toBe("held");
    if (a.kind === "acquired") await a.release();
    expect(await waitState(common)).toEqual({ running: false, pid: null });
    expect((await acquireWaitLock(common)).kind).toBe("acquired");
  });

  it("死んだプロセスと再起動前のロックは取り直す", async () => {
    const common = await tempDir();
    await mkdir(autoDir(common), { recursive: true });
    const lock = path.join(autoDir(common), "wait.lock");
    await writeFile(lock, `${deadPid()} ${currentBootAt()}\n`);
    expect((await waitState(common)).running).toBe(false);
    const a = await acquireWaitLock(common);
    expect(a.kind).toBe("acquired");
    expect((await readFile(lock, "utf8")).split(" ")[0]).toBe(
      String(process.pid),
    );
    if (a.kind === "acquired") await a.release();
    await writeFile(lock, `${process.pid} ${currentBootAt() - 100000}\n`);
    expect((await acquireWaitLock(common)).kind).toBe("acquired");
  });

  it.each(["", "garbage\n"])(
    "中身が %j の新しい wait.lock は held（pid は null）で、残り、待ち受けは動いていない扱い",
    async (content) => {
      const common = await tempDir();
      await mkdir(autoDir(common), { recursive: true });
      const lock = path.join(autoDir(common), "wait.lock");
      await writeFile(lock, content);
      expect(await acquireWaitLock(common)).toEqual({
        kind: "held",
        pid: null,
      });
      expect(await readFile(lock, "utf8")).toBe(content);
      expect(await waitState(common)).toEqual({ running: false, pid: null });
    },
  );

  it("外すとき、他人のロックに替わっていたら消さない", async () => {
    const common = await tempDir();
    const a = await acquireWaitLock(common);
    expect(a.kind).toBe("acquired");
    const lock = path.join(autoDir(common), "wait.lock");
    const other = `${process.pid + 1} ${currentBootAt()}\n`;
    await writeFile(lock, other);
    if (a.kind === "acquired") await a.release();
    expect(await readFile(lock, "utf8")).toBe(other);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "外すときの失敗は投げず、ロックのパスを含む警告を出す",
    async () => {
      const common = await tempDir();
      const a = await acquireWaitLock(common);
      expect(a.kind).toBe("acquired");
      const lock = path.join(autoDir(common), "wait.lock");
      const write = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      await chmod(autoDir(common), 0o555);
      try {
        if (a.kind === "acquired")
          await expect(a.release()).resolves.toBe(undefined);
        const warned = write.mock.calls.map((c) => String(c[0])).join("");
        expect(warned).toContain(lock);
      } finally {
        write.mockRestore();
        await chmod(autoDir(common), 0o755);
      }
    },
  );
});

function clock() {
  let ms = T0.getTime();
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(ms),
    sleep: async (n: number) => {
      sleeps.push(n);
      ms += n;
    },
  };
}

const deps = (
  common: string,
  active: string[],
  c = clock(),
  extra: Partial<WaitDeps> = {},
): WaitDeps => ({
  common,
  activeIds: async () => active,
  now: c.now,
  sleep: c.sleep,
  pollMs: 5000,
  maxWaitMs: 12 * 3600 * 1000,
  ...extra,
});

describe("waitForTurn", () => {
  it("古い番から1つ拾って印をつけ、同じ番を二度返さない", async () => {
    const common = await tempDir();
    await writeAuto(
      common,
      withTurn(
        newRecord("T12", T0),
        "integrate",
        new Date(T0.getTime() + 2000),
      ),
    );
    await writeAuto(common, withTurn(newRecord("T13", T0), "approve", T0));
    const c = clock();
    const d = deps(common, ["T12", "T13"], c, { maxWaitMs: 20000 });
    expect(await waitForTurn(d)).toMatchObject({ id: "T13", kind: "approve" });
    expect(await waitForTurn(d)).toMatchObject({
      id: "T12",
      kind: "integrate",
    });
    expect((await readAuto(common, "T13"))!.turn!.picked).toBe(true);
    // 番がもうない：待って、最長で null
    expect(await waitForTurn(d)).toBeNull();
    expect(c.sleeps.length).toBe(4);
  });

  it("番がなければ見直しを続け、あとから立った番を拾う", async () => {
    const common = await tempDir();
    await writeAuto(common, newRecord("T12", T0));
    const c = clock();
    let n = 0;
    const d = deps(common, ["T12"], c, {
      sleep: async (ms) => {
        await c.sleep(ms);
        if (++n === 3)
          await writeAuto(
            common,
            withTurn(newRecord("T12", T0), "approve", c.now()),
          );
      },
    });
    expect(await waitForTurn(d)).toMatchObject({ id: "T12" });
    expect(n).toBe(3);
  });

  it("作業中のおまかせのタスクがなければ、拾わず null", async () => {
    const common = await tempDir();
    const c = clock();
    expect(await waitForTurn(deps(common, ["T12"], c))).toBeNull();
    await writeAuto(common, withTurn(newRecord("T12", T0), "approve", T0));
    // T12 は作業中でない
    expect(await waitForTurn(deps(common, [], c))).toBeNull();
    expect((await readAuto(common, "T12"))!.turn!.picked).toBe(false);
    // おまかせを外したタスクの番は拾わない
    await writeAuto(
      common,
      withOff(withTurn(newRecord("T12", T0), "approve", T0), null, T0),
    );
    expect(await waitForTurn(deps(common, ["T12"], c))).toBeNull();
    expect(c.sleeps).toEqual([]);
  });

  it("作業中でないタスクの番は、ほかのタスクが作業中でも拾わない", async () => {
    const common = await tempDir();
    await writeAuto(common, withTurn(newRecord("T12", T0), "approve", T0));
    await writeAuto(common, newRecord("T13", T0));
    const c = clock();
    expect(
      await waitForTurn(deps(common, ["T13"], c, { maxWaitMs: 20000 })),
    ).toBeNull();
    // 待って見直した（T13 が作業中なので先に終わらない）
    expect(c.sleeps.length).toBeGreaterThan(0);
    expect((await readAuto(common, "T12"))!.turn!.picked).toBe(false);
  });

  it("12時間たったら拾わず null", async () => {
    const common = await tempDir();
    await writeAuto(common, newRecord("T12", T0));
    const c = clock();
    // 見直しの間隔を10分にして回数を減らす（最長の判定は間隔によらない）
    expect(
      await waitForTurn(deps(common, ["T12"], c, { pollMs: 600000 })),
    ).toBeNull();
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(12 * 3600 * 1000);
  });
});
