import { FlowError } from "../../src/types.ts";
import {
  git,
  gitOrThrow,
  loadExclude,
  loadIdentity,
  loadWords,
  PUBLIC_REF,
  say,
  topLevel,
  type Ctx,
  type Identity,
} from "./common.ts";
import { findIds, idTreeProblems, loadIdPrefix } from "./ids.ts";

/** 木だけを見る確かめの入力 */
export interface TreeInputs {
  words: string[];
  exclude: string[];
  idPrefix: string;
  /** 当たりのパスを出すと見えてしまうファイル（手元のパスを含むパス）。語の一覧の語を含むパスのほかに、件数だけにする */
  hidePath?: (file: string) => boolean;
}

export interface CheckInputs {
  words: string[];
  exclude: string[];
  identity: Identity;
  /** main の .orca-flow/config.json の idPrefix（なければ既定値） */
  idPrefix: string;
}

export async function loadCheckInputs(ctx: Ctx): Promise<CheckInputs> {
  const words = await loadWords(ctx);
  const identity = await loadIdentity(ctx);
  const exclude = await loadExclude(ctx);
  const idPrefix = await loadIdPrefix(ctx);
  return { words, exclude, identity, idPrefix };
}

function hitWords(text: string, lowered: readonly string[]): number[] {
  const haystack = text.toLowerCase();
  const hits: number[] = [];
  lowered.forEach((word, index) => {
    if (haystack.includes(word)) hits.push(index + 1);
  });
  return hits;
}

/** pathspec の * ? [ \ を文字として扱う */
function escapeGlob(word: string): string {
  return word.replace(/[\\*?[]/g, (c) => `\\${c}`);
}

function records(text: string): string[] {
  return text.split("\0").filter((r) => r !== "");
}

/**
 * 木のパスと中身は、git の中で照合する。外のコマンドの出力は 64KB ごとに区切って文字にするため、
 * 区切り目にかかった日本語が壊れる。壊れうる出力（パス）は、表示と件数にしか使わない
 */
async function treeProblems(
  ctx: Ctx,
  commit: string,
  inputs: TreeInputs,
): Promise<string[]> {
  const problems: string[] = [];

  for (const entry of inputs.exclude) {
    const out = await gitOrThrow(
      ctx,
      ["ls-tree", "-r", "--name-only", "-z", commit, "--", entry],
      "ファイルの一覧の取得",
    );
    if (out !== "") problems.push(`抜くパスが木に残っています：${entry}`);
  }

  const emptyTree = (
    await gitOrThrow(
      ctx,
      ["hash-object", "-t", "tree", "/dev/null"],
      "空の木の取得",
    )
  ).trim();
  // 大文字小文字の区別は pathspec の icase が ASCII だけなので、元の形・小文字・大文字を足して取りこぼしを減らす
  const variants = inputs.words.map((w) => [
    ...new Set([w, w.toLowerCase(), w.toUpperCase()].map(escapeGlob)),
  ]);
  const any = variants.flat().map((v) => `:(icase)*${v}*`);
  const none = variants.flat().map((v) => `:(exclude,icase)*${v}*`);

  for (const [index, list] of variants.entries()) {
    const out = await gitOrThrow(
      ctx,
      [
        "diff-tree",
        "-r",
        "--name-only",
        "-z",
        "--no-renames",
        emptyTree,
        commit,
        "--",
        ...list.map((v) => `:(icase)*${v}*`),
      ],
      "パスの照合",
    );
    const count = records(out).length;
    if (count > 0)
      problems.push(`ファイルのパスに ${index + 1} 番目の語（${count} 件）`);
  }

  const grep = async (word: string, pathspecs: string[]) => {
    const out = await git(ctx, [
      "grep",
      "-l",
      "-z",
      "-a",
      "-F",
      "-i",
      "-e",
      word,
      commit,
      "--",
      ...pathspecs,
    ]);
    if (out.code === 1) return [];
    if (out.code !== 0) throw new FlowError(1, "中身の照合に失敗しました");
    return records(out.stdout).map((r) => r.slice(commit.length + 1));
  };
  for (const [index, word] of inputs.words.entries()) {
    // パスに語を含むファイルは、パスを出すと語が見えるので、件数だけ出す
    let concealed = 0;
    for (const file of await grep(word, [".", ...none])) {
      if (inputs.hidePath?.(file)) concealed += 1;
      else problems.push(`${file}：${index + 1} 番目の語`);
    }
    if (concealed > 0)
      problems.push(
        `パスに手元のパスを含むファイルの中身に ${index + 1} 番目の語（${concealed} 件）`,
      );
    const hidden = await grep(word, any);
    if (hidden.length > 0)
      problems.push(
        `パスに語を含むファイルの中身に ${index + 1} 番目の語（${hidden.length} 件）`,
      );
  }

  // git grep はシンボリックリンクの行き先を見ないので、blob を読んで照合する。パスは出さない
  const listing = await gitOrThrow(
    ctx,
    [
      "ls-tree",
      "-r",
      "--full-tree",
      "--format=%(objectmode) %(objectname)",
      commit,
    ],
    "ファイルの一覧の取得",
  );
  const links = new Set<string>();
  for (const line of listing.split("\n")) {
    const [mode, sha] = line.split(" ");
    if (mode === "120000" && sha) links.add(sha);
  }
  const lowered = inputs.words.map((word) => word.toLowerCase());
  const linkHits = new Map<number, number>();
  for (const sha of links) {
    const target = await gitOrThrow(
      ctx,
      ["cat-file", "blob", sha],
      "リンクの読み取り",
    );
    for (const n of hitWords(target, lowered))
      linkHits.set(n, (linkHits.get(n) ?? 0) + 1);
  }
  for (const [n, count] of linkHits)
    problems.push(`シンボリックリンクの行き先に ${n} 番目の語（${count} 件）`);
  return problems;
}

/**
 * 木（コミットまたは木の名前）だけを見る確かめ：抜くパス・語・ID の形。当たった内容の一覧を返す。
 * 語は空でもよい（語の確かめを飛ばす）。ctx.cwd は作業ツリーのトップ
 */
export async function checkTree(
  ctx: Ctx,
  tree: string,
  inputs: TreeInputs,
): Promise<string[]> {
  const problems = await treeProblems(ctx, tree, inputs);
  problems.push(
    ...(await idTreeProblems(
      ctx,
      tree,
      inputs.idPrefix,
      inputs.words,
      inputs.hidePath,
    )),
  );
  return problems;
}

/**
 * 1つのコミットを確かめて、当たった内容の一覧を返す（空なら問題なし）。
 * 語そのものは返さない。パスと「何番目の語か」だけ。ctx.cwd は作業ツリーのトップ
 */
export async function checkCommit(
  ctx: Ctx,
  commit: string,
  inputs: CheckInputs,
): Promise<string[]> {
  const problems = await checkTree(ctx, commit, inputs);
  const lowered = inputs.words.map((word) => word.toLowerCase());

  const meta = await gitOrThrow(
    ctx,
    ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", commit],
    "コミットの読み取り",
  );
  const parts = meta.split("\0");
  const [an = "", ae = "", cn = "", ce = ""] = parts;
  const message = parts.slice(4).join("\0");
  for (const [label, value] of [
    ["作者の名前", an],
    ["コミットした人の名前", cn],
  ] as const) {
    if (value !== inputs.identity.name)
      problems.push(`${label}が公開用の名前と違います`);
  }
  for (const [label, value] of [
    ["作者のメールアドレス", ae],
    ["コミットした人のメールアドレス", ce],
  ] as const) {
    if (value !== inputs.identity.email)
      problems.push(`${label}が公開用のメールアドレスと違います`);
  }
  for (const [label, value] of [
    ["作者の名前", an],
    ["作者のメールアドレス", ae],
    ["コミットした人の名前", cn],
    ["コミットした人のメールアドレス", ce],
    ["メッセージ", message],
  ] as const) {
    for (const n of hitWords(value, lowered))
      problems.push(`${label}に ${n} 番目の語`);
  }
  const ids = findIds(message, inputs.idPrefix);
  if (ids.length > 0) problems.push(`メッセージに ID の形：${ids.join("、")}`);
  return problems;
}

/** 複数のコミットを確かめて、問題を出力する。問題があれば true */
export async function reportCheck(
  ctx: Ctx,
  commits: readonly string[],
  inputs: CheckInputs,
): Promise<boolean> {
  let failed = false;
  for (const commit of commits) {
    const problems = await checkCommit(ctx, commit, inputs);
    if (problems.length === 0) continue;
    failed = true;
    say(ctx, `確かめに落ちました：コミット ${commit.slice(0, 10)}`);
    for (const problem of [...new Set(problems)]) say(ctx, `  - ${problem}`);
  }
  return failed;
}

export async function check(
  base: Ctx,
  args: readonly string[],
): Promise<number> {
  if (args.length > 1) throw new FlowError(2, "使い方：check [〈コミット〉]");
  const ctx = { ...base, cwd: await topLevel(base) };
  const inputs = await loadCheckInputs(ctx);
  const target = args[0] ?? PUBLIC_REF;
  const resolved = await git(ctx, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${target}^{commit}`,
  ]);
  if (resolved.code !== 0)
    throw new FlowError(2, `コミットが見つかりません：${target}`);
  const commit = resolved.stdout.trim();
  if (await reportCheck(ctx, [commit], inputs)) return 1;
  say(ctx, "確かめに通りました");
  return 0;
}
