import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";
import { makeTmpDir } from "../helpers/tmp/index.ts";
import {
  makeRepo as makeInitRepo,
  tempDir as initTempDir,
} from "../init/helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
// 入口は依存の package.json の隣（根の node_modules を直接読まない）
const VITEST = path.join(
  path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

interface Child {
  code: number;
  output: string;
  tmp: string;
  out: string;
}

/**
 * 空の一時の親を TMPDIR・TMP・TEMP に差し替えて、子の vitest を流す。
 * 既定は本物の設定。globalSetup: false なら助け（setupFiles）だけで流す */
async function runChild(
  fixture: string,
  opts: { globalSetup?: boolean; marker?: boolean } = {},
): Promise<Child> {
  const { globalSetup = true, marker = false } = opts;
  const tmp = await makeTmpDir("orca-flow-child-tmp-");
  if (marker) {
    // 同じ TMPDIR に並ぶ、別の実行の親に見えるフォルダ
    await mkdir(path.join(tmp, "orca-flow-test-other"));
    await writeFile(path.join(tmp, "orca-flow-test-other/keep"), "残す");
  }
  const outDir = await makeTmpDir("orca-flow-child-out-");
  const out = path.join(outDir, "created.txt");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("VITEST")) delete env[key];
  Object.assign(env, {
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    ORCA_TMP_FIXTURE_OUT: out,
  });
  const result = await testRunner(
    process.execPath,
    [
      VITEST,
      "run",
      "--root",
      ROOT,
      "--config",
      path.join(
        ROOT,
        globalSetup
          ? "test/tmp-cleanup/child.config.ts"
          : "test/tmp-cleanup/child-no-global.config.ts",
      ),
      `test/tmp-cleanup/fixtures/${fixture}.fixture.ts`,
    ],
    { cwd: ROOT, env, timeoutMs: 50_000 },
  );
  return {
    code: result.code,
    output: result.stdout + result.stderr,
    tmp,
    out,
  };
}

const lines = async (file: string) =>
  (await readFile(file, "utf8")).split("\n").filter(Boolean);

describe("実行ごとの親フォルダ", () => {
  it("os.tmpdir() が orca-flow-test- で始まる親フォルダになっている", () => {
    expect(path.basename(tmpdir())).toMatch(/^orca-flow-test-/);
    expect(process.env.TMP).toBe(tmpdir());
    expect(process.env.TEMP).toBe(tmpdir());
  });
});

describe("一時フォルダの助け", () => {
  it("1つのテストで作ったフォルダが、次のテストの始まりには消えている（子の vitest）", async () => {
    const child = await runChild("inside");
    expect(child.code, child.output).toBe(0);
    expect(await lines(child.out)).toHaveLength(4);
  });

  it("beforeAll で作ったフォルダは、テストの間は残り、ファイルの終わりに消える", async () => {
    // globalSetup なし：親ごと消えることに頼らず、助けの片づけだけを確かめる
    const child = await runChild("before-all", { globalSetup: false });
    expect(child.code, child.output).toBe(0);
    const [repo] = await lines(child.out);
    expect(repo).toBeTruthy();
    expect(existsSync(repo!)).toBe(false);
  });

  it("テストが落ちても、そのテストで作ったフォルダが消えている", async () => {
    const child = await runChild("failing", { globalSetup: false });
    expect(child.code, child.output).not.toBe(0);
    expect(child.output).toMatch(/2 failed/);
    const dirs = [
      ...(await lines(child.out)),
      ...(await lines(`${child.out}.2`)),
    ];
    expect(dirs).toHaveLength(3);
    for (const dir of dirs) expect(existsSync(dir), dir).toBe(false);
  });

  it("子の vitest の終わりに、差し替えた TMPDIR が空になる", async () => {
    for (const fixture of ["inside", "before-all", "failing"]) {
      const child = await runChild(fixture);
      expect(await readdir(child.tmp), `${fixture}\n${child.output}`).toEqual(
        [],
      );
    }
  });

  it("同じ TMPDIR に並ぶ別の実行の親と、自分が作っていないものは残る", async () => {
    const child = await runChild("inside", { marker: true });
    expect(child.code, child.output).toBe(0);
    expect(await readdir(child.tmp), child.output).toEqual([
      "orca-flow-test-other",
    ]);
    expect(existsSync(path.join(child.tmp, "orca-flow-test-other/keep"))).toBe(
      true,
    );
  });

  it("この実行で、4つの作り方すべてのフォルダを作って使える", async () => {
    const dirs = [
      await tempDir(),
      initTempDir(),
      await makeRepo(),
      makeInitRepo(),
    ];
    for (const dir of dirs) {
      expect(existsSync(dir)).toBe(true);
      expect(dir.startsWith(tmpdir())).toBe(true);
    }
  });
});
