import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dropDepends,
  readDepends,
  writeDependsAt,
} from "../../src/lib/depends.ts";
import { git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");

async function setup() {
  const root = await makeRepo();
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return { root, dir: path.join(common, "orca-flow", "depends"), common };
}

describe("依存の記録", () => {
  it("記録がなければ空の並び", async () => {
    const { root } = await setup();
    expect(await readDepends(testRunner, root, "T02")).toEqual([]);
  });

  it("書くと ID・依存・時刻が入り、読める。一時ファイルを残さない", async () => {
    const { root, dir, common } = await setup();
    await writeDependsAt(common, "T02", ["T01", "T01", "T00"], T0);
    expect(
      JSON.parse(await readFile(path.join(dir, "T02.json"), "utf8")),
    ).toEqual({
      id: "T02",
      depends: ["T01", "T00"],
      at: T0.toISOString(),
    });
    expect(await readDepends(testRunner, root, "T02")).toEqual(["T01", "T00"]);
    expect(await readdir(dir)).toEqual(["T02.json"]);
  });

  it("依存が空なら古い記録を消す", async () => {
    const { root, dir, common } = await setup();
    await writeDependsAt(common, "T02", ["T01"], T0);
    await writeDependsAt(common, "T02", [], T0);
    expect(await readdir(dir)).toEqual([]);
    expect(await readDepends(testRunner, root, "T02")).toEqual([]);
  });

  it("壊れた記録は止まり、形の外れた ID は空", async () => {
    const { root, dir, common } = await setup();
    await writeDependsAt(common, "T03", ["T01"], T0);
    await writeFile(path.join(dir, "T03.json"), "{壊れ");
    await expect(readDepends(testRunner, root, "T03")).rejects.toThrow(
      /依存の記録が壊れています：depends\/T03\.json/,
    );
    await writeFile(path.join(dir, "T03.json"), '{"depends":"T01"}');
    await expect(readDepends(testRunner, root, "T03")).rejects.toThrow(
      /壊れています/,
    );
    expect(await readDepends(testRunner, root, "../x")).toEqual([]);
  });

  it("dropDepends は指した依存だけ外して残りを返す。ほかの ID は触らない", async () => {
    const { root, common } = await setup();
    await writeDependsAt(common, "T05", ["T01", "T02"], T0);
    await writeDependsAt(common, "T06", ["T01"], T0);
    expect(await dropDepends(testRunner, root, "T05", ["T01"], T0)).toEqual([
      "T02",
    ]);
    expect(await readDepends(testRunner, root, "T05")).toEqual(["T02"]);
    expect(await readDepends(testRunner, root, "T06")).toEqual(["T01"]);
    expect(await dropDepends(testRunner, root, "T05", ["T02"], T0)).toEqual([]);
    expect(await readDepends(testRunner, root, "T05")).toEqual([]);
  });

  it("記録がない ID を外しても何も作らない", async () => {
    const { root, dir } = await setup();
    expect(await dropDepends(testRunner, root, "T09", ["T01"])).toEqual([]);
    await expect(readdir(dir)).rejects.toThrow();
  });
});
