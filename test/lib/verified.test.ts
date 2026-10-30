import { describe, expect, it } from "vitest";
import {
  allInSkipPaths,
  clearRecord,
  readRecord,
  recordMismatch,
  writeRecord,
} from "../../src/lib/verified.ts";
import { makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const record = {
  id: "T12",
  head: "aaa",
  base: "bbb",
  commands: ["pnpm test"],
  at: "2026-01-01T00:00:00.000Z",
};

describe("verified", () => {
  it("書いた記録を読め、消せる。壊れた記録は null", async () => {
    const root = await makeRepo();
    expect(await readRecord(testRunner, root, "T12")).toBeNull();
    await writeRecord(testRunner, root, record);
    expect(await readRecord(testRunner, root, "T12")).toEqual(record);
    await clearRecord(testRunner, root, "T12");
    expect(await readRecord(testRunner, root, "T12")).toBeNull();
    await clearRecord(testRunner, root, "T12");
    await writeRecord(testRunner, root, { ...record, commands: [1] as never });
    expect(await readRecord(testRunner, root, "T12")).toBeNull();
  });

  it("recordMismatch は理由を返し、そろえば null", () => {
    const now = { head: "aaa", base: "bbb", commands: ["pnpm test"] };
    expect(recordMismatch(record, now)).toBeNull();
    expect(recordMismatch(null, now)).toContain("記録がありません");
    expect(recordMismatch(record, { ...now, head: "x" })).toContain("ブランチ");
    expect(recordMismatch(record, { ...now, base: "x" })).toContain("main");
    expect(recordMismatch(record, { ...now, commands: [] })).toContain(
      "コマンド",
    );
  });

  it("allInSkipPaths はディレクトリの区切りで比べ、差分が空なら false", () => {
    expect(allInSkipPaths(["docs/a.md", "docs/b/c.md"], ["docs/"])).toBe(true);
    expect(allInSkipPaths(["docs/a.md", "src/a.ts"], ["docs/"])).toBe(false);
    expect(allInSkipPaths(["docsx/a.md"], ["docs"])).toBe(false);
    expect(allInSkipPaths([], ["docs/"])).toBe(false);
  });
});

describe("テストに関係しない場所", () => {
  const config = (extra: Record<string, unknown> = {}) =>
    ({
      verifySkipPaths: ["docs/"],
      progress: { file: "PROGRESS.md" },
      ...extra,
    }) as never;

  it("verifySkipPaths・設定のファイル・進捗表を除く", async () => {
    const { testIrrelevantPaths, testRelevantFiles } =
      await import("../../src/lib/verified.ts");
    expect(testIrrelevantPaths(config())).toEqual([
      "docs/",
      ".orca-flow/config.json",
      "PROGRESS.md",
    ]);
    expect(
      testRelevantFiles(
        ["docs/a.md", ".orca-flow/config.json", "PROGRESS.md", "src/a.ts"],
        config(),
      ),
    ).toEqual(["src/a.ts"]);
  });

  it("progress が null なら進捗表を足さない", async () => {
    const { testIrrelevantPaths, testRelevantFiles } =
      await import("../../src/lib/verified.ts");
    const c = config({ progress: null });
    expect(testIrrelevantPaths(c)).toEqual(["docs/", ".orca-flow/config.json"]);
    expect(testRelevantFiles(["PROGRESS.md"], c)).toEqual(["PROGRESS.md"]);
  });
});
