import path from "node:path";
import type { Runner } from "../../../src/lib/exec.ts";
import { writePushRecord } from "../../../src/lib/finish.ts";
import type { CommandContext } from "../../../src/types.ts";
import { fakeOrca, type FakeOrca } from "../../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, tempDir } from "../../helpers/repo.ts";
import { testRunner } from "../../helpers/runner.ts";

/** 偽物の GitHub。他人の文章の本文には印の文字を入れ、出力・カード・記録に出ないことを確かめる */
export const SECRET_MARK = "ZZ印の文字ZZ";

/** 書いた人の立場（authorAssociation）と bot の印。省けば答えに入れない（読めない場面） */
export interface FakeWho {
  association?: string;
  bot?: boolean;
  /** 書いた時刻（コメントとスレッドの発言は createdAt、レビューは submittedAt）。省けば答えに入れない（読めない・保留中のレビュー） */
  at?: string;
  /** 出していない下書き（スレッドの発言に state: PENDING を付ける）。本物は viewer 本人の下書きだけを返す */
  pending?: boolean;
}

export interface FakeThread {
  id: string;
  resolvedBy: string | null;
  comments: ({ id: string; author: string; body: string } & FakeWho)[];
}

export interface FakePr {
  number: number;
  repo: string;
  branch: string;
  updatedAt: string;
  head: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  ci: "SUCCESS" | "PENDING" | "FAILURE" | null;
  cross: boolean;
  /** state は省けば COMMENTED、commit（出した先のコミット）は省けば PR の今の先頭 */
  reviews: ({
    id: string;
    author: string;
    body: string;
    state?: string;
    commit?: string;
  } & FakeWho)[];
  comments: ({ id: string; author: string; body: string } & FakeWho)[];
  threads: FakeThread[];
  mergeCommit: string | null;
  mergedAt: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string;
}

export interface FakeGh {
  viewer: string;
  remaining: number;
  /** rate_limit 以外の問い合わせが返す上限の印 */
  rateLimited: boolean;
  /** 上限の印を返したあと、gh api rate_limit が返す戻る時刻（秒）。残りは0になる */
  resetAt: number;
  /** 上限の印を返した回数 */
  denied: number;
  /** 1段目・2段目の GraphQL の呼び出し */
  stage1: number;
  stage2: number;
  /** 2段目に渡された PR の番号（呼び出しの順） */
  stage2Numbers: number[][];
  /** 古いスレッドをめくる問い合わせの呼び出しと、その問い合わせに渡された PR の番号・本文 */
  older: number;
  olderNumbers: number[][];
  olderQueries: string[];
  /** 古いスレッドをめくる問い合わせだけを失敗させる：gh の失敗か、上限の印。"" なら失敗させない */
  failOlder: "" | "error" | "rate-limit";
  /** failOlder で失敗させた回数 */
  olderFailed: number;
  /** 偽物の応答から totalCount・pageInfo を抜く（本物でこの項が読めなかった場面） */
  omitTotalCount: boolean;
  omitPageInfo: boolean;
  /** gh に渡された引数の全部 */
  calls: string[][];
  /** 問い合わせを失敗させる標準エラー */
  failStderr: string;
  prs: Map<number, FakePr>;
  /** gh pr ready の呼び出し */
  ready: string[][];
  add: (pr: Partial<FakePr> & { number: number }) => FakePr;
  /** GraphQL の点数（GitHub の決まり：一覧の数を100ごとに数えて100で割る） */
  costOf: (stage: 1 | 2, n: number) => number;
}

export function fakeGh(repo = "o/r"): FakeGh {
  const gh: FakeGh = {
    viewer: "me",
    remaining: 5000,
    rateLimited: false,
    resetAt: 1_800_000_000,
    denied: 0,
    stage1: 0,
    stage2: 0,
    stage2Numbers: [],
    older: 0,
    olderNumbers: [],
    olderQueries: [],
    failOlder: "",
    olderFailed: 0,
    omitTotalCount: false,
    omitPageInfo: false,
    calls: [],
    failStderr: "",
    prs: new Map(),
    ready: [],
    add: (over) => {
      const pr: FakePr = {
        repo,
        branch: `task/T${over.number}-x`,
        updatedAt: "2026-11-04T00:00:00Z",
        head: `head${over.number}`,
        isDraft: false,
        state: "OPEN",
        ci: "SUCCESS",
        cross: false,
        reviews: [],
        comments: [],
        threads: [],
        mergeCommit: null,
        mergedAt: null,
        reviewDecision: null,
        mergeStateStatus: "BLOCKED",
        ...over,
      };
      gh.prs.set(pr.number, pr);
      return pr;
    },
    costOf: (stage, n) =>
      stage === 1
        ? Math.max(1, Math.ceil((1 + n) / 100))
        : Math.max(1, Math.ceil((1 + n * 6) / 100)),
  };
  return gh;
}

const person = (login: string, who: FakeWho = {}) => ({
  login,
  ...(who.bot === undefined ? {} : { __typename: who.bot ? "Bot" : "User" }),
});

/** 立場は、省いたときは答えに入れない（authorAssociation が読めない場面） */
const assoc = (who: FakeWho) =>
  who.association === undefined ? {} : { authorAssociation: who.association };

const stamp = (who: FakeWho, field: "createdAt" | "submittedAt") =>
  who.at === undefined ? {} : { [field]: who.at };

function nodeOf(
  pr: FakePr,
  opts: { omitTotalCount: boolean; omitPageInfo: boolean },
) {
  return {
    id: `PR_${pr.number}`,
    number: pr.number,
    url: `https://github.com/${pr.repo}/pull/${pr.number}`,
    state: pr.state,
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    headRefOid: pr.head,
    headRefName: pr.branch,
    isCrossRepository: pr.cross,
    mergedAt: pr.mergedAt,
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
    reviewDecision: pr.reviewDecision,
    mergeStateStatus: pr.mergeStateStatus,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: pr.ci === null ? null : { state: pr.ci },
          },
        },
      ],
    },
    // 他人の文章（本文）は、本物の問い合わせでは取らない。偽物は返しても、読む側が取らないことを確かめる
    reviews: {
      nodes: pr.reviews.map((r) => ({
        id: r.id,
        body: r.body,
        state: r.state ?? "COMMENTED",
        commit: { oid: r.commit ?? pr.head },
        ...stamp(r, "submittedAt"),
        ...assoc(r),
        author: person(r.author, r),
      })),
    },
    comments: {
      nodes: pr.comments.map((c) => ({
        id: c.id,
        body: c.body,
        ...stamp(c, "createdAt"),
        ...assoc(c),
        author: person(c.author, c),
      })),
    },
    reviewThreads: {
      ...(opts.omitTotalCount ? {} : { totalCount: pr.threads.length }),
      ...(opts.omitPageInfo
        ? {}
        : {
            pageInfo: {
              hasPreviousPage: pr.threads.length > 30,
              startCursor:
                pr.threads.length > 0
                  ? `cur${Math.max(0, pr.threads.length - 30)}`
                  : null,
            },
          }),
      nodes: pr.threads.slice(-30).map((t) => ({
        id: t.id,
        isResolved: t.resolvedBy !== null,
        resolvedBy: t.resolvedBy ? person(t.resolvedBy) : null,
        comments: {
          nodes: t.comments.map((c) => ({
            id: c.id,
            body: c.body,
            ...stamp(c, "createdAt"),
            ...assoc(c),
            state: c.pending ? "PENDING" : "PUBLISHED",
            author: person(c.author, c),
          })),
        },
      })),
    },
  };
}

const ok = (stdout: string) => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

/** gh だけを偽物に回す Runner（git・orca はほかの Runner へ） */
export function ghRunner(gh: FakeGh, rest: Runner): Runner {
  return async (cmd, args, opts) => {
    if (cmd !== "gh") return rest(cmd, args, opts);
    gh.calls.push([...args]);
    if (gh.failStderr)
      return { code: 1, stdout: "", stderr: gh.failStderr, timedOut: false };
    if (args[0] === "api" && args[1] === "rate_limit")
      return ok(
        JSON.stringify({
          resources: {
            graphql: {
              limit: 5000,
              // 上限の印のあとは、残りが0で戻る時刻を返す（本物の上限の印のあと）
              remaining: gh.rateLimited && gh.denied > 0 ? 0 : gh.remaining,
              reset: gh.resetAt,
            },
          },
        }),
      );
    if (args[0] === "api" && args[1] === "graphql") {
      if (gh.rateLimited) {
        gh.denied++;
        return {
          code: 1,
          stdout: "",
          stderr: "gh: API rate limit exceeded for user",
          timedOut: false,
        };
      }
      const query = args.find((a) => a.startsWith("query="))!.slice(6);
      const vars = Object.fromEntries(
        args
          .map((a, i) =>
            args[i - 1] === "-f" && !a.startsWith("query=") ? a : null,
          )
          .filter((a): a is string => a !== null)
          .map((a) => [
            a.slice(0, a.indexOf("=")),
            a.slice(a.indexOf("=") + 1),
          ]),
      );
      if (query.includes("search(")) {
        gh.stage1++;
        const repoName = /repo:(\S+)/.exec(vars.q ?? "")?.[1];
        const all = [...gh.prs.values()].filter(
          (p) => p.repo === repoName && p.state === "OPEN",
        );
        return ok(
          JSON.stringify({
            data: {
              viewer: person(gh.viewer),
              rateLimit: {
                cost: gh.costOf(1, all.length),
                remaining: gh.remaining,
                resetAt: "x",
              },
              search: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: all.map((p) => nodeOf(p, gh)),
              },
            },
          }),
        );
      }
      if (query.includes("before:") && gh.failOlder !== "") {
        gh.olderFailed++;
        if (gh.failOlder === "rate-limit") gh.denied++;
        return {
          code: 1,
          stdout: "",
          stderr:
            gh.failOlder === "rate-limit"
              ? "gh: API rate limit exceeded for user"
              : "boom (502)",
          timedOut: false,
        };
      }
      if (query.includes("before:")) {
        // 古いスレッドをめくる問い合わせ：解決の印と pageInfo だけを返す
        gh.older++;
        const olderNums = [...query.matchAll(/pr_(\d+):/g)].map((m) =>
          Number(m[1]),
        );
        gh.olderNumbers.push(olderNums);
        gh.olderQueries.push(query);
        const repository: Record<string, unknown> = {};
        for (const n of olderNums) {
          const all = gh.prs.get(n)?.threads ?? [];
          const end = Number((vars[`c_${n}`] ?? "cur0").slice(3));
          // 問い合わせの last: 件数だけ返す（GitHub の上限は100件。それを超える値にすると本物では誤りになる）
          const page = Number(
            new RegExp(`pr_${n}: .*?last: (\\d+)`).exec(query)?.[1] ?? 100,
          );
          if (page > 100)
            throw new Error(`last: ${page} は GitHub の上限（100）を超える`);
          const start = Math.max(0, end - page);
          repository[`pr_${n}`] = {
            reviewThreads: {
              pageInfo: {
                hasPreviousPage: start > 0,
                startCursor: `cur${start}`,
              },
              nodes: all
                .slice(start, end)
                .map((t) => ({ isResolved: t.resolvedBy !== null })),
            },
          };
        }
        return ok(
          JSON.stringify({
            data: {
              rateLimit: { cost: 1, remaining: gh.remaining, resetAt: "x" },
              repository,
            },
          }),
        );
      }
      gh.stage2++;
      const numbers = [...query.matchAll(/pr_(\d+):/g)].map((m) =>
        Number(m[1]),
      );
      gh.stage2Numbers.push(numbers);
      const repository: Record<string, unknown> = {};
      for (const n of numbers) {
        const pr = gh.prs.get(n);
        repository[`pr_${n}`] = pr ? nodeOf(pr, gh) : null;
      }
      return ok(
        JSON.stringify({
          data: {
            rateLimit: {
              cost: gh.costOf(2, numbers.length),
              remaining: gh.remaining,
              resetAt: "x",
            },
            repository,
          },
        }),
      );
    }
    // 送る関数（pr-ready）が PR を探す・読む呼び出し
    if (args[0] === "pr" && (args[1] === "list" || args[1] === "view")) {
      const rollup = (pr: FakePr) =>
        pr.ci === null
          ? []
          : [
              {
                status: pr.ci === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
                conclusion:
                  pr.ci === "SUCCESS"
                    ? "SUCCESS"
                    : pr.ci === "FAILURE"
                      ? "FAILURE"
                      : "",
              },
            ];
      const asJson = (pr: FakePr) => ({
        number: pr.number,
        url: `https://github.com/${pr.repo}/pull/${pr.number}`,
        isDraft: pr.isDraft,
        state: pr.state,
        headRefOid: pr.head,
        statusCheckRollup: rollup(pr),
        isCrossRepository: pr.cross,
      });
      if (args[1] === "list") {
        const branch = args[args.indexOf("--head") + 1];
        return ok(
          JSON.stringify(
            [...gh.prs.values()].filter((p) => p.branch === branch).map(asJson),
          ),
        );
      }
      const pr = gh.prs.get(Number(args[2]));
      return pr
        ? ok(JSON.stringify(asJson(pr)))
        : { code: 1, stdout: "", stderr: "not found", timedOut: false };
    }
    if (args[0] === "pr" && args[1] === "ready") {
      gh.ready.push([...args]);
      const pr = gh.prs.get(Number(args[2]));
      if (pr) pr.isDraft = false;
      return ok("");
    }
    return ok("");
  };
}

export interface Harness {
  root: string;
  gh: FakeGh;
  orca: FakeOrca;
  runner: Runner;
  out: string[];
  err: string[];
  now: Date;
  ctx: (argv?: string[]) => CommandContext;
  /** 状態のファイルのある場所 */
  dir: string;
}

/** メインの作業ツリー（origin は GitHub の URL）と偽物の GitHub・Orca */
export async function harness(
  config: Record<string, unknown> = {},
): Promise<Harness> {
  const root = await makeRepo({ ...config });
  await git(root, "remote", "add", "origin", "https://github.com/o/r.git");
  const gh = fakeGh();
  const orca = fakeOrca();
  const out: string[] = [];
  const err: string[] = [];
  const h: Harness = {
    root,
    gh,
    orca,
    runner: ghRunner(gh, orca.runner),
    out,
    err,
    now: new Date("2026-11-04T01:00:00Z"),
    dir: path.join(root, ".git", "orca-flow", "pr-watch"),
    ctx: (argv = []) => ({
      argv,
      cwd: root,
      json: false,
      runner: h.runner,
      env: {},
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      now: () => h.now,
    }),
  };
  return h;
}

/**
 * マージの後始末まで確かめるための origin（本物の bare）。origin の URL は GitHub のまま、
 * url.insteadOf で取り込み先だけを bare に向ける
 */
export async function withOrigin(h: Harness): Promise<string> {
  const origin = path.join(await tempDir("orca-flow-origin-"), "origin.git");
  await git(
    path.dirname(origin),
    "init",
    "--quiet",
    "--bare",
    "-b",
    "main",
    origin,
  );
  await git(
    h.root,
    "config",
    `url.${origin}.insteadOf`,
    "https://github.com/o/r.git",
  );
  await git(h.root, "push", "--quiet", "origin", "main");
  return origin;
}

/** タスクの worktree と push の記録を置く */
export async function taskWithRecord(
  h: Harness,
  id: string,
  number: number,
  files: Record<string, string> = { [`src/${id}.ts`]: "a\n" },
) {
  const wt = await addTaskWorktree(h.root, id, "x", files);
  const head = await git(wt.path, "rev-parse", "HEAD");
  await writePushRecord(testRunner, h.root, id, {
    id,
    branch: wt.branch,
    base: "main",
    pushedHead: head,
    pushedAt: "2026-11-04T00:00:00Z",
    pr: { number, url: `https://github.com/o/r/pull/${number}` },
  });
  return { wt, head };
}

export const comments = (orca: FakeOrca) =>
  orca
    .callsOf("worktree", "set")
    .map((c) => c[c.indexOf("--comment") + 1] ?? "");
