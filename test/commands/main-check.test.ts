import {
  mkdir,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireConfig } from "../../src/config.ts";
import {
  mainCheckState,
  recordMerge,
  type MainCheckRecord,
} from "../../src/lib/main-check.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";
import { bashScreen, fakeOrca, runCli } from "../helpers/fake-orca.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { testRunner } from "../helpers/runner.ts";

const checkDir = (root: string) =>
  path.join(root, ".git", "orca-flow", "main-check");

const readRec = async (root: string, commit: string) =>
  JSON.parse(
    await readFile(path.join(checkDir(root), `${commit}.json`), "utf8"),
  ) as MainCheckRecord;

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

const pending = async (root: string, commit: string, id: string) =>
  recordMerge(testRunner, root, await requireConfig(root), {
    commit,
    id,
    sameTree: false,
    commands: [],
    at: "2026-10-26T00:00:00.000Z",
  });

const run = (root: string, runner = fakeOrca().runner) =>
  runCli(["main-check", "run"], { cwd: root, runner });

describe("main-check run", () => {
  it("確かめ用の worktree を作り、setup.sh とコマンドを流して、通れば「通った」", async () => {
    const root = await makeRepo(
      { verify: ["test -f .setup-ran", "test -f a.txt"] },
      { ".orca-flow/setup.sh": "touch .setup-ran\n" },
    );
    await git(root, "add", "-A");
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    const result = await run(root);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const record = await readRec(root, m1);
    expect(record).toMatchObject({
      status: "passed",
      id: "T01",
      commands: ["test -f .setup-ran", "test -f a.txt"],
      failedCommand: null,
    });
    expect(record.logPath).toContain(checkDir(root));
    expect((await stat(path.join(checkDir(root), "tree"))).isDirectory()).toBe(
      true,
    );
    // git worktree list には載らない（Orca のサイドバーに出ない）
    expect(
      (await git(root, "worktree", "list", "--porcelain"))
        .split("\n")
        .filter((l) => l.startsWith("worktree ")),
    ).toEqual([`worktree ${(await realpath(root)).replaceAll("\\", "/")}`]);
    // 作業ツリーには何も書かない
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(
      await git(path.join(checkDir(root), "tree"), "rev-parse", "HEAD"),
    ).toBe(m1);
  });

  it("落ちたら「落ちた」と出力の終わりを記録し、終了コード1で原因を出す", async () => {
    const root = await makeRepo({
      verify: ["echo 準備; echo だめでした >&2; exit 3"],
    });
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("T01");
    expect(result.err).toContain(m1.slice(0, 8));
    expect(result.err).toContain("exit 3");
    expect(result.err).toContain("だめでした");
    const record = await readRec(root, m1);
    expect(record.status).toBe("failed");
    expect(record.failedCommand).toBe("echo 準備; echo だめでした >&2; exit 3");
    expect(record.tail).toContain("だめでした");
    expect(record.culprit).toBe(m1);
    const log = await readFile(record.logPath!, "utf8");
    expect(log).toContain("だめでした");
  });

  it("最後に通ったコミットからの差がテストに関係しない場所だけなら、流さず「飛ばした」", async () => {
    const mark = path.join(await tempDir(), "count");
    const root = await makeRepo({
      verify: [`echo x >> ${mark}`],
      verifySkipPaths: ["docs/"],
    });
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    expect((await run(root)).code).toBe(0);
    const m2 = await mergeTask(root, "T02", { "docs/a.md": "1\n" });
    await pending(root, m2, "T02");
    const result = await run(root);
    expect(result.code).toBe(0);
    expect((await readRec(root, m2)).status).toBe("skipped");
    expect((await readFile(mark, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("3つのマージのうち2つ目で落ちるとき、二分探索で2つ目を原因として記録する", async () => {
    const root = await makeRepo({ verify: ["test ! -f BAD"] });
    expect((await run(root)).code).toBe(0);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    const m2 = await mergeTask(root, "T02", { BAD: "x\n" });
    const m3 = await mergeTask(root, "T03", { "c.txt": "1\n" });
    for (const [c, id] of [
      [m1, "T01"],
      [m2, "T02"],
      [m3, "T03"],
    ] as const)
      await pending(root, c, id);
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("T02");
    expect((await readRec(root, m3)).culprit).toBe(m2);
    expect((await readRec(root, m3)).culpritLabel).toBe("T02");
    expect((await readRec(root, m2)).status).toBe("failed");
    expect((await readRec(root, m1)).status).toBe("passed");
    const state = await mainCheckState(
      testRunner,
      root,
      await requireConfig(root),
    );
    expect(state).toMatchObject({
      kind: "failed",
      culprit: m2,
      culpritLabel: "T02",
    });
  });

  it("マージでないコミット（戻すコミット）も first-parent の1つとして確かめ、戻せば通る", async () => {
    const root = await makeRepo({ verify: ["test ! -f BAD"] });
    expect((await run(root)).code).toBe(0);
    const m1 = await mergeTask(root, "T01", { BAD: "x\n" });
    await pending(root, m1, "T01");
    expect((await run(root)).code).toBe(1);
    await git(root, "revert", "--no-edit", "-m", "1", m1);
    const revert = await git(root, "rev-parse", "HEAD");
    expect(await run(root)).toMatchObject({ code: 0 });
    const record = await readRec(root, revert);
    expect(record.id).toBeNull();
    expect(record.subject).toContain("Revert");
    expect(["passed", "skipped"]).toContain(record.status);
    expect(
      (await mainCheckState(testRunner, root, await requireConfig(root))).kind,
    ).toBe("passed");
  });

  it("確かめの途中で main が進んだら、終わったあと新しい先頭も確かめる", async () => {
    const root = await makeRepo({});
    const guard = path.join(await tempDir(), "advanced");
    await writeFile(
      path.join(root, ".orca-flow", "config.json"),
      JSON.stringify({
        verify: [
          `test -f ${guard} || (touch ${guard} && git -C ${root} commit --quiet --allow-empty -m 途中で進む)`,
        ],
      }),
    );
    await git(root, "commit", "--quiet", "-am", "設定を直す");
    const first = await git(root, "rev-parse", "HEAD");
    const result = await run(root);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const second = await git(root, "rev-parse", "HEAD");
    expect(second).not.toBe(first);
    expect((await readRec(root, first)).status).toBe("passed");
    expect((await readRec(root, second)).status).toMatch(/passed|skipped/);
  });

  it("ロックが生きていれば終了コード2、プロセスのいない古いロックは取り直す", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const dir = checkDir(root);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "run.lock"), `${process.pid}\n`);
    const blocked = await run(root);
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain("別のプロセス");
    expect(blocked.err).toContain(path.join(dir, "run.lock"));
    expect(blocked.err).toContain(String(process.pid));
    expect(blocked.err).toContain("そのプロセスがいなければ");
    const dead = await testRunner("sh", ["-c", "echo $$"]);
    await writeFile(path.join(dir, "run.lock"), dead.stdout);
    const result = await run(root);
    expect(result.code).toBe(0);
    expect(await readdir(dir)).not.toContain("run.lock");
  });
});

/** git checkout の呼び出しを数え、指定があれば失敗させる Runner */
function checkoutRunner(options: {
  failWhen?: (args: readonly string[], n: number) => boolean;
}) {
  const calls = { checkouts: 0, clones: 0 };
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "git" && args[0] === "clone") calls.clones++;
    if (cmd === "git" && args[0] === "checkout" && args.includes("--detach")) {
      calls.checkouts++;
      if (options.failWhen?.(args, calls.checkouts))
        return {
          code: 1,
          stdout: "",
          stderr: "checkout が壊れた",
          timedOut: false,
        };
    }
    return testRunner(cmd, args, opts);
  };
  return { runner, calls };
}

describe("確かめの場所（クローン）", () => {
  it("使い回す：2回目は作業ツリーを作り直さず、そのコミットに切り替える", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const { runner, calls } = checkoutRunner({});
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    expect((await run(root, runner)).code).toBe(0);
    await writeFile(path.join(checkDir(root), "tree", "mark"), "x");
    const m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
    await pending(root, m2, "T02");
    expect((await run(root, runner)).code).toBe(0);
    // 作り直されていない：1回目に置いた印が残っている
    expect(
      await readFile(path.join(checkDir(root), "tree", "mark"), "utf8"),
    ).toBe("x");
    expect(calls.checkouts).toBeGreaterThanOrEqual(2);
    expect(
      await git(path.join(checkDir(root), "tree"), "rev-parse", "HEAD"),
    ).toBe(m2);
  });

  it("前からある確かめ用の worktree は片付けられ、git worktree list から消える", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const old = path.join(checkDir(root), "worktree");
    await mkdir(checkDir(root), { recursive: true });
    await git(root, "worktree", "add", "--detach", "--quiet", old, "HEAD");
    await writeFile(path.join(old, "mark.txt"), "x");
    expect(await git(root, "worktree", "list")).toContain("worktree");
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    expect((await run(root)).code).toBe(0);
    await expect(stat(old)).rejects.toThrow();
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(
      "main-check",
    );
  });
});

describe("確かめ用の作業ツリーで init の setup.sh が流れる（R2）", () => {
  it("雛形の setup.sh が「準備はしません」で終わらず、.worktreeinclude のファイルがコピーされ、依存の導入の行も流れる", async () => {
    const template = await readFile(
      path.join(import.meta.dirname, "../../templates/setup.sh"),
      "utf8",
    );
    expect(template).toContain("# orca-flow:install");
    const setup = template.replace("# orca-flow:install", "touch .installed");
    const root = await makeRepo(
      { verify: ["test -f .installed", "test -f secret.env"] },
      {
        ".orca-flow/setup.sh": setup,
        ".worktreeinclude": "secret.env\n",
        ".gitignore": "secret.env\n.installed\n",
        "secret.env": "秘密\n",
      },
    );
    await git(root, "add", "-A");
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    const result = await run(root);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const record = await readRec(root, m1);
    expect(record.status).toBe("passed");
    const log = await readFile(record.logPath!, "utf8");
    expect(log).not.toContain("準備はしません");
    expect(log).toContain(
      "メインのチェックアウトからコピーしました：secret.env",
    );
    expect(
      await readFile(path.join(checkDir(root), "tree", "secret.env"), "utf8"),
    ).toBe("秘密\n");
    expect(
      (await git(root, "worktree", "list", "--porcelain"))
        .split("\n")
        .filter((l) => l.startsWith("worktree ")),
    ).toEqual([`worktree ${(await realpath(root)).replaceAll("\\", "/")}`]);
    // 作業ツリーに書くだけで、メインの作業ツリーは汚れない
    expect(await git(root, "status", "--porcelain")).toBe("");
  });
});

describe("準備の失敗は「落ちた」にしない（O3）", () => {
  it("checkout が1回失敗しても、作業ツリーを作り直して流し、「通った」になる", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    const { runner, calls } = checkoutRunner({
      failWhen: (_a, n) => n === 1,
    });
    const result = await run(root, runner);
    expect(result.code).toBe(0);
    expect((await readRec(root, m1)).status).toBe("passed");
    expect(calls.checkouts).toBe(2);
  });

  it("作り直しても失敗するなら「確かめられなかった」で、二分探索をせず、知らせも送らない", async () => {
    const root = await makeRepo({ verify: ["true"] });
    expect((await run(root)).code).toBe(0);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    const m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
    await pending(root, m1, "T01");
    await pending(root, m2, "T02");
    const orca = fakeOrca();
    const other = await addTaskWorktree(root, "T13", "other");
    orca.terminals.push({
      handle: "term_t13",
      worktreePath: other.path,
      agentIdentity: "claude",
    });
    const { runner, calls } = checkoutRunner({
      failWhen: (args) => args.includes(m2),
    });
    const wrapped: Runner = (cmd, args, opts) =>
      cmd === "orca" ? orca.runner(cmd, args, opts) : runner(cmd, args, opts);
    const result = await run(root, wrapped);
    expect(result.code).toBe(1);
    expect(result.err).toContain("確かめができませんでした");
    const record = await readRec(root, m2);
    expect(record.status).toBe("unchecked");
    expect(record.culprit).toBeNull();
    expect(calls.checkouts).toBe(2);
    await expect(readRec(root, m1)).resolves.toMatchObject({
      status: "pending",
    });
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    expect(
      await mainCheckState(testRunner, root, await requireConfig(root)),
    ).toMatchObject({ kind: "unchecked", commit: m2 });
    const list = await runCli(["main-check"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(list.out).toContain("確かめられなかった");
  });

  it("setup.sh が落ちたら「確かめられなかった」で、ログのパスがある", async () => {
    const marker = path.join(await tempDir(), "ok");
    const root = await makeRepo(
      { verify: ["true"] },
      { ".orca-flow/setup.sh": `test -f ${marker}\n` },
    );
    await git(root, "add", "-A");
    expect((await run(root)).code).toBe(1);
    const head = await git(root, "rev-parse", "HEAD");
    const record = await readRec(root, head);
    expect(record.status).toBe("unchecked");
    expect(record.failedCommand).toBe("bash .orca-flow/setup.sh");
    expect(record.logPath).toContain(checkDir(root));
  });

  it("「確かめられなかった」は通ったとして数えず、もう一度確かめる", async () => {
    const marker = path.join(await tempDir(), "ok");
    const root = await makeRepo(
      { verify: ["true"], verifySkipPaths: ["docs/"] },
      { ".orca-flow/setup.sh": `test -f ${marker}\n` },
    );
    // 最後に通ったコミットを作る
    await writeFile(marker, "");
    expect((await run(root)).code).toBe(0);
    await rm(marker);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    expect((await run(root)).code).toBe(1);
    expect((await readRec(root, m1)).status).toBe("unchecked");
    // 直ったら同じコミットを流し直す（「すでに確かめ済み」にならない）
    await writeFile(marker, "");
    const again = await run(root);
    expect(again.code).toBe(0);
    expect((await readRec(root, m1)).status).toBe("passed");
    // 通っていない m1 を基点にせず、docs だけの m2 でも m1 の変更を含めて流す
    await rm(path.join(checkDir(root), `${m1}.json`));
    await pending(root, m1, "T01");
    await patchStatus(root, m1, "unchecked");
    const m2 = await mergeTask(root, "T02", { "docs/a.md": "1\n" });
    await pending(root, m2, "T02");
    expect((await run(root)).code).toBe(0);
    expect((await readRec(root, m2)).status).toBe("passed");
  });
});

async function patchStatus(root: string, commit: string, status: string) {
  const file = path.join(checkDir(root), `${commit}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...record, status }));
}

describe("原因を探している間・分からないとき（O4）", () => {
  it("探している間の先頭は、原因を書かない落ちた（searching）", async () => {
    const root = await makeRepo({ verify: ["test ! -f BAD"] });
    expect((await run(root)).code).toBe(0);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    const m2 = await mergeTask(root, "T02", { BAD: "x\n" });
    const m3 = await mergeTask(root, "T03", { "c.txt": "1\n" });
    for (const [c, id] of [
      [m1, "T01"],
      [m2, "T02"],
      [m3, "T03"],
    ] as const)
      await pending(root, c, id);
    const config = await requireConfig(root);
    const seen: Awaited<ReturnType<typeof mainCheckState>>[] = [];
    const runner: Runner = async (cmd, args, opts) => {
      if (
        cmd === "git" &&
        args[0] === "checkout" &&
        !args.includes(m3) &&
        seen.length === 0
      )
        seen.push(await mainCheckState(testRunner, root, config));
      return testRunner(cmd, args, opts);
    };
    expect((await run(root, runner)).code).toBe(1);
    expect(seen[0]).toMatchObject({
      kind: "failed",
      cause: "searching",
      culprit: null,
    });
    expect(await mainCheckState(testRunner, root, config)).toMatchObject({
      cause: "known",
      culprit: m2,
    });
  });

  it("二分探索の途中のコミットが確かめられなければ、原因を決めずに終わる", async () => {
    const root = await makeRepo({ verify: ["test ! -f BAD"] });
    expect((await run(root)).code).toBe(0);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    const m2 = await mergeTask(root, "T02", { BAD: "x\n" });
    const m3 = await mergeTask(root, "T03", { "c.txt": "1\n" });
    for (const [c, id] of [
      [m1, "T01"],
      [m2, "T02"],
      [m3, "T03"],
    ] as const)
      await pending(root, c, id);
    const { runner } = checkoutRunner({ failWhen: (a) => a.includes(m1) });
    const result = await run(root, runner);
    expect(result.code).toBe(1);
    const head = await readRec(root, m3);
    expect(head.status).toBe("failed");
    expect(head.culprit).toBeNull();
    expect(head.causeUnknown).toBe(true);
    expect(
      await mainCheckState(testRunner, root, await requireConfig(root)),
    ).toMatchObject({ kind: "failed", cause: "unknown", culprit: null });
  });

  it("環境が壊れてどのコミットも落ちるとき、原因の1つ前を流し直して落ち、先頭は「確かめられなかった」で原因を書かない", async () => {
    const marker = path.join(await tempDir(), "env-ok");
    await writeFile(marker, "");
    const root = await makeRepo({ verify: [`test -f ${marker}`] });
    expect((await run(root)).code).toBe(0);
    await rm(marker);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    const m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
    await pending(root, m1, "T01");
    await pending(root, m2, "T02");
    const result = await run(root);
    expect(result.code).toBe(1);
    const head = await readRec(root, m2);
    expect(head.status).toBe("unchecked");
    expect(head.culprit).toBeNull();
    expect(head.culpritLabel).toBeNull();
    expect(
      await mainCheckState(testRunner, root, await requireConfig(root)),
    ).toMatchObject({ kind: "unchecked", commit: m2 });
    // 環境が直れば、流し直して通る
    await writeFile(marker, "");
    expect((await run(root)).code).toBe(0);
  });
});

describe("環境の不調で落ちた二分探索を、あとの本当の落ちの原因にしない（R1）", () => {
  it("環境を壊して4つ流して「確かめられなかった」にし、直して本当に落ちるマージを入れたら、原因は本当のマージ", async () => {
    const marker = path.join(await tempDir(), "env-ok");
    await writeFile(marker, "");
    const root = await makeRepo({
      verify: [`test -f ${marker} && test ! -f BAD`],
    });
    const initial = await git(root, "rev-parse", "HEAD");
    expect((await run(root)).code).toBe(0);
    await rm(marker);
    const ms: string[] = [];
    for (const id of ["T01", "T02", "T03", "T04"]) {
      ms.push(await mergeTask(root, id, { [`${id}.txt`]: "1\n" }));
      await pending(root, ms.at(-1)!, id);
    }
    expect((await run(root)).code).toBe(1);
    expect((await readRec(root, ms[3]!)).status).toBe("unchecked");
    // 途中で「落ちた」にしたコミットは残らない
    for (const c of ms.slice(0, 3)) {
      const status = (await readRec(root, c).catch(() => null))?.status;
      expect(["unchecked", "pending", undefined]).toContain(status);
    }
    // 前に通っていた記録は書き換えない
    expect((await readRec(root, initial)).status).toBe("passed");
    await writeFile(marker, "");
    const bad = await mergeTask(root, "T05", { BAD: "x\n" });
    await pending(root, bad, "T05");
    expect((await run(root)).code).toBe(1);
    const head = await readRec(root, bad);
    expect(head.status).toBe("failed");
    expect(head.culprit).toBe(bad);
    expect(head.culpritLabel).toBe("T05");
    expect(
      await mainCheckState(testRunner, root, await requireConfig(root)),
    ).toMatchObject({ kind: "failed", cause: "known", culprit: bad });
  });
});

describe("確かめられなかった・原因の文（R4・R5・R13）", () => {
  const patch = async (root: string, commit: string, fields: object) => {
    const file = path.join(checkDir(root), `${commit}.json`);
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...record, ...fields }));
  };

  it("準備の失敗と環境の不調は文が分かれる（run と一覧）", async () => {
    const marker = path.join(await tempDir(), "env-ok");
    await writeFile(marker, "");
    const root = await makeRepo({ verify: [`test -f ${marker}`] });
    expect((await run(root)).code).toBe(0);
    await rm(marker);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    const m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
    await pending(root, m1, "T01");
    await pending(root, m2, "T02");
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("main の確かめができませんでした");
    expect(result.err).toContain("原因の1つ前も今の環境で落ちました");
    expect(result.err).not.toContain("準備の失敗");
    const list = await runCli(["main-check"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(list.out).toContain("原因の1つ前も今の環境で落ちました");
    expect(list.out).not.toContain("準備の失敗");
  });

  it("準備の失敗は「準備の失敗：」と出る（run と一覧）", async () => {
    const root = await makeRepo(
      { verify: ["true"] },
      { ".orca-flow/setup.sh": "exit 1\n" },
    );
    await git(root, "add", "-A");
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("準備の失敗：bash .orca-flow/setup.sh");
    const list = await runCli(["main-check"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(list.out).toContain("準備の失敗：bash .orca-flow/setup.sh");
    expect(list.out).not.toContain("原因の1つ前");
  });

  it("同じ run に落ちたと確かめられなかったがあれば、両方出す", async () => {
    // 1つ目の round で落ち、main が進んだ2つ目の round で準備が失敗する
    const root = await makeRepo({ verify: ["test ! -f BAD"] });
    expect((await run(root)).code).toBe(0);
    const m1 = await mergeTask(root, "T01", { BAD: "x\n" });
    await pending(root, m1, "T01");
    let advanced = false;
    const base = fakeOrca().runner;
    const runner: Runner = async (cmd, args, opts) => {
      const result = await base(cmd, args, opts);
      if (cmd === "sh" && !advanced) {
        advanced = true;
        const m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
        await pending(root, m2, "T02");
      }
      return result;
    };
    const wrapped: Runner = (cmd, args, opts) =>
      cmd === "git" && args[0] === "checkout" && advanced
        ? Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "壊れた",
            timedOut: false,
          })
        : runner(cmd, args, opts);
    const result = await run(root, wrapped);
    expect(result.code).toBe(1);
    expect(result.err).toContain("で落ちました");
    expect(result.err).toContain("main の確かめができませんでした");
  });

  it("一覧：探している・探していたプロセスがいない・分からない・原因が分かっている", async () => {
    const root = await makeRepo();
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    const list = async () =>
      (
        await runCli(["main-check"], {
          cwd: root,
          runner: fakeOrca().runner,
        })
      ).out.split("\n")[0]!;
    await patch(root, m1, {
      status: "failed",
      failedCommand: "pnpm test",
      searching: true,
      pid: process.pid,
      bootAt: null,
    });
    expect(await list()).toContain("原因：探しています");
    await patch(root, m1, { pid: 2_000_000_000 });
    const stalled = await list();
    expect(stalled).toContain("探していたプロセスがいません");
    expect(stalled).not.toContain("原因：探しています");
    await patch(root, m1, { searching: false, pid: null, causeUnknown: true });
    expect(await list()).toContain("原因：分かりません");
    await patch(root, m1, {
      causeUnknown: false,
      culprit: m1,
      culpritLabel: "T01",
    });
    expect(await list()).toContain("原因：T01");
  });

  it("run で原因が分からないとき「原因のコミットは分かりません」と出る", async () => {
    const root = await makeRepo({ verify: ["test ! -f BAD"] });
    expect((await run(root)).code).toBe(0);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    const m2 = await mergeTask(root, "T02", { BAD: "x\n" });
    const m3 = await mergeTask(root, "T03", { "c.txt": "1\n" });
    for (const [c, id] of [
      [m1, "T01"],
      [m2, "T02"],
      [m3, "T03"],
    ] as const)
      await pending(root, c, id);
    const { runner } = checkoutRunner({ failWhen: (a) => a.includes(m1) });
    const result = await run(root, runner);
    expect(result.err).toContain("原因のコミットは分かりません");
  });
});

describe("知らせ：起動の順の形と初回（R9・R12）", () => {
  const taskOrca = async (root: string) => {
    const other = await addTaskWorktree(root, "T13", "other");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_t13",
      worktreePath: other.path,
      agentIdentity: "claude",
    });
    return orca;
  };

  it("先頭が記録のない進捗表のコミット、その下に「待ち」のマージ：1回の run で知らせが1回、ID が入る", async () => {
    const root = await makeRepo({ verify: ["true"] });
    expect((await run(root)).code).toBe(0);
    const orca = await taskOrca(root);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "統括役: T01 の統合を進捗に記録する",
    );
    expect((await run(root, orca.runner)).code).toBe(0);
    const sends = orca.callsOf("terminal", "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![5]).toContain("main に T01 が入り、");
  });

  it("同じ木のマージの上に進捗表のコミット：知らせは1回で ID が入る", async () => {
    const root = await makeRepo({ verify: ["true"] });
    expect((await run(root)).code).toBe(0);
    const orca = await taskOrca(root);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await recordMerge(testRunner, root, await requireConfig(root), {
      commit: m1,
      id: "T01",
      sameTree: true,
      commands: ["true"],
      at: "x",
    });
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "統括役: T01 の統合を進捗に記録する",
    );
    expect((await run(root, orca.runner)).code).toBe(0);
    const sends = orca.callsOf("terminal", "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![5]).toContain("main に T01 が入り、");
  });

  it("知らせの状態がない初回でも、同じ木のマージ M の上に進捗表のコミット P が先頭なら M の ID が入る", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await recordMerge(testRunner, root, await requireConfig(root), {
      commit: m1,
      id: "T01",
      sameTree: true,
      commands: ["true"],
      at: "x",
    });
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "統括役: T01 の統合を進捗に記録する",
    );
    const orca = await taskOrca(root);
    expect((await run(root, orca.runner)).code).toBe(0);
    const sends = orca.callsOf("terminal", "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![5]).toContain("main に T01 が入り、");
  });
});

describe("main が進んだ知らせ", () => {
  async function withTask(config: Record<string, unknown> = {}) {
    const root = await makeRepo({ verify: ["test ! -f BAD"], ...config });
    expect((await run(root)).code).toBe(0);
    const other = await addTaskWorktree(root, "T13", "other");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_t13",
      worktreePath: other.path,
      agentIdentity: "claude",
    });
    return { root, orca };
  }

  it("先頭で通ったら、前に知らせたあとに入った ID をまとめて作業中のタスクに送る", async () => {
    const { root, orca } = await withTask();
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    const m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
    await pending(root, m1, "T01");
    await pending(root, m2, "T02");
    const result = await run(root, orca.runner);
    expect(result.code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toEqual([
      [
        "terminal",
        "send",
        "--terminal",
        "term_t13",
        "--text",
        "（統括役より）main に T01・T02 が入り、main の確かめが通りました。作業中なら区切りで git merge main をしてください。統合待ちなら何もしなくてかまいません。",
        "--enter",
      ],
    ]);
    // 同じ ID をもう一度知らせない
    const m3 = await mergeTask(root, "T03", { "c.txt": "1\n" });
    await pending(root, m3, "T03");
    await run(root, orca.runner);
    expect(orca.callsOf("terminal", "send")[1]![5]).toContain(
      "main に T03 が入り、",
    );
  });

  it("落ちたら送らず、直って通ったときに落ちていた間の ID もまとめて送る", async () => {
    const { root, orca } = await withTask();
    const m1 = await mergeTask(root, "T01", { BAD: "x\n" });
    await pending(root, m1, "T01");
    expect((await run(root, orca.runner)).code).toBe(1);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
    await git(root, "revert", "--no-edit", "-m", "1", m1);
    expect((await run(root, orca.runner)).code).toBe(0);
    expect(orca.callsOf("terminal", "send")[0]![5]).toContain(
      "main に T01 が入り、",
    );
  });

  it("同じ木で通った先頭では、コマンドも setup も流さず、知らせを1回だけ送る", async () => {
    const mark = path.join(await tempDir(), "count");
    const { root, orca } = await withTask({ verify: [`echo x >> ${mark}`] });
    await rm(mark, { force: true });
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await recordMerge(testRunner, root, await requireConfig(root), {
      commit: m1,
      id: "T01",
      sameTree: true,
      commands: ["true"],
      at: "2026-10-26T00:00:00.000Z",
    });
    await rm(path.join(checkDir(root), "tree"), {
      recursive: true,
      force: true,
    });
    const result = await run(root, orca.runner);
    expect(result.code).toBe(0);
    await expect(readFile(mark, "utf8")).rejects.toThrow();
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    expect(orca.callsOf("terminal", "send")[0]![5]).toContain(
      "main に T01 が入り、",
    );
    await run(root, orca.runner);
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
  });

  it("確かめの最中に入った未確かめのマージの ID は知らせに入らず、通ったときに1回だけ送られる", async () => {
    const { root, orca } = await withTask();
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    let done = false;
    const runner: Runner = async (cmd, args, opts) => {
      const result = await orca.runner(cmd, args, opts);
      if (cmd === "sh" && !done) {
        done = true;
        const m2 = await mergeTask(root, "T02", { BAD: "x\n" });
        await pending(root, m2, "T02");
      }
      return result;
    };
    expect((await run(root, runner)).code).toBe(1);
    const sends = orca.callsOf("terminal", "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![5]).toContain("main に T01 が入り、");
    expect(sends[0]![5]).not.toContain("T02");
    await git(root, "revert", "--no-edit", "-m", "1", "HEAD");
    expect((await run(root, orca.runner)).code).toBe(0);
    const after = orca.callsOf("terminal", "send");
    expect(after).toHaveLength(2);
    expect(after[1]![5]).toContain("main に T02 が入り、");
  });

  it("すでに通った先頭で知らせている間に入ったマージも、同じ run の中で確かめる", async () => {
    const { root, orca } = await withTask();
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await recordMerge(testRunner, root, await requireConfig(root), {
      commit: m1,
      id: "T01",
      sameTree: true,
      commands: [],
      at: "x",
    });
    let m2 = "";
    let inner = -1;
    const runner: Runner = async (cmd, args, opts) => {
      const result = await orca.runner(cmd, args, opts);
      if (cmd === "orca" && args.includes("send") && !m2) {
        m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
        await pending(root, m2, "T02");
        inner = (await run(root)).code;
      }
      return result;
    };
    expect((await run(root, runner)).code).toBe(0);
    expect(inner).toBe(2);
    expect((await readRec(root, m2)).status).toBe("passed");
    expect(orca.callsOf("terminal", "send")).toHaveLength(2);
  });

  it("記録をまだ書いていない統括役のマージも、件名から ID を取って知らせる", async () => {
    const { root, orca } = await withTask();
    await mergeTask(root, "T01", { "a.txt": "1\n" });
    expect((await run(root, orca.runner)).code).toBe(0);
    const sends = orca.callsOf("terminal", "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![5]).toContain("main に T01 が入り、");
  });

  it("前に知らせた位置も最後に通ったコミットもないときは、記録のない古いマージの ID を並べない", async () => {
    const root = await makeRepo({ verify: ["true"] });
    await mergeTask(root, "T01", { "a.txt": "1\n" });
    await mergeTask(root, "T02", { "b.txt": "1\n" });
    const other = await addTaskWorktree(root, "T13", "other");
    const orca = fakeOrca();
    orca.terminals.push({
      handle: "term_t13",
      worktreePath: other.path,
      agentIdentity: "claude",
    });
    expect((await run(root, orca.runner)).code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
  });

  it("新しい ID がなければ知らせを送らず、知らせ済みの位置だけ進める", async () => {
    const { root, orca } = await withTask();
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    expect((await run(root, orca.runner)).code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    // 進捗表のような、ID のないコミットだけが増えた
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "統括役: T01 の統合を進捗に記録する",
    );
    expect((await run(root, orca.runner)).code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    const state = JSON.parse(
      await readFile(path.join(checkDir(root), "notice.state"), "utf8"),
    );
    expect(state.notifiedUpTo).toBe(await git(root, "rev-parse", "HEAD"));
  });

  it("before-merge のときは run が知らせを送らない", async () => {
    const { root, orca } = await withTask({ integrateVerify: "before-merge" });
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    expect((await run(root, orca.runner)).code).toBe(0);
    expect(orca.callsOf("terminal", "send")).toEqual([]);
  });

  it("送れなかったタスクは記録に残り、main-check の一覧に警告で出て、次に送れたら消える", async () => {
    const { root, orca } = await withTask();
    orca.terminals[0]!.screen = bashScreen();
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    const result = await run(root, orca.runner);
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      "T13 のタスク長に main が進んだ知らせを送れませんでした",
    );
    const list = await runCli(["main-check"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(list.code).toBe(0);
    expect(list.err).toContain("送れませんでした");
    expect(list.err).toContain("bash モード");
    expect(list.err).toContain(
      "統合待ちのタスクなら、何もしなくてかまいません",
    );
    const json = await runCli(["main-check", "--json"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(JSON.parse(json.out).warnings).toHaveLength(1);
    // 入力欄が直ったあとの次の確かめで送れたら消える
    delete orca.terminals[0]!.screen;
    const m2 = await mergeTask(root, "T02", { "b.txt": "1\n" });
    await pending(root, m2, "T02");
    await run(root, orca.runner);
    expect(orca.callsOf("terminal", "send")).toHaveLength(1);
    const after = await runCli(["main-check"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(after.err).toBe("");
  });
});

describe("main-check（一覧）", () => {
  it("コミットごとに ID と状態を新しい順に出し、--json でも同じ中身", async () => {
    const root = await makeRepo({ verify: ["test ! -f BAD"] });
    expect((await run(root)).code).toBe(0);
    const m1 = await mergeTask(root, "T01", { "a.txt": "1\n" });
    await pending(root, m1, "T01");
    expect((await run(root)).code).toBe(0);
    const m2 = await mergeTask(root, "T02", { BAD: "x\n" });
    await pending(root, m2, "T02");
    expect((await run(root)).code).toBe(1);
    const m3 = await mergeTask(root, "T03", { "c.txt": "1\n" });
    await pending(root, m3, "T03");

    const list = await runCli(["main-check"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(list.code).toBe(0);
    const lines = list.out.split("\n");
    expect(lines[0]).toContain(m3.slice(0, 8));
    expect(lines[0]).toContain("T03");
    expect(lines[0]).toContain("待ち");
    expect(lines[1]).toContain("T02");
    expect(lines[1]).toContain("落ちた");
    expect(lines[1]).toContain("test ! -f BAD");
    expect(lines[2]).toContain("T01");
    expect(lines[2]).toContain("通った");

    const json = await runCli(["main-check", "--json"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    const data = JSON.parse(json.out) as {
      commits: { id: string | null; status: string; commit: string }[];
    };
    expect(data.commits.slice(0, 3).map((c) => [c.id, c.status])).toEqual([
      ["T03", "pending"],
      ["T02", "failed"],
      ["T01", "passed"],
    ]);
    expect(data.commits[0]!.commit).toBe(m3);
  });

  it("知らない引数は終了コード1", async () => {
    const root = await makeRepo();
    expect(
      (
        await runCli(["main-check", "あれ"], {
          cwd: root,
          runner: fakeOrca().runner,
        })
      ).code,
    ).toBe(1);
  });
});
