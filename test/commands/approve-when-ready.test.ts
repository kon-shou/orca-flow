import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { newRecord, readAuto, withOff, writeAuto } from "../../src/lib/auto.ts";
import { appendStage } from "../../src/lib/stage-log.ts";
import {
  startAfterFile,
  writeStartAfterAt,
  type StartAfterEntry,
} from "../../src/lib/start-after.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const common = (root: string) => path.join(root, ".git");
const DOC = "docs/tasks/T05.md";

let tick = 0;
async function stage(
  root: string,
  id: string,
  state: string,
  command = state === "designing" ? "new" : "status",
) {
  await appendStage(common(root), id, {
    at: new Date(T0.getTime() + ++tick * 1000).toISOString(),
    state,
    note: null,
    command,
  });
}

const after: StartAfterEntry[] = [
  { id: "T01", repo: null, wait: "implemented" },
];

/** 前 T01（まだ実装中）と、T01 を待つ印のある後ろ T05（spec-review）が作業中のリポジトリ */
async function setup(
  options: { ready?: boolean; doc?: boolean; ignored?: boolean } = {},
) {
  const root = await makeRepo(
    {},
    options.ignored ? { ".gitignore": "docs/tasks/\n" } : {},
  );
  await addTaskWorktree(root, "T01", "first");
  const doc = specDoc("T05", { allowed: ["src/b/"] });
  const wt = await addTaskWorktree(
    root,
    "T05",
    "second",
    (options.doc ?? true) && !options.ignored ? { [DOC]: doc } : {},
  );
  if (options.ignored) await writeFiles(wt.path, { [DOC]: doc });
  await writeStartAfterAt(common(root), "T05", after, T0);
  await stage(root, "T01", "designing");
  await stage(root, "T01", options.ready ? "integrate-wait" : "working");
  await stage(root, "T05", "designing");
  await stage(root, "T05", "spec-review");
  return { root, wt: wt.path };
}

const blobOf = async (wt: string) =>
  (await git(wt, "hash-object", "--", DOC)).trim();

async function cli(argv: string[], cwd: string, orca = fakeOrca()) {
  return runCli(argv, { cwd, runner: orca.runner });
}

const head = async (cwd: string) =>
  (await git(cwd, "rev-parse", "HEAD")).trim();

describe("approve --when-ready（先の承認）", () => {
  it("前が整っていない印のタスクに、設計書の指紋と時刻をおまかせの記録に残し、ほかは何もしない", async () => {
    const { root, wt } = await setup();
    const mainHead = await head(root);
    const wtHead = await head(wt);
    const orca = fakeOrca();
    const r = await cli(["approve", "T05", "--when-ready"], root, orca);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.startsWith("先に承認しました")).toBe(true);
    const record = await readAuto(common(root), "T05");
    expect(record).toMatchObject({
      auto: true,
      approveOnly: true,
      turn: null,
      preApproval: { blob: await blobOf(wt) },
    });
    expect(Number.isNaN(Date.parse(record!.preApproval!.at))).toBe(false);
    // 取り込み・進捗表のコミット・カード・送りはない
    expect(orca.calls).toEqual([]);
    expect(await head(root)).toBe(mainHead);
    expect(await head(wt)).toBe(wtHead);
    const json = await cli(["approve", "T05", "--when-ready", "--json"], root);
    expect(JSON.parse(json.out)).toMatchObject({
      id: "T05",
      preApproval: { blob: await blobOf(wt) },
    });
  });

  it("設計書が無視されていても、ファイルの中身で指紋を取る", async () => {
    const { root, wt } = await setup({ ignored: true });
    const r = await cli(["approve", "T05", "--when-ready"], root);
    expect(r.code).toBe(0);
    expect((await readAuto(common(root), "T05"))!.preApproval!.blob).toBe(
      await blobOf(wt),
    );
  });

  it.each([
    [
      "印がない",
      async (root: string) => rm(startAfterFile(common(root), "T05")),
    ],
    [
      "前が整っている",
      async (root: string) => stage(root, "T01", "integrate-wait"),
    ],
    [
      "印が読めない",
      async (root: string) =>
        writeFile(startAfterFile(common(root), "T05"), "{"),
    ],
    [
      "前が読めない",
      async (root: string) =>
        writeStartAfterAt(
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
        ),
    ],
    [
      "段の記録の最後が spec-review でない",
      async (root: string) => stage(root, "T05", "working", "approve"),
    ],
  ])("%sなら終了コード1で記録を書かない", async (_label, change) => {
    const { root } = await setup();
    await change(root);
    const r = await cli(["approve", "T05", "--when-ready"], root);
    expect(r.code).toBe(1);
    expect(await readAuto(common(root), "T05")).toBeNull();
  });

  it("設計書がなければ終了コード1で記録を書かない", async () => {
    const { root } = await setup({ doc: false });
    const r = await cli(["approve", "T05", "--when-ready"], root);
    expect(r.code).toBe(1);
    expect(await readAuto(common(root), "T05")).toBeNull();
  });

  it("未コミットの変更があれば終了コード1で記録を書かない", async () => {
    const { root, wt } = await setup();
    await writeFile(path.join(wt, "draft.txt"), "途中\n");
    const r = await cli(["approve", "T05", "--when-ready"], root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("未コミットの変更");
    expect(await readAuto(common(root), "T05")).toBeNull();
  });

  it("--prechanges-done と一緒なら終了コード1で記録を書かない", async () => {
    const { root } = await setup();
    const r = await cli(
      ["approve", "T05", "--when-ready", "--prechanges-done"],
      root,
    );
    expect(r.code).toBe(1);
    expect(await readAuto(common(root), "T05")).toBeNull();
  });

  it("統括役の場所でなければ終了コード2", async () => {
    const { root, wt } = await setup();
    const r = await cli(["approve", "T05", "--when-ready"], wt);
    expect(r.code).toBe(2);
    expect(await readAuto(common(root), "T05")).toBeNull();
  });

  it("おまかせを外してあれば承認だけのおまかせとして入に戻し、ふつうのおまかせは承認だけにしない", async () => {
    const { root } = await setup();
    await writeAuto(
      common(root),
      withOff(newRecord("T05", T0), "人が確かめる", T0),
    );
    expect((await cli(["approve", "T05", "--when-ready"], root)).code).toBe(0);
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: true,
      approveOnly: true,
      offReason: null,
      offAt: null,
    });

    await writeAuto(common(root), newRecord("T05", T0));
    expect((await cli(["approve", "T05", "--when-ready"], root)).code).toBe(0);
    expect(await readAuto(common(root), "T05")).toMatchObject({
      auto: true,
      approveOnly: false,
      preApproval: { blob: expect.any(String) },
    });
  });
});

describe("先の承認の見分け", () => {
  const lineOf = (out: string) =>
    out.split("\n").find((l) => l.startsWith("前の実装完了を待っています"));

  it("status の spec-review の1行に、先の承認が有効か外れたかが出る", async () => {
    const { root, wt } = await setup();
    await cli(["approve", "T05", "--when-ready"], root);
    const kept = await cli(["status", "spec-review"], wt);
    expect(lineOf(kept.out)).toContain("先に承認してあります");
    expect(lineOf(kept.out)).not.toContain("先に承認しておけます");

    await writeFiles(wt, { [DOC]: "# 書き直した設計書\n" });
    await git(wt, "commit", "--quiet", "-am", "設計書を直す");
    const changed = await cli(["status", "spec-review"], wt);
    expect(lineOf(changed.out)).toContain(
      "先の承認は、設計書が変わったので外れました",
    );
    expect(lineOf(changed.out)).not.toContain("先に承認してあります");
  });

  it("設計書が無視されていても、ファイルの中身で見分ける", async () => {
    const { root, wt } = await setup({ ignored: true });
    await cli(["approve", "T05", "--when-ready"], root);
    expect(lineOf((await cli(["status", "spec-review"], wt)).out)).toContain(
      "先に承認してあります",
    );
    await writeFiles(wt, { [DOC]: "# 書き直した設計書\n" });
    expect(lineOf((await cli(["status", "spec-review"], wt)).out)).toContain(
      "先の承認は、設計書が変わったので外れました",
    );
  });

  it("auto show と一覧と --json に先の承認が出て、auto off で消える", async () => {
    const { root, wt } = await setup();
    await cli(["approve", "T05", "--when-ready"], root);

    const show = await cli(["auto", "show", "T05"], root);
    expect(show.out).toContain("先の承認：有効");
    const list = await cli(["auto"], root);
    const row = list.out
      .split("\n")
      .find((l) => l.startsWith("T05：作業中・前"));
    expect(row).toContain("先の承認：有効");
    expect(
      JSON.parse((await cli(["auto", "show", "T05", "--json"], root)).out)
        .preApproval,
    ).toMatchObject({ valid: true });
    expect(
      JSON.parse((await cli(["auto", "--json"], root)).out).startAfter,
    ).toMatchObject([{ id: "T05", preApproval: { valid: true } }]);

    await writeFiles(wt, { [DOC]: "# 書き直した設計書\n" });
    await git(wt, "commit", "--quiet", "-am", "設計書を直す");
    expect((await cli(["auto", "show", "T05"], root)).out).toContain(
      "先の承認：設計書が変わったので外れました",
    );
    const stale = (await cli(["auto"], root)).out
      .split("\n")
      .find((l) => l.startsWith("T05：作業中・前"));
    expect(stale).toContain("先の承認：設計書が変わったので外れました");
    expect(
      JSON.parse((await cli(["auto", "--json"], root)).out).startAfter,
    ).toMatchObject([{ id: "T05", preApproval: { valid: false } }]);

    expect((await cli(["auto", "off", "T05"], root)).code).toBe(0);
    expect((await readAuto(common(root), "T05"))!.preApproval).toBeNull();
    expect((await cli(["auto", "show", "T05"], root)).out).not.toContain(
      "先の承認",
    );
    expect(
      JSON.parse((await cli(["auto", "--json"], root)).out).startAfter,
    ).toMatchObject([{ id: "T05", preApproval: null }]);
  });
});

/** 待ち受けを短い間で流す（番がなければすぐ終わる） */
async function waitOnce(root: string, orca = fakeOrca()) {
  const out: string[] = [];
  const code = await main(["auto", "wait", "--json"], {
    cwd: root,
    runner: orca.runner,
    env: {
      ...process.env,
      ORCA_FLOW_AUTO_POLL_MS: "5",
      ORCA_FLOW_AUTO_MAX_WAIT_MS: "60",
    },
    stdout: (t) => out.push(t),
    stderr: () => {},
  });
  return { code, out: out.join("\n") };
}

const READY_LINE = (out: string) =>
  out.split("\n").find((l) => l.startsWith("前が整っています"));

describe("前が整ったあとの先の承認", () => {
  it("待ち受けが番を立てて拾っても、先の承認は元の指紋のまま残り、auto show に有効と出る", async () => {
    const { root, wt } = await setup();
    await cli(["approve", "T05", "--when-ready"], root);
    const blob = (await readAuto(common(root), "T05"))!.preApproval!.blob;
    await stage(root, "T01", "integrate-wait");

    const waited = await waitOnce(root);
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.out).turn).toMatchObject({
      id: "T05",
      kind: "approve",
    });
    const record = await readAuto(common(root), "T05");
    expect(record!.turn).toMatchObject({ kind: "approve", picked: true });
    expect(record!.preApproval!.blob).toBe(blob);
    expect(blob).toBe(await blobOf(wt));
    expect((await cli(["auto", "show", "T05"], root)).out).toContain(
      "先の承認：有効",
    );
  });

  it("status が番を立てても、先の承認は元の指紋のまま残り、auto show に有効と出る", async () => {
    const { root, wt } = await setup();
    await cli(["approve", "T05", "--when-ready"], root);
    const blob = (await readAuto(common(root), "T05"))!.preApproval!.blob;
    await stage(root, "T01", "integrate-wait");

    const r = await cli(["status", "spec-review"], wt);
    expect(r.code).toBe(0);
    const record = await readAuto(common(root), "T05");
    expect(record!.turn).toMatchObject({ kind: "approve", picked: false });
    expect(record!.preApproval!.blob).toBe(blob);
    expect((await cli(["auto", "show", "T05"], root)).out).toContain(
      "先の承認：有効",
    );
  });

  it("status の「前が整っています」の1行に、先の承認が有効か外れたかが出る", async () => {
    const { root, wt } = await setup();
    await cli(["approve", "T05", "--when-ready"], root);
    await stage(root, "T01", "integrate-wait");

    expect(READY_LINE((await cli(["status", "spec-review"], wt)).out)).toBe(
      "前が整っています（T01（実装完了を待つ：統合待ちになりました））。先に承認してあります。承認は、統括役の待ち受け（/orca-flow:auto）が番を立てて、先の承認のまま進めます",
    );

    await writeFiles(wt, { [DOC]: "# 書き直した設計書\n" });
    await git(wt, "commit", "--quiet", "-am", "設計書を直す");
    expect(READY_LINE((await cli(["status", "spec-review"], wt)).out)).toBe(
      "前が整っています（T01（実装完了を待つ：統合待ちになりました））。先の承認は、設計書が変わったので外れました。承認は、統括役の待ち受け（/orca-flow:auto）が番を立てて進めます",
    );
  });

  it("status で設計書の指紋を求められなければ、先の承認は外れたと出し、先の承認なしの案内にしない", async () => {
    const { root, wt } = await setup();
    await cli(["approve", "T05", "--when-ready"], root);
    const orca = fakeOrca();
    const failing: Runner = async (cmd, args, opts) =>
      cmd === "git" && args[0] === "hash-object"
        ? { code: 1, stdout: "", stderr: "壊れた", timedOut: false }
        : orca.runner(cmd, args, opts);
    const r = await runCli(["status", "spec-review"], {
      cwd: wt,
      runner: failing,
    });
    expect(r.code).toBe(0);
    const line = r.out
      .split("\n")
      .find((l) => l.startsWith("前の実装完了を待っています"));
    expect(line).toContain("先の承認は、設計書が変わったので外れました");
    expect(line).not.toContain("先に承認してあります");
  });
});

describe("先の承認を出さないタスク", () => {
  const rowOf = (out: string) =>
    out.split("\n").find((l) => l.startsWith("T05：作業中・前"));

  it("最後の spec-review のあとに承認が済んでいれば、一覧・show・--json に先の承認を出さない", async () => {
    const { root } = await setup();
    await cli(["approve", "T05", "--when-ready"], root);
    expect(rowOf((await cli(["auto"], root)).out)).toContain("先の承認：有効");
    await stage(root, "T05", "working", "approve");

    expect(rowOf((await cli(["auto"], root)).out)).not.toContain("先の承認");
    expect((await cli(["auto", "show", "T05"], root)).out).not.toContain(
      "先の承認",
    );
    expect(
      JSON.parse((await cli(["auto", "show", "T05", "--json"], root)).out)
        .preApproval,
    ).toBeNull();
    expect(
      JSON.parse((await cli(["auto", "--json"], root)).out).startAfter,
    ).toMatchObject([{ id: "T05", preApproval: null }]);
  });

  it("作業中でなければ、一覧・show・--json に先の承認を出さない", async () => {
    const { root, wt } = await setup();
    await cli(["approve", "T05", "--when-ready"], root);
    await git(root, "worktree", "remove", "--force", wt);

    const row = (await cli(["auto"], root)).out
      .split("\n")
      .find((l) => l.startsWith("T05：作業中ではありません・前"));
    expect(row).toBeDefined();
    expect(row).not.toContain("先の承認");
    expect((await cli(["auto", "show", "T05"], root)).out).not.toContain(
      "先の承認",
    );
    expect(
      JSON.parse((await cli(["auto", "show", "T05", "--json"], root)).out)
        .preApproval,
    ).toBeNull();
    expect(
      JSON.parse((await cli(["auto", "--json"], root)).out).startAfter,
    ).toMatchObject([{ id: "T05", preApproval: null }]);
  });
});
