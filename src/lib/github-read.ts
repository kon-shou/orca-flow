import {
  MAX_THREAD_FLIPS,
  OLDER_THREAD_PAGE,
  THREAD_PAGE,
  addOlderThreadsPage,
  readNewerThreads,
} from "../common/threads.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import {
  GH_TIMEOUT_MS,
  envSecrets,
  redactSecrets,
  type CiResult,
  type GhContext,
  type PrState,
} from "./github.ts";

// GitHub を読むだけの呼び出し（見張りの問い合わせ）。書く呼び出しは github.ts にあり、ここには置かない。
// 必ず Runner を通す。2段の GraphQL：1段目は開いている自分のタスクの PR の更新の時刻・先頭・CI の要約、
// 2段目は動いた PR の中身（他人の文章は取らず、ID と書いた人の名前だけ）。

/** 上限の印（レート制限・二次レート制限）。戻る時刻まで問い合わせない */
export class RateLimitedError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`GitHub が上限の印を返しました：${detail}`);
    this.name = "RateLimitedError";
    this.detail = detail;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const RATE_LIMIT_WORDS =
  /rate limit|secondary rate|abuse detection|RATE_LIMITED/i;

function ghError(g: GhContext, text: string, what: string): FlowError {
  const detail = redactSecrets(text.trim(), envSecrets(g.env ?? {}));
  return new FlowError(
    1,
    `gh の${what}に失敗しました${detail ? `：${detail}` : ""}`,
  );
}

async function gh(
  g: ReadContext,
  args: readonly string[],
  what: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const left = g.timeLeftMs ? g.timeLeftMs() : Infinity;
  if (left <= 0)
    throw new FlowError(1, `gh の${what}の前に時間切れになりました`);
  const result = await g.runner("gh", args, {
    cwd: g.cwd,
    timeoutMs: Math.min(GH_TIMEOUT_MS, left),
  });
  if (result.code === 127)
    throw new FlowError(
      2,
      "gh（GitHub CLI）が見つかりません。入れて gh auth login でログインしてください",
    );
  if (result.timedOut)
    throw new FlowError(1, `gh の${what}が時間内に終わりませんでした`);
  return result;
}

// ---- 残り ----

/** 読みの問い合わせの文脈。timeLeftMs があれば、gh の時間切れを回の残りの時間に合わせる */
export interface ReadContext extends GhContext {
  timeLeftMs?: () => number;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  /** 戻る時刻（ISO） */
  resetAt: string;
}

/** `gh api rate_limit`：GraphQL の残り（この問い合わせは回数に数えない） */
export async function readRateLimit(g: ReadContext): Promise<RateLimit> {
  const result = await gh(g, ["api", "rate_limit"], "残りの確認");
  if (result.code !== 0) {
    if (RATE_LIMIT_WORDS.test(result.stderr + result.stdout))
      throw new RateLimitedError("rate_limit");
    throw ghError(g, result.stderr || result.stdout, "残りの確認");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // 下で扱う
  }
  const graphql =
    isObject(parsed) && isObject(parsed.resources)
      ? parsed.resources.graphql
      : null;
  if (
    !isObject(graphql) ||
    typeof graphql.remaining !== "number" ||
    typeof graphql.limit !== "number"
  )
    throw new FlowError(1, "gh api rate_limit の出力を読めませんでした");
  const reset = typeof graphql.reset === "number" ? graphql.reset : 0;
  return {
    limit: graphql.limit,
    remaining: graphql.remaining,
    resetAt: new Date(reset * 1000).toISOString(),
  };
}

// ---- GraphQL ----

export interface GraphqlResult {
  data: Record<string, unknown>;
  /** この問い合わせの点数（rateLimit.cost）。読めなければ null */
  cost: number | null;
  remaining: number | null;
}

/** GraphQL を1回流す。上限の印は RateLimitedError、一部の PR が見つからないだけの誤りは data を返す */
async function graphql(
  g: ReadContext,
  query: string,
  variables: Record<string, string>,
  what: string,
): Promise<GraphqlResult> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables))
    args.push("-f", `${name}=${value}`);
  const result = await gh(g, args, what);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // 下で扱う
  }
  const errors =
    isObject(parsed) && Array.isArray(parsed.errors)
      ? parsed.errors.filter(isObject)
      : [];
  const joined = `${result.stderr}\n${result.stdout}`;
  if (
    errors.some((e) => str(e.type) === "RATE_LIMITED") ||
    (result.code !== 0 && RATE_LIMIT_WORDS.test(joined))
  )
    throw new RateLimitedError(what);
  const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : null;
  // 見つからない PR が混じっただけなら、取れた分を使う
  const onlyNotFound =
    errors.length > 0 && errors.every((e) => str(e.type) === "NOT_FOUND");
  if (data === null || (errors.length > 0 && !onlyNotFound))
    throw ghError(
      g,
      result.code !== 0 ? result.stderr || result.stdout : "不正な出力",
      what,
    );
  if (result.code !== 0 && !onlyNotFound)
    throw ghError(g, result.stderr || result.stdout, what);
  const rate = isObject(data.rateLimit) ? data.rateLimit : null;
  return {
    data,
    cost: rate && typeof rate.cost === "number" ? rate.cost : null,
    remaining:
      rate && typeof rate.remaining === "number" ? rate.remaining : null,
  };
}

// ---- リポジトリの名前 ----

/** origin の URL から `owner/name` を読む。GitHub のものでなければ null */
export function repoFromRemote(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

/** 見るリポジトリの `owner/name`（git の origin から。GitHub に問い合わせない） */
export async function readRepoName(
  runner: Runner,
  root: string,
): Promise<string> {
  // get-url は url.*.insteadOf を展開するので、設定の値をそのまま読む
  const result = await runner("git", ["config", "--get", "remote.origin.url"], {
    cwd: root,
  });
  const name = result.code === 0 ? repoFromRemote(result.stdout) : null;
  if (!name)
    throw new FlowError(
      1,
      "origin の URL から GitHub のリポジトリを読めませんでした（git config remote.origin.url を確かめてください）",
    );
  return name;
}

// ---- 1段目 ----

export interface Stage1Pr {
  /** GraphQL のノード ID */
  id: string;
  number: number;
  url: string;
  updatedAt: string;
  head: string | null;
  branch: string;
  isDraft: boolean;
  ci: CiResult;
}

export interface Stage1Result {
  viewer: string;
  prs: Stage1Pr[];
  cost: number;
  remaining: number | null;
  calls: number;
}

/** CI の要約の状態（statusCheckRollup.state）を CI の結果に */
export function ciOfSummary(state: string | null): CiResult {
  switch (state) {
    case "SUCCESS":
      return "passed";
    case "FAILURE":
    case "ERROR":
      return "failed";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

const STAGE1_QUERY = `query($q: String!, $after: String) {
  viewer { login }
  rateLimit { cost remaining resetAt }
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id number url updatedAt headRefOid headRefName isDraft isCrossRepository
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const MAX_PAGES = 5;

function summaryOf(node: Record<string, unknown>): string | null {
  const commits = isObject(node.commits) ? node.commits : null;
  const first =
    commits && Array.isArray(commits.nodes) ? commits.nodes[0] : null;
  const commit =
    isObject(first) && isObject(first.commit) ? first.commit : null;
  const rollup =
    commit && isObject(commit.statusCheckRollup)
      ? commit.statusCheckRollup
      : null;
  return rollup ? str(rollup.state) : null;
}

/**
 * 1段目：自分の開いている PR のうち、このリポジトリで、ブランチが branchPrefix のものだけ。
 * 取るのは ID・番号・更新の時刻・先頭・下書きか・CI の要約の状態だけ
 */
export async function fetchOpenTaskPrs(
  g: ReadContext,
  repo: string,
  branchPrefix: string,
): Promise<Stage1Result> {
  const prs: Stage1Pr[] = [];
  let viewer = "";
  let cost = 0;
  let remaining: number | null = null;
  let calls = 0;
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await graphql(
      g,
      STAGE1_QUERY,
      {
        q: `repo:${repo} is:pr is:open author:@me`,
        ...(after === null ? {} : { after }),
      },
      "PR の一覧の問い合わせ",
    );
    calls++;
    cost += result.cost ?? 0;
    remaining = result.remaining;
    if (isObject(result.data.viewer))
      viewer = str(result.data.viewer.login) ?? viewer;
    const search = isObject(result.data.search) ? result.data.search : null;
    const nodes = search && Array.isArray(search.nodes) ? search.nodes : [];
    for (const node of nodes) {
      if (!isObject(node) || typeof node.number !== "number") continue;
      const branch = str(node.headRefName) ?? "";
      // フォークからの PR・タスクのブランチでないものは、タスクの PR ではない
      if (node.isCrossRepository === true || !branch.startsWith(branchPrefix))
        continue;
      prs.push({
        id: str(node.id) ?? "",
        number: node.number,
        url: str(node.url) ?? "",
        updatedAt: str(node.updatedAt) ?? "",
        head: str(node.headRefOid),
        branch,
        isDraft: node.isDraft === true,
        ci: ciOfSummary(summaryOf(node)),
      });
    }
    const info = search && isObject(search.pageInfo) ? search.pageInfo : null;
    if (info?.hasNextPage === true && typeof info.endCursor === "string")
      after = info.endCursor;
    else break;
  }
  if (viewer === "")
    throw new FlowError(1, "GitHub の自分のアカウント名を読めませんでした");
  return { viewer, prs, cost, remaining, calls };
}

// ---- 2段目 ----

export interface Person {
  id: string;
  /** 書いた人のログイン名。消えたアカウントは null */
  author: string | null;
  /** 書いた人とリポジトリの関係（authorAssociation）。答えにない・読めなければ null か省く（起こす側に倒す） */
  association?: string | null;
  /** 作者が Bot か（__typename）。省けば false */
  bot?: boolean;
  /** 書いた時刻（コメントとスレッドの発言は createdAt、レビューは出した submittedAt）。保留中のレビュー・読めないときは null か省く */
  at?: string | null;
  /** 出していない下書き（スレッドの発言の state が PENDING）。省けば false */
  pending?: boolean;
}

export interface ThreadDetail {
  id: string;
  resolved: boolean;
  resolvedBy: string | null;
  comments: Person[];
}

/** 2段目で読んだ PR の中身。他人の文章（本文）は取らない */
export interface PrDetail {
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  head: string | null;
  branch: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommit: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  ci: CiResult;
  reviews: Person[];
  comments: Person[];
  /** 新しい側から読んだスレッド（最大 THREAD_PAGE 件） */
  threads: ThreadDetail[];
  /** スレッドの合計（totalCount）。読めなければ null（分からない） */
  threadTotal: number | null;
  /**
   * 新しい側の読みより前のスレッドの、解決の印の数え（めくって読んだ分だけ。ID・書いた人・本文は取らない）。
   * complete は「最後まで読めた」印。前が残った・合計が読めず30件以上あるときは false
   */
  olderThreads: { read: number; unresolved: number; complete: boolean };
  /** 新しい側の読みより前があるときの、めくりの起点（pageInfo.startCursor）。前がなければ null */
  threadsBefore: string | null;
  /** bot でない人が今の先頭（head）に出した承認（APPROVED）が、読んだレビューの中にある */
  headApproved: boolean;
}

// スレッドの数えの定数と読みは共通の部品に置く。今の名前で読めるよう、定数は同じ名前で出し直す
export { MAX_THREAD_FLIPS, OLDER_THREAD_PAGE, THREAD_PAGE };

const DETAIL_FIELDS = `fragment F on PullRequest {
  number url state isDraft updatedAt headRefOid headRefName mergedAt
  mergeCommit { oid }
  reviewDecision mergeStateStatus
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviews(last: 30) { nodes { id authorAssociation state commit { oid } author { login __typename } submittedAt } }
  comments(last: 30) { nodes { id authorAssociation author { login __typename } createdAt } }
  reviewThreads(last: 30) {
    totalCount
    pageInfo { hasPreviousPage startCursor }
    nodes {
      id isResolved resolvedBy { login }
      comments(last: 20) { nodes { id authorAssociation author { login __typename } createdAt state } }
    }
  }
}`;

/** 2段目の問い合わせの本文（PR の番号ごとに pr_〈番号〉 の別名） */
export function stage2Query(numbers: readonly number[]): string {
  const aliases = numbers
    .map((n) => `pr_${n}: pullRequest(number: ${n}) { ...F }`)
    .join("\n    ");
  return `query($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${aliases}
  }
}
${DETAIL_FIELDS}`;
}

/** 古いスレッドをめくる問い合わせ（解決の印と pageInfo だけ。PR ごとに別名と変数の c_〈番号〉） */
export function olderThreadsQuery(numbers: readonly number[]): string {
  const vars = numbers.map((n) => `$c_${n}: String!`).join(", ");
  const aliases = numbers
    .map(
      (n) =>
        `pr_${n}: pullRequest(number: ${n}) { reviewThreads(last: ${OLDER_THREAD_PAGE}, before: $c_${n}) { pageInfo { hasPreviousPage startCursor } nodes { isResolved } } }`,
    )
    .join("\n    ");
  return `query($owner: String!, $name: String!, ${vars}) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${aliases}
  }
}`;
}

function people(value: unknown, timeField: string): Person[] {
  const nodes =
    isObject(value) && Array.isArray(value.nodes) ? value.nodes : [];
  return nodes.filter(isObject).map((n) => ({
    id: str(n.id) ?? "",
    author: isObject(n.author) ? str(n.author.login) : null,
    association: str(n.authorAssociation),
    bot: isObject(n.author) && n.author.__typename === "Bot",
    at: str(n[timeField]),
    ...(n.state === "PENDING" ? { pending: true } : {}),
  }));
}

/** 今の先頭に人（bot でない・消えていない）が出した承認があるか。本文は読まない */
function headApprovedOf(reviews: unknown, head: string | null): boolean {
  if (head === null) return false;
  const nodes =
    isObject(reviews) && Array.isArray(reviews.nodes) ? reviews.nodes : [];
  return nodes
    .filter(isObject)
    .some(
      (n) =>
        n.state === "APPROVED" &&
        isObject(n.commit) &&
        n.commit.oid === head &&
        isObject(n.author) &&
        str(n.author.login) !== null &&
        n.author.__typename !== "Bot",
    );
}

function detailFrom(node: Record<string, unknown>): PrDetail | null {
  if (typeof node.number !== "number") return null;
  const raw = String(node.state ?? "").toUpperCase();
  const state: PrState =
    raw === "MERGED" ? "merged" : raw === "CLOSED" ? "closed" : "open";
  const newer = readNewerThreads(node.reviewThreads);
  return {
    number: node.number,
    url: str(node.url) ?? "",
    state,
    isDraft: node.isDraft === true,
    head: str(node.headRefOid),
    branch: str(node.headRefName) ?? "",
    updatedAt: str(node.updatedAt) ?? "",
    mergedAt: str(node.mergedAt),
    mergeCommit: isObject(node.mergeCommit) ? str(node.mergeCommit.oid) : null,
    reviewDecision: str(node.reviewDecision),
    mergeStateStatus: str(node.mergeStateStatus),
    ci: ciOfSummary(summaryOf(node)),
    reviews: people(node.reviews, "submittedAt"),
    comments: people(node.comments, "createdAt"),
    threads: newer.nodes.map((t) => ({
      id: str(t.id) ?? "",
      resolved: t.isResolved === true,
      resolvedBy: isObject(t.resolvedBy) ? str(t.resolvedBy.login) : null,
      comments: people(t.comments, "createdAt"),
    })),
    threadTotal: newer.total,
    olderThreads: newer.older,
    threadsBefore: newer.before,
    headApproved: headApprovedOf(node.reviews, str(node.headRefOid)),
  };
}

export interface Stage2Result {
  /** 読めた PR（番号 → 中身）。見つからなかった PR は入らない */
  details: Map<number, PrDetail>;
  cost: number;
  remaining: number | null;
  /** 流した問い合わせの回数（読み1回＋めくった回数） */
  calls: number;
}

/** 2段目：動いた PR の中身を、1つの GraphQL にまとめて読む */
export async function fetchPrDetails(
  g: ReadContext,
  repo: string,
  numbers: readonly number[],
  /** 問い合わせが通るたびに、使った回数と点数を足す先。途中で投げても、それまでの分は残る */
  usage?: { calls: number; cost: number },
): Promise<Stage2Result> {
  const [owner, name] = repo.split("/") as [string, string];
  const result = await graphql(
    g,
    stage2Query(numbers),
    { owner, name },
    "動いた PR の問い合わせ",
  );
  const repository = isObject(result.data.repository)
    ? result.data.repository
    : {};
  const details = new Map<number, PrDetail>();
  for (const number of numbers) {
    const node = repository[`pr_${number}`];
    const detail = isObject(node) ? detailFrom(node) : null;
    if (detail) details.set(number, detail);
  }
  let cost = result.cost ?? 0;
  let remaining = result.remaining;
  let calls = 1;
  if (usage) {
    usage.calls += 1;
    usage.cost += cost;
  }

  // 前があるスレッドの PR だけ、古い側へ100件ずつめくる（別名で1つの問い合わせにまとめ、最大3回）
  const cursors = new Map<number, string>();
  for (const [n, d] of details)
    if (d.threadsBefore !== null && d.state === "open")
      cursors.set(n, d.threadsBefore);
  for (let flip = 0; flip < MAX_THREAD_FLIPS && cursors.size > 0; flip++) {
    const targets = [...cursors.keys()];
    const vars: Record<string, string> = { owner, name };
    for (const n of targets) vars[`c_${n}`] = cursors.get(n)!;
    const page = await graphql(
      g,
      olderThreadsQuery(targets),
      vars,
      "古いスレッドの問い合わせ",
    );
    calls++;
    cost += page.cost ?? 0;
    if (usage) {
      usage.calls += 1;
      usage.cost += page.cost ?? 0;
    }
    remaining = page.remaining ?? remaining;
    const repo2 = isObject(page.data.repository) ? page.data.repository : {};
    for (const n of targets) {
      cursors.delete(n);
      const node = repo2[`pr_${n}`];
      const next = addOlderThreadsPage(
        details.get(n)!.olderThreads,
        isObject(node) && isObject(node.reviewThreads)
          ? node.reviewThreads
          : null,
      );
      if (next !== null) cursors.set(n, next);
    }
  }
  return { details, cost, remaining, calls };
}
