import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { parseConfig } from "../../src/config.ts";
import {
  INSTALL_MARKER,
  ORCA_YAML,
  TEMPLATES_DIR,
  renderSetupScript,
} from "../../src/commands/init.ts";
import type { RunResult } from "../../src/lib/exec.ts";
import {
  capture,
  fakeOrcaRunner,
  git,
  makeRepo,
  ok,
  tempDir,
  type OrcaHandler,
} from "./helpers.ts";

const JS = {
  "package.json": JSON.stringify({
    scripts: { lint: "eslint .", test: "vitest run" },
  }),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
};

/** repo list に root がない Orca */
const freshOrca =
  (repos: unknown[] = []): OrcaHandler =>
  (args) => {
    if (args[0] === "repo" && args[1] === "list") return ok({ repos });
    return ok({});
  };

async function init(
  cwd: string,
  argv: string[],
  handler: OrcaHandler = freshOrca(),
) {
  const io = capture();
  const r = fakeOrcaRunner(handler);
  const code = await main(["init", ...argv], {
    ...io,
    cwd,
    runner: r.runner,
  });
  return { code, io, calls: r.calls };
}

const status = (root: string) => git(root, "status", "--porcelain");
const head = (root: string) => git(root, "rev-parse", "HEAD").trim();

describe("init", () => {
  it("--yes がなければ一覧を出すだけで何も書かず、Orca も呼ばない", async () => {
    const root = makeRepo(JS);
    const { code, io, calls } = await init(root, []);
    expect(code).toBe(0);
    expect(status(root)).toBe("");
    expect(calls.filter((c) => c.cmd === "orca")).toEqual([]);
    const text = io.text();
    expect(text).toContain("--yes");
    expect(text).toContain(".orca-flow/config.json：置く");
    expect(text).toContain("pnpm lint");
    expect(text).toContain("Bash(orca *)");
    expect(text).toContain("Bash(orca-flow *)");
  });

  it("--yes で、ないファイルを置き、Orca に登録して show にする。コミットしない", async () => {
    const root = makeRepo(JS);
    const before = head(root);
    const { code, calls } = await init(root, ["--yes"]);
    expect(code).toBe(0);

    const config = JSON.parse(
      readFileSync(path.join(root, ".orca-flow/config.json"), "utf8"),
    ) as Record<string, unknown>;
    const parsed = parseConfig(config);
    expect(parsed.verify).toEqual(["pnpm lint", "pnpm test"]);
    expect(parsed.maxActiveTasks).toBe(3);
    expect(parsed.readFirst).toEqual([]);

    const setup = path.join(root, ".orca-flow/setup.sh");
    expect(readFileSync(setup, "utf8")).toContain(
      "pnpm install --frozen-lockfile --prefer-offline",
    );
    expect(readFileSync(setup, "utf8")).not.toContain(INSTALL_MARKER);
    expect(statSync(setup).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(root, "orca.yaml"), "utf8")).toBe(ORCA_YAML);
    expect(existsSync(path.join(root, ".orca-flow/spec-template.md"))).toBe(
      existsSync(path.join(TEMPLATES_DIR, "spec-template.md")),
    );

    const orca = calls.filter((c) => c.cmd === "orca").map((c) => c.args);
    expect(orca).toEqual([
      ["repo", "list", "--json"],
      ["repo", "add", "--path", root, "--json"],
      [
        "repo",
        "set",
        "--repo",
        `path:${root}`,
        "--external-worktree-visibility",
        "show",
        "--json",
      ],
    ]);
    expect(head(root)).toBe(before);
    expect(status(root)).not.toBe("");
  });

  it("登録済みで show なら repo add も repo set もしない", async () => {
    const root = makeRepo(JS);
    const { calls } = await init(
      root,
      ["--yes"],
      freshOrca([{ path: root, externalWorktreeVisibility: "show" }]),
    );
    expect(calls.filter((c) => c.cmd === "orca").map((c) => c.args)).toEqual([
      ["repo", "list", "--json"],
    ]);
  });

  it("登録済みで hide なら repo set だけ", async () => {
    const root = makeRepo(JS);
    const { calls } = await init(
      root,
      ["--yes"],
      freshOrca([{ path: root, externalWorktreeVisibility: "hide" }]),
    );
    const orca = calls.filter((c) => c.cmd === "orca").map((c) => c.args);
    expect(orca.map((a) => a.slice(0, 2).join(" "))).toEqual([
      "repo list",
      "repo set",
    ]);
  });

  it("Orca が動いていなくても、ファイルは置いて0で終わり、手順を出す", async () => {
    const root = makeRepo(JS);
    const down: OrcaHandler = (): RunResult => ({
      code: 1,
      stdout: "",
      stderr: "Orca is not running",
      timedOut: false,
    });
    const { code, io } = await init(root, ["--yes"], down);
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".orca-flow/config.json"))).toBe(true);
    expect(io.text()).toContain(`orca repo add --path ${root}`);
  });

  it("ある orca.yaml と config.json は書き換えず、orca.yaml に足すものを出す", async () => {
    const yaml = "scripts:\n  setup: pnpm install\n";
    const config = JSON.stringify({ verify: ["make check"] });
    const root = makeRepo({
      ...JS,
      "orca.yaml": yaml,
      ".orca-flow/config.json": config,
    });
    const { code, io } = await init(root, ["--yes"]);
    expect(code).toBe(0);
    expect(readFileSync(path.join(root, "orca.yaml"), "utf8")).toBe(yaml);
    expect(
      readFileSync(path.join(root, ".orca-flow/config.json"), "utf8"),
    ).toBe(config);
    expect(io.text()).toContain("orca.yaml はすでにある");
    expect(io.text()).toContain("setup: bash .orca-flow/setup.sh");
    expect(existsSync(path.join(root, ".orca-flow/setup.sh"))).toBe(true);
  });

  it(".gitattributes に appendOnlyFiles の行を足し、重ねて足さない", async () => {
    const root = makeRepo({
      ".orca-flow/config.json": JSON.stringify({
        appendOnlyFiles: ["docs/decisions.md", "CHANGELOG.md"],
      }),
      ".gitattributes": "*.png binary\nCHANGELOG.md merge=union",
    });
    await init(root, ["--yes"]);
    await init(root, ["--yes"]);
    expect(readFileSync(path.join(root, ".gitattributes"), "utf8")).toBe(
      "*.png binary\nCHANGELOG.md merge=union\ndocs/decisions.md merge=union\n",
    );
  });

  it("--yes を2回流しても、置いたファイルは変わらない", async () => {
    const root = makeRepo(JS);
    await init(root, ["--yes"]);
    const first = readFileSync(path.join(root, ".orca-flow/setup.sh"), "utf8");
    const { io } = await init(root, ["--yes"]);
    expect(readFileSync(path.join(root, ".orca-flow/setup.sh"), "utf8")).toBe(
      first,
    );
    expect(io.text()).toContain(
      ".orca-flow/setup.sh：すでにあるので書き換えない",
    );
  });

  it("メインのチェックアウトでなければ2で、何も書かない", async () => {
    const root = makeRepo(JS);
    const wt = path.join(tempDir(), "wt");
    git(root, "worktree", "add", "-q", "-b", "task/T1-x", wt);
    const { code, io } = await init(wt, ["--yes"]);
    expect(code).toBe(2);
    expect(io.errText()).toContain("メインのチェックアウト");
    expect(status(wt)).toBe("");
  });

  it("git の外では2", async () => {
    const { code } = await init(tempDir(), []);
    expect(code).toBe(2);
  });

  it("--json で置くものを JSON で出す", async () => {
    const root = makeRepo(JS);
    const io = capture();
    const r = fakeOrcaRunner(freshOrca());
    const code = await main(["init", "--json"], {
      ...io,
      cwd: root,
      runner: r.runner,
    });
    expect(code).toBe(0);
    const data = JSON.parse(io.text()) as {
      yes: boolean;
      files: { path: string; action: string }[];
    };
    expect(data.yes).toBe(false);
    expect(data.files).toContainEqual({
      path: "orca.yaml",
      action: "create",
    });
  });
});

describe("renderSetupScript", () => {
  it("印の行を依存の導入の行に置き換える", () => {
    const out = renderSetupScript(`a\n${INSTALL_MARKER}\nb\n`, [
      "step x pnpm install",
    ]);
    expect(out).toBe("a\nstep x pnpm install\nb\n");
  });

  it("検出したものがなければコメントにする", () => {
    const out = renderSetupScript(`a\n${INSTALL_MARKER}\n`, []);
    expect(out).not.toContain(INSTALL_MARKER);
    expect(out).toContain("# 依存の導入");
  });
});
