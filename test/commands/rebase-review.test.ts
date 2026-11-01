import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readReviewed } from "../../src/lib/rebase-review.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

async function setup() {
  const root = await makeRepo({}, { "f.txt": "1\n2\n3\n4\n5\n" });
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["f.txt"] }),
  });
  await writeFiles(wt.path, {
    "f.txt": "1\n2\n3\nNEW\n4\n5\n",
    "docs/tasks/reports/T12.md": "報告\n",
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  return { root, wt };
}

const review = (cwd: string, ...args: string[]) =>
  runCli(["rebase-review", ...args], { cwd, runner: fakeOrca().runner });

describe("rebase-review", () => {
  it("--done：今の HEAD のタスク自身の変更で記録を書く", async () => {
    const { wt } = await setup();
    const result = await review(wt.path, "--done", "--json");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out);
    expect(data).toMatchObject({ id: "T12", recorded: true });
    const record = await readReviewed(testRunner, wt.path, "T12");
    expect(record?.head).toBe(await git(wt.path, "rev-parse", "HEAD"));
    expect(record?.fingerprint).toBe(data.fingerprint);
  });

  it("変わらない rebase（前後の行と行番号だけの違い）は終了コード0で記録を書く", async () => {
    const { root, wt } = await setup();
    const before = await git(wt.path, "rev-parse", "HEAD");
    await writeFiles(root, { "f.txt": "0\n1\n2\n3\n4\n5\n" });
    await git(root, "commit", "--quiet", "-am", "main が進む");
    await git(wt.path, "rebase", "--quiet", "main");
    const result = await review(wt.path, before, "--json");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      same: true,
      recorded: true,
      files: [],
    });
    expect(await readReviewed(testRunner, wt.path, "T12")).not.toBeNull();
  });

  it("main が前後の行だけを変えた rebase（競合なし）は終了コード0で、指紋が同じ", async () => {
    const root = await makeRepo({}, { "f.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n" });
    const wt = await addTaskWorktree(root, "T12", "shop", {
      "docs/tasks/T12.md": specDoc("T12", { allowed: ["f.txt"] }),
    });
    await writeFiles(wt.path, {
      "f.txt": "1\n2\n3\n4\n5\n6\n7\n8\nNEW\n9\n",
      "docs/tasks/reports/T12.md": "報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
    const before = await git(wt.path, "rev-parse", "HEAD");
    const first = await review(wt.path, "--done", "--json");
    // main が、タスクの変更の3行前（diff の前後の行）を変える
    await writeFiles(root, { "f.txt": "1\n2\n3\n4\n5\nSIX\n7\n8\n9\n" });
    await git(root, "commit", "--quiet", "-am", "main が前後の行を変える");
    const rebase = await testRunner("git", ["rebase", "main"], {
      cwd: wt.path,
    });
    expect(rebase.code).toBe(0);
    const result = await review(wt.path, before, "--json");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out);
    expect(data).toMatchObject({ same: true, recorded: true, files: [] });
    expect(data.fingerprint).toBe(JSON.parse(first.out).fingerprint);
  });

  it("人が読む出力は、見直しを記録したことを言う", async () => {
    const { wt } = await setup();
    const result = await review(wt.path, "HEAD");
    expect(result.code).toBe(0);
    expect(result.out).toContain("見直しを記録しました");
  });

  it("変わった rebase（競合を直した）は終了コード1で、変わった行だけを出し、記録を書かない", async () => {
    const { root, wt } = await setup();
    const before = await git(wt.path, "rev-parse", "HEAD");
    // 同じ場所を main も変えて競合させ、直し方を変える
    await writeFiles(root, { "f.txt": "1\n2\n3\nMAIN\n4\n5\n" });
    await git(root, "commit", "--quiet", "-am", "main が同じ場所を変える");
    const rebase = await testRunner("git", ["rebase", "main"], {
      cwd: wt.path,
    });
    expect(rebase.code).not.toBe(0);
    await writeFiles(wt.path, { "f.txt": "1\n2\n3\nMAIN\nNEW2\n4\n5\n" });
    await git(wt.path, "add", "f.txt");
    const cont = await testRunner("git", ["rebase", "--continue"], {
      cwd: wt.path,
      env: { ...process.env, GIT_EDITOR: "true" },
    });
    expect(cont.code).toBe(0);
    const result = await review(wt.path, before);
    expect(result.code).toBe(1);
    expect(result.out).toContain("f.txt");
    expect(result.out).toContain("前にだけ：+NEW");
    expect(result.out).toContain("今にだけ：+NEW2");
    expect(result.out).not.toContain("+MAIN");
    expect(await readReviewed(testRunner, wt.path, "T12")).toBeNull();
    const json = await review(wt.path, before, "--json");
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({
      same: false,
      recorded: false,
      files: [
        {
          file: "f.txt",
          onlyBefore: ["+NEW"],
          onlyNow: ["+NEW2"],
          reordered: false,
        },
      ],
    });
  });

  it("引数の誤り・見つからないコミット・タスク以外の場所は終了コード1", async () => {
    const { root, wt } = await setup();
    expect((await review(wt.path)).code).toBe(1);
    expect((await review(wt.path, "--done", "HEAD")).code).toBe(1);
    const missing = await review(wt.path, "0".repeat(40));
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("見つかりません");
    expect((await review(root, "--done")).code).toBe(1);
    expect(
      existsSync(path.join(root, ".git", "orca-flow", "reviewed", "T12.json")),
    ).toBe(false);
  });
});
