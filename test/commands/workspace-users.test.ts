import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import { capture, makeRepo, tempDir, writeFiles } from "../init/helpers.ts";

const PKG = "@demo/core";

const done = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

/** git は本物、子の CLI（node）は設定の答えだけを返す偽物 */
const runnerWith =
  (configFor: (cwd: string | undefined) => Partial<RunResult>): Runner =>
  async (cmd, args, opts) =>
    cmd === process.execPath
      ? done(configFor(opts?.cwd))
      : realRunner(cmd, args, opts);

function setup(apps: Record<string, Record<string, string>>) {
  const common = makeRepo();
  const dir = tempDir("orca-flow-ws-");
  const paths: Record<string, string> = {};
  const repos: Record<string, unknown>[] = [
    {
      name: "demo-core",
      path: common,
      role: "common",
      keywords: ["共通"],
      scope: "共通の処理",
      package: PKG,
      bumpCommand: "pnpm up @demo/core",
    },
  ];
  for (const [name, files] of Object.entries(apps)) {
    paths[name] = makeRepo(files);
    repos.push({ name, path: paths[name], role: "app", keywords: ["画面"] });
  }
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  return { common, dir, paths };
}

async function list(dir: string, runner: Runner) {
  const io = capture();
  const code = await main(["workspace", "--json"], {
    ...io,
    cwd: dir,
    runner,
  });
  return {
    code,
    data: JSON.parse(io.text()) as { repos: Record<string, unknown>[] },
  };
}

const ok = runnerWith(() => ({
  code: 0,
  stdout: JSON.stringify({ baseBranch: "main" }),
}));

describe("workspace --json の users", () => {
  it("共通の要素に、パッケージ名を持つアプリだけが並ぶ。アプリの要素にはキーがない", async () => {
    const { dir } = setup({
      "app-a": { "package.json": `{"dependencies":{"${PKG}":"1.0.0"}}\n` },
      "app-b": { "package.json": `{"dependencies":{"${PKG}-ui":"1.0.0"}}\n` },
      "app-c": { "sub/composer.json": `{"require":{"${PKG}":"^1"}}\n` },
    });
    const { data } = await list(dir, ok);
    expect(data.repos[0]!.users).toEqual(["app-a", "app-c"]);
    expect(data.repos[1]).not.toHaveProperty("users");
  });

  it("アプリが1つも使っていなければ空の並び", async () => {
    const { dir } = setup({ "app-a": {} });
    const { data } = await list(dir, ok);
    expect(data.repos[0]!.users).toEqual([]);
  });

  it("読めないアプリ（init がまだ）があれば null", async () => {
    const { dir, paths } = setup({
      "app-a": { "package.json": `{"dependencies":{"${PKG}":"1.0.0"}}\n` },
      "app-b": {},
    });
    const runner = runnerWith((cwd) =>
      cwd === paths["app-b"]
        ? { code: 2, stderr: "init がまだ" }
        : { code: 0, stdout: JSON.stringify({ baseBranch: "main" }) },
    );
    const { data } = await list(dir, runner);
    expect(data.repos[0]!.users).toBeNull();
  });

  it("baseBranch が git にないアプリがあれば null", async () => {
    const { dir } = setup({ "app-a": {} });
    const runner = runnerWith(() => ({
      code: 0,
      stdout: JSON.stringify({ baseBranch: "no-such-branch" }),
    }));
    const { data } = await list(dir, runner);
    expect(data.repos[0]!.users).toBeNull();
  });

  it("今までの欄はそのまま出る", async () => {
    const { dir } = setup({ "app-a": {} });
    const { data } = await list(dir, ok);
    expect(data.repos[0]).toMatchObject({
      name: "demo-core",
      role: "common",
      package: PKG,
      bumpCommand: "pnpm up @demo/core",
      initialized: true,
      baseBranch: "main",
    });
  });
});
