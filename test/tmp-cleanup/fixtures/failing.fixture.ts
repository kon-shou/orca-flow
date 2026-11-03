import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { makeRepo, tempDir } from "../../helpers/repo.ts";

it("作ったあとで落ちる", async () => {
  const dirs = [await tempDir(), await makeRepo()];
  writeFileSync(process.env.ORCA_TMP_FIXTURE_OUT!, dirs.join("\n"));
  expect(1).toBe(2);
});

it("作ったあとで例外を投げる", async () => {
  const dir = await tempDir();
  writeFileSync(`${process.env.ORCA_TMP_FIXTURE_OUT!}.2`, dir);
  throw new Error("わざと落とす");
});
