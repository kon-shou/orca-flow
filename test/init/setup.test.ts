import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATES_DIR, renderSetupScript } from "../../src/commands/init.ts";
import { detectFromFiles } from "../../src/lib/detect.ts";
import { git, makeRepo, tempDir, writeFiles } from "./helpers.ts";

const MARKER = "MARKER_SECRET_VALUE_6b1f";

function fakeBin(): { dir: string; log: string } {
  const dir = tempDir("orca-flow-p3-bin-");
  const log = path.join(dir, "calls.log");
  for (const name of ["pnpm", "uv"]) {
    const file = path.join(dir, name);
    writeFileSync(
      file,
      `#!/bin/sh\necho "${name} $* @ $(pwd -P)" >> "${log}"\n` +
        `[ "${name}" = pnpm ] && exit "\${FAKE_PNPM_EXIT:-0}"\nexit 0\n`,
    );
    chmodSync(file, 0o755);
  }
  return { dir, log };
}

function setupRepo() {
  const detection = detectFromFiles(
    ["package.json", "pnpm-lock.yaml", "services/backend/uv.lock"],
    () => null,
  );
  const script = renderSetupScript(
    readFileSync(path.join(TEMPLATES_DIR, "setup.sh"), "utf8"),
    detection.installLines,
  );
  const root = makeRepo({
    "package.json": "{}",
    "pnpm-lock.yaml": "",
    "services/backend/uv.lock": "",
    ".gitignore": ".env.local\nsecrets/\n",
    ".worktreeinclude":
      "# 秘密のファイル\n.env.local\nsecrets/*.key\nmissing.env\n",
    ".orca-flow/setup.sh": script,
  });
  writeFiles(root, {
    ".env.local": `TOKEN=${MARKER}\n`,
    "secrets/a.key": `${MARKER}-a\n`,
    "secrets/b.key": `${MARKER}-b\n`,
    "secrets/c.txt": "not included\n",
  });
  const wt = path.join(tempDir("orca-flow-p3-wt-"), "T1");
  git(root, "worktree", "add", "-q", "-b", "task/T1-x", wt);
  return { root, wt };
}

function runSetup(cwd: string, bin: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [".orca-flow/setup.sh"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    },
  });
}

describe("setup.sh", () => {
  it(".worktreeinclude のファイルをコピーし、あるものは上書きせず、中身を出さず、依存を入れる", () => {
    const { root, wt } = setupRepo();
    writeFiles(wt, { "secrets/b.key": "mine\n" });
    const bin = fakeBin();
    const result = runSetup(wt, bin.dir);
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);

    expect(readFileSync(path.join(wt, ".env.local"), "utf8")).toBe(
      `TOKEN=${MARKER}\n`,
    );
    expect(readFileSync(path.join(wt, "secrets/a.key"), "utf8")).toBe(
      `${MARKER}-a\n`,
    );
    expect(readFileSync(path.join(wt, "secrets/b.key"), "utf8")).toBe("mine\n");
    expect(existsSync(path.join(wt, "secrets/c.txt"))).toBe(false);
    expect(existsSync(path.join(wt, "missing.env"))).toBe(false);
    expect(output).not.toContain(MARKER);
    expect(output).toContain(".env.local");

    const calls = readFileSync(bin.log, "utf8").trim().split("\n");
    expect(calls).toEqual([
      `pnpm install --frozen-lockfile --prefer-offline @ ${wt}`,
      `uv sync @ ${path.join(wt, "services/backend")}`,
    ]);
    expect(readFileSync(path.join(root, ".env.local"), "utf8")).toContain(
      MARKER,
    );
  });

  it("pnpm が失敗したら0以外で終わり、どの段階かを日本語で出す", () => {
    const { wt } = setupRepo();
    const bin = fakeBin();
    const result = runSetup(wt, bin.dir, { FAKE_PNPM_EXIT: "3" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "「依存の導入（pnpm install）」の段階で失敗しました",
    );
    expect(result.stderr).not.toContain(MARKER);
    // 後の段階は流さない
    expect(readFileSync(bin.log, "utf8")).not.toContain("uv sync");
  });

  it("メインのチェックアウトでは何もしない", () => {
    const { root } = setupRepo();
    const bin = fakeBin();
    const before = git(root, "status", "--porcelain", "--ignored");
    const result = runSetup(root, bin.dir);
    expect(result.status).toBe(0);
    expect(existsSync(bin.log)).toBe(false);
    expect(git(root, "status", "--porcelain", "--ignored")).toBe(before);
  });

  it("サブフォルダから流しても worktree のトップで動く", () => {
    const { wt } = setupRepo();
    const bin = fakeBin();
    const result = spawnSync("bash", ["../../.orca-flow/setup.sh"], {
      cwd: path.join(wt, "services/backend"),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin.dir}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(wt, ".env.local"))).toBe(true);
  });
});

describe("setup.sh の 2b の段", () => {
  function stageRepo(ignored: boolean) {
    const script = renderSetupScript(
      readFileSync(path.join(TEMPLATES_DIR, "setup.sh"), "utf8"),
      [],
    );
    const root = makeRepo({
      ".gitignore": ignored ? ".orca-flow/\n.claude/settings.local.json\n" : "",
      ...(ignored
        ? {}
        : { ".orca-flow/config.json": "{}\n", ".orca-flow/setup.sh": script }),
    });
    writeFiles(root, {
      ".orca-flow/config.json": "{}\n",
      ".orca-flow/setup.sh": script,
      ".orca-flow/lint.md": "rules\n",
      ".claude/settings.local.json": '{"a":1}\n',
    });
    if (!ignored) git(root, "add", "-A");
    const wt = path.join(tempDir("orca-flow-p3-wt-"), "T2");
    git(root, "worktree", "add", "-q", "-b", "task/T2-x", wt);
    return { root, wt, script };
  }

  const runMain = (root: string, wt: string) =>
    spawnSync("bash", [path.join(root, ".orca-flow/setup.sh")], {
      cwd: wt,
      encoding: "utf8",
    });

  it("無視されているときだけコピーし、あれば上書きせず、中身を出さない", () => {
    const { root, wt } = stageRepo(true);
    writeFiles(root, { ".orca-flow/lint.md": "SECRET_BODY_77\n" });
    writeFiles(wt, { ".orca-flow/lint.md": "mine\n" });
    const result = runMain(root, wt);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(wt, ".orca-flow/config.json"))).toBe(true);
    expect(readFileSync(path.join(wt, ".orca-flow/lint.md"), "utf8")).toBe(
      "mine\n",
    );
    expect(
      readFileSync(path.join(wt, ".claude/settings.local.json"), "utf8"),
    ).toBe('{"a":1}\n');
    expect(result.stdout + result.stderr).not.toContain("SECRET_BODY_77");
  });

  it("追跡されているリポジトリでは何もコピーしない", () => {
    const { root, wt } = stageRepo(false);
    git(wt, "rm", "-q", "-r", "--cached", "--ignore-unmatch", ".claude");
    const result = runMain(root, wt);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(wt, ".claude/settings.local.json"))).toBe(
      false,
    );
  });

  it("無視されていないファイルはコピーしない", () => {
    const { root, wt } = stageRepo(true);
    writeFileSync(path.join(wt, ".gitignore"), ".orca-flow/\n");
    const result = runMain(root, wt);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(wt, ".claude/settings.local.json"))).toBe(
      false,
    );
    expect(result.stderr).toContain(
      "無視されていないのでコピーしません：.claude/settings.local.json",
    );
  });
});
