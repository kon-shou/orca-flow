import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { dropDepends, readDepends } from "../../src/lib/depends.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

async function setup() {
  const root = await makeRepo();
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return { root, file: path.join(common, "orca-flow/depends/T01.json") };
}

describe("new --depends：依存の記録", () => {
  it("作業ツリーの外に ID・依存・時刻を書き、drop で外せる", async () => {
    const { root, file } = await setup();
    const result = await runCli(
      ["new", "--title", "a", "--slug", "a", "--depends", "T00,T02"],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(result.code).toBe(0);
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record).toMatchObject({ id: "T01", depends: ["T00", "T02"] });
    expect(typeof record.at).toBe("string");
    expect(await readDepends(testRunner, root, "T01")).toEqual(["T00", "T02"]);
    await dropDepends(testRunner, root, "T01", ["T00"]);
    expect(await readDepends(testRunner, root, "T01")).toEqual(["T02"]);
  });

  it("依存がなければ記録を作らない", async () => {
    const { root, file } = await setup();
    const result = await runCli(["new", "--title", "a", "--slug", "a"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    await expect(stat(file)).rejects.toThrow();
  });
});
