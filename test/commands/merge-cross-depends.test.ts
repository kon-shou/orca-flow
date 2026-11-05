import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { readDepends, writeDependsAt } from "../../src/lib/depends.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import { addItem, updateState } from "../../src/lib/outbox.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, tempDir } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const done = (code: number, stdout = "", stderr = "") => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

const PACKAGE = "@acme/core";
const VERSION = "1.4.0";

interface RepoEntry {
  name: string;
  path: string;
  package: string;
  version: string;
  ids: string[];
}

/** gh だけを偽物にする。PR は承認済みで開いている */
async function setup(options: {
  landed: string[];
  bump: boolean;
  /** 件名の行だけで、依存先の push の記録は書かない */
  subjectOnly?: boolean;
  /** 依存先に PR はあるがマージのコミットがない記録を書く */
  prOpen?: string[];
  /** 件名の行は置かず、マージのコミットつきの push の記録だけを書く */
  recordOnly?: string[];
}) {
  const dep = await makeRepo({ idPrefix: "S" });
  const depRecord = async (id: string, merge: boolean) =>
    writePushRecord(testRunner, dep, id, {
      id,
      branch: `task/${id}-x`,
      base: "main",
      pushedHead: "0".repeat(40),
      pushedAt: "2026-11-04T00:00:00Z",
      pr: { number: 3, url: "https://example.invalid/pull/3" },
      ...(merge ? { mergeCommit: await git(dep, "rev-parse", "HEAD") } : {}),
    });
  for (const id of options.landed) {
    await git(
      dep,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      `統括役: ${id} をマージする`,
    );
    if (!options.subjectOnly) await depRecord(id, true);
  }
  for (const id of options.prOpen ?? []) await depRecord(id, false);
  for (const id of options.recordOnly ?? []) {
    await git(
      dep,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      `${id} の中身（PR のマージ）`,
    );
    await depRecord(id, true);
  }
  const root = await makeRepo({});
  const origin = path.join(await tempDir("orca-flow-origin-"), "origin.git");
  await git(
    path.dirname(origin),
    "init",
    "--quiet",
    "--bare",
    "-b",
    "main",
    origin,
  );
  await git(root, "remote", "add", "origin", "https://github.com/o/r.git");
  await git(
    root,
    "config",
    `url.${origin}.insteadOf`,
    "https://github.com/o/r.git",
  );
  await git(root, "push", "--quiet", "origin", "main");
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "src/a.ts": "a\n",
    ...(options.bump
      ? { "package.json": `{ "${PACKAGE}": "^${VERSION}" }\n` }
      : {}),
  });
  const head = await git(wt.path, "rev-parse", "HEAD");
  const common = path.join(root, ".git");
  await writePushRecord(testRunner, root, "T12", {
    id: "T12",
    branch: wt.branch,
    base: "main",
    pushedHead: head,
    pushedAt: "2026-11-04T00:00:00Z",
    pr: { number: 7, url: "https://example.invalid/pull/7" },
  });
  const { item } = await addItem(
    common,
    {
      taskId: "T12",
      kind: "push",
      body: "",
      head,
      target: { remote: "origin", branch: wt.branch, base: "main", pr: null },
    },
    {},
    new Date("2026-11-04T00:00:00Z"),
  );
  await updateState(common, item, "sent", new Date("2026-11-04T00:00:00Z"));

  const merges: string[][] = [];
  const orca = fakeOrca();
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "gh") {
      if (args[0] === "--version" || args[0] === "auth") return done(0, "ok");
      if (args[0] === "repo" && args[1] === "view")
        return done(
          0,
          JSON.stringify({
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: true,
          }),
        );
      if (args[0] === "api" && args[1] === "graphql")
        return done(
          0,
          JSON.stringify({
            data: {
              rateLimit: { cost: 1, remaining: 100, resetAt: "" },
              repository: {
                pr_7: {
                  number: 7,
                  url: "https://example.invalid/pull/7",
                  state: merges.length > 0 ? "MERGED" : "OPEN",
                  isDraft: false,
                  updatedAt: "2026-11-04T00:00:00Z",
                  headRefOid: head,
                  headRefName: wt.branch,
                  mergedAt: merges.length > 0 ? "2026-11-04T01:00:00Z" : null,
                  mergeCommit: merges.length > 0 ? { oid: head } : null,
                  reviewDecision: "APPROVED",
                  mergeStateStatus: "CLEAN",
                  commits: { nodes: [] },
                  reviews: { nodes: [] },
                  comments: { nodes: [] },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: { hasPreviousPage: false, startCursor: "0" },
                    nodes: [],
                  },
                },
              },
            },
          }),
        );
      if (args[0] === "pr" && args[1] === "view")
        return done(
          0,
          JSON.stringify({
            number: 7,
            url: "https://example.invalid/pull/7",
            isDraft: false,
            state: merges.length > 0 ? "MERGED" : "OPEN",
            headRefOid: head,
            statusCheckRollup: [],
            isCrossRepository: false,
            mergeCommit: merges.length > 0 ? { oid: head } : null,
            mergedAt: merges.length > 0 ? "2026-11-04T01:00:00Z" : null,
          }),
        );
      if (args[0] === "pr" && args[1] === "merge") {
        merges.push([...args]);
        return done(0);
      }
      return done(0);
    }
    return orca.runner(cmd, args, opts);
  };
  const merge = (...argv: string[]) =>
    runCli(["merge", "T12", ...argv], { cwd: root, runner });
  return { root, dep, head, common, merges, merge };
}

const recordFile = (root: string) =>
  path.join(root, ".git", "orca-flow", "cross-depends", "T12.json");

async function writeRecord(root: string, repos: RepoEntry[]) {
  await mkdir(path.dirname(recordFile(root)), { recursive: true });
  await writeFile(
    recordFile(root),
    JSON.stringify({ id: "T12", at: "2026-11-04T00:00:00.000Z", repos }),
  );
}

const entry = (dep: string, ids: string[]): RepoEntry => ({
  name: "core",
  path: dep,
  package: PACKAGE,
  version: VERSION,
  ids,
});

describe("merge：またぐ依存の門", () => {
  it("外れていれば --show に出る", async () => {
    const t = await setup({ landed: [], bump: false });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const result = await t.merge("--show");
    expect(result.code).toBe(0);
    expect(result.out).toContain("core:S5");
    expect(result.out).toContain("版上げ");
    expect(result.out).toContain("外れた確かめがあります");
  });

  it("外れていれば --head はマージを呼ばず終了コード2", async () => {
    const t = await setup({ landed: [], bump: true });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(result.err).toContain("core:S5");
    expect(t.merges).toEqual([]);
  });

  it("依存先が入っていて版上げがあれば通る", async () => {
    const t = await setup({ landed: ["S5"], bump: true });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const result = await t.merge("--show");
    expect(result.out).toContain("通りました");
    expect(result.out).toContain(
      "またぐ依存：OK（依存先が PR でマージされていて、版上げがあります）",
    );
  });

  it("件名の行だけ：--show に「PR でマージされていません」と integrate の言葉、--head は2で止まる（--head と --show の両方）", async () => {
    const t = await setup({ landed: ["S5"], bump: true, subjectOnly: true });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const show = await t.merge("--show");
    expect(show.out).toContain("core:S5 が core で PR でマージされていません");
    expect(show.out).toContain("integrate で入れたものは数えない");
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(result.err).toContain("PR でマージされていません");
    expect(t.merges).toEqual([]);
  });

  it("PR はあるがマージのコミットがない：依存先での /orca-flow:push の案内が出る", async () => {
    const t = await setup({ landed: [], bump: true, prOpen: ["S5"] });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(result.err).toContain("PR でマージされていません");
    expect(result.err).toContain("/orca-flow:push S5");
  });

  it("依存先がどこにも入っていなければ「PR でマージされていません」で止まる", async () => {
    const t = await setup({ landed: [], bump: true });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      "core:S5 が core で PR でマージされていません",
    );
    expect(result.err).not.toContain("integrate で入れた");
  });

  it("件名の行と push の記録の両方があり、マージのコミットが祖先なら --head も通る", async () => {
    const t = await setup({ landed: ["S5"], bump: true });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("PR でマージされていません");
    expect(t.merges.length).toBe(1);
  });

  it("件名の行がなく、push の記録（マージのコミットつき）だけで入った依存先は --show も --head も通る", async () => {
    const t = await setup({ landed: [], bump: true, recordOnly: ["S5"] });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const show = await t.merge("--show");
    expect(show.out).toContain("通りました");
    expect(show.out).not.toContain("PR でマージされていません");
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("PR でマージされていません");
    expect(t.merges.length).toBe(1);
  });

  it("--drop-depend 〈名前〉:〈ID〉 で記録から外れ、最後の ID が外れたリポジトリは消える", async () => {
    const t = await setup({ landed: [], bump: true });
    await writeRecord(t.root, [
      entry(t.dep, ["S5", "S6"]),
      { ...entry(t.dep, ["S7"]), name: "other", package: "@acme/other" },
    ]);
    const first = await t.merge("--drop-depend", "core:S5");
    expect(first.code).toBe(0);
    expect(t.merges).toEqual([]);
    const record = JSON.parse(await readFile(recordFile(t.root), "utf8"));
    expect(record.repos[0].ids).toEqual(["S6"]);
    const second = await t.merge("--drop-depend", "core:S6,other:S7");
    expect(second.code).toBe(0);
    expect(existsSync(recordFile(t.root))).toBe(false);
  });

  it("今の依存の ID と 〈名前〉:〈ID〉 を混ぜると、それぞれの記録から外れる", async () => {
    const t = await setup({ landed: [], bump: true });
    await writeDependsAt(t.common, "T12", ["T3", "T4"], new Date());
    await writeRecord(t.root, [entry(t.dep, ["S5", "S6"])]);
    const result = await t.merge("--drop-depend", "T3,core:S5");
    expect(result.code).toBe(0);
    expect(await readDepends(testRunner, t.root, "T12")).toEqual(["T4"]);
    const record = JSON.parse(await readFile(recordFile(t.root), "utf8"));
    expect(record.repos[0].ids).toEqual(["S6"]);
  });

  it("記録にない 〈名前〉:〈ID〉 だけなら終了コード1で何も変えない", async () => {
    const t = await setup({ landed: [], bump: true });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const result = await t.merge("--drop-depend", "core:S9");
    expect(result.code).toBe(1);
    const record = JSON.parse(await readFile(recordFile(t.root), "utf8"));
    expect(record.repos[0].ids).toEqual(["S5"]);
  });

  it("push のあとに手元だけで版上げを足しても、--show も --head も外れになる", async () => {
    const t = await setup({ landed: ["S5"], bump: false });
    await writeRecord(t.root, [entry(t.dep, ["S5"])]);
    const wtPath = (await git(t.root, "worktree", "list", "--porcelain"))
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9))
      .find((p) => p !== t.root)!;
    await writeFile(
      path.join(wtPath, "package.json"),
      `{ "${PACKAGE}": "^${VERSION}" }\n`,
    );
    await git(wtPath, "add", "-A");
    await git(wtPath, "commit", "--quiet", "-m", "T12: 手元だけの版上げ");
    const show = await t.merge("--show");
    expect(show.out).toContain("版上げ");
    expect(show.out).toContain("外れた確かめがあります");
    const result = await t.merge("--head", t.head);
    expect(result.code).toBe(2);
    expect(result.err).toContain("版上げ");
    expect(t.merges).toEqual([]);
  });

  it("--drop-depend で片方の種類だけを外すと、もう片方が残りに出る", async () => {
    const t = await setup({ landed: [], bump: true });
    await writeDependsAt(t.common, "T12", ["T3"], new Date());
    await writeRecord(t.root, [entry(t.dep, ["S1", "S5"])]);
    const result = await t.merge("--drop-depend", "T3");
    expect(result.code).toBe(0);
    expect(result.out).toContain("残り：core:S1、core:S5");
    const other = await t.merge("--drop-depend", "core:S1");
    expect(other.out).toContain("残り：core:S5");
    expect(other.out).not.toContain("残り：なし");
  });

  it("--drop-depend の --json の left と crossLeft に両方の残りが出る", async () => {
    const t = await setup({ landed: [], bump: true });
    await writeDependsAt(t.common, "T12", ["T3", "T4"], new Date());
    await writeRecord(t.root, [entry(t.dep, ["S1"])]);
    const result = await t.merge("--drop-depend", "T3", "--json");
    const data = JSON.parse(result.out);
    expect(JSON.stringify(data)).toContain("T4");
    expect(JSON.stringify(data)).toContain("core:S1");
  });

  it("記録がなければ --show は「記録なし」と出し、版上げがあるとは言わない", async () => {
    const t = await setup({ landed: [], bump: false });
    const result = await t.merge("--show");
    expect(result.out).toContain("またぐ依存：OK（記録なし）");
    expect(result.out).not.toContain("版上げがあります");
  });
});
