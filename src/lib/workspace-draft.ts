import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import { isMainWorktree } from "./git.ts";
import { SLUG_PATTERN } from "./slug.ts";
import { BRANCH_DEFINITION_FILES, hasPackageName } from "./branch-push.ts";

export type DraftManager = "pnpm" | "npm" | "yarn" | "bun" | "composer";

/** `workspace --draft` の、子1つ分 */
export interface DraftRepo {
  /** フォルダ名が slug の形ならそれ。違えば null */
  name: string | null;
  /** 設定に書く形（ワークスペースのフォルダからの相対） */
  path: string;
  /** origin の clone 元。なければ null。認証の値が入っているときと、「-」で始まるときも null（理由は problems） */
  url: string | null;
  package: string | null;
  manager: DraftManager | null;
  /** HEAD の一番上にある Playwright か Cypress の設定のファイル名。なければ null */
  e2e: string | null;
  role: "common" | "app";
  /** このパッケージ名を使うほかの対象の名前の並び。読めなければ null */
  users: string[] | null;
  problems: string[];
}

export interface DraftListing {
  /** ワークスペースのフォルダ（今の場所）の実のパス */
  dir: string;
  repos: DraftRepo[];
}

/** 種類の違うロックファイルが複数あるときは、この並びの先のものを取る */
const LOCKFILES: readonly [string, DraftManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["composer.lock", "composer"],
];

/** E2E の道具の設定のファイル（HEAD の一番上）。先に見つかったものを取る */
const E2E_CONFIG_FILES = [
  ...["ts", "js", "mjs", "cjs", "mts", "cts"].map(
    (ext) => `playwright.config.${ext}`,
  ),
  ...["ts", "js", "mjs", "cjs", "mts", "cts"].map(
    (ext) => `cypress.config.${ext}`,
  ),
];

/** 名前を読む定義。両方に name があれば先の package.json を取る */
const NAME_FILES = ["package.json", "composer.json"] as const;

const realOrNull = async (p: string): Promise<string | null> => {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
};

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
  );
};

/** ユーザー名やトークンを含む clone 元か（ssh の `git@host` のようにユーザー名だけの ssh は秘密ではないので含めない） */
export function urlHasCredentials(url: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)@/i.exec(url);
  if (!m) return false;
  const userinfo = m[2]!;
  if (userinfo.includes(":")) return true;
  return !/^(ssh|git\+ssh|ssh\+git)$/i.test(m[1]!);
}

async function topLevelProblem(
  runner: Runner,
  real: string,
): Promise<string | null> {
  const top = await runner("git", ["rev-parse", "--show-toplevel"], {
    cwd: real,
  });
  if (top.code !== 0) return "git のリポジトリではありません";
  if ((await realOrNull(top.stdout.trim())) !== real)
    return "リポジトリの一番上ではありません（リポジトリの下のフォルダです）";
  let main = false;
  try {
    main = await isMainWorktree(runner, real);
  } catch {
    main = false;
  }
  return main
    ? null
    : "リンクした worktree です（メインの作業ツリーを指してください）";
}

async function readHeadName(
  runner: Runner,
  repo: string,
): Promise<string | null> {
  for (const file of NAME_FILES) {
    const r = await runner("git", ["show", `HEAD:${file}`], { cwd: repo });
    if (r.code !== 0) continue;
    try {
      const name = (JSON.parse(r.stdout) as { name?: unknown }).name;
      if (typeof name === "string" && name !== "") return name;
    } catch {
      // 読めない定義は名前なしとして次へ
    }
  }
  return null;
}

async function readManager(
  runner: Runner,
  repo: string,
): Promise<DraftManager | null> {
  const r = await runner("git", ["ls-tree", "--name-only", "HEAD"], {
    cwd: repo,
  });
  if (r.code !== 0) return null;
  const files = new Set(r.stdout.split(/\r?\n/));
  return LOCKFILES.find(([file]) => files.has(file))?.[1] ?? null;
}

async function readE2e(runner: Runner, repo: string): Promise<string | null> {
  const r = await runner("git", ["ls-tree", "--name-only", "HEAD"], {
    cwd: repo,
  });
  if (r.code !== 0) return null;
  const files = new Set(r.stdout.split(/\r?\n/));
  return E2E_CONFIG_FILES.find((f) => files.has(f)) ?? null;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 対象の実のパス。渡さなければ、親のフォルダの直下のメインの作業ツリーの一番上（今の場所を除く） */
async function findTargets(
  runner: Runner,
  dir: string,
  cwd: string,
  given: readonly string[],
): Promise<{ real: string; given: boolean }[]> {
  if (given.length > 0) {
    const out: { real: string; given: boolean }[] = [];
    const seen = new Set<string>();
    for (const g of given) {
      const abs = path.resolve(cwd, g);
      const real = (await realOrNull(abs)) ?? abs;
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ real, given: true });
    }
    return out;
  }
  const parent = path.dirname(dir);
  if (parent === dir) return [];
  const out: { real: string; given: boolean }[] = [];
  const names = (await readdir(parent)).sort();
  for (const name of names) {
    const real = await realOrNull(path.join(parent, name));
    if (real === null || real === dir || !(await isDir(real))) continue;
    if ((await topLevelProblem(runner, real)) === null)
      out.push({ real, given: false });
  }
  return out;
}

/** 設定の下書きの材料を集める。読むだけで何も書かない */
export async function draftWorkspace(
  runner: Runner,
  cwd: string,
  given: readonly string[],
): Promise<DraftListing> {
  const dir = (await realOrNull(cwd)) ?? path.resolve(cwd);
  const targets = await findTargets(runner, dir, cwd, given);
  if (targets.length === 0)
    throw new FlowError(
      2,
      "下書きの対象がありません（親のフォルダの直下にリポジトリがありません）。リポジトリのパスを渡してください",
    );

  const repos: DraftRepo[] = [];
  const readable: { name: string; path: string }[] = [];
  const indexOf: (number | null)[] = [];
  for (const [i, t] of targets.entries()) {
    const problems: string[] = [];
    const base = path.basename(t.real);
    const rel = path.relative(dir, t.real);
    const draft: DraftRepo = {
      name: SLUG_PATTERN.test(base) ? base : null,
      path: rel === "" ? "." : rel.split(path.sep).join("/"),
      url: null,
      package: null,
      manager: null,
      e2e: null,
      role: "app",
      users: [],
      problems,
    };
    repos.push(draft);
    indexOf.push(null);
    if (!(await isDir(t.real))) {
      problems.push("フォルダが見つかりません");
      continue;
    }
    if (isInside(dir, t.real) || isInside(t.real, dir))
      problems.push(
        "ワークスペースのフォルダと入れ子か同じ場所です（設定に使えません）",
      );
    const top = await topLevelProblem(runner, t.real);
    if (top !== null) {
      problems.push(top);
      continue;
    }
    const origin = await runner(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd: t.real },
    );
    const url = origin.code === 0 ? origin.stdout.trim() : "";
    if (url !== "") {
      if (urlHasCredentials(url))
        problems.push(
          "origin の clone 元に認証の値が入っているため、url は空にしました（値は出していません）。認証の値のない clone 元を使ってください",
        );
      else if (url.startsWith("-"))
        problems.push(
          "origin の clone 元が「-」で始まるため、url は空にしました",
        );
      else draft.url = url;
    }
    const head = await runner(
      "git",
      ["rev-parse", "--verify", "-q", "HEAD^{commit}"],
      { cwd: t.real },
    );
    if (head.code !== 0) {
      problems.push(
        "コミットがありません（パッケージ名とロックファイルは読めません）",
      );
      continue;
    }
    draft.package = await readHeadName(runner, t.real);
    draft.manager = await readManager(runner, t.real);
    draft.e2e = await readE2e(runner, t.real);
    indexOf[i] = readable.length;
    readable.push({
      name: draft.name ?? base,
      path: t.real,
    });
  }

  for (let i = 0; i < repos.length; i++) {
    for (let j = i + 1; j < repos.length; j++) {
      if (
        isInside(targets[i]!.real, targets[j]!.real) ||
        isInside(targets[j]!.real, targets[i]!.real)
      ) {
        const msg = (other: DraftRepo, real: string) =>
          `${other.name ?? path.basename(real)} と入れ子か同じ場所です（設定に使えません）`;
        repos[i]!.problems.push(msg(repos[j]!, targets[j]!.real));
        repos[j]!.problems.push(msg(repos[i]!, targets[i]!.real));
      }
    }
  }

  const names = [
    ...new Set(
      repos.flatMap((r, i) =>
        indexOf[i] !== null && r.package !== null ? [r.package] : [],
      ),
    ),
  ];
  // hits[k]: readable[k] の定義に各パッケージ名が出るか。読めない対象があれば null
  let hits: Map<string, boolean>[] | null = null;
  if (names.length > 0) {
    hits = [];
    for (const r of readable) {
      const found = await grepNames(runner, r.path, names);
      if (found === null) {
        hits = null;
        break;
      }
      hits.push(found);
    }
  }
  for (const [i, repo] of repos.entries()) {
    const at = indexOf[i];
    if (at === null || at === undefined || repo.package === null) continue;
    if (hits === null) {
      repo.users = null;
    } else {
      repo.users = readable
        .filter((_, k) => k !== at && hits[k]!.get(repo.package!) === true)
        .map((r) => r.name);
    }
    repo.role = repo.users !== null && repo.users.length > 0 ? "common" : "app";
  }
  return { dir, repos };
}

/** HEAD の定義（5種。どの階層でも）の行に出るパッケージ名。git grep は1回。読めなければ null */
async function grepNames(
  runner: Runner,
  repo: string,
  names: readonly string[],
): Promise<Map<string, boolean> | null> {
  const result = await runner(
    "git",
    [
      "grep",
      "-h",
      "-I",
      "-F",
      ...names.flatMap((n) => ["-e", n]),
      "HEAD",
      "--",
      ...BRANCH_DEFINITION_FILES.map((f) => `:(glob)**/${f}`),
    ],
    { cwd: repo },
  );
  if (result.code !== 0 && result.code !== 1) return null;
  const lines =
    result.code === 1
      ? []
      : result.stdout.split(/\r?\n/).filter((l) => l !== "");
  return new Map(
    names.map((n) => [n, lines.some((l) => hasPackageName(l, n))]),
  );
}
