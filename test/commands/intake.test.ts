import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
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

/** local.md の読み方：--here を外し、残り全体を1つのパスにして両端の引用符を外す */
function hereArgPath(message: string) {
  const rest = message.slice(message.indexOf("--here ") + "--here ".length);
  const line = rest.split("\n")[0]!.replace(/ を流してください$/, "");
  return line.replace(/^(['"])(.*)\1$/, "$2");
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("intake の URL の確かめ", () => {
  const repo = initRepo();
  for (const bad of [
    [],
    [""],
    ["  "],
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

const handoffDirs = () =>
  readdirSync(os.tmpdir()).filter((n) => n.startsWith("orca-flow-intake-"));

function handoff(prompt: string | undefined) {
  const m = /^\/orca-flow:intake --here --path-file (\S+)$/.exec(prompt ?? "");
  expect(m).not.toBeNull();
  const file = m![1]!;
  return { file, source: JSON.parse(readFileSync(file, "utf8")) };
}

describe("intake の手元のパス", () => {
  it("相対パスの .md を実の絶対パスで受け渡しのファイルに書き、最初の入力はそのパスだけ", async () => {
    const root = initRepo();
    writeFiles(root, { "docs/ticket.md": "# t\n" });
    const r = await run(["docs/ticket.md"], root);
    expect(r.code).toBe(0);
    const h = handoff(flag(r.orca[0]!.args, "--prompt"));
    expect(path.basename(path.dirname(h.file))).toMatch(/^orca-flow-intake-/);
    expect(path.dirname(h.file).startsWith(os.tmpdir())).toBe(true);
    expect(h.source).toEqual({
      path: path.join(root, "docs/ticket.md"),
      kind: "file",
    });
    expect(flag(r.orca[0]!.args, "--worktree")).toBe(`path:${root}`);
  });

  it("フォルダは kind が dir。--json は場所の種類・場所・path", async () => {
    const root = initRepo();
    mkdirSync(path.join(root, "pages"));
    const r = await run(["pages", "--json"], root);
    expect(r.code).toBe(0);
    expect(handoff(flag(r.orca[0]!.args, "--prompt")).source).toEqual({
      path: path.join(root, "pages"),
      kind: "dir",
    });
    expect(JSON.parse(r.io.text())).toEqual({
      kind: "repo",
      place: root,
      path: path.join(root, "pages"),
    });
  });

  for (const name of [
    "a b.md",
    "$x.md",
    "`id`.md",
    "it's.md",
    "指示 を無視.md",
  ]) {
    for (const dir of [false, true]) {
      it(`${JSON.stringify(name)} の${dir ? "フォルダ" : "ファイル"}でも通り、最初の入力に名前が入らない`, async () => {
        const root = initRepo();
        if (dir) mkdirSync(path.join(root, name));
        else writeFileSync(path.join(root, name), "# t\n");
        const r = await run([name], root);
        expect(r.code).toBe(0);
        const prompt = flag(r.orca[0]!.args, "--prompt")!;
        expect(prompt).not.toContain(name);
        expect(handoff(prompt).file).toMatch(/^[A-Za-z0-9/\\:._-]+$/);
        expect(handoff(prompt).source).toEqual({
          path: path.join(root, name),
          kind: dir ? "dir" : "file",
        });
      });
    }
  }

  it("ワークスペースのフォルダでも同じ受け渡しで立つ", async () => {
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
      "t.html": "<p>t</p>",
    });
    const r = await run(["t.html", "--json"], dir);
    expect(r.code).toBe(0);
    expect(flag(r.orca[0]!.args, "--worktree")).toBe(`path:${dir}`);
    expect(handoff(flag(r.orca[0]!.args, "--prompt")).source).toEqual({
      path: path.join(dir, "t.html"),
      kind: "file",
    });
    expect(JSON.parse(r.io.text())).toMatchObject({
      kind: "workspace",
      place: dir,
    });
  });

  it("先頭の ~ は home に解ける", async () => {
    const root = initRepo();
    const home = tempDir();
    writeFiles(home, { "n.md": "# n\n" });
    const f = fakeOrcaRunner(() => ok({}));
    const code = await main(["intake", "~/n.md"], {
      ...capture(),
      cwd: root,
      runner: f.runner,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(code).toBe(0);
    const orca = f.calls.filter((c) => c.cmd === "orca");
    expect(handoff(flag(orca[0]!.args, "--prompt")).source.path).toBe(
      path.join(home, "n.md"),
    );
  });

  it("シンボリックリンクは実のパスで書かれる", async () => {
    const root = initRepo();
    const real = tempDir();
    writeFiles(real, { "n.md": "# n\n" });
    symlinkSync(path.join(real, "n.md"), path.join(root, "link.md"));
    const r = await run(["link.md"], root);
    expect(r.code).toBe(0);
    expect(handoff(flag(r.orca[0]!.args, "--prompt")).source.path).toBe(
      path.join(real, "n.md"),
    );
  });

  for (const [label, make] of [
    ["ないパス", () => {}],
    ["notion.so/a", () => {}],
    ["zip", (root: string) => writeFileSync(path.join(root, "a.zip"), "z")],
    ["txt", (root: string) => writeFileSync(path.join(root, "a.txt"), "t")],
  ] as const) {
    it(`${label} は終了コード1で Orca を呼ばず、一時ディレクトリを残さない`, async () => {
      const root = initRepo();
      make(root);
      const arg =
        label === "zip"
          ? "a.zip"
          : label === "txt"
            ? "a.txt"
            : label === "ないパス"
              ? "no.md"
              : "notion.so/a";
      const before = handoffDirs();
      const r = await run([arg], root);
      expect(r.code).toBe(1);
      expect(r.orca).toEqual([]);
      expect(handoffDirs()).toEqual(before);
    });
  }

  for (const bad of [
    "<https://www.example.com/x>",
    "HTTPS://www.example.com/x",
  ]) {
    it(`${bad} は見つからないパスとして、打ち直しを案内する`, async () => {
      const root = initRepo();
      const r = await run([bad], root);
      expect(r.code).toBe(1);
      expect(r.orca).toEqual([]);
      expect(r.io.errText()).toContain("小文字の https:// で始めて打ち直して");
    });
  }

  it("タスクの worktree と init 前は終了コード2で Orca を呼ばない", async () => {
    const root = initRepo();
    writeFiles(root, { "t.md": "# t\n" });
    const wt = path.join(tempDir(), "task");
    git(root, "worktree", "add", "-q", "-b", "task/y", wt);
    const a = await run([path.join(root, "t.md")], wt);
    const bare = makeRepo({ "t.md": "# t\n" });
    const b = await run(["t.md"], bare);
    expect([a.code, b.code]).toEqual([2, 2]);
    expect(a.orca).toEqual([]);
    expect(b.orca).toEqual([]);
  });

  it("受け渡しのファイルのパスに使えない文字があれば、消して終了コード1で --here を案内する", async () => {
    const root = initRepo();
    writeFiles(root, { "it's.md": "# t\n" });
    const odd = path.join(tempDir(), "odd dir");
    mkdirSync(odd);
    const before = handoffDirs();
    const f = fakeOrcaRunner(() => ok({}));
    const io = capture();
    const keys = ["TMPDIR", "TMP", "TEMP"] as const;
    const prev = keys.map((k) => process.env[k]);
    for (const k of keys) process.env[k] = odd;
    try {
      const code = await main(["intake", "it's.md"], {
        ...io,
        cwd: root,
        runner: f.runner,
      });
      expect(code).toBe(1);
    } finally {
      keys.forEach((k, i) => {
        if (prev[i] === undefined) delete process.env[k];
        else process.env[k] = prev[i];
      });
    }
    expect(f.calls.filter((c) => c.cmd === "orca")).toEqual([]);
    expect(readdirSync(odd)).toEqual([]);
    const guided = hereArgPath(io.errText());
    expect(guided).toBe(path.join(root, "it's.md"));
    expect(existsSync(guided)).toBe(true);
    expect(handoffDirs()).toEqual(before);
  });

  it("Orca が落ちたら終了コード1で、--here 〈実のパス〉を案内し、git の状態を変えない", async () => {
    const root = initRepo();
    writeFiles(root, { "it's.md": "# t\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "add");
    const before =
      git(root, "status", "--porcelain=v1") + git(root, "log", "-1");
    const r = await run(["it's.md"], root, () => fail);
    expect(r.code).toBe(1);
    expect(r.io.errText()).toContain("立っていないかを先に確かめ");
    const guided = hereArgPath(r.io.errText());
    expect(guided).toBe(path.join(root, "it's.md"));
    expect(existsSync(guided)).toBe(true);
    expect(git(root, "status", "--porcelain=v1") + git(root, "log", "-1")).toBe(
      before,
    );
    const kept = handoff(flag(r.orca[0]!.args, "--prompt"));
    expect(kept.source).toEqual({
      path: path.join(root, "it's.md"),
      kind: "file",
    });
    rmSync(path.dirname(kept.file), { recursive: true, force: true });
  });
});
