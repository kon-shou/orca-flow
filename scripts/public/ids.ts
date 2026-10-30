import { DEFAULT_CONFIG, CONFIG_PATH, parseConfig } from "../../src/config.ts";
import { FlowError } from "../../src/types.ts";
import { git, gitOrThrow, MAIN_REF, type Ctx } from "./common.ts";

/** 正規表現の特別な文字を文字として扱う */
function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, (c) => `\\${c}`);
}

/**
 * main の .orca-flow/config.json の idPrefix。ファイルがなければ既定値。
 * 読めない・形が違うなら終了コード2
 */
export async function loadIdPrefix(ctx: Ctx): Promise<string> {
  const out = await git(ctx, ["show", `${MAIN_REF}:${CONFIG_PATH}`]);
  if (out.code !== 0) return DEFAULT_CONFIG.idPrefix;
  try {
    return parseConfig(JSON.parse(out.stdout)).idPrefix;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlowError(
      2,
      `main の ${CONFIG_PATH} を読めません（ID の形の確かめに idPrefix が要ります）：${detail}`,
    );
  }
}

/**
 * ID の形：idPrefix の前が ASCII の英数字でない（または行頭）、
 * idPrefix のあとに数字が1つ以上、英小文字が0〜1個、そのあとが ASCII の英数字でない（または行末）。
 * 大文字小文字は区別する
 */
export function idPattern(idPrefix: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9])${escapeRegex(idPrefix)}[0-9]+[a-z]?(?![A-Za-z0-9])`,
    "g",
  );
}

/** 文の中の ID の形（当たった語）の一覧 */
export function findIds(text: string, idPrefix: string): string[] {
  return [...text.matchAll(idPattern(idPrefix))].map((m) => m[0]);
}

/** git grep（拡張正規表現）用。先読み・後読みが使えないので、前後の1文字を含めて当てる */
function grepPattern(idPrefix: string): string {
  const prefix = idPrefix.replace(/[\\^$.*+?()[\]{}|]/g, (c) => `\\${c}`);
  return `(^|[^A-Za-z0-9])${prefix}[0-9]+[a-z]?([^A-Za-z0-9]|$)`;
}

/**
 * 1つのコミットの木のパス・中身・シンボリックリンクの行き先にある ID の形。当たった場所と語を返す（語は隠さない）。
 * ただし、パスに語の一覧の語を含むファイルの当たりは、パスを出すと語が見えるので、件数だけにする
 */
export async function idTreeProblems(
  ctx: Ctx,
  commit: string,
  idPrefix: string,
  words: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  const lowered = words.map((word) => word.toLowerCase());
  const hasWord = (file: string) => {
    const haystack = file.toLowerCase();
    return lowered.some((word) => haystack.includes(word));
  };
  let hidden = 0;
  const report = (file: string, text: (shown: string) => string) => {
    if (hasWord(file)) hidden += 1;
    else problems.push(text(file));
  };

  const listing = await gitOrThrow(
    ctx,
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    "ファイルの一覧の取得",
  );
  const blobs = new Map<string, string>();
  const links: Array<{ file: string; sha: string }> = [];
  for (const record of listing.split("\0")) {
    // 既定の形「mode SP type SP sha TAB path」。-z ではパスを引用符で囲まない
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (!m) continue;
    const [, mode = "", sha = "", file = ""] = m;
    const hits = findIds(file, idPrefix);
    if (hits.length > 0)
      report(
        file,
        (shown) => `ファイルのパスに ID の形：${shown}：${hits.join("、")}`,
      );
    if (mode === "120000") links.push({ file, sha });
    else if (mode !== "160000") blobs.set(file, sha);
  }

  // git grep はシンボリックリンクの行き先を見ないので、blob を読んで照合する
  for (const { file, sha } of links) {
    const target = await gitOrThrow(
      ctx,
      ["cat-file", "blob", sha],
      "リンクの読み取り",
    );
    const hits = findIds(target, idPrefix);
    if (hits.length > 0)
      report(
        file,
        (shown) =>
          `シンボリックリンクの行き先に ID の形：${shown}：${hits.join("、")}`,
      );
  }

  // 行を絞るためだけに git grep（ERE）を使う。バイト単位で照合し（LC_ALL=C）、-a で属性の binary・-diff に左右されない。
  // 当たりの語は、読み直した行から findIds で全部出す。バイナリ（NUL を含む blob）は自分で除く
  const out = await git(
    ctx,
    [
      "grep",
      "--no-color",
      "-a",
      "-l",
      "-z",
      "-E",
      "-e",
      grepPattern(idPrefix),
      commit,
      "--",
      ".",
    ],
    { env: { LC_ALL: "C" } },
  );
  if (out.code !== 0 && out.code !== 1) {
    const detail = out.stderr.trim();
    throw new FlowError(
      1,
      `中身の照合に失敗しました${detail ? `：${detail}` : ""}`,
    );
  }
  if (out.code === 0) {
    const files = out.stdout
      .split("\0")
      .filter((r) => r !== "")
      .map((r) => r.slice(commit.length + 1));
    if (files.length === 0)
      throw new FlowError(1, "中身の照合の結果を読み取れませんでした");
    for (const file of files) {
      const sha = blobs.get(file);
      if (sha === undefined)
        throw new FlowError(1, "中身の照合の結果とファイルの一覧が合いません");
      const text = await gitOrThrow(
        ctx,
        ["cat-file", "blob", sha],
        "ファイルの読み取り",
      );
      if (text.includes("\0")) continue;
      for (const [index, line] of text.split("\n").entries()) {
        const hits = findIds(line, idPrefix);
        if (hits.length > 0)
          report(
            file,
            (shown) => `ID の形：${shown}：${index + 1}：${hits.join("、")}`,
          );
      }
    }
  }
  if (hidden > 0)
    problems.push(`パスに語を含むファイルに ID の形（${hidden} 件）`);
  return problems;
}
