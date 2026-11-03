import { existsSync, writeFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { makeRepo } from "../../helpers/repo.ts";

let repo = "";
beforeAll(async () => {
  repo = await makeRepo();
  writeFileSync(process.env.ORCA_TMP_FIXTURE_OUT!, repo);
});

it("1つめ：beforeAll で作ったものがある", () => {
  expect(existsSync(repo)).toBe(true);
});

it("2つめ：テストが終わっても beforeAll で作ったものが残る", () => {
  expect(existsSync(repo)).toBe(true);
});
