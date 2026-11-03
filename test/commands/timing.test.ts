import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { git, makeRepo } from "../helpers/repo.ts";

const T = (min: number, day = 1) =>
  new Date(2026, 0, day, 12, min).toISOString();
const rows = (list: [string, string, string | null, string?][]): string =>
  list
    .map(([at, state, note, command]) =>
      JSON.stringify({ at, state, note, command: command ?? "status" }),
    )
    .join("\n") + "\n";

async function put(root: string, id: string, text: string) {
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const dir = path.join(common, "orca-flow", "stages");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.jsonl`), text);
}

async function timing(root: string, argv: string[], now = new Date(T(0, 20))) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["timing", ...argv], {
    cwd: root,
    runner: fakeOrca().runner,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => now,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** 統合までの分（designing, working, 待ち）で作る */
const done = (day: number, design: number, work: number, wait: number) =>
  rows([
    [T(0, day), "designing", null, "new"],
    [T(design, day), "working", "実装 1 回目", "approve"],
    [T(design + work, day), "integrate-wait", null],
    [T(design + work + wait, day), "integrated", null, "integrate"],
  ]);

describe("timing <ID>", () => {
  it("統合済みのタスクで、段・番・全体の合計が合う", async () => {
    const root = await makeRepo();
    await put(root, "T01", done(1, 5, 20, 10));
    const r = await timing(root, ["T01", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.integrated).toBe(true);
    expect(j.totalSeconds).toBe(35 * 60);
    expect(j.stages).toEqual({
      designing: 300,
      working: 1200,
      "integrate-wait": 600,
    });
    expect(j.workingNotes).toEqual({ "実装 〈数〉 回目": 1200 });
    expect(j.turns).toEqual({ タスク長: 1500, 待ち: 600 });
    const text = await timing(root, ["T01"]);
    expect(text.out).toContain("最初から統合まで 35.0分");
  });

  it("統合前のタスクは今の段を now まで数え、印を出す", async () => {
    const root = await makeRepo();
    await put(
      root,
      "T02",
      rows([
        [T(0, 5), "designing", null, "new"],
        [T(10, 5), "working", "実装中", "approve"],
      ]),
    );
    const r = await timing(root, ["T02"], new Date(T(40, 5)));
    expect(r.code).toBe(0);
    expect(r.out).toContain("統合前です");
    const marked = r.out.split("\n").filter((l) => l.includes("← 今の段"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("working");
    const j = JSON.parse(
      (await timing(root, ["T02", "--json"], new Date(T(40, 5)))).out,
    );
    expect(j.integrated).toBe(false);
    expect(j.segments.map((s: { open: boolean }) => s.open)).toEqual([
      false,
      true,
    ]);
    expect(j.stages.working).toBe(30 * 60);
  });

  it("記録がなければ終了コード1", async () => {
    const root = await makeRepo();
    const r = await timing(root, ["T99"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("段の記録はまだありません");
  });
});

describe("timing の引数の誤り", () => {
  it.each([[["../T01"]], [["T01", "--since", "2026-01-01"]], [["T01", "T02"]]])(
    "%j は終了コード1",
    async (argv) => {
      const root = await makeRepo();
      await put(root, "T01", done(1, 5, 20, 10));
      const r = await timing(root, argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain("使い方");
    },
  );
});

describe("timing", () => {
  it("記録が途中から始まるタスクは全体の集計から外し、件数を出す", async () => {
    const root = await makeRepo();
    await put(root, "T01", done(1, 5, 200, 95));
    await put(root, "T02", rows([[T(0, 2), "integrated", null, "integrate"]]));
    await put(
      root,
      "T03",
      rows([
        [T(0, 3), "integrate-wait", null],
        [T(60, 3), "integrated", null, "integrate"],
      ]),
    );
    const j = JSON.parse((await timing(root, ["--json"])).out);
    expect(j.tasks).toBe(1);
    expect(j.skippedNoStart).toBe(2);
    expect(j.total).toMatchObject({ count: 1, medianSeconds: 300 * 60 });
    const text = await timing(root, []);
    expect(text.out).toContain("統合済みのタスク 1 件");
    expect(text.out).toContain("2 件");
    expect(text.out).toContain("集計から外しました");
  });

  it("記録がなければ「段の記録はまだありません」で終了コード0", async () => {
    const root = await makeRepo();
    const r = await timing(root, []);
    expect(r.code).toBe(0);
    expect(r.out).toBe("段の記録はまだありません");
  });

  it("統合済みだけを集めて中央値が合い、--since で古いものが外れる", async () => {
    const root = await makeRepo();
    await put(root, "T01", done(1, 5, 20, 10));
    await put(root, "T02", done(2, 10, 40, 20) + "壊れた行\n");
    await put(root, "T03", done(3, 3, 10, 5));
    await put(root, "T04", rows([[T(0, 4), "designing", null, "new"]]));
    const all = JSON.parse((await timing(root, ["--json"])).out);
    expect(all.tasks).toBe(3);
    expect(all.skippedLines).toBe(1);
    const stat = (list: { key: string }[], key: string) =>
      list.find((x) => x.key === key);
    expect(stat(all.stages, "designing")).toMatchObject({
      count: 3,
      totalSeconds: 1080,
      medianSeconds: 300,
    });
    expect(stat(all.stages, "working")).toMatchObject({ medianSeconds: 1200 });
    expect(stat(all.workingNotes, "実装 〈数〉 回目")).toMatchObject({
      count: 3,
      medianSeconds: 1200,
    });
    expect(stat(all.turns, "待ち")).toMatchObject({ medianSeconds: 600 });
    expect(all.total).toMatchObject({
      totalSeconds: 7380,
      medianSeconds: 2100,
    });

    const since = JSON.parse(
      (await timing(root, ["--since", "2026-01-02", "--json"])).out,
    );
    expect(since.tasks).toBe(2);
    expect(stat(since.stages, "designing")).toMatchObject({
      medianSeconds: 390,
    });
    const text = await timing(root, ["--since", "2026-01-02"]);
    expect(text.out).toContain("統合済みのタスク 2 件");
    const bad = await timing(root, ["--since", "きのう"]);
    expect(bad.code).toBe(1);
  });
});
