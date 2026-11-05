import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import {
  readCrossDepends,
  writeCrossDepends,
} from "../../src/lib/cross-depends.ts";
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

const repo = (over: Record<string, unknown> = {}) => ({
  name: "lib",
  path: "/tmp/lib-main",
  package: "@acme/lib",
  version: "1.4.0",
  ids: ["L01"],
  ...over,
});

async function setup() {
  const root = await makeRepo();
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return { root, file: path.join(common, "orca-flow/cross-depends/T01.json") };
}

const newTask = (
  root: string,
  orca: ReturnType<typeof fakeOrca>,
  json?: string,
) =>
  runCli(
    [
      "new",
      "--title",
      "a",
      "--slug",
      "a",
      ...(json === undefined ? [] : ["--cross-depends-json", json]),
    ],
    { cwd: root, runner: orca.runner },
  );

describe("new --cross-depends-json", () => {
  it("正しい値で作業ツリーの外に記録ができる", async () => {
    const { root, file } = await setup();
    const result = await newTask(root, fakeOrca(), JSON.stringify([repo()]));
    expect(result.code).toBe(0);
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record).toMatchObject({ id: "T01", repos: [repo()] });
    expect(typeof record.at).toBe("string");
  });

  it("形の違う値は Orca を呼ぶ前に終了コード1で止まり、記録も作らない", async () => {
    const values = [
      "{",
      "[]",
      JSON.stringify([repo(), repo()]),
      JSON.stringify([repo({ path: "relative/lib" })]),
      JSON.stringify([repo({ version: "" })]),
      JSON.stringify([repo({ ids: ["xx"] })]),
    ];
    for (const value of values) {
      const { root, file } = await setup();
      const orca = fakeOrca();
      const result = await newTask(root, orca, value);
      expect(result.code, value).toBe(1);
      expect(orca.calls).toEqual([]);
      await expect(stat(file)).rejects.toThrow();
      expect(await git(root, "branch", "--list", "task/*")).toBe("");
    }
  });

  it("名前が外れたリポジトリ（Lib）は決まった文で終了コード1、Orca を呼ばない", async () => {
    const { root } = await setup();
    const orca = fakeOrca();
    const result = await newTask(
      root,
      orca,
      JSON.stringify([repo({ name: "Lib" })]),
    );
    expect(result.code).toBe(1);
    expect(orca.calls).toEqual([]);
    expect(result.err.trimEnd()).toBe(
      "orca-flow: --cross-depends-json の形が違います：repos[0].name が名前の形（英小文字・数字・「-」）ではありません",
    );
  });

  it("なしで流すと同じ ID の古い記録が消える", async () => {
    const { root, file } = await setup();
    await writeCrossDepends(testRunner, root, "T01", [repo()]);
    await stat(file);
    const result = await newTask(root, fakeOrca());
    expect(result.code).toBe(0);
    expect(await readCrossDepends(testRunner, root, "T01")).toBeNull();
  });
});
