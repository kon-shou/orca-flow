import { describe, expect, it } from "vitest";
import { requireConfig } from "../../src/config.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import { taskMergedInto } from "../../src/lib/merged.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const commit = async (root: string, subject: string, file = subject) => {
  await writeFiles(root, { [`f/${file.replace(/\W/g, "_")}`]: `${subject}\n` });
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", subject);
  return git(root, "rev-parse", "HEAD");
};

const record = (root: string, id: string, extra: Record<string, unknown>) =>
  writePushRecord(testRunner, root, id, {
    id,
    branch: `task/${id}-x`,
    base: "main",
    pushedHead: "0".repeat(40),
    pushedAt: "2026-11-03T00:00:00Z",
    pr: null,
    ...extra,
  });

const check = async (root: string, id: string, ref = "main") =>
  taskMergedInto(testRunner, root, await requireConfig(root), id, ref);

describe("taskMergedInto", () => {
  it("件名の行があれば「件名の行」で入った", async () => {
    const root = await makeRepo();
    const name = (await requireConfig(root)).integratorName;
    await commit(root, `${name}: T12 をマージする`);
    expect(await check(root, "T12")).toEqual({ merged: true, by: "subject" });
  });

  it("部分一致の行（ID の後ろに数が続く）は入ったとみなさない", async () => {
    const root = await makeRepo();
    const name = (await requireConfig(root)).integratorName;
    await commit(root, `${name}: T123 をマージする`);
    await commit(root, `${name}: T12 をマージする 以降`);
    expect(await check(root, "T12")).toEqual({ merged: false, by: null });
  });

  it("件名の行がなく、記録のコミットが ref の祖先なら「push の記録」で入った", async () => {
    const root = await makeRepo();
    const sha = await commit(root, "GitHub のマージ");
    await record(root, "T12", { mergeCommit: sha });
    expect(await check(root, "T12")).toEqual({
      merged: true,
      by: "push-record",
    });
  });

  it("件名の行を先に見る（記録もあっても「件名の行」）", async () => {
    const root = await makeRepo();
    const name = (await requireConfig(root)).integratorName;
    const sha = await commit(root, `${name}: T12 をマージする`);
    await record(root, "T12", { mergeCommit: sha });
    expect((await check(root, "T12")).by).toBe("subject");
  });

  it("記録のコミットが祖先でないときは入っていない", async () => {
    const root = await makeRepo();
    await git(root, "switch", "--quiet", "-c", "side");
    const sha = await commit(root, "別の枝");
    await git(root, "switch", "--quiet", "main");
    await record(root, "T12", { mergeCommit: sha });
    expect(await check(root, "T12")).toEqual({ merged: false, by: null });
  });

  it("手元にないコミット（128）・記録がない・名前の形でない値は入っていない", async () => {
    const root = await makeRepo();
    expect(await check(root, "T12")).toEqual({ merged: false, by: null });
    await record(root, "T12", { mergeCommit: "a".repeat(40) });
    expect(await check(root, "T12")).toEqual({ merged: false, by: null });
    // 形が違う値は git に渡さない（main や HEAD は ref として読めてしまう）
    for (const value of ["main", "HEAD", "--all", "", 1, null, "1" + "x"]) {
      await record(root, "T12", { mergeCommit: value });
      const calls: string[][] = [];
      const spy: typeof testRunner = (cmd, args, opts) => {
        calls.push([...args]);
        return testRunner(cmd, args, opts);
      };
      const r = await taskMergedInto(
        spy,
        root,
        await requireConfig(root),
        "T12",
        "main",
      );
      expect(r).toEqual({ merged: false, by: null });
      expect(calls.some((a) => a.includes("--is-ancestor"))).toBe(false);
    }
  });

  it("ref が読めなければ投げる", async () => {
    const root = await makeRepo();
    await expect(check(root, "T12", "origin/main")).rejects.toMatchObject({
      code: 1,
    });
    await expect(check(root, "T12", "--all")).rejects.toMatchObject({
      code: 1,
    });
  });

  it("別の ref で見分ける", async () => {
    const root = await makeRepo();
    const base = await git(root, "rev-parse", "HEAD");
    const name = (await requireConfig(root)).integratorName;
    await commit(root, `${name}: T12 をマージする`);
    expect((await check(root, "T12", "main")).merged).toBe(true);
    expect((await check(root, "T12", base)).merged).toBe(false);
  });

  it("push の記録の道でも ref を見る（記録のコミットより前の ref には入っていない）", async () => {
    const root = await makeRepo();
    const before = await git(root, "rev-parse", "HEAD");
    const sha = await commit(root, "GitHub のマージ");
    await record(root, "T12", { mergeCommit: sha });
    expect(await check(root, "T12", "main")).toEqual({
      merged: true,
      by: "push-record",
    });
    expect(await check(root, "T12", before)).toEqual({
      merged: false,
      by: null,
    });
  });

  it("countSubject:false：件名の行だけでは入ったとみなさず、記録のコミットが祖先なら push の記録で入る", async () => {
    const root = await makeRepo();
    const config = await requireConfig(root);
    const sha = await commit(
      root,
      `${config.integratorName}: T12 をマージする`,
    );
    const only = { countSubject: false };
    expect(
      await taskMergedInto(testRunner, root, config, "T12", "main", only),
    ).toEqual({ merged: false, by: null });
    await record(root, "T12", { mergeCommit: sha });
    expect(
      await taskMergedInto(testRunner, root, config, "T12", "main", only),
    ).toEqual({ merged: true, by: "push-record" });
    // 既定は変わらない
    expect((await check(root, "T12")).by).toBe("subject");
  });
});
