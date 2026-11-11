import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";

// 返信の本投稿の本文の組み立て。
// 返信した指摘の書き手ごとに、メンションと、指摘の場所ごとの「返信しました」か「直しました（範囲の差分の URL）」を並べる。
// 本文に入れるのは、ログイン名・ファイルと行・コミットの SHA と URL・決まった短い文だけ（他人の文章は写さない）。

export interface ReplyAuthor {
  login: string;
  isBot: boolean;
}

export interface ReplyBodyComment {
  id: string;
  path: string | null;
  line: number | null;
  /** 返す先のコメントの書き手。読めなければ null */
  author: ReplyAuthor | null;
}

/** 指摘の直しのコミットをまとめた範囲（どちらも40桁の SHA。始まりは一番古い直しの1つ目の親） */
export interface FixRange {
  start: string;
  end: string;
}

export interface ReplyBodyInput {
  /** 人の本文（記録のレビューの本文）。空白だけならないものとして扱う */
  summary: string;
  comments: readonly ReplyBodyComment[];
  /** 自分のログイン名（メンションしない）。読めなければ null */
  viewer: string | null;
  /** PR の URL。直しがあるときだけ要る */
  prUrl: string | null;
  /** 返信のコメントの ID ごとの、直しの範囲。ない返信は「返信しました」だけ */
  ranges: ReadonlyMap<string, FixRange>;
}

const UNKNOWN_AUTHOR = "（書き手不明）";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function placeOf(c: ReplyBodyComment): string {
  const file = c.path ?? "場所不明";
  return c.line === null ? file : `${file}:${c.line}`;
}

/** 本投稿の本文を組み立てる（純粋な関数。同じ中身なら、渡す順によらず同じ本文になる） */
export function buildReplyBody(input: ReplyBodyInput): string {
  const human = input.summary.trim() === "" ? "" : input.summary.trimEnd();
  if (input.comments.length === 0) return human;

  const sorted = [...input.comments].sort(
    (a, b) =>
      cmp(a.path ?? "", b.path ?? "") ||
      (a.line ?? -1) - (b.line ?? -1) ||
      cmp(a.id, b.id),
  );
  const viewer = input.viewer?.toLowerCase() ?? null;
  // 書き手ごと（ログイン名の大小を区別しない）。並びは最初の返信の順
  const groups = new Map<string, { heading: string; lines: string[] }>();
  for (const c of sorted) {
    const key = c.author ? c.author.login.toLowerCase() : "";
    let group = groups.get(key);
    if (!group) {
      const heading = !c.author
        ? UNKNOWN_AUTHOR
        : c.author.isBot || key === viewer
          ? c.author.login
          : `@${c.author.login}`;
      group = { heading, lines: [] };
      groups.set(key, group);
    }
    const range = input.ranges.get(c.id);
    if (range && !input.prUrl)
      throw new FlowError(
        1,
        "PR の URL が読めないので、直しのリンクを作れません",
      );
    const what = range
      ? `直しました（${input.prUrl!.replace(/\/+$/, "")}/files/${range.start}..${range.end}）`
      : "返信しました";
    group.lines.push(`- \`${placeOf(c)}\`：${what}`);
  }
  const built = [...groups.values()]
    .map((g) => [g.heading, ...g.lines].join("\n"))
    .join("\n\n");
  return human === "" ? built : `${human}\n\n${built}`;
}

// ---- git で直しのコミットの範囲を決める（Runner を通す） ----

const FULL_SHA = /^[0-9a-f]{40}$/;

async function gitOut(
  runner: Runner,
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; out: string }> {
  const r = await runner("git", args, { cwd });
  return { ok: r.code === 0, out: r.stdout.trim() };
}

/** 16進の形の SHA（短くてもよい）をコミットの40桁にする。解けなければ null */
export async function resolveCommit(
  runner: Runner,
  cwd: string,
  sha: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  const r = await gitOut(runner, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${sha}^{commit}`,
  ]);
  return r.ok && FULL_SHA.test(r.out) ? r.out : null;
}

/**
 * ancestor が tip から（tip 自身を含めて）たどれるか。
 * yes：祖先。no：祖先でない（git の終了コード1）。unresolved：解けない・手元にないなどそれ以外
 */
export async function ancestryOf(
  runner: Runner,
  cwd: string,
  ancestor: string,
  tip: string,
): Promise<"yes" | "no" | "unresolved"> {
  const r = await runner(
    "git",
    ["merge-base", "--is-ancestor", ancestor, tip],
    {
      cwd,
    },
  );
  return r.code === 0 ? "yes" : r.code === 1 ? "no" : "unresolved";
}

/** ancestor が tip から（tip 自身を含めて）たどれるか。解けないときも false */
export async function isAncestor(
  runner: Runner,
  cwd: string,
  ancestor: string,
  tip: string,
): Promise<boolean> {
  return (await ancestryOf(runner, cwd, ancestor, tip)) === "yes";
}

/** コミットが手元にあるか */
export async function hasCommit(
  runner: Runner,
  cwd: string,
  sha: string,
): Promise<boolean> {
  const r = await runner("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd });
  return r.code === 0;
}

/**
 * 直しのコミットをまとめた範囲：始まりは一番古いものの1つ目の親、終わりは一番新しいもの。
 * 古い・新しいはタスクのブランチの履歴の順で決める（渡す順によらない）。shas は40桁とする
 */
export async function fixRangeOf(
  runner: Runner,
  cwd: string,
  shas: readonly string[],
): Promise<FixRange> {
  const unique = [...new Set(shas)].sort();
  if (unique.length === 0) throw new FlowError(1, "直しのコミットがありません");
  // 渡したコミットの共通の祖先の親から先を、親が先の順に並べる（間のコミットも並ぶ）
  const base = await gitOut(runner, cwd, [
    "merge-base",
    "--octopus",
    ...unique,
  ]);
  const listed = await gitOut(runner, cwd, [
    "rev-list",
    "--topo-order",
    "--reverse",
    ...unique,
    ...(base.ok && FULL_SHA.test(base.out) ? ["--not", `${base.out}^@`] : []),
  ]);
  if (!listed.ok)
    throw new FlowError(1, "git rev-list で直しのコミットの順を決められません");
  const order = listed.out.split("\n").filter((l) => unique.includes(l));
  const oldest = order[0] ?? unique[0]!;
  const newest = order[order.length - 1] ?? unique[0]!;
  const parent = await gitOut(runner, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${oldest}^1`,
  ]);
  if (!parent.ok || !FULL_SHA.test(parent.out))
    throw new FlowError(
      1,
      `直しのコミット ${oldest.slice(0, 8)} に親がなく、範囲を決められません`,
    );
  return { start: parent.out, end: newest };
}
