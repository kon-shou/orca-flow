import { realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkCrossDepends,
  dropCrossDepends,
  parseCrossDependsJson,
  parseCrossDependsRef,
  readCrossDepends,
  removeCrossDepends,
  resolveCrossDependsArgs,
  writeCrossDepends,
  type CrossDependsRepo,
} from "../../src/lib/cross-depends.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import { FlowError } from "../../src/types.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const recordFile = async (root: string, id: string) =>
  path.join(
    await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "orca-flow/cross-depends",
    `${id}.json`,
  );

const repo = (over: Partial<CrossDependsRepo> = {}): CrossDependsRepo => ({
  name: "lib",
  path: "/tmp/lib-main",
  package: "@acme/lib",
  version: "1.4.0",
  ids: ["L01"],
  ...over,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof FlowError ? e.code : -1;
  }
  return 0;
};

describe("記録の読み書き", () => {
  it("書いた記録を読み直すと同じ中身で、ないときは null", async () => {
    const root = await makeRepo();
    expect(await readCrossDepends(testRunner, root, "T01")).toBeNull();
    const repos = [repo(), repo({ name: "ui", ids: ["U01", "U02"] })];
    await writeCrossDepends(testRunner, root, "T01", repos, new Date(0));
    const read = await readCrossDepends(testRunner, root, "T01");
    expect(read).toEqual({
      id: "T01",
      at: "1970-01-01T00:00:00.000Z",
      repos,
    });
  });

  it("repos が空なら記録を消す。removeCrossDepends でも消える", async () => {
    const root = await makeRepo();
    await writeCrossDepends(testRunner, root, "T01", [repo()]);
    await writeCrossDepends(testRunner, root, "T01", []);
    await expect(stat(await recordFile(root, "T01"))).rejects.toThrow();
    await writeCrossDepends(testRunner, root, "T01", [repo()]);
    await removeCrossDepends(testRunner, root, "T01");
    expect(await readCrossDepends(testRunner, root, "T01")).toBeNull();
  });

  it("形の違う記録は FlowError(1)", async () => {
    const root = await makeRepo();
    await writeCrossDepends(testRunner, root, "T01", [repo()]);
    const f = await recordFile(root, "T01");
    const bad: unknown[] = [
      "{",
      "[]",
      JSON.stringify({ id: "T01", at: "x", repos: [] }),
      JSON.stringify({ id: "T02", at: "x", repos: [repo()] }),
      JSON.stringify({ id: "T01", at: "x", repos: [repo({ path: "rel" })] }),
      JSON.stringify({ id: "T01", at: "x", repos: [repo({ version: "" })] }),
      JSON.stringify({ id: "T01", at: "x", repos: [repo({ ids: [] })] }),
      JSON.stringify({ id: "T01", at: "x", repos: [repo(), repo()] }),
    ];
    for (const text of bad) {
      await writeFile(f, text as string);
      expect(await code(readCrossDepends(testRunner, root, "T01"))).toBe(1);
      expect(await code(checkCrossDepends(testRunner, root, "b", "T01"))).toBe(
        1,
      );
    }
  });
});

describe("parseCrossDependsRef", () => {
  it("名前:ID の形だけ分ける", () => {
    expect(parseCrossDependsRef("lib:L01")).toEqual({ name: "lib", id: "L01" });
    expect(parseCrossDependsRef("L01")).toBeNull();
    expect(parseCrossDependsRef("Lib:L01")).toBeNull();
    expect(parseCrossDependsRef("lib:")).toBeNull();
    expect(parseCrossDependsRef("lib:xx")).toBeNull();
  });
});

describe("parseCrossDependsJson", () => {
  it("名前の重なり・相対パス・空の版・ID の形の外れは FlowError(1)", () => {
    const ok = JSON.stringify([repo()]);
    expect(parseCrossDependsJson(ok)).toEqual([repo()]);
    for (const bad of [
      "{",
      "{}",
      "[]",
      JSON.stringify([repo(), repo()]),
      JSON.stringify([repo({ path: "lib" })]),
      JSON.stringify([repo({ version: " " })]),
      JSON.stringify([repo({ package: "" })]),
      JSON.stringify([repo({ ids: ["x"] })]),
      JSON.stringify([repo({ name: "Lib" })]),
    ])
      expect(() => parseCrossDependsJson(bad)).toThrow(FlowError);
  });
});

describe("dropCrossDepends", () => {
  it("ref を外し、最後の ID が外れたリポジトリは消え、repos が空なら記録ごと消える", async () => {
    const root = await makeRepo();
    await writeCrossDepends(testRunner, root, "T01", [
      repo({ ids: ["L01", "L02"] }),
      repo({ name: "ui", ids: ["U01"] }),
    ]);
    const a = await dropCrossDepends(testRunner, root, "T01", ["lib:L01"]);
    expect(a?.repos.map((r) => [r.name, r.ids])).toEqual([
      ["lib", ["L02"]],
      ["ui", ["U01"]],
    ]);
    // 記録にない ref・名前だけ違う ref は何もしない
    await dropCrossDepends(testRunner, root, "T01", [
      "lib:L09",
      "ui:L02",
      "L02",
    ]);
    expect(
      (await readCrossDepends(testRunner, root, "T01"))?.repos,
    ).toHaveLength(2);
    await dropCrossDepends(testRunner, root, "T01", ["lib:L02"]);
    expect(
      (await readCrossDepends(testRunner, root, "T01"))?.repos.map(
        (r) => r.name,
      ),
    ).toEqual(["ui"]);
    expect(
      await dropCrossDepends(testRunner, root, "T01", ["ui:U01"]),
    ).toBeNull();
    await expect(stat(await recordFile(root, "T01"))).rejects.toThrow();
    expect(
      await dropCrossDepends(testRunner, root, "T01", ["ui:U01"]),
    ).toBeNull();
  });
});

// 依存先（共通）の子を本物の git で作る
const NAME = "統括役";
async function makeLib(
  opts: {
    merged?: boolean;
    init?: boolean;
    config?: Record<string, unknown>;
    subject?: string;
    /** merged のとき、依存先の push の記録（PR のマージのコミット）を書くか。既定は書く */
    pushRecord?: boolean;
  } = {},
) {
  const lib = await makeRepo({
    idPrefix: "L",
    baseBranch: "main",
    ...opts.config,
  });
  if (opts.init === false) {
    await git(lib, "rm", "--quiet", "-r", ".orca-flow");
    await git(lib, "commit", "--quiet", "-m", "設定を消す");
  }
  if (opts.merged !== false) {
    await writeFiles(lib, { "x.txt": "x\n" });
    await git(lib, "add", "-A");
    await git(
      lib,
      "commit",
      "--quiet",
      "-m",
      opts.subject ?? `${NAME}: L01 をマージする`,
    );
    if (opts.pushRecord !== false)
      await writePushRecord(testRunner, lib, "L01", {
        id: "L01",
        branch: "task/L01-x",
        base: "main",
        pushedHead: "0".repeat(40),
        pushedAt: "2026-11-04T00:00:00Z",
        pr: { number: 3, url: "https://example.invalid/pull/3" },
        mergeCommit: await git(lib, "rev-parse", "HEAD"),
      });
  }
  return await realpath(lib);
}

async function makeApp(files: Record<string, string> = {}) {
  const app = await makeRepo({ idPrefix: "T" });
  const task = await addTaskWorktree(app, "T01", "x", files);
  return { app, ...task };
}

const gate = (app: string, branch: string) =>
  checkCrossDepends(testRunner, app, branch, "T01");

describe("checkCrossDepends：門", () => {
  it("記録がなければ空", async () => {
    const { app, branch } = await makeApp();
    expect(await gate(app, branch)).toEqual([]);
  });

  it("依存先の push の記録のマージのコミットが祖先で、版上げの行があれば通る", async () => {
    const lib = await makeLib();
    const { app, branch } = await makeApp({
      "packages/web/package.json":
        '{\n  "dependencies": { "@acme/lib": "^1.4.0" }\n}\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    expect(await gate(app, branch)).toEqual([]);
  });

  it("依存先に入っていなければ外れの文、版上げがなければ別の外れの文", async () => {
    const lib = await makeLib({ merged: false });
    const { app, branch } = await makeApp();
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("lib:L01 が lib で PR でマージされていません");
    expect(lines[0]).not.toContain("integrate");
    expect(lines[0]).not.toContain("/orca-flow:push");
    expect(lines[1]).toContain(
      "lib の版上げ（@acme/lib を 1.4.0）がタスクのブランチにありません",
    );
  });

  it("作業ツリーだけにある版上げ（コミット前）は版上げとみなさない", async () => {
    const lib = await makeLib();
    const { app, branch, path: wt } = await makeApp();
    await writeFiles(wt, { "package.json": '"@acme/lib": "1.4.0"\n' });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    expect(await gate(app, branch)).toHaveLength(1);
  });

  it("版の前後に数字か . が続く行は版上げとみなさない", async () => {
    const lib = await makeLib();
    for (const line of [
      '"@acme/lib": "11.4.0"',
      '"@acme/lib": "1.4.0.1"',
      '"@acme/lib": "1.4.01"',
    ]) {
      const { app, branch } = await makeApp({ "package.json": `${line}\n` });
      await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
      expect(await gate(app, branch)).toHaveLength(1);
    }
    // パッケージ名と版が別の行なら当たらない。go.mod の v つきは当たる
    const split = await makeApp({ "package.json": '"@acme/lib":\n"1.4.0"\n' });
    await writeCrossDepends(testRunner, split.app, "T01", [
      repo({ path: lib }),
    ]);
    expect(await gate(split.app, split.branch)).toHaveLength(1);
    const gomod = await makeApp({ "svc/go.mod": "require @acme/lib v1.4.0\n" });
    await writeCrossDepends(testRunner, gomod.app, "T01", [
      repo({ path: lib }),
    ]);
    expect(await gate(gomod.app, gomod.branch)).toEqual([]);
  });

  it("パッケージ名の前後がパッケージ名に使う文字なら当てない", async () => {
    const lib = await makeLib();
    for (const line of [
      '"@acme/core-kit": "^1.4.0"',
      '"x@acme/core": "1.4.0"',
      '"@acme/core/sub": "1.4.0"',
      '"@acme/core_x": "1.4.0"',
      '"@acme/core.js": "1.4.0"',
    ]) {
      const { app, branch } = await makeApp({ "package.json": `${line}\n` });
      await writeCrossDepends(testRunner, app, "T01", [
        repo({ path: lib, package: "@acme/core" }),
      ]);
      expect(await gate(app, branch), line).toHaveLength(1);
    }
    const slash = await makeApp({
      "go.mod": "require example.com/lib/v2 v1.4.0\n",
    });
    await writeCrossDepends(testRunner, slash.app, "T01", [
      repo({ path: lib, package: "example.com/lib" }),
    ]);
    expect(await gate(slash.app, slash.branch)).toHaveLength(1);
    // 今までの形は当てる
    for (const [file, line, pkg] of [
      ["package.json", '"@acme/core": "1.4.0"', "@acme/core"],
      ["pyproject.toml", '@acme/core = "1.4.0"', "@acme/core"],
      ["Cargo.toml", 'name = "core"\nversion = "1.4.0"', "core"],
      ["Cargo.toml", 'core = "1.4.0"', "core"],
    ] as const) {
      const ok = await makeApp({ [file]: `${line}\n` });
      await writeCrossDepends(testRunner, ok.app, "T01", [
        repo({ path: lib, package: pkg }),
      ]);
      const lines = await gate(ok.app, ok.branch);
      if (line.includes("\n")) expect(lines).toHaveLength(1);
      else expect(lines, line).toEqual([]);
    }
  });

  it("依存先の baseBranch に入っているかで見る（main にだけあれば外れ）", async () => {
    const lib = await makeLib({ config: { baseBranch: "develop" } });
    await git(lib, "branch", "develop", "HEAD~1");
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lib:L01 が lib で PR でマージされていません");
    expect(lines[0]).toContain("記録のマージのコミット（");
    expect(lines[0]).not.toContain("/orca-flow:push");
    await git(lib, "branch", "-f", "develop", "main");
    expect(await gate(app, branch)).toEqual([]);
  });

  it("依存先の integratorName の件名の行だけでは通らず、push の記録があれば通る", async () => {
    const config = { integratorName: "ボット" };
    const subjectOnly = await makeLib({
      config,
      subject: "ボット: L01 をマージする",
      pushRecord: false,
    });
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [
      repo({ path: subjectOnly }),
    ]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("integrate で入れたものは数えない");
    const viaPr = await makeLib({
      config,
      subject: "ボット: L01 をマージする",
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: viaPr })]);
    expect(await gate(app, branch)).toEqual([]);
  });

  it("(i) 件名の行がある：push の記録（PR あり・マージのコミットなし）があっても push の案内は入らず、--drop-depend が入る", async () => {
    const lib = await makeLib({ pushRecord: false });
    await writePushRecord(testRunner, lib, "L01", {
      id: "L01",
      branch: "task/L01-x",
      base: "main",
      pushedHead: "0".repeat(40),
      pushedAt: "2026-11-04T00:00:00Z",
      pr: { number: 3, url: "https://example.invalid/pull/3" },
    });
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--drop-depend lib:L01");
    expect(lines[0]).not.toContain("/orca-flow:push");
  });

  it("件名の行だけ：外れの文に integrate の言葉が入り、push の案内は入らない", async () => {
    const lib = await makeLib({ pushRecord: false });
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lib:L01 が lib で PR でマージされていません");
    expect(lines[0]).toContain("integrate で入れたものは数えない");
    expect(lines[0]).not.toContain("/orca-flow:push");
  });

  it("PR はあるがマージのコミットがない：依存先での /orca-flow:push の案内が入る", async () => {
    const lib = await makeLib({ merged: false });
    await writePushRecord(testRunner, lib, "L01", {
      id: "L01",
      branch: "task/L01-x",
      base: "main",
      pushedHead: "0".repeat(40),
      pushedAt: "2026-11-04T00:00:00Z",
      pr: { number: 3, url: "https://example.invalid/pull/3" },
    });
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lib:L01 が lib で PR でマージされていません");
    expect(lines[0]).toContain("/orca-flow:push L01");
    expect(lines[0]).toContain(
      "PR がまだならマージし、GitHub でマージ済みなら lib で",
    );
    expect(lines[0]).not.toContain("integrate");
  });

  it("(iv) 記録に PR がない：PR にしてマージする案内が入る", async () => {
    const lib = await makeLib({ merged: false });
    await writePushRecord(testRunner, lib, "L01", {
      id: "L01",
      branch: "task/L01-x",
      base: "main",
      pushedHead: "0".repeat(40),
      pushedAt: "2026-11-04T00:00:00Z",
      pr: null,
    });
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "。lib で /orca-flow:push L01 で PR にし、マージしてください",
    );
    expect(lines[0]).not.toContain("integrate");
  });

  it("(v) 記録がない：基本の文だけ", async () => {
    const lib = await makeLib({ merged: false });
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    expect(await gate(app, branch)).toEqual([
      "lib:L01 が lib で PR でマージされていません",
    ]);
  });

  it("件名の行と push の記録の両方があり、マージのコミットが祖先なら通る", async () => {
    const lib = await makeLib();
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    expect(await gate(app, branch)).toEqual([]);
  });

  it("(iii) 記録のマージのコミットが baseBranch の祖先でなければ外れ（push の案内は入らない）", async () => {
    const lib = await makeLib({ subject: "L01 の中身を入れる" });
    await git(lib, "checkout", "--quiet", "-b", "side", "HEAD~1");
    await writeFiles(lib, { "y.txt": "y\n" });
    await git(lib, "add", "-A");
    await git(lib, "commit", "--quiet", "-m", "別");
    const off = await git(lib, "rev-parse", "HEAD");
    await git(lib, "checkout", "--quiet", "main");
    await writePushRecord(testRunner, lib, "L01", {
      id: "L01",
      mergeCommit: off,
    });
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PR でマージされていません");
    expect(lines[0]).toContain(
      `記録のマージのコミット（${off.slice(0, 7)}）が lib の main にありません`,
    );
    expect(lines[0]).toContain("手元の main を origin に合わせてください");
    expect(lines[0]).not.toContain("/orca-flow:push");
  });

  it("版上げを探すのは定義のファイル5種類だけ（README.md・package.json.bak は外れのまま）", async () => {
    const lib = await makeLib();
    for (const file of ["README.md", "package.json.bak", "docs/notes.txt"]) {
      const { app, branch } = await makeApp({
        [file]: '"@acme/lib": "1.4.0"\n',
      });
      await writeCrossDepends(testRunner, app, "T01", [repo({ path: lib })]);
      const lines = await gate(app, branch);
      expect(lines, file).toHaveLength(1);
      expect(lines[0]).toContain("版上げ");
    }
  });

  it("場所が読めない（パスがない・メインの一番上でない・自分と同じ・init 前）は外れ", async () => {
    const lib = await makeLib();
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    const cases: [string, string][] = [
      [path.join(lib, "no-such"), "パスがありません"],
      [path.join(lib, ".git"), "git"],
      [app, "自分と同じ"],
      [await makeLib({ init: false }), "init 前"],
    ];
    // 一番上でない（サブディレクトリ）と worktree
    await writeFiles(lib, { "sub/a.txt": "a\n" });
    cases.push([path.join(lib, "sub"), "一番上"]);
    const other = await addTaskWorktree(lib, "L09", "y");
    cases.push([other.path, "一番上"]);
    for (const [p, word] of cases) {
      await writeCrossDepends(testRunner, app, "T01", [repo({ path: p })]);
      const lines = await gate(app, branch);
      expect(lines.length, p).toBeGreaterThan(0);
      expect(lines.join("\n"), p).toContain(word);
      expect(lines[0]).toContain("lib の");
    }
  });

  it("依存先の idPrefix の形でない ID は外れ", async () => {
    const lib = await makeLib();
    const { app, branch } = await makeApp({
      "package.json": '"@acme/lib": "1.4.0"\n',
    });
    await writeCrossDepends(testRunner, app, "T01", [
      repo({ path: lib, ids: ["X01"] }),
    ]);
    const lines = await gate(app, branch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lib:X01");
  });
});

describe("resolveCrossDependsArgs：親の確かめ", () => {
  const repos = [
    {
      name: "lib",
      path: "/w/lib",
      role: "common" as const,
      package: "@acme/lib",
    },
    { name: "ui", path: "/w/ui", role: "common" as const, package: "@acme/ui" },
    { name: "web", path: "/w/web", role: "app" as const },
    { name: "api", path: "/w/api", role: "app" as const },
  ];
  const resolve = (child: string, deps?: string, bumps?: string) =>
    resolveCrossDependsArgs(repos, child, deps, bumps);

  it("どちらも空なら null", () => {
    expect(resolve("web")).toBeNull();
    expect(resolve("lib")).toBeNull();
  });

  it("設定のパスとパッケージ名に解いた JSON にする（同じ名前の ID はまとめる）", () => {
    const json = resolve(
      "web",
      "lib:L01,ui:U02,lib:L03",
      "lib=1.4.0, ui=2.0.0",
    )!;
    expect(JSON.parse(json)).toEqual([
      {
        name: "lib",
        path: "/w/lib",
        package: "@acme/lib",
        version: "1.4.0",
        ids: ["L01", "L03"],
      },
      {
        name: "ui",
        path: "/w/ui",
        package: "@acme/ui",
        version: "2.0.0",
        ids: ["U02"],
      },
    ]);
    expect(parseCrossDependsJson(json)).toHaveLength(2);
  });

  it("知らない名前・アプリの依存先・共通の子・版のない依存先・依存のない版は終了コード1", () => {
    const fails: [string, string | undefined, string | undefined][] = [
      ["web", "nope:L01", "nope=1.0.0"],
      ["nope", "lib:L01", "lib=1.0.0"],
      ["web", "api:A01", "api=1.0.0"],
      ["lib", "ui:U01", "ui=1.0.0"],
      ["web", "lib:L01", undefined],
      ["web", "lib:L01", "ui=1.0.0"],
      ["web", "lib:L01", "lib=1.0.0,lib=1.1.0"],
      ["web", undefined, "lib=1.0.0"],
      ["web", "lib:xx", "lib=1.0.0"],
      ["web", "lib:L01", "lib="],
    ];
    for (const [child, deps, bumps] of fails) {
      let error: unknown;
      try {
        resolve(child, deps, bumps);
      } catch (e) {
        error = e;
      }
      expect(error, `${child} ${deps} ${bumps}`).toBeInstanceOf(FlowError);
      expect((error as FlowError).code).toBe(1);
    }
  });

  it("外れは全部まとめて返す", () => {
    try {
      resolve("lib", "nope:L01,api:A01", undefined);
      expect.unreachable();
    } catch (e) {
      const msg = (e as FlowError).message;
      expect(msg).toContain("共通です");
      expect(msg).toContain("nope");
      expect(msg).toContain("api");
    }
  });
});
