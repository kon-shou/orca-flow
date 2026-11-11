import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import { capture, makeRepo, tempDir, writeFiles } from "../init/helpers.ts";

const done = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

interface ChildCall {
  args: string[];
  requestText: string | null;
  requestPath: string | null;
}

/** 子の CLI の呼び出しを記録する偽物。依頼のファイルは呼ばれた時点の中身を読む */
function fake(options: { fail?: boolean } = {}) {
  const calls: ChildCall[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd !== process.execPath) return realRunner(cmd, args, opts);
    const list = args.slice(2);
    const at = list.findIndex(
      (a) => a === "--request-file" || a.startsWith("--request-file="),
    );
    let requestPath: string | null = null;
    let requestText: string | null = null;
    if (at >= 0) {
      requestPath = list[at]!.includes("=")
        ? list[at]!.slice("--request-file=".length)
        : list[at + 1]!;
      requestText = await readFile(requestPath, "utf8");
    }
    calls.push({ args: list, requestText, requestPath });
    if (list[0] === "config")
      return done({ stdout: JSON.stringify({ baseBranch: "main" }) });
    return options.fail
      ? done({ code: 1, stderr: "失敗" })
      : done({ stdout: "{}" });
  };
  return { runner, calls };
}

async function workspace(readFirst?: unknown) {
  const outer = tempDir("orca-flow-ws-");
  const dir = path.join(outer, "ws");
  const repos = [
    {
      name: "kit",
      path: makeRepo(),
      role: "common",
      keywords: ["共通"],
      scope: "部品",
      package: "@example/kit",
      bumpCommand: "pnpm up @example/kit",
    },
    { name: "shop", path: makeRepo(), role: "app", keywords: ["画面"] },
  ];
  writeFiles(dir, {
    "orca-flow-workspace.json": JSON.stringify({
      repos,
      ...(readFirst === undefined ? {} : { readFirst }),
    }),
    "docs/deploy.md": "デプロイ",
    "request.md": "# やりたいこと\n\n本文",
  });
  writeFiles(outer, { "ci.md": "CI" });
  return { dir, outer };
}

const NEW = ["workspace", "shop", "new", "--title", "t", "--slug", "s"];

describe("workspace --json の readFirst", () => {
  it("実の絶対パスで出る（フォルダの外の相対を含む）", async () => {
    const { dir, outer } = await workspace(["docs/deploy.md", "../ci.md"]);
    const io = capture();
    await main(["workspace", "--json"], {
      ...io,
      cwd: dir,
      runner: fake().runner,
    });
    const data = JSON.parse(io.text()) as { readFirst?: string[] };
    expect(data.readFirst).toEqual([
      path.join(await realpath(dir), "docs", "deploy.md"),
      path.join(await realpath(outer), "ci.md"),
    ]);
  });

  it("欄がなければキーがない", async () => {
    const { dir } = await workspace();
    const io = capture();
    await main(["workspace", "--json"], {
      ...io,
      cwd: dir,
      runner: fake().runner,
    });
    expect(JSON.parse(io.text())).not.toHaveProperty("readFirst");
  });

  it("ないファイルは終了コード1で、パスが分かる", async () => {
    const { dir } = await workspace(["docs/none.md"]);
    const io = capture();
    const code = await main(["workspace", "--json"], {
      ...io,
      cwd: dir,
      runner: fake().runner,
    });
    expect(code).toBe(1);
    expect(io.text() + io.errText()).toContain("docs/none.md");
  });
});

function readFirstArg(args: string[]): string[] | null {
  const at = args.findIndex(
    (a) => a === "--read-first-json" || a.startsWith("--read-first-json="),
  );
  if (at < 0) return null;
  const value = args[at]!.includes("=")
    ? args[at]!.slice("--read-first-json=".length)
    : args[at + 1]!;
  return JSON.parse(value) as string[];
}

describe("workspace 〈名前〉 new の先に読む文書", () => {
  const run = async (extra: string[], readFirst?: unknown) => {
    const { dir } = await workspace(readFirst);
    const f = fake();
    const io = capture();
    const code = await main([...NEW, ...extra], {
      ...io,
      cwd: dir,
      runner: f.runner,
    });
    return { dir, f, code, io };
  };

  it("--request-file 値：絶対パスで、元のパスと中身のまま渡り、文書は --read-first-json で渡る", async () => {
    const { dir, f } = await run(
      ["--request-file", "request.md"],
      ["docs/deploy.md"],
    );
    const call = f.calls.find((c) => c.args[0] === "new")!;
    const real = await realpath(dir);
    expect(call.requestText).toBe("# やりたいこと\n\n本文");
    expect(call.requestPath).toBe(path.join(dir, "request.md"));
    expect(readFirstArg(call.args)).toEqual([
      path.join(real, "docs", "deploy.md"),
    ]);
  });

  it("--request-file=値 も同じ", async () => {
    const { dir, f } = await run(
      ["--request-file=request.md"],
      ["docs/deploy.md"],
    );
    const call = f.calls.find((c) => c.args[0] === "new")!;
    expect(call.requestText).toBe("# やりたいこと\n\n本文");
    expect(call.requestPath).toBe(path.join(dir, "request.md"));
    expect(readFirstArg(call.args)).toHaveLength(1);
  });

  it("--request-file がなくても渡る", async () => {
    const { f } = await run([], ["docs/deploy.md"]);
    const call = f.calls.find((c) => c.args[0] === "new")!;
    expect(call.args.join(" ")).not.toContain("request-file");
    expect(readFirstArg(call.args)).toHaveLength(1);
  });

  it("子が失敗しても終了コードは子のまま", async () => {
    const { dir } = await workspace(["docs/deploy.md"]);
    const code = await main([...NEW, "--request-file", "request.md"], {
      ...capture(),
      cwd: dir,
      runner: fake({ fail: true }).runner,
    });
    expect(code).toBe(1);
  });

  it("readFirst がなければ渡さない", async () => {
    const { f } = await run(["--request-file", "request.md"]);
    const call = f.calls.find((c) => c.args[0] === "new")!;
    expect(readFirstArg(call.args)).toBeNull();
    expect(call.requestText).toBe("# やりたいこと\n\n本文");
  });

  it("new 以外には渡さない", async () => {
    const { dir } = await workspace(["docs/deploy.md"]);
    const f = fake();
    await main(["workspace", "shop", "config"], {
      ...capture(),
      cwd: dir,
      runner: f.runner,
    });
    const call = f.calls.find((c) => c.args[0] === "config")!;
    expect(call.args.join(" ")).not.toContain("read-first-json");
  });

  it.each([
    [["--read-first-json", '["/x.md"]']],
    [['--read-first-json=["/x.md"]']],
  ])(
    "人が --read-first-json を書くと、子を流さず終了コード1",
    async (extra) => {
      const { f, code, io } = await run(extra, ["docs/deploy.md"]);
      expect(code).toBe(1);
      expect(io.errText()).toContain("--read-first-json");
      expect(f.calls.find((c) => c.args[0] === "new")).toBeUndefined();
    },
  );

  it.each([[["--read-first-from", "T03"]], [["--read-first-from=T03"]]])(
    "readFirst があるとき --read-first-from を書くと、子を流さず終了コード1で、理由が分かる",
    async (extra) => {
      const { f, code, io } = await run(extra, ["docs/deploy.md"]);
      expect(code).toBe(1);
      expect(io.errText()).toContain("--read-first-from");
      expect(io.errText()).toContain("readFirst");
      expect(io.errText()).not.toContain("--read-first-json");
      expect(f.calls.find((c) => c.args[0] === "new")).toBeUndefined();
    },
  );

  it("readFirst がなければ --read-first-from はそのまま子へ渡り、--read-first-json は付かない", async () => {
    const { f, code } = await run(["--read-first-from", "T03"]);
    expect(code).toBe(0);
    const call = f.calls.find((c) => c.args[0] === "new")!;
    const at = call.args.indexOf("--read-first-from");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(call.args[at + 1]).toBe("T03");
    expect(readFirstArg(call.args)).toBeNull();
  });
});
