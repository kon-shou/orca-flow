import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAuto } from "../../src/lib/auto.ts";
import { appendStage, readStages } from "../../src/lib/stage-log.ts";
import { writeStartAfterAt } from "../../src/lib/start-after.ts";
import {
  bashScreen,
  claudeScreen,
  fakeOrca,
  runCli,
} from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const common = (root: string) => path.join(root, ".git");
const DOC = "docs/tasks/T05.md";
const PROGRESS_FILE = "docs/progress.md";
const OTHER_BLOB = "0".repeat(40);
const STALE = "orca-flow: 設計書が読んだときから変わっています";

let tick = 0;
async function stage(root: string, id: string, state: string, command: string) {
  await appendStage(common(root), id, {
    at: new Date(T0.getTime() + ++tick * 1000).toISOString(),
    state,
    note: null,
    command,
  });
}

/**
 * 前 T01（実装中）を待つ印のある T05（spec-review）が作業中のリポジトリ。
 * 設計書には事前変更があり、進捗表もある（止まったときに何も変えないかを見るため）
 */
async function setup(options: { ignored?: boolean } = {}) {
  const root = await makeRepo(
    { progress: { file: PROGRESS_FILE } },
    {
      [PROGRESS_FILE]: PROGRESS.replace(
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
        "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T05 | 後ろ | — | 設計中 | task/T05-second | |\n",
      ),
      ...(options.ignored ? { ".gitignore": "docs/tasks/\n" } : {}),
    },
  );
  await addTaskWorktree(root, "T01", "first");
  const doc = specDoc("T05", {
    allowed: ["src/b/"],
    prechanges: ["`package.json` に何かを足す"],
  });
  const wt = await addTaskWorktree(
    root,
    "T05",
    "second",
    options.ignored ? {} : { [DOC]: doc },
  );
  if (options.ignored) await writeFiles(wt.path, { [DOC]: doc });
  await writeStartAfterAt(
    common(root),
    "T05",
    [{ id: "T01", repo: null, wait: "implemented" }],
    T0,
  );
  await stage(root, "T01", "designing", "new");
  await stage(root, "T01", "working", "status");
  await stage(root, "T05", "designing", "new");
  await stage(root, "T05", "spec-review", "status");
  const blob = await git(wt.path, "hash-object", "--", DOC);
  return { root, wt: wt.path, blob };
}

/** 承認の道ごとの引数（ふつうの道は事前変更を入れた体で流す） */
const PATHS: [string, string[]][] = [
  ["ふつうの approve", ["--prechanges-done"]],
  ["--when-ready", ["--when-ready"]],
];

/** 何も変わっていないかを比べるための写し */
async function snapshot(root: string, wt: string) {
  return {
    main: await git(root, "rev-parse", "HEAD"),
    task: await git(wt, "rev-parse", "HEAD"),
    progress: await readFile(path.join(root, PROGRESS_FILE), "utf8"),
    stages: (await readStages(common(root), "T05"))?.entries.length,
    auto: await readAuto(common(root), "T05"),
  };
}

describe("approve --doc-blob", () => {
  it.each(
    PATHS.flatMap(([label, flags]) =>
      [false, true].map((ignored) => [label, ignored, flags] as const),
    ),
  )(
    "%s：今の設計書の blob と同じなら今までどおり進む（無視された設計書：%s）",
    async (_label, ignored, flags) => {
      const { root, blob } = await setup({ ignored });
      const r = await runCli(["approve", "T05", ...flags, "--doc-blob", blob], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      if (flags.includes("--when-ready"))
        expect((await readAuto(common(root), "T05"))!.preApproval!.blob).toBe(
          blob,
        );
      else
        expect(
          (await readStages(common(root), "T05"))!.entries.at(-1),
        ).toMatchObject({ state: "working", command: "approve" });
    },
  );

  it.each(PATHS)(
    "%s：blob が違えば終了コード1で、両方の blob を出し、取り込み・進捗表・Orca・記録のどれもしない",
    async (_label, flags) => {
      const { root, wt, blob } = await setup();
      // main を進めておく（取り込めばタスクの HEAD が動く）
      await git(
        root,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "main を進める",
      );
      const before = await snapshot(root, wt);
      const orca = fakeOrca();
      const r = await runCli(
        // 事前変更の確かめ（終了コード2）より前に止まるかも見るため、ふつうの道でも --prechanges-done を外す
        [
          "approve",
          "T05",
          ...flags.filter((f) => f !== "--prechanges-done"),
          "--doc-blob",
          OTHER_BLOB,
        ],
        { cwd: root, runner: orca.runner },
      );
      expect(r.code).toBe(1);
      expect(r.err.startsWith(STALE)).toBe(true);
      expect(r.err).toContain(OTHER_BLOB);
      expect(r.err).toContain(blob);
      expect(orca.calls).toEqual([]);
      expect(await snapshot(root, wt)).toEqual(before);
    },
  );

  it.each(
    PATHS.flatMap(([label, flags]) =>
      ["abc", "g".repeat(40), "0".repeat(41), "0".repeat(63), ""].map(
        (value) => [label, value, flags] as const,
      ),
    ),
  )(
    "%s：blob の形でない値（%j）は終了コード1で何も変えない",
    async (_label, value, flags) => {
      const { root, wt } = await setup();
      const before = await snapshot(root, wt);
      const orca = fakeOrca();
      const r = await runCli(
        ["approve", "T05", ...flags, `--doc-blob=${value}`],
        { cwd: root, runner: orca.runner },
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("--doc-blob");
      expect(orca.calls).toEqual([]);
      expect(await snapshot(root, wt)).toEqual(before);
    },
  );

  it("64字の blob（SHA-256 のリポジトリの形）も形として受け付け、違えば比べて止まる", async () => {
    const { root } = await setup();
    const r = await runCli(
      ["approve", "T05", "--when-ready", "--doc-blob", "a".repeat(64)],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.code).toBe(1);
    expect(r.err.startsWith(STALE)).toBe(true);
    expect(await readAuto(common(root), "T05")).toBeNull();
  });

  it.each(PATHS)(
    "%s：改行が CRLF で text=auto の無視された設計書でも、--no-filters で求めた blob なら進む",
    async (_label, flags) => {
      const { root, wt } = await setup({ ignored: true });
      const file = path.join(wt, DOC);
      const crlf = (await readFile(file, "utf8")).replace(/\n/g, "\r\n");
      await writeFile(file, crlf);
      await mkdir(path.join(common(root), "info"), { recursive: true });
      await writeFile(
        path.join(common(root), "info", "attributes"),
        "* text=auto\n",
      );
      const raw = await git(wt, "hash-object", DOC, "--no-filters");
      // 変換がかかる求め方では値が違う（確かめに意味がある前提）
      expect(await git(wt, "hash-object", DOC)).not.toBe(raw);
      const r = await runCli(["approve", "T05", ...flags, "--doc-blob", raw], {
        cwd: root,
        runner: fakeOrca().runner,
      });
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
    },
  );

  it.each([
    ["あれば添える", true],
    ["なければ添えない", false],
  ] as const)(
    "送る直前に入力欄がふさがったときの流し直しの案内に、--doc-blob を%s",
    async (_label, withBlob) => {
      const { root, wt, blob } = await setup();
      const orca = fakeOrca();
      orca.terminals.push({
        handle: "term_lead",
        worktreePath: wt,
        agentIdentity: "claude",
        screenSequence: [claudeScreen(), bashScreen()],
      });
      const r = await runCli(
        [
          "approve",
          "T05",
          "--prechanges-done",
          ...(withBlob ? ["--doc-blob", blob] : []),
        ],
        { cwd: root, runner: orca.runner },
      );
      expect(r.code).toBe(2);
      expect(r.err).toContain("orca-flow approve T05 --prechanges-done");
      if (withBlob) expect(r.err).toContain(`--doc-blob ${blob} を流せば`);
      else expect(r.err).not.toContain("--doc-blob");
    },
  );
});
