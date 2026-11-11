import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planAppBump, smallestStableVersion } from "../../src/lib/app-bump.ts";
import {
  writeCrossDepends,
  type CrossDependsRepo,
} from "../../src/lib/cross-depends.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import { FlowError } from "../../src/types.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { testRunner } from "../helpers/runner.ts";

const BRANCH = "task/T05-lib";

/** 共通（origin つき）と、共通の枝を取り込んだアプリのタスクを作る */
async function setup(options: { lockHead?: string } = {}) {
  const origin = await tempDir("orca-flow-origin-");
  await git(origin, "init", "--bare", "--quiet", "-b", "main");
  const common = await makeRepo();
  await git(common, "remote", "add", "origin", origin);
  await git(common, "push", "--quiet", "origin", "main");
  const pushedHead = await git(common, "rev-parse", "HEAD");

  const app = await makeRepo();
  const lock = options.lockHead ?? pushedHead;
  const task = await addTaskWorktree(app, "T01", "x", {
    "composer.json": `{"require":{"acme/core-kit":"dev-${BRANCH}"}}\n`,
    "composer.lock": `{"name":"acme/core-kit","version":"dev-${BRANCH}","reference":"${lock}"}\n`,
  });
  const repo: CrossDependsRepo = {
    name: "core-kit",
    path: common,
    package: "acme/core-kit",
    branch: BRANCH,
    branchCommand: `composer require acme/core-kit:dev-{branch}`,
    bumpCommand: "composer require acme/core-kit:^1",
    ids: ["T05"],
  };
  await writeCrossDepends(testRunner, app, "T01", [repo]);
  return { origin, common, app, task, repo, pushedHead };
}

/** 共通の main に PR のマージのコミットを足し、push の記録に残して origin へ送る */
async function mergeCommon(
  common: string,
  pushedHead: string,
  id = "T05",
  file = "feature.txt",
) {
  await writeFiles(common, { [file]: "x\n" });
  await git(common, "add", "-A");
  await git(common, "commit", "--quiet", "-m", "GitHub のマージ");
  const mergeCommit = await git(common, "rev-parse", "HEAD");
  await git(common, "push", "--quiet", "origin", "main");
  await writePushRecord(testRunner, common, id, {
    id,
    branch: BRANCH,
    base: "main",
    pushedHead,
    pushedAt: "2026-11-03T00:00:00Z",
    pr: { number: 1, url: "https://example.invalid/pr/1" },
    mergeCommit,
  });
  return mergeCommit;
}

const tagOrigin = (origin: string, name: string, commit: string) =>
  git(origin, "tag", name, commit);

/** ディレクトリの下のファイルの並びと中身 */
async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    out[path.relative(dir, file)] = await readFile(file, "utf8");
  }
  return out;
}

describe("smallestStableVersion", () => {
  it("v数.数.数の中で一番小さい版を返し、前置きつきは数えない", () => {
    expect(smallestStableVersion(["v1.3.0", "v1.2.0", "v1.10.0"])).toBe(
      "1.2.0",
    );
    expect(smallestStableVersion(["v1.2.0-rc.1", "1.2.0", "v1.2"])).toBeNull();
    expect(smallestStableVersion(["v1.2.0-rc.1", "v2.0.0"])).toBe("2.0.0");
    expect(smallestStableVersion(["v1.9.0", "v1.10.0"])).toBe("1.9.0");
  });
});

describe("planAppBump", () => {
  it("記録がなければ null、branch のない要素（--bumps）は判定しない", async () => {
    const { app, repo } = await setup();
    expect(await planAppBump(testRunner, app, "T09", BRANCH)).toBeNull();
    await writeCrossDepends(testRunner, app, "T01", [
      {
        ...repo,
        branch: undefined,
        branchCommand: undefined,
        version: "1.0.0",
      },
    ]);
    expect(await planAppBump(testRunner, app, "T01", "task/T01-x")).toEqual([]);
  });

  it("壊れた記録は FlowError(1)", async () => {
    const { app } = await setup();
    const common = await git(
      app,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    await writeFiles(common, { "orca-flow/cross-depends/T01.json": "{" });
    await expect(
      planAppBump(testRunner, app, "T01", "task/T01-x"),
    ).rejects.toBeInstanceOf(FlowError);
  });

  it("マージされ、マージを含むタグが v1.2.0 と v1.3.0 なら、版 1.2.0 で bump", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.3.0", mergeCommit);
    await tagOrigin(origin, "v1.2.0", mergeCommit);
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan).toEqual([
      {
        name: "core-kit",
        branch: BRANCH,
        verdict: "bump",
        version: "1.2.0",
        key: "bump:core-kit:1.2.0",
        reason: expect.stringContaining("1.2.0"),
      },
    ]);
  });

  it("マージより前のコミットだけを含むタグは数えない", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    await tagOrigin(origin, "v0.9.0", pushedHead);
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.0.0", mergeCommit);
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan?.[0]).toMatchObject({ verdict: "bump", version: "1.0.0" });
  });

  it("前置きつきのタグだけなら wait", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.2.0-rc.1", mergeCommit);
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan?.[0]).toMatchObject({
      verdict: "wait",
      version: null,
      key: null,
    });
  });

  it("タグを取ってこられないときは wait と理由を返し、共通のブランチ・作業ツリーを動かさない", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.2.0", mergeCommit);
    await git(common, "remote", "set-url", "origin", `${origin}-missing`);
    const before = await git(
      common,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    );
    const head = await git(common, "rev-parse", "HEAD");
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan?.[0]?.verdict).toBe("wait");
    expect(plan?.[0]?.reason).toContain("タグ");
    expect(await git(common, "rev-parse", "HEAD")).toBe(head);
    expect(await git(common, "status", "--porcelain")).toBe("");
    expect(
      await git(common, "for-each-ref", "--format=%(refname) %(objectname)"),
    ).toBe(before);
  });

  it("タグの取得は、共通のブランチ・作業ツリー・FETCH_HEAD を動かさない", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.2.0", mergeCommit);
    const heads = await git(
      common,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes",
    );
    const commonDir = await git(
      common,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const recordBefore = await snapshotDir(path.join(commonDir, "orca-flow"));
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan?.[0]?.verdict).toBe("bump");
    await expect(stat(path.join(commonDir, "FETCH_HEAD"))).rejects.toThrow();
    expect(await snapshotDir(path.join(commonDir, "orca-flow"))).toEqual(
      recordBefore,
    );
    expect(
      await git(
        common,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/remotes",
      ),
    ).toBe(heads);
    expect(await git(common, "status", "--porcelain")).toBe("");
    expect(await git(common, "tag", "--list")).toBe("v1.2.0");
  });

  it("まだマージされておらず、push した先頭がロックファイルにないなら reimport", async () => {
    const { app, task, common } = await setup({ lockHead: "a".repeat(40) });
    const pushedHead = await git(common, "rev-parse", "HEAD");
    await writePushRecord(testRunner, common, "T05", {
      id: "T05",
      branch: BRANCH,
      base: "main",
      pushedHead,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: null,
    });
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan).toEqual([
      expect.objectContaining({
        verdict: "reimport",
        version: null,
        key: `reimport:core-kit:${pushedHead.slice(0, 12)}`,
      }),
    ]);
  });

  it("push した先頭がロックファイルにあれば wait。push の記録がなくても wait", async () => {
    const { app, task, common, pushedHead } = await setup();
    const none = await planAppBump(testRunner, app, "T01", task.branch);
    expect(none?.[0]).toMatchObject({ verdict: "wait", key: null });
    await writePushRecord(testRunner, common, "T05", {
      id: "T05",
      branch: BRANCH,
      base: "main",
      pushedHead,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: null,
    });
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan?.[0]).toMatchObject({ verdict: "wait", key: null });
  });

  it("利用者の fetch.prune の設定があっても、手元にしかないタグを消さない", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.2.0", mergeCommit);
    await git(common, "tag", "v9.9.9", mergeCommit);
    await git(common, "config", "fetch.prune", "true");
    await git(common, "config", "fetch.pruneTags", "true");
    await git(common, "config", "remote.origin.prune", "true");
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan?.[0]).toMatchObject({ verdict: "bump", version: "1.2.0" });
    expect((await git(common, "tag", "--list")).split("\n").sort()).toEqual([
      "v1.2.0",
      "v9.9.9",
    ]);
  });

  it("origin でタグが付け直されて取得が終了コード1でも、新しいタグで版を上げる", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.0.0", pushedHead);
    await git(common, "fetch", "--quiet", "origin", "refs/tags/*:refs/tags/*");
    await git(origin, "tag", "-f", "v1.0.0", mergeCommit);
    await tagOrigin(origin, "v1.1.0", mergeCommit);
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan?.[0]).toMatchObject({ verdict: "bump", version: "1.1.0" });
    // 手元のタグは上書きしない
    expect(await git(common, "rev-parse", "v1.0.0")).toBe(pushedHead);
  });

  it("付け直しで取得が失敗し版も出ないときは、error: などの行を理由にして wait", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.0.0", pushedHead);
    await git(common, "fetch", "--quiet", "origin", "refs/tags/*:refs/tags/*");
    await git(origin, "tag", "-f", "v1.0.0", mergeCommit);
    const plan = await planAppBump(testRunner, app, "T01", task.branch);
    expect(plan?.[0]?.verdict).toBe("wait");
    expect(plan?.[0]?.reason).not.toMatch(/：From /);
    expect(plan?.[0]?.reason).toMatch(/clobber|！|!|error|fatal/);
  });

  it("取得の失敗の文のトークンは理由に出さない", async () => {
    const { app, task, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.2.0", mergeCommit);
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const runner: Runner = async (cmd, args, opts) =>
      cmd === "git" && args.includes("fetch")
        ? {
            code: 128,
            stdout: "",
            stderr: `fatal: unable to access 'https://${token}@example.invalid/x.git/'`,
            timedOut: false,
          }
        : testRunner(cmd, args, opts);
    const plan = await planAppBump(runner, app, "T01", task.branch, {
      env: { ...process.env, GH_TOKEN: "secret-value-for-test" },
    });
    // 手元にまだタグがないので wait
    expect(plan?.[0]?.verdict).toBe("wait");
    expect(plan?.[0]?.reason).toContain("fatal:");
    expect(plan?.[0]?.reason).not.toContain(token);
    expect(plan?.[0]?.reason).not.toContain("secret-value-for-test");
  });

  describe("共通に ID が2つあるとき", () => {
    async function twoIds() {
      const s = await setup();
      const first = await mergeCommon(s.common, s.pushedHead);
      const second = await mergeCommon(s.common, first, "T06", "feature2.txt");
      await writeCrossDepends(testRunner, s.app, "T01", [
        { ...s.repo, ids: ["T05", "T06"] },
      ]);
      return { ...s, first, second };
    }

    it("1つ目のマージだけを含むタグは版にせず、両方を含む一番小さいタグで bump", async () => {
      const { app, task, origin, first, second } = await twoIds();
      await tagOrigin(origin, "v1.0.0", first);
      const waiting = await planAppBump(testRunner, app, "T01", task.branch);
      expect(waiting?.[0]).toMatchObject({ verdict: "wait", version: null });
      await tagOrigin(origin, "v1.2.0", second);
      await tagOrigin(origin, "v1.3.0", second);
      const plan = await planAppBump(testRunner, app, "T01", task.branch);
      expect(plan?.[0]).toMatchObject({ verdict: "bump", version: "1.2.0" });
    });

    it("片方だけマージ済みなら bump にならない", async () => {
      const s = await setup();
      const first = await mergeCommon(s.common, s.pushedHead);
      await tagOrigin(s.origin, "v1.0.0", first);
      await writePushRecord(testRunner, s.common, "T06", {
        id: "T06",
        branch: BRANCH,
        base: "main",
        pushedHead: s.pushedHead,
        pushedAt: "2026-11-03T00:00:00Z",
        pr: null,
      });
      await writeCrossDepends(testRunner, s.app, "T01", [
        { ...s.repo, ids: ["T05", "T06"] },
      ]);
      const plan = await planAppBump(testRunner, s.app, "T01", s.task.branch);
      expect(plan?.[0]?.verdict).not.toBe("bump");
    });

    it("どれかの先頭がロックファイルに入っていれば wait", async () => {
      const s = await setup();
      await writeFiles(s.common, { "other.txt": "y\n" });
      await git(s.common, "add", "-A");
      await git(s.common, "commit", "--quiet", "-m", "別の先頭");
      const other = await git(s.common, "rev-parse", "HEAD");
      for (const [id, head] of [
        ["T05", other],
        ["T06", s.pushedHead],
      ] as const)
        await writePushRecord(testRunner, s.common, id, {
          id,
          branch: BRANCH,
          base: "main",
          pushedHead: head,
          pushedAt: "2026-11-03T00:00:00Z",
          pr: null,
        });
      await writeCrossDepends(testRunner, s.app, "T01", [
        { ...s.repo, ids: ["T05", "T06"] },
      ]);
      // ロックファイルには T06 の先頭だけがある
      const plan = await planAppBump(testRunner, s.app, "T01", s.task.branch);
      expect(plan?.[0]).toMatchObject({ verdict: "wait", key: null });
    });
  });

  it("取り込み直しの判定は、作業ツリーでなくブランチの先頭のロックファイルを読む", async () => {
    // ブランチの先頭が古く、作業ツリーだけを新しくしても reimport
    const old = await setup({ lockHead: "a".repeat(40) });
    const head = await git(old.common, "rev-parse", "HEAD");
    await writePushRecord(testRunner, old.common, "T05", {
      id: "T05",
      branch: BRANCH,
      base: "main",
      pushedHead: head,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: null,
    });
    await writeFiles(old.task.path, {
      "composer.lock": `{"reference":"${head}"}\n`,
    });
    const a = await planAppBump(testRunner, old.app, "T01", old.task.branch);
    expect(a?.[0]?.verdict).toBe("reimport");

    // ブランチの先頭が新しく、作業ツリーだけを古くしても wait
    const fresh = await setup();
    await writePushRecord(testRunner, fresh.common, "T05", {
      id: "T05",
      branch: BRANCH,
      base: "main",
      pushedHead: fresh.pushedHead,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: null,
    });
    await writeFiles(fresh.task.path, {
      "composer.lock": `{"reference":"${"b".repeat(40)}"}\n`,
    });
    const b = await planAppBump(
      testRunner,
      fresh.app,
      "T01",
      fresh.task.branch,
    );
    expect(b?.[0]).toMatchObject({ verdict: "wait", key: null });
  });

  it("枝の名前がロックファイルから消えていれば done", async () => {
    const { app, origin, common, pushedHead } = await setup();
    const mergeCommit = await mergeCommon(common, pushedHead);
    await tagOrigin(origin, "v1.2.0", mergeCommit);
    const done = await addTaskWorktree(app, "T02", "y", {
      "composer.json": `{"require":{"acme/core-kit":"^1.2"}}\n`,
    });
    await writeCrossDepends(testRunner, app, "T02", [
      {
        name: "core-kit",
        path: common,
        package: "acme/core-kit",
        branch: BRANCH,
        branchCommand: "composer require acme/core-kit:dev-{branch}",
        bumpCommand: "composer require acme/core-kit:^1",
        ids: ["T05"],
      },
    ]);
    const plan = await planAppBump(testRunner, app, "T02", done.branch);
    expect(plan?.[0]).toMatchObject({
      verdict: "done",
      version: null,
      key: null,
    });
  });
});
