import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANCH_PACKAGE_FILES,
  branchPushFileAt,
  isPackageFile,
  lineHasBranch,
  readBranchPushMark,
  readBranchPushMarkAt,
  removeBranchPushMarkAt,
  writeBranchPushMarkAt,
} from "../../src/lib/branch-push.ts";
import { tempDir } from "../helpers/repo.ts";
import { git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

describe("枝の push の印", () => {
  it("共通ディレクトリの orca-flow/branch-push/〈ID〉.json に書き、読める", async () => {
    const common = await tempDir();
    await writeBranchPushMarkAt(
      common,
      "T01",
      "task/T01-core-kit",
      new Date("2026-11-04T00:00:00Z"),
    );
    const file = branchPushFileAt(common, "T01");
    expect(file).toBe(path.join(common, "orca-flow/branch-push/T01.json"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      id: "T01",
      branch: "task/T01-core-kit",
      at: "2026-11-04T00:00:00.000Z",
    });
    expect(await readBranchPushMarkAt(common, "T01")).toMatchObject({
      id: "T01",
      branch: "task/T01-core-kit",
    });
  });

  it("書き直すと push した先頭が消える", async () => {
    const common = await tempDir();
    const now = new Date("2026-11-04T00:00:00Z");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(branchPushFileAt(common, "T01")), {
      recursive: true,
    });
    await writeFile(
      branchPushFileAt(common, "T01"),
      JSON.stringify({
        id: "T01",
        branch: "b",
        at: "x",
        pushedHead: "abc",
        pushedAt: "y",
      }),
    );
    expect((await readBranchPushMarkAt(common, "T01"))?.pushedHead).toBe("abc");
    await writeBranchPushMarkAt(common, "T01", "task/T01-a", now);
    const after = await readBranchPushMarkAt(common, "T01");
    expect(after?.pushedHead).toBeUndefined();
    expect(after?.pushedAt).toBeUndefined();
  });

  it("消すと読めない", async () => {
    const common = await tempDir();
    const now = new Date("2026-11-04T00:00:00Z");
    await writeBranchPushMarkAt(common, "T01", "task/T01-a", now);
    await removeBranchPushMarkAt(common, "T01");
    expect(await readBranchPushMarkAt(common, "T01")).toBeNull();
    await expect(stat(branchPushFileAt(common, "T01"))).rejects.toThrow();
    // なくても消せる
    await removeBranchPushMarkAt(common, "T01");
  });

  it("壊れた印・形の違う ID は null", async () => {
    const common = await tempDir();
    expect(await readBranchPushMarkAt(common, "zz")).toBeNull();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(common, "orca-flow/branch-push"), {
      recursive: true,
    });
    await writeFile(branchPushFileAt(common, "T01"), "{");
    expect(await readBranchPushMarkAt(common, "T01")).toBeNull();
    await writeFile(
      branchPushFileAt(common, "T01"),
      JSON.stringify({ id: "T02", branch: "b", at: "x" }),
    );
    expect(await readBranchPushMarkAt(common, "T01")).toBeNull();
  });

  it("本物の git のどの worktree からも同じ印を読める", async () => {
    const root = await makeRepo();
    const common = (
      await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).trim();
    await writeBranchPushMarkAt(common, "T01", "task/T01-a", new Date());
    expect(await readBranchPushMark(testRunner, root, "T01")).not.toBeNull();
  });
});

describe("パッケージの定義の一覧と枝の名前の当て方", () => {
  it("17種を1つの一覧にし、isPackageFile が使う", () => {
    expect(BRANCH_PACKAGE_FILES).toHaveLength(17);
    for (const f of BRANCH_PACKAGE_FILES)
      expect(isPackageFile(`a/b/${f}`)).toBe(true);
    expect(isPackageFile("README.md")).toBe(false);
  });
  it("長い名前の一部は当てない", () => {
    expect(lineHasBranch('"dev-feat/x": "1"', "feat/x")).toBe(true);
    expect(lineHasBranch("feat/xy", "feat/x")).toBe(false);
    expect(lineHasBranch("afeat/x", "feat/x")).toBe(false);
  });
});
