import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireConfig } from "../../src/config.ts";
import type { Runner } from "../../src/lib/exec.ts";
import {
  failedMainLine,
  launchMainCheck,
  mainCheckState,
  recordMerge,
  runMainCheck,
  shortCommit,
  unsentNoticeWarnings,
} from "../../src/lib/main-check.ts";
import { currentBootAt, parseLock, sameBoot } from "../../src/lib/lock.ts";
import { runCli } from "../helpers/fake-orca.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const checkDir = (root: string) =>
  path.join(root, ".git", "orca-flow", "main-check");

/** タスクのブランチを切ってコミットし、main に --no-ff でマージする。マージのコミットを返す */
async function mergeTask(
  root: string,
  id: string,
  files: Record<string, string>,
): Promise<string> {
  const branch = `task/${id}-x`;
  await git(root, "switch", "--quiet", "-c", branch);
  await writeFiles(root, files);
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", `${id}: 作る`);
  await git(root, "switch", "--quiet", "main");
  await git(
    root,
    "merge",
    "--no-ff",
    "--quiet",
    "-m",
    `統括役: ${id} をマージする`,
    branch,
  );
  return git(root, "rev-parse", "HEAD");
}

const head = (root: string) => git(root, "rev-parse", "HEAD");

describe("mainCheckState と recordMerge", () => {
  it("記録がなければ none、待ちの記録なら pending、同じ木なら passed", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    expect(await mainCheckState(testRunner, root, config)).toEqual({
      kind: "none",
    });
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await recordMerge(testRunner, root, config, {
      commit: m1,
      id: "T01",
      sameTree: false,
      commands: [],
      at: "2026-10-26T00:00:00.000Z",
    });
    expect(await mainCheckState(testRunner, root, config)).toEqual({
      kind: "pending",
      commit: m1,
    });
    const m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
    await recordMerge(testRunner, root, config, {
      commit: m2,
      id: "T02",
      sameTree: true,
      commands: ["true"],
      at: "2026-10-26T00:00:00.000Z",
    });
    // 先頭が通っていれば、その下の待ちは関係ない
    expect(await mainCheckState(testRunner, root, config)).toEqual({
      kind: "passed",
      commit: m2,
    });
    const saved = JSON.parse(
      await readFile(path.join(checkDir(root), `${m2}.json`), "utf8"),
    );
    expect(saved).toMatchObject({
      id: "T02",
      status: "passed",
      sameTree: true,
      commands: ["true"],
    });
  });

  it("プロセスのいない「確かめ中」は待ちと同じに扱う", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await recordMerge(testRunner, root, config, {
      commit: m1,
      id: "T01",
      sameTree: false,
      commands: [],
      at: "x",
    });
    const file = path.join(checkDir(root), `${m1}.json`);
    const record = JSON.parse(await readFile(file, "utf8"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({ ...record, status: "running", pid: 2_000_000_000 }),
    );
    expect((await mainCheckState(testRunner, root, config)).kind).toBe(
      "pending",
    );
    await writeFile(
      file,
      JSON.stringify({ ...record, status: "running", pid: process.pid }),
    );
    expect((await mainCheckState(testRunner, root, config)).kind).toBe(
      "running",
    );
  });

  it("落ちたあと、記録のない戻すコミットが先頭でも failed（原因の ID つき）", async () => {
    const root = await makeRepo({ verify: ["test ! -f BAD"] });
    const config = await requireConfig(root);
    await runCli(["main-check", "run"], { cwd: root, runner: testRunner });
    const m1 = await mergeTask(root, "T01", { BAD: "x\n" });
    await recordMerge(testRunner, root, config, {
      commit: m1,
      id: "T01",
      sameTree: false,
      commands: [],
      at: "x",
    });
    const run = await runCli(["main-check", "run"], {
      cwd: root,
      runner: testRunner,
    });
    expect(run.code).toBe(1);
    await git(root, "commit", "--quiet", "--allow-empty", "-m", "事前変更");
    const state = await mainCheckState(testRunner, root, config);
    expect(state).toMatchObject({
      kind: "failed",
      commit: m1,
      culprit: m1,
      culpritLabel: "T01",
      failedCommand: "test ! -f BAD",
    });
  });
});

describe("unsentNoticeWarnings", () => {
  it("状態がなければ空", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    expect(await unsentNoticeWarnings(testRunner, root, config)).toEqual([]);
  });
});

describe("launchMainCheck", () => {
  it("偽の Runner には、node で起動役を呼ぶ呼び出しが1回残る", async () => {
    const root = await makeRepo();
    const calls: { cmd: string; args: readonly string[]; cwd?: string }[] = [];
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "git") return testRunner(cmd, args, opts);
      calls.push({ cmd, args, cwd: opts?.cwd });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await launchMainCheck(runner, root);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args.join(" ")).toContain("orca-flow");
    expect(calls[0]!.args).toContain(root);
    expect(calls[0]!.cwd).toBe(root);
    // ログの置き場所は共通ディレクトリの下
    expect(calls[0]!.args.at(-1)).toContain(path.join(".git", "orca-flow"));
  });

  it("起動役が失敗したら日本語のエラー", async () => {
    const root = await makeRepo();
    const runner: Runner = async (cmd, args, opts) =>
      cmd === "git"
        ? testRunner(cmd, args, opts)
        : { code: 1, stdout: "", stderr: "だめ", timedOut: false };
    await expect(launchMainCheck(runner, root)).rejects.toThrow(
      "main の確かめを起動できませんでした",
    );
  });

  it(
    "本物の Runner では、数秒眠る子を起動して2秒以内に戻り、子があとで記録を書く",
    { timeout: 90_000 },
    async () => {
      const root = await makeRepo({ verify: ["sleep 3"] });
      const config = await requireConfig(root);
      const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
      await recordMerge(testRunner, root, config, {
        commit: m1,
        id: "T01",
        sameTree: false,
        commands: [],
        at: "x",
      });
      const started = Date.now();
      await launchMainCheck(testRunner, root);
      expect(Date.now() - started).toBeLessThan(2000);
      const file = path.join(checkDir(root), `${m1}.json`);
      const statusNow = JSON.parse(await readFile(file, "utf8")).status;
      expect(["pending", "running"]).toContain(statusNow);
      let status = statusNow;
      for (
        let i = 0;
        i < 300 &&
        status !== "passed" &&
        status !== "failed" &&
        status !== "unchecked";
        i++
      ) {
        await new Promise((r) => setTimeout(r, 200));
        status = JSON.parse(await readFile(file, "utf8")).status;
      }
      // 打ち切りまでに終わらなければ、run.log の中身を出して落ちる
      if (status !== "passed") {
        const log = await readFile(
          path.join(checkDir(root), "run.log"),
          "utf8",
        ).catch(() => "（run.log がありません）");
        throw new Error(
          `60秒待っても確かめが通りませんでした（状態：${status}）。run.log：\n${log}`,
        );
      }
      expect(status).toBe("passed");
      expect(await readdir(checkDir(root))).toContain("run.log");
    },
  );
});

const FAKE_PID = 2_000_000_000;

async function pendingMerge(root: string, id: string) {
  const config = await requireConfig(root);
  const commit = await mergeTask(root, id, { [`${id}.txt`]: "1\n" });
  await recordMerge(testRunner, root, config, {
    commit,
    id,
    sameTree: false,
    commands: [],
    at: "x",
  });
  return commit;
}

async function patchRecord(
  root: string,
  commit: string,
  patch: Record<string, unknown>,
) {
  const file = path.join(checkDir(root), `${commit}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...record, ...patch }));
}

describe("落ちた記録の上に確かめ中・待ちがあるとき（C4）", () => {
  it("下の最初の結果が落ちたなら、落ちた扱いで、上のコミットを添える", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const m1 = await pendingMerge(root, "T01");
    await patchRecord(root, m1, {
      status: "failed",
      culprit: m1,
      culpritLabel: "T01",
      failedCommand: "pnpm test",
    });
    const m2 = await pendingMerge(root, "T02");
    expect(await mainCheckState(testRunner, root, config)).toMatchObject({
      kind: "failed",
      commit: m1,
      cause: "known",
      culprit: m1,
      above: { kind: "pending", commit: m2 },
    });
    await patchRecord(root, m2, { status: "running", pid: process.pid });
    expect(await mainCheckState(testRunner, root, config)).toMatchObject({
      kind: "failed",
      above: { kind: "running", commit: m2 },
    });
  });

  it("下が通っていれば、今までどおり確かめ中・待ちを返す", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const m1 = await pendingMerge(root, "T01");
    await patchRecord(root, m1, { status: "passed" });
    const m2 = await pendingMerge(root, "T02");
    expect(await mainCheckState(testRunner, root, config)).toEqual({
      kind: "pending",
      commit: m2,
    });
  });
});

describe("確かめられなかったの下の結果（R10）", () => {
  it("下が落ちていれば落ちた扱いで、上の確かめられなかったコミットを添える", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const m1 = await pendingMerge(root, "T01");
    await patchRecord(root, m1, {
      status: "failed",
      culprit: m1,
      culpritLabel: "T01",
      failedCommand: "pnpm test",
    });
    const m2 = await pendingMerge(root, "T02");
    await patchRecord(root, m2, { status: "unchecked" });
    expect(await mainCheckState(testRunner, root, config)).toMatchObject({
      kind: "failed",
      commit: m1,
      above: { kind: "unchecked", commit: m2 },
    });
  });

  it("下が通っていれば、今までどおり unchecked を返す", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const m1 = await pendingMerge(root, "T01");
    await patchRecord(root, m1, { status: "passed" });
    const m2 = await pendingMerge(root, "T02");
    await patchRecord(root, m2, { status: "unchecked" });
    expect(await mainCheckState(testRunner, root, config)).toMatchObject({
      kind: "unchecked",
      commit: m2,
    });
  });
});

describe("確かめられなかった・原因を探している間", () => {
  it("先頭が「確かめられなかった」なら unchecked（止めない状態）", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const m1 = await pendingMerge(root, "T01");
    await patchRecord(root, m1, {
      status: "unchecked",
      failedCommand: "bash .orca-flow/setup.sh",
      logPath: "/tmp/x.log",
    });
    expect(await mainCheckState(testRunner, root, config)).toEqual({
      kind: "unchecked",
      commit: m1,
      logPath: "/tmp/x.log",
      failedCommand: "bash .orca-flow/setup.sh",
      reason: "prep",
    });
  });

  it("探している間は原因を書かず searching、探すプロセスがいなければ stalled、分からなければ unknown", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const m1 = await pendingMerge(root, "T01");
    await patchRecord(root, m1, {
      status: "failed",
      failedCommand: "pnpm test",
      searching: true,
      pid: process.pid,
      bootAt: currentBootAt(),
    });
    const searching = await mainCheckState(testRunner, root, config);
    expect(searching).toMatchObject({
      kind: "failed",
      cause: "searching",
      culprit: null,
      culpritLabel: null,
    });
    expect(failedMainLine(searching as never)).not.toContain(shortCommit(m1));
    await patchRecord(root, m1, { pid: FAKE_PID });
    expect(await mainCheckState(testRunner, root, config)).toMatchObject({
      cause: "stalled",
      culprit: null,
    });
    await patchRecord(root, m1, {
      searching: false,
      pid: null,
      causeUnknown: true,
    });
    expect(await mainCheckState(testRunner, root, config)).toMatchObject({
      cause: "unknown",
      culprit: null,
    });
  });
});

describe("再起動のあとのロックと確かめ中（O5）", () => {
  it("起動の時刻の比べ方：幅の中は同じ、遠ければ違う、書いてなければ同じ", () => {
    expect(sameBoot(null)).toBe(true);
    expect(sameBoot(currentBootAt() + 5)).toBe(true);
    expect(sameBoot(currentBootAt() - 3600)).toBe(false);
    expect(parseLock("123\n")).toEqual({ pid: 123, bootAt: null });
    expect(parseLock("123 1761800000\n")).toEqual({
      pid: 123,
      bootAt: 1761800000,
    });
  });

  it("起動の時刻が違う確かめ中は、プロセスの番号が生きていても待ちとして扱う", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const m1 = await pendingMerge(root, "T01");
    await patchRecord(root, m1, {
      status: "running",
      pid: process.pid,
      bootAt: currentBootAt() - 3600,
    });
    expect((await mainCheckState(testRunner, root, config)).kind).toBe(
      "pending",
    );
    await patchRecord(root, m1, { bootAt: currentBootAt() });
    expect((await mainCheckState(testRunner, root, config)).kind).toBe(
      "running",
    );
  });

  const deps = async (root: string) => ({
    runner: testRunner,
    cwd: root,
    config: await requireConfig(root),
    stdout: () => {},
    stderr: () => {},
    now: () => new Date(),
  });

  it("ロックの起動の時刻が違えば、番号が生きていても古いロックとして取り直す", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(checkDir(root), { recursive: true });
    await writeFile(
      path.join(checkDir(root), "run.lock"),
      `${process.pid} ${currentBootAt() - 3600}\n`,
    );
    const result = await runMainCheck(await deps(root), root);
    expect(result.kind).toBe("done");
  });

  it("番号だけの古い形のロックは、生きているプロセスなら取らない", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(checkDir(root), { recursive: true });
    const lock = path.join(checkDir(root), "run.lock");
    await writeFile(lock, `${process.pid}\n`);
    const result = await runMainCheck(await deps(root), root);
    expect(result).toEqual({
      kind: "locked",
      lockPath: lock,
      pid: process.pid,
    });
  });

  it("中身が空の新しい run.lock は持ち主ありとして locked（pid は null）を返し、ロックは残る", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(checkDir(root), { recursive: true });
    const lock = path.join(checkDir(root), "run.lock");
    await writeFile(lock, "");
    const result = await runMainCheck(await deps(root), root);
    expect(result).toEqual({ kind: "locked", lockPath: lock, pid: null });
    expect(await readFile(lock, "utf8")).toBe("");
  });

  it("外すとき、他人のロックに替わっていたら消さない", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const lock = path.join(checkDir(root), "run.lock");
    const other = `${process.pid + 1} ${currentBootAt()}\n`;
    let swapped = false;
    const runner: Runner = async (cmd, args, opts) => {
      const result = await testRunner(cmd, args, opts);
      if (!swapped && existsSync(lock)) {
        swapped = true;
        await writeFile(lock, other);
      }
      return result;
    };
    const result = await runMainCheck({ ...(await deps(root)), runner }, root);
    expect(result.kind).toBe("done");
    expect(swapped).toBe(true);
    expect(await readFile(lock, "utf8")).toBe(other);
  });

  it("外すのに失敗しても結果を上書きせず、ロックのパスだけを警告する（結果を残したとは言わない）", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const lock = path.join(checkDir(root), "run.lock");
    let swapped = false;
    const runner: Runner = async (cmd, args, opts) => {
      const result = await testRunner(cmd, args, opts);
      if (!swapped && existsSync(lock)) {
        // ロックをディレクトリに替え、外すときの読み込みを失敗させる（chmod に頼らない）
        swapped = true;
        await rm(lock);
        await mkdir(lock);
      }
      return result;
    };
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const result = await runMainCheck(
        { ...(await deps(root)), runner },
        root,
      );
      expect(result.kind).toBe("done");
      expect(swapped).toBe(true);
      const warned = write.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).toContain(lock);
      expect(warned).toContain("main の確かめのロックを外せませんでした");
      expect(warned).not.toContain("確かめの結果は残してあります");
    } finally {
      write.mockRestore();
    }
  });
});

describe("ロックを持っている間に入ったマージ（新2）", () => {
  it("ロックを離したあとの読み直しで拾って、同じ run の中で確かめる", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const config = await requireConfig(root);
    const m1 = await pendingMerge(root, "T01");
    let revParses = 0;
    let m2 = "";
    const runner: Runner = async (cmd, args, opts) => {
      const result = await testRunner(cmd, args, opts);
      // run の内側の「確かめ直す前に main が進んだか」を読んだあと、ロックを離す前に新しいマージを入れる
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "main") {
        revParses++;
        if (revParses === 2) m2 = await pendingMerge(root, "T02");
      }
      return result;
    };
    const result = await runMainCheck(
      {
        runner,
        cwd: root,
        config,
        stdout: () => {},
        stderr: () => {},
        now: () => new Date(),
      },
      root,
    );
    expect(result.kind).toBe("done");
    expect(m2).not.toBe("");
    const rec = async (c: string) =>
      JSON.parse(
        await readFile(path.join(checkDir(root), `${c}.json`), "utf8"),
      );
    expect((await rec(m1)).status).toBe("passed");
    expect(["passed", "skipped"]).toContain((await rec(m2)).status);
    expect(await readdir(checkDir(root))).not.toContain("run.lock");
  });
});

describe("落ちた main の文の短いコミット", () => {
  it("桁は shortCommit で1つ", () => {
    expect(shortCommit("a".repeat(40))).toHaveLength(8);
    expect(
      failedMainLine({
        kind: "failed",
        commit: "f".repeat(40),
        culprit: "a".repeat(40),
        culpritLabel: "T01",
        failedCommand: "x",
        cause: "known",
      }),
    ).toContain(`（${"a".repeat(8)}）`);
  });
});
