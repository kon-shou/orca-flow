import { describe, expect, it } from "vitest";
import { DEFAULT_SHARED_PATHS } from "../../src/config.ts";
import { realRunner } from "../../src/lib/exec.ts";
import { detectRepo, installLine } from "../../src/lib/detect.ts";
import { makeRepo, writeFiles } from "./helpers.ts";

const pkg = (scripts: Record<string, string>) =>
  JSON.stringify({ name: "x", scripts });

describe("detect", () => {
  it("pnpm のワークスペース：ルートの scripts から verify、pnpm install の行", async () => {
    const root = makeRepo({
      "package.json": pkg({
        lint: "eslint .",
        typecheck: "tsc",
        test: "vitest run",
        format: "prettier -w .",
      }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": pkg({ test: "vitest" }),
      ".npmrc": "auto-install-peers=true\n",
      "CLAUDE.md": "# rules\n",
      ".worktreeinclude": ".env.local\n",
    });
    const d = await detectRepo(root, realRunner);
    expect(d.packageManager).toBe("pnpm");
    expect(d.verify).toEqual(["pnpm lint", "pnpm typecheck", "pnpm test"]);
    expect(d.installLines).toEqual([
      installLine(".", "依存の導入（pnpm install）", [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--prefer-offline",
      ]),
    ]);
    expect(d.installLines[0]).toBe(
      "step '依存の導入（pnpm install）' pnpm install --frozen-lockfile --prefer-offline",
    );
    expect(d.sharedPaths).toEqual([...DEFAULT_SHARED_PATHS, ".npmrc"]);
    expect(d.lockfiles).toEqual(["pnpm-lock.yaml"]);
    expect(d.worktreeInclude).toBe(true);
    expect(d.claudeMd).toBe("CLAUDE.md");
    expect(d.readFirst).toEqual(["CLAUDE.md"]);
    expect(d.pathVerify).toEqual([]);
  });

  it("npm：npm run と npm test、npm ci の行。ない scripts は入れない", async () => {
    const root = makeRepo({
      "package.json": pkg({ lint: "eslint .", test: "node --test" }),
      "package-lock.json": "{}",
    });
    const d = await detectRepo(root, realRunner);
    expect(d.packageManager).toBe("npm");
    expect(d.verify).toEqual(["npm run lint", "npm test"]);
    expect(d.installLines).toEqual(["step '依存の導入（npm ci）' npm ci"]);
    expect(d.sharedPaths).toEqual([...DEFAULT_SHARED_PATHS]);
    expect(d.claudeMd).toBeNull();
    expect(d.readFirst).toEqual([]);
  });

  it("uv（サブフォルダ）：そのフォルダで uv sync、pytest は pathVerify に入れる", async () => {
    const root = makeRepo({
      "package.json": pkg({ test: "vitest run" }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "services/backend/pyproject.toml":
        '[project]\nname = "backend"\n[dependency-groups]\ndev = ["pytest"]\n',
      "services/backend/uv.lock": "version = 1\n",
      ".python-version": "3.12\n",
    });
    // node_modules と無視されたファイルは見ない
    writeFiles(root, {
      ".gitignore": "ignored/\n",
      "ignored/uv.lock": "x",
      "node_modules/x/uv.lock": "x",
    });
    const d = await detectRepo(root, realRunner);
    expect(d.uvDirs).toEqual(["services/backend"]);
    expect(d.pyprojectDirs).toEqual(["services/backend"]);
    expect(d.verify).toEqual(["pnpm test"]);
    expect(d.pathVerify).toEqual([
      {
        paths: ["services/backend/"],
        commands: ["cd services/backend && uv run pytest"],
      },
    ]);
    expect(d.installLines).toEqual([
      "step '依存の導入（pnpm install）' pnpm install --frozen-lockfile --prefer-offline",
      "step_in services/backend '依存の導入（services/backend で uv sync）' uv sync",
    ]);
    expect(d.lockfiles.sort()).toEqual([
      "pnpm-lock.yaml",
      "services/backend/uv.lock",
    ]);
    expect(d.sharedPaths).toEqual([...DEFAULT_SHARED_PATHS, ".python-version"]);
  });

  it("uv（トップ）：uv sync と uv run pytest を verify に", async () => {
    const root = makeRepo({
      "pyproject.toml": '[project]\nname = "x"\n[tool.pytest.ini_options]\n',
      "uv.lock": "version = 1\n",
    });
    const d = await detectRepo(root, realRunner);
    expect(d.packageManager).toBeNull();
    expect(d.verify).toEqual(["uv run pytest"]);
    expect(d.installLines).toEqual(["step '依存の導入（uv sync）' uv sync"]);
    expect(d.pathVerify).toEqual([]);
  });

  it("Cargo：cargo test。依存の導入の行は書かない", async () => {
    const root = makeRepo({
      "Cargo.toml": '[package]\nname = "x"\n',
      "Cargo.lock": "version = 3\n",
      "rust-toolchain.toml": '[toolchain]\nchannel = "stable"\n',
    });
    const d = await detectRepo(root, realRunner);
    expect(d.verify).toEqual(["cargo test"]);
    expect(d.installLines).toEqual([]);
    expect(d.lockfiles).toEqual(["Cargo.lock"]);
    expect(d.sharedPaths).toEqual([
      ...DEFAULT_SHARED_PATHS,
      "rust-toolchain.toml",
    ]);
  });

  it("go：go vet と go test。依存の導入の行は書かない", async () => {
    const root = makeRepo({
      "go.mod": "module example.com/x\n\ngo 1.23\n",
      "go.sum": "",
      "go.work": "go 1.23\n",
      ".claude/CLAUDE.md": "# rules\n",
    });
    const d = await detectRepo(root, realRunner);
    expect(d.verify).toEqual(["go vet ./...", "go test ./..."]);
    expect(d.installLines).toEqual([]);
    expect(d.sharedPaths).toEqual([...DEFAULT_SHARED_PATHS, "go.work"]);
    expect(d.readFirst).toEqual([".claude/CLAUDE.md"]);
  });

  it("追記の表らしいファイル（docs/decisions.md）は推測しない", async () => {
    const root = makeRepo({
      "docs/decisions.md": "| 日付 | 判断 |\n| --- | --- |\n",
      "docs/progress.md": "| ID | 状態 |\n| --- | --- |\n",
    });
    const d = await detectRepo(root, realRunner);
    expect(d.sharedPaths).toEqual([...DEFAULT_SHARED_PATHS]);
    expect(JSON.stringify(d)).not.toContain("decisions");
  });
});
