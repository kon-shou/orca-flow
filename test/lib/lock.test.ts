import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FlowError } from "../../src/types.ts";
import {
  LOCK_FRESH_MS,
  acquireLock,
  currentBootAt,
  holderAlive,
  parseLock,
  parseLockKind,
  releaseOrWarn,
  sameBoot,
  type LockOptions,
} from "../../src/lib/lock.ts";
import { tempDir } from "../helpers/repo.ts";

const options: LockOptions = {
  waitMs: 0,
  maxAttempts: 3,
  failed: (lock, detail) => `ロックで失敗（${lock}：${detail}）`,
};

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

async function lockPath(): Promise<string> {
  const dir = await tempDir();
  await mkdir(dir, { recursive: true });
  return path.join(dir, "x.lock");
}

async function age(file: string, ms: number): Promise<void> {
  const t = new Date(Date.now() - ms);
  await utimes(file, t, t);
}

describe("読み取り", () => {
  it("番号と起動の時刻を読む。番号だけの古い形も読む", () => {
    expect(parseLock("123 1761800000\n")).toEqual({
      pid: 123,
      bootAt: 1761800000,
    });
    expect(parseLock("123\n")).toEqual({ pid: 123, bootAt: null });
    expect(Number.isNaN(parseLock("").pid)).toBe(true);
  });

  it("起動の時刻と生死", () => {
    expect(sameBoot(null)).toBe(true);
    expect(sameBoot(currentBootAt() - 3600)).toBe(false);
    expect(holderAlive(process.pid, currentBootAt())).toBe(true);
    expect(holderAlive(process.pid, currentBootAt() - 3600)).toBe(false);
    expect(holderAlive(deadPid(), null)).toBe(false);
  });
});

describe("持ち主の種類", () => {
  it("3つめの語が種類。古い形・読めない形は null", () => {
    expect(parseLockKind("123 1761800000 integrate\n")).toBe("integrate");
    expect(parseLockKind("123 1761800000\n")).toBeNull();
    expect(parseLockKind("123\n")).toBeNull();
    expect(parseLockKind("")).toBeNull();
    // 種類があっても番号と起動の時刻は同じに読める
    expect(parseLock("123 1761800000 integrate\n")).toEqual({
      pid: 123,
      bootAt: 1761800000,
    });
  });

  it("kind を渡すとロックに書き、取れなかった側に held で返す。外すと消える", async () => {
    const lock = await lockPath();
    const got = await acquireLock(lock, { ...options, kind: "approve" });
    expect(got.kind).toBe("acquired");
    expect(await readFile(lock, "utf8")).toBe(
      `${process.pid} ${currentBootAt()} approve\n`,
    );
    expect(await acquireLock(lock, { ...options, kind: "new" })).toEqual({
      kind: "held",
      lockPath: lock,
      pid: process.pid,
      holderKind: "approve",
    });
    if (got.kind === "acquired") await got.release();
    await expect(stat(lock)).rejects.toThrow();
  });

  it("種類のない古いロックを持ち主が持っていても、held に holderKind は付かない", async () => {
    const lock = await lockPath();
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    const got = await acquireLock(lock, { ...options, kind: "new" });
    expect(got.kind).toBe("held");
    expect("holderKind" in got).toBe(false);
  });

  it("種類を書いたロックでも、生きていなければ取り直す", async () => {
    const lock = await lockPath();
    await writeFile(lock, `${deadPid()} ${currentBootAt()} integrate\n`);
    expect((await acquireLock(lock, options)).kind).toBe("acquired");
  });
});

describe("acquireLock", () => {
  it("取れて、自分の中身を書き、外すと消える", async () => {
    const lock = await lockPath();
    const got = await acquireLock(lock, options);
    expect(got.kind).toBe("acquired");
    expect(await readFile(lock, "utf8")).toBe(
      `${process.pid} ${currentBootAt()}\n`,
    );
    if (got.kind === "acquired") await got.release();
    await expect(stat(lock)).rejects.toThrow();
  });

  it("生きていないプロセスのロックは取り直す", async () => {
    const lock = await lockPath();
    await writeFile(lock, `${deadPid()} ${currentBootAt()}\n`);
    expect((await acquireLock(lock, options)).kind).toBe("acquired");
  });

  it("再起動より前のロックは取り直す", async () => {
    const lock = await lockPath();
    await writeFile(lock, `${process.pid} ${currentBootAt() - 100000}\n`);
    expect((await acquireLock(lock, options)).kind).toBe("acquired");
  });

  it("生きているプロセスのロックは取らない。番号だけの古い形も同じ", async () => {
    const lock = await lockPath();
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    expect(await acquireLock(lock, options)).toEqual({
      kind: "held",
      lockPath: lock,
      pid: process.pid,
    });
    await writeFile(lock, `${process.pid}\n`);
    expect(await acquireLock(lock, options)).toMatchObject({
      kind: "held",
      pid: process.pid,
    });
  });

  it.each(["", "garbage\n"])(
    "中身が %j のロックは、新しい間は取らず、古ければ取り直す",
    async (content) => {
      const lock = await lockPath();
      await writeFile(lock, content);
      expect(await acquireLock(lock, options)).toEqual({
        kind: "held",
        lockPath: lock,
        pid: null,
      });
      expect(await readFile(lock, "utf8")).toBe(content);
      await age(lock, LOCK_FRESH_MS + 1000);
      expect((await acquireLock(lock, options)).kind).toBe("acquired");
    },
  );

  it("外すとき、中身が自分の書いたものでなければ消さない", async () => {
    const lock = await lockPath();
    const got = await acquireLock(lock, options);
    expect(got.kind).toBe("acquired");
    await writeFile(lock, `${process.pid + 1} ${currentBootAt()}\n`);
    if (got.kind === "acquired") await got.release();
    expect(await readFile(lock, "utf8")).toBe(
      `${process.pid + 1} ${currentBootAt()}\n`,
    );
  });

  it("外すときにすでにない場合は何もしない", async () => {
    const lock = await lockPath();
    const got = await acquireLock(lock, options);
    expect(got.kind).toBe("acquired");
    const { rm } = await import("node:fs/promises");
    await rm(lock);
    if (got.kind === "acquired")
      await expect(got.release()).resolves.toBe(undefined);
  });

  it("待つ長さの間は待ち、持ち主が外せば取れる", async () => {
    const lock = await lockPath();
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    setTimeout(() => {
      void import("node:fs/promises").then((m) => m.rm(lock));
    }, 150);
    const got = await acquireLock(lock, {
      waitMs: 3000,
      pollMs: 20,
      failed: options.failed,
    });
    expect(got.kind).toBe("acquired");
  });

  it("待っても取れなければ held を返す", async () => {
    const lock = await lockPath();
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    const started = Date.now();
    const got = await acquireLock(lock, {
      waitMs: 200,
      pollMs: 20,
      failed: options.failed,
    });
    expect(got.kind).toBe("held");
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it("ロックのパスがディレクトリなら、回り続けずにパスを含む FlowError(1)", async () => {
    const lock = await lockPath();
    await mkdir(lock);
    const error = await acquireLock(lock, {
      waitMs: 60_000,
      failed: options.failed,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowError);
    expect((error as FlowError).code).toBe(1);
    expect((error as FlowError).message).toContain(lock);
  });

  it("書けない（親がない）ときも、パスを含む FlowError(1)", async () => {
    const lock = path.join(await tempDir(), "no", "such", "x.lock");
    const error = await acquireLock(lock, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowError);
    expect((error as FlowError).message).toContain(lock);
  });

  const isRoot = process.getuid?.() === 0 || process.platform === "win32";

  it.skipIf(isRoot)(
    "古いロックを消せない（親が書けない）ときは、パスを含む FlowError(1)",
    async () => {
      const lock = await lockPath();
      await writeFile(lock, `${deadPid()} ${currentBootAt()}\n`);
      const dir = path.dirname(lock);
      await chmod(dir, 0o555);
      try {
        const error = await acquireLock(lock, options).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FlowError);
        expect((error as FlowError).code).toBe(1);
        expect((error as FlowError).message).toContain(lock);
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  it.skipIf(isRoot)(
    "外すときの失敗は release が FlowError(1) で投げ、releaseOrWarn は投げずに警告を出す",
    async () => {
      const lock = await lockPath();
      const got = await acquireLock(lock, {
        ...options,
        releaseFailed: (file, detail) => `外せない（${file}：${detail}）`,
      });
      expect(got.kind).toBe("acquired");
      if (got.kind !== "acquired") return;
      const dir = path.dirname(lock);
      const write = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      await chmod(dir, 0o555);
      try {
        const error = await got.release().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FlowError);
        expect((error as FlowError).message).toContain("外せない");
        expect((error as FlowError).message).toContain(lock);
        await expect(releaseOrWarn(got.release)).resolves.toBe(undefined);
        const warned = write.mock.calls.map((c) => String(c[0])).join("");
        expect(warned).toContain(lock);
      } finally {
        write.mockRestore();
        await chmod(dir, 0o755);
      }
    },
  );
});

describe("写しが残っていない", () => {
  const lib = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "lib",
  );
  it.each(["merge-order.ts", "main-check.ts", "auto.ts"])(
    "%s にロックを wx で作る処理と中身を読む関数の定義がない",
    async (name) => {
      const text = await readFile(path.join(lib, name), "utf8");
      expect(text).not.toMatch(/flag:\s*["']wx["']/);
      expect(text).not.toMatch(/function\s+parseLock|const\s+parseLock/);
      expect(text).not.toMatch(
        /from\s+["']\.\/main-check\.ts["'][^;]*parseLock/,
      );
    },
  );
});
