import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import { capture, makeRepo, tempDir, writeFiles } from "../init/helpers.ts";

const done = (r: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

const goodPstack = {
  id: "pstack@cursor-plugins",
  enabled: true,
  installPath: "/p",
};
const goodMarkets = [
  { name: "cursor-plugins", source: "github", repo: "cursor/plugins" },
];

/** git は本物。claude は導入済み（withPlugin が偽なら orca-flow が未導入）、子の CLI は成功を返す偽物 */
const makeRunner =
  (withPlugin: boolean): Runner =>
  async (cmd, args, opts) => {
    if (cmd === "claude") {
      if (args[1] === "list")
        return done({
          stdout: JSON.stringify([
            ...(withPlugin ? [{ id: "orca-flow@x", enabled: true }] : []),
            goodPstack,
          ]),
        });
      if (args[1] === "marketplace")
        return done({ stdout: JSON.stringify(goodMarkets) });
      return done();
    }
    if (cmd === process.execPath)
      return done({ stdout: '{"baseBranch":"main"}' });
    return realRunner(cmd, args, opts);
  };
const runner = makeRunner(true);

const repo = (name: string, p: string, role: "common" | "app", extra = {}) => ({
  name,
  path: p,
  role,
  keywords: [name],
  ...(role === "common"
    ? { scope: "s", package: "@d/c", bumpCommand: "pnpm up" }
    : {}),
  ...extra,
});

/** core はまだなく clone 元に docs/guide.md がある。app は clone 元を持つ */
function scene(
  over: {
    readFirst?: unknown;
    coreHasDoc?: boolean;
    coreFiles?: Record<string, string>;
    appExisting?: boolean;
  } = {},
) {
  const srcCore = makeRepo(
    over.coreFiles ??
      (over.coreHasDoc === false ? {} : { "docs/guide.md": "guide\n" }),
  );
  const srcApp = makeRepo();
  const root = tempDir("orca-flow-setup-rf-");
  const dir = path.join(root, "ws");
  const appDocs = path.relative(dir, path.join(srcApp, "docs", "x.md"));
  const given = path.join(root, "given.json");
  const config = {
    repos: [
      repo("core", "../core", "common", { url: srcCore }),
      over.appExisting
        ? repo("app", path.relative(dir, srcApp), "app")
        : repo("app", "../app", "app", { url: srcApp }),
    ],
    readFirst: over.appExisting
      ? [appDocs]
      : (over.readFirst ?? ["../core/docs/guide.md", "../notes.md"]),
  };
  writeFiles(root, { "given.json": JSON.stringify(config) });
  writeFiles(dir, { ".keep": "" });
  return { root, dir, given, app: srcApp };
}

async function run(dir: string, argv: string[], useRunner: Runner = runner) {
  const io = capture();
  const code = await main(["workspace", ...argv], {
    ...io,
    cwd: dir,
    runner: useRunner,
  });
  return { code, io, all: io.text() + io.errText() };
}

describe("workspace --setup：先に読む文書", () => {
  it("計画で、ない子の下の文書は clone で入る旨、ほかは置く旨を出し、0のまま", async () => {
    const s = scene();
    const r = await run(s.dir, ["--setup", s.given]);
    expect(r.code).toBe(0);
    const core = path.join(s.root, "core", "docs", "guide.md");
    const notes = path.join(s.root, "notes.md");
    expect(r.all).toContain(`${core}（core の clone で入る見込みです）`);
    expect(r.all).toContain(`${notes}（置いてください）`);
    expect(existsSync(path.join(s.root, "core"))).toBe(false);
  });

  it("計画で、すでにある子の下のない文書は、clone で入るとは言わず置く旨を出す", async () => {
    const s = scene({
      appExisting: true,
    });
    const r = await run(s.dir, ["--setup", s.given]);
    expect(r.code).toBe(0);
    const doc = path.join(s.app, "docs", "x.md");
    expect(r.all).toContain(`${doc}（置いてください）`);
    expect(r.all).not.toContain("clone で入る見込み");
  });

  it("計画の --json の next に同じ文が入る", async () => {
    const s = scene();
    const r = await run(s.dir, ["--setup", s.given, "--json"]);
    expect(r.code).toBe(0);
    const next = (JSON.parse(r.io.text()) as { next: string[] }).next;
    expect(next).toHaveLength(2);
    expect(next[0]).toContain("clone で入る見込み");
    expect(next[1]).toContain("置いてください");
  });

  it("文書がすべてあれば、計画に文書の行は出ない", async () => {
    const s = scene({ readFirst: [] });
    const r = await run(s.dir, ["--setup", s.given]);
    expect(r.all).not.toContain("先に読む文書");
  });

  it("--yes で、clone のあとも文書がなければ2で、置く文書のパスを出す", async () => {
    const s = scene();
    const r = await run(s.dir, ["--setup", s.given, "--yes", "--json"]);
    expect(r.code).toBe(2);
    const data = JSON.parse(r.io.text()) as { next: string[] };
    const notes = path.join(s.root, "notes.md");
    expect(data.next).toContain(`先に読む文書を置いてください：${notes}`);
    expect(data.next.join("\n")).not.toContain("guide.md");
    expect(existsSync(path.join(s.root, "core", ".git"))).toBe(true);
  });

  it("--yes で、入る見込みと出した文書が clone のあとも入らなければ2", async () => {
    const s = scene({
      coreHasDoc: false,
      readFirst: ["../core/docs/guide.md"],
    });
    const r = await run(s.dir, ["--setup", s.given, "--yes", "--json"]);
    expect(r.code).toBe(2);
    const data = JSON.parse(r.io.text()) as { next: string[] };
    const doc = path.join(s.root, "core", "docs", "guide.md");
    expect(data.next).toContain(`先に読む文書を置いてください：${doc}`);
    expect(existsSync(path.join(s.root, "core", ".git"))).toBe(true);
  });

  it("--yes で、プラグインを入れたときは開き直しの案内と置く文書の両方を出す", async () => {
    const s = scene();
    const r = await run(
      s.dir,
      ["--setup", s.given, "--yes", "--json"],
      makeRunner(false),
    );
    expect(r.code).toBe(2);
    const data = JSON.parse(r.io.text()) as { next: string[] };
    const notes = path.join(s.root, "notes.md");
    expect(data.next.join("\n")).toContain("Claude Code を開き直して");
    expect(data.next).toContain(`先に読む文書を置いてください：${notes}`);
  });

  it("--yes の文字の出力にも、子の一覧と置く文書が出る", async () => {
    const s = scene();
    const r = await run(s.dir, ["--setup", s.given, "--yes"]);
    expect(r.code).toBe(2);
    expect(r.all).toContain("core");
    expect(r.all).toContain("次の手順");
    expect(r.all).toContain("先に読む文書を置いてください");
  });

  it("--yes で、文書が clone で入れば0", async () => {
    const s = scene({ readFirst: ["../core/docs/guide.md"] });
    const r = await run(s.dir, ["--setup", s.given, "--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(s.root, "core", "docs", "guide.md"))).toBe(
      true,
    );
  });

  it("--yes の終わりの読み直しで出る設定の誤りは1", async () => {
    const s = scene({
      readFirst: ["../core/docs/guide.md"],
      coreFiles: { "docs/guide.md/x": "x\n" },
    });
    const plan = await run(s.dir, ["--setup", s.given]);
    expect(plan.code).toBe(0);
    const r = await run(s.dir, ["--setup", s.given, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("通常のファイルにしてください");
    expect(existsSync(path.join(s.root, "core", ".git"))).toBe(true);
  });
});
