import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import {
  capture,
  fakeOrcaRunner,
  git,
  makeRepo,
  ok,
  tempDir,
  writeFiles,
  type OrcaHandler,
} from "./helpers.ts";

const JS = {
  "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
};

const goodHooks = {
  repo: {
    hookSettings: {
      scripts: { setup: 'bash "$ORCA_ROOT_PATH/.orca-flow/setup.sh"' },
      setupAgentStartupPolicy: "wait-for-setup",
    },
  },
};

const orca =
  (hooks: unknown = goodHooks): OrcaHandler =>
  (args) => {
    if (args[0] === "repo" && args[1] === "list") return ok({ repos: [] });
    if (args[0] === "repo" && args[1] === "show") return ok(hooks);
    return ok({});
  };

async function init(cwd: string, argv: string[], handler = orca()) {
  const io = capture();
  const r = fakeOrcaRunner(handler);
  const code = await main(["init", ...argv], {
    ...io,
    cwd,
    runner: r.runner,
  });
  return { code, io };
}

const status = (root: string) => git(root, "status", "--porcelain");
const read = (root: string, file: string) =>
  readFileSync(path.join(root, file), "utf8");
const json = (io: ReturnType<typeof capture>) => JSON.parse(io.text());

describe("init --untracked", () => {
  it("config に untracked を書き、exclude に行を足し、git の差分を出さない", async () => {
    const root = makeRepo(JS);
    writeFiles(root, {
      ".orca-flow/config.json": JSON.stringify({
        decisionsFile: "docs/decisions.md",
        appendOnlyFiles: ["docs/decisions.md", "CHANGES.md"],
      }),
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "x");
    git(root, "rm", "-q", "-r", "--cached", ".orca-flow");
    git(root, "commit", "-q", "-m", "y");
    const { code } = await init(root, ["--untracked", "--yes"]);
    expect(code).toBe(0);
    const exclude = read(root, ".git/info/exclude");
    for (const line of ["/.orca-flow/", "/docs/tasks/", "/docs/decisions.md"])
      expect(exclude.split("\n")).toContain(line);
    expect(JSON.parse(read(root, ".orca-flow/config.json"))).toMatchObject({
      untracked: true,
      decisionsFile: "docs/decisions.md",
    });
    for (const f of [".gitignore", ".gitattributes", "orca.yaml"])
      expect(existsSync(path.join(root, f))).toBe(false);
    expect(status(root)).toBe("");
    expect(read(root, ".git/info/attributes")).toBe("CHANGES.md merge=union\n");
  });

  it("新しい config.json は untracked: true を持ち、既存の config にはそのキーだけ足す", async () => {
    const fresh = makeRepo(JS);
    await init(fresh, ["--untracked", "--yes"]);
    expect(JSON.parse(read(fresh, ".orca-flow/config.json")).untracked).toBe(
      true,
    );

    const root = makeRepo(JS);
    const original = { baseBranch: "main", idPrefix: "Q", verify: ["a"] };
    writeFiles(root, { ".orca-flow/config.json": JSON.stringify(original) });
    await init(root, ["--untracked", "--yes"]);
    expect(JSON.parse(read(root, ".orca-flow/config.json"))).toEqual({
      ...original,
      untracked: true,
    });
  });

  it("2回目の init --yes は untracked として動き、行を重ねない", async () => {
    const root = makeRepo(JS);
    await init(root, ["--untracked", "--yes"]);
    const before = read(root, ".git/info/exclude");
    const { code, io } = await init(root, ["--yes", "--json"]);
    expect(code).toBe(0);
    expect(json(io).untracked).toBe(true);
    expect(json(io).exclude).toEqual([]);
    expect(read(root, ".git/info/exclude")).toBe(before);
  });

  it("settings.local.json が無視されていなければ exclude に足し、無視されていれば足さない", async () => {
    const a = makeRepo(JS);
    await init(a, ["--untracked", "--yes"]);
    expect(read(a, ".git/info/exclude")).toContain(
      "/.claude/settings.local.json",
    );
    const b = makeRepo({
      ...JS,
      ".gitignore": ".claude/settings.local.json\n",
    });
    await init(b, ["--untracked", "--yes"]);
    expect(read(b, ".git/info/exclude")).not.toContain("settings.local");
  });

  it("ステージだけと push していないコミットのファイルを出し、インデックスと HEAD を変えない", async () => {
    const root = makeRepo(JS);
    writeFiles(root, { ".orca-flow/spec-template.md": "x\n" });
    git(root, "add", ".orca-flow/spec-template.md");
    git(root, "commit", "-q", "-m", "tpl");
    writeFiles(root, { ".orca-flow/config.json": "{}\n" });
    git(root, "add", ".orca-flow/config.json");
    const headBefore = git(root, "rev-parse", "HEAD");
    const indexBefore = git(root, "ls-files", "-s");
    const { io } = await init(root, ["--untracked", "--yes", "--json"]);
    const data = json(io);
    expect(data.trackedFlowFiles).toEqual(
      expect.arrayContaining([
        ".orca-flow/config.json",
        ".orca-flow/spec-template.md",
      ]),
    );
    expect(data.untrackSteps.join("\n")).toContain("git rm -r --cached");
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(root, "ls-files", "-s")).toBe(indexBefore);
  });

  it("push 済み・push していない・ステージだけを分けて文を出し、ステージした .gitignore の行も exclude に足す", async () => {
    const root = makeRepo({ ...JS, ".orca-flow/pushed.md": "p\n" });
    const bare = tempDir("orca-flow-p3-remote-");
    git(bare, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", bare);
    git(root, "push", "-q", "origin", "main");
    writeFiles(root, { ".orca-flow/local.md": "l\n" });
    git(root, "add", ".orca-flow/local.md");
    git(root, "commit", "-q", "-m", "local");
    writeFiles(root, {
      ".orca-flow/メモ's.md": "s\n",
      ".gitignore": "/docs/tasks/\n",
    });
    git(root, "add", ".orca-flow", ".gitignore");
    const { io } = await init(root, ["--untracked", "--yes", "--json"]);
    const data = json(io);
    const steps: string = data.untrackSteps.join("\n");
    expect(steps).toContain("ステージだけのファイル：");
    expect(steps).toContain(
      "push していないコミットにあるファイル：.orca-flow/local.md",
    );
    expect(steps).toContain("push 済みのファイル：.orca-flow/pushed.md");
    expect(steps).toContain("'.orca-flow/メモ'\\''s.md'");
    expect(data.trackedFlowLines).toContain(".gitignore：/docs/tasks/");
    expect(read(root, ".git/info/exclude").split("\n")).toContain(
      "/docs/tasks/",
    );
    // 流し直しても、追跡側の行を exclude に重ねて足さない
    await init(root, ["--untracked", "--yes", "--json"]);
    expect(
      read(root, ".git/info/exclude")
        .split("\n")
        .filter((l) => l === "/docs/tasks/"),
    ).toHaveLength(1);
  });

  it("追跡中の decisionsFile を知らせる", async () => {
    const root = makeRepo({
      ...JS,
      "docs/decisions.md": "# d\n",
      ".orca-flow/config.json": JSON.stringify({
        decisionsFile: "docs/decisions.md",
        appendOnlyFiles: ["docs/decisions.md"],
      }),
    });
    const { io } = await init(root, ["--untracked", "--json"]);
    const data = json(io);
    expect(data.trackedFlowFiles).toContain("docs/decisions.md");
    expect(data.untrackSteps.join("\n")).toContain("decisionsFile が追跡中");
  });

  it("--yes なしでは何も書かない", async () => {
    const root = makeRepo(JS);
    writeFiles(root, {
      ".orca-flow/config.json": JSON.stringify({
        idPrefix: "Q",
        appendOnlyFiles: ["CHANGES.md"],
      }),
    });
    const excludeBefore = read(root, ".git/info/exclude");
    const configBefore = read(root, ".orca-flow/config.json");
    await init(root, ["--untracked"]);
    expect(read(root, ".git/info/exclude")).toBe(excludeBefore);
    expect(read(root, ".orca-flow/config.json")).toBe(configBefore);
    expect(existsSync(path.join(root, ".git/info/attributes"))).toBe(false);
    // --yes をつければ同じ設定で info/attributes ができる（上の確かめが空回りしていない）
    await init(root, ["--untracked", "--yes"]);
    expect(read(root, ".git/info/attributes")).toContain(
      "CHANGES.md merge=union",
    );

    const fresh = makeRepo(JS);
    await init(fresh, ["--untracked"]);
    expect(existsSync(path.join(fresh, ".orca-flow/config.json"))).toBe(false);
  });

  it("--json に untracked・exclude・infoAttributes・trackedFlowFiles・hooks がある", async () => {
    const root = makeRepo(JS);
    const { io } = await init(root, ["--untracked", "--json"]);
    const data = json(io);
    expect(data).toMatchObject({
      untracked: true,
      trackedFlowFiles: [],
      infoAttributes: [],
      hooks: { ok: true },
    });
    expect(data.exclude).toContain("/.orca-flow/");
  });

  it("見出し 2b つきの setup.sh は書き換えず、段がないとは言わない。ない setup.sh は作り直しを案内する", async () => {
    const root = makeRepo(JS);
    const script =
      "#!/bin/sh\n# 2b. git で追跡していない orca-flow のファイルを、x\n";
    writeFiles(root, { ".orca-flow/setup.sh": script });
    const { io } = await init(root, ["--untracked", "--yes"]);
    expect(read(root, ".orca-flow/setup.sh")).toBe(script);
    expect(io.text()).not.toContain("段がありません");

    const old = makeRepo(JS);
    writeFiles(old, { ".orca-flow/setup.sh": "#!/bin/sh\n" });
    const r = await init(old, ["--untracked", "--yes"]);
    expect(r.io.text()).toContain("setup.sh を消して init --yes で作り直して");
    expect(read(old, ".orca-flow/setup.sh")).toBe("#!/bin/sh\n");
  });

  it("流すたびに手順と状態（そろった・そろっていない・確かめられない）を出す", async () => {
    const root = makeRepo(JS);
    const good = await init(root, ["--untracked"]);
    expect(good.io.text()).toContain(
      'bash "$ORCA_ROOT_PATH/.orca-flow/setup.sh"',
    );
    expect(good.io.text()).toContain("状態：そろっています");

    const bad = await init(
      root,
      ["--untracked", "--yes"],
      orca({
        repo: {
          hookSettings: {
            scripts: { setup: "" },
            setupAgentStartupPolicy: "start-immediately",
          },
        },
      }),
    );
    expect(bad.io.text()).toContain("状態：そろっていません");
    expect(bad.io.text()).toContain("流し直して確かめてください");
    expect(bad.io.text()).toContain("wait-for-setup");

    const unknown = await init(root, ["--untracked"], (args) =>
      args[1] === "show"
        ? { code: 1, stdout: "", stderr: "", timedOut: false }
        : orca()(args),
    );
    expect(unknown.io.text()).toContain("状態：確かめられませんでした");
    expect(unknown.code).toBe(0);
  });

  it("untracked でなければ exclude も hooks も出さず、画面の設定も読まない", async () => {
    const root = makeRepo(JS);
    const excludeBefore = read(root, ".git/info/exclude");
    const io = capture();
    const r = fakeOrcaRunner(orca());
    await main(["init", "--yes", "--json"], {
      ...io,
      cwd: root,
      runner: r.runner,
    });
    const data = json(io);
    expect(data.untracked).toBeUndefined();
    expect(data.exclude).toBeUndefined();
    expect(data.hooks).toBeUndefined();
    expect(existsSync(path.join(root, "orca.yaml"))).toBe(true);
    expect(read(root, ".git/info/exclude")).toBe(excludeBefore);
    expect(r.calls.some((c) => c.args[1] === "show")).toBe(false);
  });
});
