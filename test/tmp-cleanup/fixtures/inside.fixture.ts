import { existsSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  makeRepo as makeRepoA,
  tempDir as tempDirA,
} from "../../helpers/repo.ts";
import {
  makeRepo as makeRepoB,
  tempDir as tempDirB,
} from "../../init/helpers.ts";

// 子の vitest だけが流す（*.test.ts ではないのでふだんの実行に入らない）
const created: string[] = [];

it("1つめ：4つの作り方で作る", async () => {
  created.push(await tempDirA(), tempDirB(), await makeRepoA(), makeRepoB());
  writeFileSync(process.env.ORCA_TMP_FIXTURE_OUT!, created.join("\n"));
  for (const dir of created) expect(existsSync(dir), dir).toBe(true);
});

it("2つめ：1つめで作ったものが消えている", () => {
  expect(created).toHaveLength(4);
  for (const dir of created) expect(existsSync(dir), dir).toBe(false);
});
