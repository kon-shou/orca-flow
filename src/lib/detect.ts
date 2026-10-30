import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SHARED_PATHS, type PathVerify } from "../config.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";

/** リポジトリを調べた結果。init が config.json・setup.sh・一覧に使う */
export interface Detection {
  /** ルートの JS のパッケージマネージャー。package.json もなければ null */
  packageManager: PackageManager | null;
  /** 見つけたロックファイル（どの階層でも。トップからの相対パス） */
  lockfiles: string[];
  /** ルートの package.json にある scripts */
  scripts: { lint: boolean; typecheck: boolean; test: boolean };
  /** pyproject.toml のあるフォルダ（"." はトップ） */
  pyprojectDirs: string[];
  /** uv.lock のあるフォルダ（"." はトップ） */
  uvDirs: string[];
  /** トップに .worktreeinclude があるか */
  worktreeInclude: boolean;
  /** トップの CLAUDE.md か .claude/CLAUDE.md があるか */
  claudeMd: string | null;
  verify: string[];
  pathVerify: PathVerify[];
  sharedPaths: string[];
  readFirst: string[];
  /** setup.sh の印の場所に入れる行 */
  installLines: string[];
}

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const JS_LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const OTHER_LOCKFILES = ["uv.lock", "Cargo.lock", "go.sum"];

/** トップにあれば sharedPaths に足す設定のファイル */
const EXTRA_SHARED_FILES = [
  ".npmrc",
  ".yarnrc.yml",
  "bunfig.toml",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".tool-versions",
  "go.work",
  "go.work.sum",
  "rust-toolchain",
  "rust-toolchain.toml",
];

const INSTALL: Record<PackageManager, string[]> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
  npm: ["npm", "ci"],
  yarn: ["yarn", "install", "--immutable"],
  bun: ["bun", "install", "--frozen-lockfile"],
};

const SCRIPT_NAMES = ["lint", "typecheck", "test"] as const;

function runScript(pm: PackageManager, name: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm ${name}`;
    case "yarn":
      return `yarn ${name}`;
    case "bun":
      return `bun run ${name}`;
    case "npm":
      return name === "test" ? "npm test" : `npm run ${name}`;
  }
}

/** シェルの1語にする。安全な文字だけならそのまま */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_./=:@%+-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** setup.sh の1行。dir が "." でなければそのフォルダで流す */
export function installLine(
  dir: string,
  label: string,
  argv: readonly string[],
): string {
  const command = argv.map(shellQuote).join(" ");
  return dir === "."
    ? `step ${shellQuote(label)} ${command}`
    : `step_in ${shellQuote(dir)} ${shellQuote(label)} ${command}`;
}

const dirOf = (file: string) => {
  const dir = path.posix.dirname(file);
  return dir === "" ? "." : dir;
};
const baseOf = (file: string) => path.posix.basename(file);

/**
 * ファイルの一覧（トップからの相対パス）と、ファイルを読む関数から検出する。
 * docs/decisions.md のような追記の表らしいファイルは推測しない（人間と決める）
 */
export function detectFromFiles(
  files: readonly string[],
  read: (file: string) => string | null,
): Detection {
  const list = files.filter(
    (file) => !file.split("/").includes("node_modules"),
  );
  const set = new Set(list);

  const lockfileNames = new Set([
    ...JS_LOCKFILES.map(([name]) => name),
    ...OTHER_LOCKFILES,
  ]);
  const lockfiles = list.filter((file) => lockfileNames.has(baseOf(file)));

  // JS：ロックファイルのあるフォルダごとに依存を入れる
  const jsDirs = new Map<string, PackageManager>();
  for (const [name, pm] of JS_LOCKFILES) {
    for (const file of list) {
      if (baseOf(file) !== name) continue;
      const dir = dirOf(file);
      if (!jsDirs.has(dir)) jsDirs.set(dir, pm);
    }
  }
  let packageManager: PackageManager | null = jsDirs.get(".") ?? null;
  const scripts = { lint: false, typecheck: false, test: false };
  if (set.has("package.json")) {
    packageManager ??= "npm";
    const text = read("package.json");
    if (text !== null) {
      try {
        const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
        for (const name of SCRIPT_NAMES) {
          scripts[name] = typeof pkg.scripts?.[name] === "string";
        }
      } catch {
        // 読めない package.json は scripts なしとして扱う
      }
    }
  }

  const verify: string[] = [];
  const pathVerify: PathVerify[] = [];
  const installLines: string[] = [];

  if (packageManager) {
    for (const name of SCRIPT_NAMES) {
      if (scripts[name]) verify.push(runScript(packageManager, name));
    }
  }
  for (const [dir, pm] of [...jsDirs].sort(([a], [b]) =>
    a === "." ? -1 : b === "." ? 1 : a.localeCompare(b),
  )) {
    const argv = INSTALL[pm];
    const where = dir === "." ? "" : `${dir} で `;
    installLines.push(
      installLine(
        dir,
        `依存の導入（${where}${argv.slice(0, 2).join(" ")}）`,
        argv,
      ),
    );
  }

  // Python：pyproject.toml と uv.lock
  const pyprojectDirs = list
    .filter((file) => baseOf(file) === "pyproject.toml")
    .map(dirOf)
    .sort();
  const uvDirs = list
    .filter((file) => baseOf(file) === "uv.lock")
    .map(dirOf)
    .sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)));
  for (const dir of uvDirs) {
    const where = dir === "." ? "" : `${dir} で `;
    installLines.push(
      installLine(dir, `依存の導入（${where}uv sync）`, ["uv", "sync"]),
    );
    const pyproject = read(
      dir === "." ? "pyproject.toml" : `${dir}/pyproject.toml`,
    );
    if (pyproject === null || !/pytest/.test(pyproject)) continue;
    if (dir === ".") verify.push("uv run pytest");
    else
      pathVerify.push({
        paths: [`${dir}/`],
        commands: [`cd ${shellQuote(dir)} && uv run pytest`],
      });
  }

  // Rust と Go（依存はビルドのときに取るので、導入の行は書かない）
  if (set.has("Cargo.toml")) verify.push("cargo test");
  if (set.has("go.mod")) verify.push("go vet ./...", "go test ./...");

  const sharedPaths = [...DEFAULT_SHARED_PATHS];
  for (const file of EXTRA_SHARED_FILES) {
    if (set.has(file) && !sharedPaths.includes(file)) sharedPaths.push(file);
  }

  const claudeMd = set.has("CLAUDE.md")
    ? "CLAUDE.md"
    : set.has(".claude/CLAUDE.md")
      ? ".claude/CLAUDE.md"
      : null;

  return {
    packageManager,
    lockfiles,
    scripts,
    pyprojectDirs,
    uvDirs,
    worktreeInclude: set.has(".worktreeinclude"),
    claudeMd,
    verify,
    pathVerify,
    sharedPaths,
    readFirst: claudeMd ? [claudeMd] : [],
    installLines,
  };
}

/** root（git のトップ）の追跡中のファイルと、無視されていない新しいファイルから検出する */
export async function detectRepo(
  root: string,
  runner: Runner,
): Promise<Detection> {
  const result = await runner(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  );
  if (result.code !== 0) {
    throw new FlowError(
      1,
      `リポジトリのファイルの一覧が取れませんでした：${result.stderr.trim()}`,
    );
  }
  const files = [
    ...new Set(result.stdout.split("\0").filter((file) => file !== "")),
  ];
  const texts = new Map<string, string | null>();
  for (const file of files) {
    const base = baseOf(file);
    if (file === "package.json" || base === "pyproject.toml") {
      try {
        texts.set(file, await readFile(path.join(root, file), "utf8"));
      } catch {
        texts.set(file, null);
      }
    }
  }
  return detectFromFiles(files, (file) => texts.get(file) ?? null);
}

/** cwd がメインのチェックアウト（git-dir と git-common-dir が同じ）か。git の外なら null */
export async function isMainCheckout(
  runner: Runner,
  cwd: string,
): Promise<boolean | null> {
  const result = await runner(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { cwd },
  );
  if (result.code !== 0) return null;
  const [gitDir, commonDir] = result.stdout.trim().split("\n");
  if (!gitDir || !commonDir) return null;
  return path.resolve(gitDir) === path.resolve(commonDir);
}
