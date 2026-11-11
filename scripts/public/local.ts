import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowError } from "../../src/types.ts";
import { checkTree } from "./check.ts";
import {
  git,
  gitOrThrow,
  loadExclude,
  loadWordsIfPresent,
  say,
  topLevel,
  type Ctx,
} from "./common.ts";
import { loadIdPrefix } from "./ids.ts";

/** git の置き場所・作業ツリー・index を変える環境変数。手元の確かめはこれらに左右されない */
const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
];

function withoutGitLocation(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of GIT_LOCATION_VARS) delete copy[key];
  return copy;
}

/** Mac のホームの頭の形。このリポジトリの公開の木に文字のまま書かないよう、つないで作る */
const MAC_HOME_HEAD = `/${"Us"}${"ers"}/`;

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, (c) => `\\${c}`);
}

/** 探す文字の元の形・小文字・大文字（git grep -i は ASCII だけなので足す） */
function caseVariants(text: string): string[] {
  return [...new Set([text, text.toLowerCase(), text.toUpperCase()])];
}

export interface LocalPathRules {
  /** git grep -F で候補のファイルを絞るための文字 */
  literals: string[];
  /** 絞ったあとの本判定（大文字小文字を区別しない） */
  patterns: RegExp[];
}

/**
 * 手元のパスの規則。Mac のホームの頭の形（左が英数字・_・.・- でないとき）と、流した人のホームのディレクトリ
 * （右が英数字・_・- でなく、. のあとに名前の文字が続く形でもないとき。文の終わりの . は当たる）。
 * HOME がないか、ルートの1段以下（`/` や `/root`）なら、HOME の規則は飛ばす
 */
export function localPathRules(env: NodeJS.ProcessEnv): LocalPathRules {
  const literals = [MAC_HOME_HEAD];
  const patterns = [
    new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegex(MAC_HOME_HEAD)}`, "i"),
  ];
  const home = (env["HOME"] ?? "").replace(/\/+$/, "");
  const depth = home.split("/").filter((part) => part !== "").length;
  if (home.startsWith("/") && depth >= 2) {
    literals.push(home);
    patterns.push(
      new RegExp(`${escapeRegex(home)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, "i"),
    );
  }
  return { literals, patterns };
}

/** 中身・リンクの行き先の判定 */
function textHasLocalPath(rules: LocalPathRules, text: string): boolean {
  return rules.patterns.some((pattern) => pattern.test(text));
}

/** 木のパスの判定。パスは相対なので、先頭に / を足して絶対のパスと同じに見る */
export function pathHasLocalPath(rules: LocalPathRules, file: string): boolean {
  return textHasLocalPath(rules, `/${file}`);
}

function records(text: string): string[] {
  return text.split("\0").filter((r) => r !== "");
}

/**
 * 追跡中のファイルを作業ツリーの中身にした木を、一時の index で作る。
 * 作業ツリー・本物の index・HEAD・ブランチは変えない。追跡外のファイルは見ない。
 * 抜くパスは、この木の exclude.txt から読んで除く
 */
async function buildLocalTree(
  ctx: Ctx,
): Promise<{ tree: string; exclude: string[]; idPrefix: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "orca-flow-public-local-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    const tracked = await gitOrThrow(
      ctx,
      ["ls-files", "-z"],
      "追跡中のファイルの一覧の取得",
    );
    await gitOrThrow(ctx, ["read-tree", "HEAD"], "一時の index の組み立て", {
      env,
    });
    // 本物の index から消した（git rm・git mv など）パスは、HEAD の中身のまま残らないよう外す
    const present = new Set(records(tracked));
    const headFiles = records(
      await gitOrThrow(
        ctx,
        ["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"],
        "HEAD のファイルの一覧の取得",
      ),
    );
    const gone = headFiles.filter((file) => !present.has(file));
    if (gone.length > 0)
      await gitOrThrow(
        ctx,
        ["update-index", "--force-remove", "-z", "--stdin"],
        "消したパスの除外",
        { env, input: `${gone.join("\0")}\0` },
      );
    if (tracked !== "")
      await gitOrThrow(
        ctx,
        ["update-index", "--add", "--remove", "-z", "--stdin"],
        "作業ツリーの中身の反映",
        { env, input: tracked },
      );
    const full = (
      await gitOrThrow(ctx, ["write-tree"], "木の作成", { env })
    ).trim();
    const exclude = await loadExclude(ctx, full);
    const idPrefix = await loadIdPrefix(ctx, full);
    if (exclude.length > 0)
      await gitOrThrow(
        ctx,
        [
          "rm",
          "--cached",
          "-f",
          "-r",
          "-q",
          "--ignore-unmatch",
          "--",
          ...exclude.map((entry) => `:(literal)${entry}`),
        ],
        "抜くパスの除外",
        { env },
      );
    const tree = (
      await gitOrThrow(ctx, ["write-tree"], "木の作成", { env })
    ).trim();
    return { tree, exclude, idPrefix };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 木のパス・中身・シンボリックリンクの行き先にある手元のパスの当たり。
 * ホームのディレクトリの文字は出さず、「手元のパス」と場所だけ出す。
 * パスに手元のパスか語の一覧の語を含むファイルは、パスを出すと見えるので、件数だけにする
 */
async function localPathProblems(
  ctx: Ctx,
  tree: string,
  rules: LocalPathRules,
  words: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  const lowered = words.map((word) => word.toLowerCase());
  const pathHasWord = (file: string) => {
    const haystack = file.toLowerCase();
    return lowered.some((word) => haystack.includes(word));
  };
  const listing = await gitOrThrow(
    ctx,
    ["ls-tree", "-r", "-z", "--full-tree", tree],
    "ファイルの一覧の取得",
  );
  const localPaths = new Set<string>();
  const concealed = new Set<string>();
  const blobs = new Map<string, string>();
  const links: Array<{ file: string; sha: string }> = [];
  for (const record of records(listing)) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (!m) continue;
    const [, mode = "", sha = "", file = ""] = m;
    if (pathHasLocalPath(rules, file)) {
      localPaths.add(file);
      concealed.add(file);
    }
    if (pathHasWord(file)) concealed.add(file);
    if (mode === "120000") links.push({ file, sha });
    else if (mode !== "160000") blobs.set(file, sha);
  }
  if (localPaths.size > 0)
    problems.push(`ファイルのパスに手元のパス（${localPaths.size} 件）`);

  const hiddenFiles = new Set<string>();
  let linkHits = 0;
  for (const { file, sha } of links) {
    const target = await gitOrThrow(
      ctx,
      ["cat-file", "blob", sha],
      "リンクの読み取り",
    );
    if (textHasLocalPath(rules, target)) {
      if (concealed.has(file)) hiddenFiles.add(file);
      else linkHits += 1;
    }
  }
  if (linkHits > 0)
    problems.push(`シンボリックリンクの行き先に手元のパス（${linkHits} 件）`);

  // 候補のファイルを git grep で絞り、読み直して本判定する。バイト単位で照合する（LC_ALL=C）
  const out = await git(
    ctx,
    [
      "grep",
      "--no-color",
      "-a",
      "-l",
      "-z",
      "-F",
      "-i",
      ...rules.literals.flatMap((literal) =>
        caseVariants(literal).flatMap((variant) => ["-e", variant]),
      ),
      tree,
      "--",
      ".",
    ],
    { env: { LC_ALL: "C" } },
  );
  if (out.code !== 0 && out.code !== 1)
    throw new FlowError(1, "中身の照合に失敗しました");
  const shown = new Set<string>();
  if (out.code === 0) {
    for (const file of records(out.stdout).map((r) =>
      r.slice(tree.length + 1),
    )) {
      const sha = blobs.get(file);
      if (sha === undefined)
        throw new FlowError(1, "中身の照合の結果とファイルの一覧が合いません");
      const text = await gitOrThrow(
        ctx,
        ["cat-file", "blob", sha],
        "ファイルの読み取り",
      );
      if (!textHasLocalPath(rules, text)) continue;
      if (concealed.has(file)) hiddenFiles.add(file);
      else if (!shown.has(file)) {
        shown.add(file);
        problems.push(`${file}：手元のパス`);
      }
    }
  }
  if (hiddenFiles.size > 0)
    problems.push(
      `パスに手元のパスか語を含むファイルの中身に手元のパス（${hiddenFiles.size} 件）`,
    );
  return problems;
}

/**
 * 公開に出るファイル（追跡中で、抜くパスを除いたもの）を、作業ツリーの中身で確かめる。
 * ID の形・手元のパス・秘密などの形は必ず、語の一覧は置いてあるときだけ確かめる。当たりがあれば 1、なければ 0
 */
export async function local(
  base: Ctx,
  args: readonly string[],
): Promise<number> {
  if (args.length > 0) throw new FlowError(2, "使い方：local");
  const clean = { ...base, env: withoutGitLocation(base.env) };
  const ctx = { ...clean, cwd: await topLevel(clean) };
  const { tree, exclude, idPrefix } = await buildLocalTree(ctx);
  const words = await loadWordsIfPresent(ctx);
  const rules = localPathRules(ctx.env);
  const publicEmail = await git(ctx, [
    "config",
    "--get",
    "orca-flow.publicEmail",
  ]);
  const problems = await checkTree(ctx, tree, {
    words,
    exclude,
    idPrefix,
    publicEmails: publicEmail.code === 0 ? [publicEmail.stdout.trim()] : [],
    hidePath: (file) => pathHasLocalPath(rules, file),
  });
  problems.push(...(await localPathProblems(ctx, tree, rules, words)));
  const note =
    words.length === 0
      ? "語の一覧がないか空なので、語は確かめていません"
      : "語の一覧も確かめました";
  if (problems.length > 0) {
    say(ctx, "確かめに落ちました：手元の作業ツリー（公開に出るファイル）");
    for (const problem of [...new Set(problems)]) say(ctx, `  - ${problem}`);
    say(ctx, note);
    return 1;
  }
  say(ctx, `確かめに通りました（${note}）`);
  return 0;
}
