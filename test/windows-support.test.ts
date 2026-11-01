import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { findIds } from "../scripts/public/ids.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("改行", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("autocrlf を true にして clone しても、sh と node の入口に CR が入らない", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "orca-flow-crlf-"));
    dirs.push(dir);
    const dest = path.join(dir, "clone");
    // コミット済みの HEAD を clone する（作業ツリーの途中の変更は入らない）
    execFileSync(
      "git",
      ["clone", "-q", "--config", "core.autocrlf=true", ROOT, dest],
      { stdio: "pipe" },
    );
    for (const rel of ["bin/orca-flow", ".orca-flow/setup.sh", "src/main.ts"]) {
      const text = readFileSync(path.join(dest, rel), "utf8");
      expect(text.length, rel).toBeGreaterThan(0);
      expect(text.includes("\r"), rel).toBe(false);
    }
  });
});

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return testFiles(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

describe("テストの PATH", () => {
  it("PATH を ':' でつないでいる所がない（path.delimiter を使う）", () => {
    const self = path.join(ROOT, "test/windows-support.test.ts");
    const hits: string[] = [];
    for (const file of testFiles(path.join(ROOT, "test"))) {
      if (file === self) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!/\bPATH\b/.test(line)) return;
          if (/\}:\$\{|["'`]:["'`]/.test(line))
            hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("README の Windows の節", () => {
  it("Git for Windows・Node の下限・ターミナルのシェルに触れている", () => {
    const readme = read("README.md");
    const start = readme.indexOf("## Windows で使う");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start + 3);
    const next = rest.indexOf("\n## ");
    const section = next < 0 ? rest : rest.slice(0, next);
    expect(section).toContain("Git for Windows");
    expect(section).toContain("Node 22.18 以上");
    expect(section).toContain("ターミナルのシェル");
    expect(section).toContain("Git Bash");
  });
});

describe("Windows のワークフロー", () => {
  const yml = read(".github/workflows/windows.yml");

  it("windows-latest で install・lint・typecheck・test を流し、main への push と手での起動で動く", () => {
    expect(yml).toContain("runs-on: windows-latest");
    for (const cmd of [
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
    ])
      expect(yml).toContain(`run: ${cmd}`);
    expect(yml).toMatch(/push:\s*\n\s+branches: \[main\]/);
    expect(yml).toContain("workflow_dispatch:");
  });

  it("Node は engines の下限に合わせ、pnpm の版は packageManager に任せる", () => {
    const pkg = JSON.parse(read("package.json")) as {
      engines: { node: string };
    };
    const floor = pkg.engines.node.replace(/^>=/, "");
    expect(yml).toContain(`node-version: "${floor}"`);
    expect(yml).not.toMatch(/^\s+version:/m);
  });

  it("公開の確かめの ID の形に当たる語を含まない", () => {
    const prefixes = new Set([DEFAULT_CONFIG.idPrefix]);
    const config = JSON.parse(read(".orca-flow/config.json")) as {
      idPrefix?: string;
    };
    if (config.idPrefix !== undefined) prefixes.add(config.idPrefix);
    for (const prefix of prefixes) expect(findIds(yml, prefix)).toEqual([]);
  });
});
