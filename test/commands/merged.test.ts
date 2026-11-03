import { describe, expect, it } from "vitest";
import { requireConfig } from "../../src/config.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const commit = async (root: string, subject: string) => {
  await writeFiles(root, { [`f/${subject.replace(/\W/g, "_")}`]: "x\n" });
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", subject);
  return git(root, "rev-parse", "HEAD");
};

const merged = (cwd: string, args: string[]) =>
  runCli(["merged", ...args], { cwd, runner: fakeOrca().runner });

async function setup() {
  const root = await makeRepo();
  const name = (await requireConfig(root)).integratorName;
  const wt = await addTaskWorktree(root, "T20", "x", { "a.txt": "a\n" });
  await commit(root, `${name}: T11 をマージする`);
  const sha = await commit(root, "GitHub のマージ");
  await writePushRecord(testRunner, root, "T12", {
    id: "T12",
    branch: "task/T12-x",
    base: "main",
    pushedHead: "0".repeat(40),
    pushedAt: "2026-11-03T00:00:00Z",
    pr: null,
    mergeCommit: sha,
  });
  return { root, wt, sha };
}

describe("merged", () => {
  it("件名の行は「件名の行」、記録は「push の記録」で入った。全部入れば0", async () => {
    const { root } = await setup();
    const r = await merged(root, ["T11", "T12"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("T11：main に入っています（件名の行）");
    expect(r.out).toContain("T12：main に入っています（push の記録）");
  });

  it("1つでも入っていなければ1。--json の data は ref と ID ごとの結果", async () => {
    const { root } = await setup();
    const r = await merged(root, ["T11", "T99", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ref: "main",
      results: [
        { id: "T11", merged: true, by: "subject" },
        { id: "T99", merged: false, by: null },
      ],
    });
  });

  it("--ref で別の ref を見分ける", async () => {
    const { root } = await setup();
    const base = await git(root, "rev-parse", "HEAD~2");
    expect((await merged(root, ["T11"])).code).toBe(0);
    const r = await merged(root, ["T11", "--ref", base]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`T11：${base} に入っていません`);
  });

  it("push の記録の道でも --ref が効く（記録のコミットより前の ref には入っていない）", async () => {
    const { root } = await setup();
    const before = await git(root, "rev-parse", "HEAD~1");
    expect((await merged(root, ["T12"])).code).toBe(0);
    const r = await merged(root, ["T12", "--ref", before]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`T12：${before} に入っていません`);
  });

  it("読めない ref は1、ID なし・ID の形が違うも1", async () => {
    const { root } = await setup();
    const unreadable = await merged(root, ["T11", "--ref", "origin/main"]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.out).not.toContain("入っていません");
    expect(unreadable.err).toContain("読めません");
    expect((await merged(root, [])).code).toBe(1);
    const bad = await merged(root, ["x1", "T1a-b"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("x1");
  });

  it("どの作業ツリーから流しても同じ答え", async () => {
    const { root, wt } = await setup();
    const a = await merged(root, ["T11", "T12", "--json"]);
    const b = await merged(wt.path, ["T11", "T12", "--json"]);
    expect(b.code).toBe(a.code);
    expect(b.out).toBe(a.out);
  });

  it("init がまだなら2", async () => {
    const root = await makeRepo();
    await git(root, "rm", "--quiet", "-r", ".orca-flow");
    await git(root, "commit", "--quiet", "-m", "設定を消す");
    expect((await merged(root, ["T11"])).code).toBe(2);
  });
});
