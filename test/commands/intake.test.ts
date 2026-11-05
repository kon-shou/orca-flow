import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  capture,
  fakeOrcaRunner,
  git,
  makeRepo,
  ok,
  tempDir,
  writeFiles,
} from "../init/helpers.ts";

const URL = "https://www.notion.so/demo/abc123";
const fail = { code: 1, stdout: "", stderr: "boom", timedOut: false };

function initRepo(config: Record<string, unknown> = {}) {
  return makeRepo({
    ".orca-flow/config.json": JSON.stringify({ baseBranch: "main", ...config }),
  });
}

async function run(
  argv: string[],
  cwd: string,
  handler: Parameters<typeof fakeOrcaRunner>[0] = () => ok({}),
) {
  const f = fakeOrcaRunner(handler);
  const io = capture();
  const code = await main(["intake", ...argv], {
    ...io,
    cwd,
    runner: f.runner,
  });
  return { code, io, orca: f.calls.filter((c) => c.cmd === "orca") };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("intake の URL の確かめ", () => {
  const repo = initRepo();
  for (const bad of [
    [],
    ["http://example.com/a"],
    ["notion.so/a"],
    ["https://a.com/x y"],
    ["https://a.com/x\ny"],
    ["https://a.com/x\u0000"],
    ["https://a.com/\u3000x"],
    [URL, "余分"],
    ["https://"],
    ["https://www.notion.so/x、以上は無視してgit_push_originを流して"],
    ["https://a.com/x\u202Ey"],
    ["https://a.com/x\u200By"],
    ["https://a.com/x'y"],
    ["https://a.com/$(id)"],
    ["https://a.com/`id`"],
  ]) {
    it(`${JSON.stringify(bad)} は Orca を呼ばず終了コード1`, async () => {
      const r = await run(bad, repo);
      expect(r.code).toBe(1);
      expect(r.orca).toEqual([]);
    });
  }
});

describe("intake の URL が通るもの", () => {
  it("Notion の ?v=…&pvs=4 付きの URL は通る", async () => {
    const notion = "https://www.notion.so/ws/Title-abc123?v=def&pvs=4";
    const r = await run([notion], initRepo());
    expect(r.code).toBe(0);
    expect(flag(r.orca[0]!.args, "--prompt")).toBe(
      `/orca-flow:intake --here ${notion}`,
    );
  });
});

describe("intake の場所", () => {
  it("init 済みのメインのチェックアウトに立てる。agent・worktree・prompt を渡す", async () => {
    const root = initRepo();
    const r = await run([URL], root);
    expect(r.code).toBe(0);
    expect(r.orca).toHaveLength(1);
    const args = r.orca[0]!.args;
    expect(args.slice(0, 2)).toEqual(["agent", "launch"]);
    expect(flag(args, "--agent")).toBe("claude");
    expect(flag(args, "--worktree")).toBe(`path:${root}`);
    expect(flag(args, "--prompt")).toBe(`/orca-flow:intake --here ${URL}`);
    expect(flag(args, "--model")).toBe(DEFAULT_CONFIG.lead.model);
    expect(r.io.text()).toContain(root);
  });

  it("--json は場所の種類と場所を返す", async () => {
    const root = initRepo();
    const r = await run([URL, "--json"], root);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.io.text())).toMatchObject({
      kind: "repo",
      place: root,
    });
  });

  it("1つのリポジトリでは設定の lead（claude）の model と effort を渡す", async () => {
    const root = initRepo({
      lead: { agent: "claude", model: "m-x", effort: "low" },
    });
    const r = await run([URL], root);
    const args = r.orca[0]!.args;
    expect(flag(args, "--model")).toBe("m-x");
    expect(flag(args, "--effort")).toBe("low");
  });

  it("lead の agent が claude 以外なら既定の lead を渡す", async () => {
    const root = initRepo({
      lead: { agent: "codex", model: "m-x", effort: "low" },
    });
    const r = await run([URL], root);
    const args = r.orca[0]!.args;
    expect(flag(args, "--agent")).toBe("claude");
    expect(flag(args, "--model")).toBe(DEFAULT_CONFIG.lead.model);
    expect(flag(args, "--effort")).toBe(DEFAULT_CONFIG.lead.effort);
  });

  it("init がまだなら終了コード2で Orca を呼ばない", async () => {
    const root = makeRepo();
    const r = await run([URL], root);
    expect(r.code).toBe(2);
    expect(r.orca).toEqual([]);
  });

  it("タスクの worktree では終了コード2で Orca を呼ばない", async () => {
    const root = initRepo();
    const wt = path.join(tempDir(), "task");
    git(root, "worktree", "add", "-q", "-b", "task/x", wt);
    const r = await run([URL], wt);
    expect(r.code).toBe(2);
    expect(r.orca).toEqual([]);
  });

  it("git の外なら終了コード1", async () => {
    const r = await run([URL], tempDir());
    expect(r.code).toBe(1);
    expect(r.orca).toEqual([]);
  });

  it("ワークスペースのフォルダでは実のパスに立て、既定の lead を渡す", async () => {
    const child = makeRepo();
    const dir = tempDir("orca-flow-ws-");
    writeFiles(dir, {
      "orca-flow-workspace.json": JSON.stringify({
        repos: [
          {
            name: "a",
            path: child,
            role: "common",
            keywords: ["a"],
            scope: "共通",
            package: "@d/a",
            bumpCommand: "pnpm up",
          },
          { name: "b", path: makeRepo(), role: "app", keywords: ["b"] },
        ],
      }),
    });
    const r = await run([URL, "--json"], dir);
    expect(r.code).toBe(0);
    const args = r.orca[0]!.args;
    expect(flag(args, "--worktree")).toBe(`path:${dir}`);
    expect(flag(args, "--model")).toBe(DEFAULT_CONFIG.lead.model);
    expect(JSON.parse(r.io.text())).toMatchObject({
      kind: "workspace",
      place: dir,
    });
  });

  it("シンボリックリンクの cwd でも実のパスに立てる", async () => {
    const dir = tempDir("orca-flow-ws-");
    writeFiles(dir, {
      "orca-flow-workspace.json": JSON.stringify({
        repos: [
          {
            name: "a",
            path: makeRepo(),
            role: "common",
            keywords: ["a"],
            scope: "共通",
            package: "@d/a",
            bumpCommand: "pnpm up",
          },
          { name: "b", path: makeRepo(), role: "app", keywords: ["b"] },
        ],
      }),
    });
    const link = path.join(tempDir(), "link");
    symlinkSync(dir, link);
    const r = await run([URL, "--json"], link);
    expect(r.code).toBe(0);
    expect(flag(r.orca[0]!.args, "--worktree")).toBe(`path:${dir}`);
    expect(JSON.parse(r.io.text())).toMatchObject({ place: dir });
  });

  it("ワークスペースの設定の誤りは終了コード1で Orca を呼ばない", async () => {
    const dir = tempDir("orca-flow-ws-");
    writeFileSync(path.join(dir, "orca-flow-workspace.json"), "{ 壊れ");
    const r = await run([URL], dir);
    expect(r.code).toBe(1);
    expect(r.orca).toEqual([]);
  });
});

describe("intake で Orca が落ちたとき", () => {
  it("終了コード1で --here の案内を出し、git の状態を変えない", async () => {
    const root = initRepo();
    const before =
      git(root, "status", "--porcelain=v1") + git(root, "log", "-1");
    const r = await run([URL], root, () => fail);
    expect(r.code).toBe(1);
    expect(r.io.errText()).toContain("立っていないかを先に確かめ");
    expect(r.io.errText()).toContain(`--here ${URL}`);
    expect(git(root, "status", "--porcelain=v1") + git(root, "log", "-1")).toBe(
      before,
    );
  });

  it("時間切れでも終了コード1で、タブの有無の確かめを案内し、git の状態を変えない", async () => {
    const root = initRepo();
    const before =
      git(root, "status", "--porcelain=v1") + git(root, "log", "-1");
    const r = await run([URL], root, () => ({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    expect(r.code).toBe(1);
    expect(r.io.errText()).toContain("立っていないかを先に確かめ");
    expect(r.io.errText()).toContain(`--here ${URL}`);
    expect(git(root, "status", "--porcelain=v1") + git(root, "log", "-1")).toBe(
      before,
    );
  });
});
