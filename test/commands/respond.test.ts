import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner, RunResult } from "../../src/lib/exec.ts";
import { fakeGithub, type FakeGithubOptions } from "../helpers/fake-github.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";
import { draftsPath, readDrafts } from "../../src/lib/pending-review.ts";

const done = (code: number, stdout = "", stderr = ""): RunResult => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

const ALLOWED_MUTATIONS = [
  "addPullRequestReview",
  "addPullRequestReviewThreadReply",
  "updatePullRequestReviewComment",
  "deletePullRequestReviewComment",
];

/** gh api graphql の呼び出しから、mutation の名前を取り出す */
function mutationNames(calls: string[]): string[] {
  const names: string[] = [];
  for (const call of calls) {
    if (!call.startsWith("api graphql -f query=")) continue;
    const m = /^api graphql -f query=\s*mutation[^{]*\{\s*(\w+)/.exec(call);
    if (m) names.push(m[1]!);
    else if (/query=\s*mutation/.test(call))
      names.push("（読めない mutation）");
  }
  return names;
}

const SECRET_BODY = "他人の秘密の指摘文 SECRET-TEXT";

interface Fake {
  ci: "failed" | "passed";
  /** git の呼び出し（引数をつないだもの） */
  gitCalls: string[];
  /** orca の呼び出しごとの時間切れ（ミリ秒。なければ null） */
  orcaTimeouts: (number | null)[];
  /** true なら、スレッドをいつも次ページありで返す（合計 640 件） */
  endlessThreads: boolean;
}

/** respond が読む部分（PR の CI・ログ・スレッド）の足しの答え */
function respondReads(fake: Fake): FakeGithubOptions["answer"] {
  return (args, state) => {
    const data = (value: unknown) => done(0, JSON.stringify({ data: value }));
    if (args[0] === "pr" && args[1] === "view")
      return done(
        0,
        JSON.stringify({
          statusCheckRollup: [
            fake.ci === "failed"
              ? {
                  name: "test",
                  conclusion: "FAILURE",
                  status: "COMPLETED",
                  detailsUrl: "https://github.com/o/r/actions/runs/99/job/1",
                }
              : { name: "test", conclusion: "SUCCESS", status: "COMPLETED" },
          ],
        }),
      );
    if (args[0] === "run") return done(0, "log line 1\nlog line 2\n");
    if (args[0] !== "api") return undefined;
    const query = args[3]!.replace(/^query=/, "");
    if (!query.includes("reviewThreads(")) return undefined;
    state.calls.push(`QUERY ${query.replace(/\s+/g, " ")}`);
    return data({
      viewer: { login: "me" },
      repository: {
        pullRequest: {
          url: "https://github.com/o/r/pull/7",
          reviews: {
            totalCount: 1,
            nodes: [
              {
                state: "COMMENTED",
                body: "レビュー本文",
                author: { login: "bob" },
              },
            ],
          },
          comments: { totalCount: 0, nodes: [] },
          reviewThreads: {
            totalCount: fake.endlessThreads ? 640 : 1,
            pageInfo: {
              hasNextPage: fake.endlessThreads,
              endCursor: fake.endlessThreads ? "cur" : null,
            },
            nodes: fake.endlessThreads
              ? Array.from({ length: 100 }, (_, i) => ({
                  id: `PRRT_X${i}`,
                  isResolved: true,
                  path: "x.ts",
                  head: { nodes: [] },
                  tail: { totalCount: 0, nodes: [] },
                }))
              : [
                  {
                    id: "PRRT_1",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/a.ts",
                    line: 3,
                    head: {
                      nodes: [{ body: SECRET_BODY, author: { login: "bob" } }],
                    },
                    tail: {
                      totalCount: 1,
                      nodes: [{ body: SECRET_BODY, author: { login: "bob" } }],
                    },
                  },
                ],
          },
        },
      },
    });
  };
}

async function setup(over: Partial<Fake> = {}) {
  const root = await makeRepo();
  const wt = await addTaskWorktree(root, "T01", "x", { "a.txt": "a\n" });
  const fake: Fake = {
    ci: "failed",
    gitCalls: [],
    orcaTimeouts: [],
    endlessThreads: false,
    ...over,
  };
  const gh = fakeGithub({ answer: respondReads(fake) });
  const orca = fakeOrca();
  const runner: Runner = (cmd, args, opts) => {
    if (cmd === "git") fake.gitCalls.push(args.join(" "));
    if (cmd === "orca") fake.orcaTimeouts.push(opts?.timeoutMs ?? null);
    return cmd === "gh"
      ? gh.runner(cmd, args, opts)
      : orca.runner(cmd, args, opts);
  };
  const cli = (...argv: string[]) =>
    runCli(["respond", ...argv], { cwd: root, runner });
  return { root, wt, fake, gh, orca, cli };
}

const writeBody = async (text: string) => {
  const file = path.join(await tempDir(), "body.md");
  await writeFile(file, text);
  return file;
};

describe("respond input", () => {
  it("入力ファイルを共通ディレクトリに書き、標準出力には他人の文章を出さない", async () => {
    const { root, cli } = await setup();
    const r = await cli("input", "T01");
    expect(r.code).toBe(0);
    const file = `${root}/.git/orca-flow/respond/T01/input.md`;
    const text = await readFile(file, "utf8");
    expect(text).toContain(SECRET_BODY);
    expect(text).toContain("src/a.ts:3");
    expect(r.out).toContain(file);
    expect(r.out).toContain("未解決のスレッド 1 件");
    expect(r.out + r.err).not.toContain("SECRET-TEXT");
    expect(r.out + r.err).not.toContain("レビュー本文");
  });

  it("スレッドが 5 ページで読みきれないとき、呼び出しは 5 回で止まり、取りこぼしを出す", async () => {
    const { root, fake, cli, gh } = await setup({ endlessThreads: true });
    const r = await cli("input", "T01");
    expect(r.code).toBe(0);
    const pages = gh.state.calls.filter(
      (c) => c.startsWith("QUERY ") && c.includes("viewer { login }"),
    );
    expect(pages).toHaveLength(5);
    const text = await readFile(
      `${root}/.git/orca-flow/respond/T01/input.md`,
      "utf8",
    );
    expect(text).toContain("500 件読めました（合計 640 件）");
    expect(r.out).toContain("読みきれなかった");
  });

  it("CI の緑を見たら直しの回数を0に戻す", async () => {
    const { root, fake, cli } = await setup();
    expect((await cli("ci-fix", "T01")).code).toBe(0);
    expect((await cli("ci-fix", "T01")).code).toBe(0);
    fake.ci = "passed";
    expect((await cli("input", "T01")).code).toBe(0);
    const ci = JSON.parse(
      await readFile(`${root}/.git/orca-flow/respond/T01/ci.json`, "utf8"),
    );
    expect(ci.count).toBe(0);
    expect((await cli("ci-fix", "T01")).code).toBe(0);
  });
});

describe("respond ci-fix", () => {
  it("2回まで終了コード0、3回目で終了コード2", async () => {
    const { cli } = await setup();
    expect((await cli("ci-fix", "T01")).code).toBe(0);
    expect((await cli("ci-fix", "T01")).code).toBe(0);
    const third = await cli("ci-fix", "T01");
    expect(third.code).toBe(2);
    expect(third.err).toContain("人に回して");
    expect((await cli("ci-fix", "T01")).code).toBe(2);
  });

  it("上限のメッセージに戻し方（CI が緑で input を流す・ci.json を消す）を書く", async () => {
    const { root, cli } = await setup();
    await cli("ci-fix", "T01");
    await cli("ci-fix", "T01");
    const r = await cli("ci-fix", "T01");
    expect(r.code).toBe(2);
    expect(r.err).toContain("orca-flow respond input T01");
    expect(r.err).toContain(`${root}/.git/orca-flow/respond/T01/ci.json`);
  });

  it("ci.json が壊れていたら、0に戻さず終了コード1で止まる（数えも進めない）", async () => {
    const { root, cli } = await setup();
    await cli("ci-fix", "T01");
    const file = `${root}/.git/orca-flow/respond/T01/ci.json`;
    await writeFile(file, "{ 壊れた");
    const r = await cli("ci-fix", "T01");
    expect(r.code).toBe(1);
    expect(r.err).toContain(file);
    expect(await readFile(file, "utf8")).toBe("{ 壊れた");
  });

  it("壊れた ci.json は、CI が緑で input を流すと0に直る", async () => {
    const { root, fake, cli } = await setup({ ci: "passed" });
    const file = `${root}/.git/orca-flow/respond/T01/ci.json`;
    await cli("ci-fix", "T01");
    await writeFile(file, "{ 壊れた");
    expect((await cli("input", "T01")).code).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).count).toBe(0);
    expect(fake.ci).toBe("passed");
    expect((await cli("ci-fix", "T01")).code).toBe(0);
  });
});

describe("respond draft / drafts", () => {
  it("保留中のレビューへの書き込みだけを流し、レビューの送信は流さない", async () => {
    const { fake, cli, gh } = await setup();
    const body = await writeBody("直しました");
    const r = await cli(
      "draft",
      "T01",
      "--thread",
      "PRRT_1",
      "--body-file",
      body,
    );
    expect(r.code).toBe(0);
    const summary = await writeBody("全体への返事");
    expect((await cli("draft", "T01", "--summary-file", summary)).code).toBe(0);
    const edit = await writeBody("直しました（修正）");
    expect(
      (await cli("draft", "T01", "--edit", "C1", "--body-file", edit)).code,
    ).toBe(0);
    expect(gh.state.review!.comments[0]!.body).toBe("直しました（修正）");
    expect((await cli("draft", "T01", "--delete", "C1")).code).toBe(0);
    expect(gh.state.review!.comments).toEqual([]);
    // 流した mutation は、保留の書き込みだけ
    const mutations = mutationNames(gh.state.calls);
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) expect(ALLOWED_MUTATIONS).toContain(m);
    expect(mutations).toEqual(
      expect.arrayContaining([
        "addPullRequestReview",
        "addPullRequestReviewThreadReply",
        "updatePullRequestReviewComment",
        "deletePullRequestReviewComment",
      ]),
    );
    // 本文は記録に持つので、GitHub のレビューの本文は書き換えない
    expect(mutations).not.toContain("updatePullRequestReview");
    // gh のコマンド：レビューの送信・レビュー依頼・PR の編集は流さない
    const joined = gh.state.calls.join("\n");
    expect(joined).not.toContain("submitPullRequestReview");
    expect(joined).not.toContain("requestReviews");
    expect(joined).not.toContain("--add-reviewer");
    expect(gh.state.calls.some((c) => c.startsWith("pr edit"))).toBe(false);
    // git で push していない（記録した git の呼び出しの中に push がない）
    expect(fake.gitCalls.length).toBeGreaterThan(0);
    expect(fake.gitCalls.some((c) => c.split(" ").includes("push"))).toBe(
      false,
    );
  });

  it("返信を書いてから --summary-file を流すと終了コード0で、記録に本文が残る（GitHub の本文は書き換えない）", async () => {
    const { fake, cli, gh } = await setup();
    const body = await writeBody("直しました");
    expect(
      (await cli("draft", "T01", "--thread", "PRRT_1", "--body-file", body))
        .code,
    ).toBe(0);
    const summary = await writeBody("全体への返事");
    const r = await cli("draft", "T01", "--summary-file", summary);
    expect(r.code).toBe(0);
    expect(gh.state.queries.join("\n")).not.toContain(
      "updatePullRequestReview(",
    );
    const shown = await cli("drafts", "T01");
    expect(shown.out).toContain(
      "レビューの本文（会話の欄への返事）：\n    全体への返事",
    );
    expect(fake).toBeDefined();
  });

  it("手元のパスがあれば書かずに終了コード1", async () => {
    const { root, fake, cli, gh } = await setup();
    const body = await writeBody(`見てください ${root}/a.txt`);
    const r = await cli(
      "draft",
      "T01",
      "--thread",
      "PRRT_1",
      "--body-file",
      body,
    );
    expect(r.code).toBe(1);
    expect(gh.state.review).toBeNull();
    // コメントを書いていないことは、偽物の欄でなく呼び出しの記録で確かめる
    expect(mutationNames(gh.state.calls)).toEqual([]);
  });

  it("秘密らしい値は伏せ字にして書く", async () => {
    const { fake, cli, gh } = await setup();
    const body = await writeBody(
      "token ghp_abcdefghijklmnopqrstuvwxyz0123 です",
    );
    expect(
      (await cli("draft", "T01", "--thread", "PRRT_1", "--body-file", body))
        .code,
    ).toBe(0);
    expect(gh.state.review!.comments[0]!.body).not.toContain("ghp_abcdef");
  });

  it("モードを1つも渡さない・2つ渡すと終了コード1", async () => {
    const { cli } = await setup();
    const body = await writeBody("x");
    expect((await cli("draft", "T01")).code).toBe(1);
    expect(
      (
        await cli(
          "draft",
          "T01",
          "--thread",
          "T",
          "--delete",
          "C",
          "--body-file",
          body,
        )
      ).code,
    ).toBe(1);
    expect((await cli("draft", "T01", "--thread", "T")).code).toBe(1);
  });

  it("drafts は自分の下書きの全文と場所を出す", async () => {
    const { cli } = await setup();
    const body = await writeBody("理由があって直しません");
    await cli("draft", "T01", "--thread", "PRRT_1", "--body-file", body);
    const r = await cli("drafts", "T01");
    expect(r.code).toBe(0);
    expect(r.out).toContain("a.ts:3");
    expect(r.out).toContain("理由があって直しません");
    expect(r.out).toContain("C1");
  });
});

describe("respond drafts --json", () => {
  it("body と mine[].body にも、文字の出力と同じ伏せ字をかける", async () => {
    const { fake, cli, gh } = await setup();
    const body = await writeBody("下書き");
    await cli("draft", "T01", "--thread", "PRRT_1", "--body-file", body);
    // 記録の本文がないレビューの GitHub 側の本文が、秘密を含むものになった、という状況
    gh.state.review!.comments[0]!.body =
      "ghp_abcdefghijklmnopqrstuvwxyz0123 と plain-env-secret-9876";
    gh.state.review!.body = "Bearer abcdefghijklmnopqrstu です";
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "plain-env-secret-9876";
    try {
      const r = await cli("drafts", "T01", "--json");
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("ghp_abcdef");
      expect(r.out).not.toContain("plain-env-secret-9876");
      expect(r.out).not.toContain("abcdefghijklmnopqrstu");
      const data = JSON.parse(r.out);
      expect(data.mine[0].body).toContain("〈");
      expect(data.body).toContain("〈伏せた〉");
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });
});

describe("respond open", () => {
  it("ファイル・Files changed・カードの PR の参照を orca に流す", async () => {
    const { wt, orca, cli } = await setup();
    const r = await cli("open", "T01");
    expect(r.code).toBe(0);
    expect(orca.callsOf("file", "open")[0]).toEqual([
      "file",
      "open",
      "src/a.ts",
      "--worktree",
      `path:${wt.path}`,
    ]);
    expect(orca.callsOf("tab", "create")[0]).toEqual([
      "tab",
      "create",
      "--url",
      "https://github.com/o/r/pull/7/files",
      "--worktree",
      `path:${wt.path}`,
    ]);
    expect(orca.callsOf("worktree", "set")[0]).toContain("--pr");
  });

  it("Orca が落ちていても警告だけで終了コード0", async () => {
    const { orca, cli } = await setup();
    orca.unavailable = true;
    const r = await cli("open", "T01");
    expect(r.code).toBe(0);
    expect(r.err).toContain("警告");
  });

  it("Orca が応えないときは、警告を1つだけ出して残りを省く（GitHub も読まない）", async () => {
    const { orca, fake, cli, gh } = await setup();
    orca.unavailable = true;
    const r = await cli("open", "T01");
    expect(r.code).toBe(0);
    expect(r.err.split("\n").filter((l) => l.includes("警告"))).toHaveLength(1);
    // 呼んだ orca は最初の確かめ1回だけで、短い時間切れが付いている
    expect(orca.calls).toHaveLength(1);
    expect(fake.orcaTimeouts[0]).toBe(10_000);
    expect(gh.state.calls.some((c) => c.includes("reviewThreads("))).toBe(
      false,
    );
  });

  it("ファイルの場所だけを読み、CI のログも返信も読まない", async () => {
    const { fake, cli, gh } = await setup();
    expect((await cli("open", "T01")).code).toBe(0);
    expect(gh.state.calls.some((c) => c.startsWith("run "))).toBe(false);
    expect(gh.state.calls.some((c) => c.startsWith("pr view"))).toBe(false);
    const queries = gh.state.calls.filter((c) => c.startsWith("QUERY "));
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("comments");
  });
});

describe("respond の使い方", () => {
  it("知らないサブコマンドは終了コード1", async () => {
    const { cli } = await setup();
    expect((await cli("bogus")).code).toBe(1);
    expect((await cli("input")).code).toBe(1);
  });
});

describe("respond draft --fixed-by", () => {
  async function withFixes() {
    const ctx = await setup();
    const commit = async (name: string) => {
      await writeFiles(ctx.wt.path, { [name]: `${name}\n` });
      await git(ctx.wt.path, "add", "-A");
      await git(ctx.wt.path, "commit", "--quiet", "-m", name);
      return git(ctx.wt.path, "rev-parse", "HEAD");
    };
    const c1 = await commit("one");
    const c2 = await commit("two");
    const body = await writeBody("直しました");
    const common = `${ctx.root}/.git`;
    const fixedBy = async () =>
      (await readDrafts(common, "T01")).prs["7"]?.fixedBy;
    return { ...ctx, c1, c2, body, common, fixedBy };
  }

  it("返信を書くときに渡すと、40桁にそろえて返信ごとに記録に残り、drafts に短い SHA が出る", async () => {
    const { cli, c1, c2, body, fixedBy } = await withFixes();
    const r = await cli(
      "draft",
      "T01",
      "--thread",
      "PRRT_1",
      "--body-file",
      body,
      "--fixed-by",
      `${c1.slice(0, 10)},${c2}`,
    );
    expect(r.code).toBe(0);
    expect(await fixedBy()).toEqual({ C1: [c1, c2] });
    const shown = await cli("drafts", "T01");
    expect(shown.out).toContain(c1.slice(0, 8));
    expect(shown.out).toContain(c2.slice(0, 8));
    const json = JSON.parse((await cli("drafts", "T01", "--json")).out);
    expect(json.fixedBy).toEqual({ C1: [c1, c2] });
  });

  it("--edit は --fixed-by だけでも受け、none で外す。--delete で返信と一緒に消える", async () => {
    const { cli, c1, c2, body, fixedBy, gh } = await withFixes();
    await cli(
      "draft",
      "T01",
      "--thread",
      "PRRT_1",
      "--body-file",
      body,
      "--fixed-by",
      c1,
    );
    const edited = await cli("draft", "T01", "--edit", "C1", "--fixed-by", c2);
    expect(edited.code).toBe(0);
    expect(await fixedBy()).toEqual({ C1: [c2] });
    // 本文は直していない
    expect(gh.state.review!.comments[0]!.body).toBe("直しました");
    expect(
      (await cli("draft", "T01", "--edit", "C1", "--fixed-by", "none")).code,
    ).toBe(0);
    expect(await fixedBy()).toBeUndefined();
    await cli("draft", "T01", "--edit", "C1", "--fixed-by", c1);
    expect((await cli("draft", "T01", "--delete", "C1")).code).toBe(0);
    expect(await fixedBy()).toBeUndefined();
  });

  it("--edit は --body-file も --fixed-by もなければ終了コード1", async () => {
    const { cli, body } = await withFixes();
    await cli("draft", "T01", "--thread", "PRRT_1", "--body-file", body);
    expect((await cli("draft", "T01", "--edit", "C1")).code).toBe(1);
  });

  it("16進でない・解けない・タスクのブランチからたどれない・baseBranch からたどれる SHA は終了コード1で、何も書かない", async () => {
    const { cli, root, wt, body, common, gh } = await withFixes();
    // タスクのブランチに入っていないコミット
    const mainHead = await git(root, "rev-parse", "HEAD");
    const other = path.join(await tempDir(), "other");
    await git(root, "worktree", "add", "--quiet", "-b", "other", other, "main");
    await writeFiles(other, { "o.txt": "o\n" });
    await git(other, "add", "-A");
    await git(other, "commit", "--quiet", "-m", "other");
    const offBranch = await git(other, "rev-parse", "HEAD");
    expect(wt.branch).toBe("task/T01-x");
    const bad = [
      "zzzzzzz",
      "1234567890abcdef",
      offBranch,
      mainHead,
      "none,abcdef0",
      "",
    ];
    for (const value of bad) {
      const r = await cli(
        "draft",
        "T01",
        "--thread",
        "PRRT_1",
        "--body-file",
        body,
        "--fixed-by",
        value,
      );
      expect(r.code, value).toBe(1);
    }
    expect(gh.state.review).toBeNull();
    expect(gh.state.calls.filter((c) => c.includes("mutation"))).toEqual([]);
    await expect(readFile(draftsPath(common, "T01"), "utf8")).rejects.toThrow();
  });

  it("--edit に本文と悪い SHA を渡すと終了コード1で、本文も記録の結びつけも変わらない", async () => {
    const { cli, root, c1, body, common, fixedBy, gh } = await withFixes();
    await cli(
      "draft",
      "T01",
      "--thread",
      "PRRT_1",
      "--body-file",
      body,
      "--fixed-by",
      c1,
    );
    const mainHead = await git(root, "rev-parse", "HEAD");
    const newBody = await writeBody("書き換えた本文");
    const before = await readFile(draftsPath(common, "T01"), "utf8");
    for (const bad of ["zzzzzzz", "1234567890abcdef", mainHead]) {
      const r = await cli(
        "draft",
        "T01",
        "--edit",
        "C1",
        "--body-file",
        newBody,
        "--fixed-by",
        bad,
      );
      expect(r.code, bad).toBe(1);
    }
    expect(gh.state.review!.comments[0]!.body).toBe("直しました");
    expect(await fixedBy()).toEqual({ C1: [c1] });
    expect(await readFile(draftsPath(common, "T01"), "utf8")).toBe(before);
  });

  it("--delete と --summary-file には渡せない", async () => {
    const { cli, c1, body } = await withFixes();
    expect(
      (await cli("draft", "T01", "--delete", "C1", "--fixed-by", c1)).code,
    ).toBe(1);
    expect(
      (await cli("draft", "T01", "--summary-file", body, "--fixed-by", c1))
        .code,
    ).toBe(1);
  });

  it("fixedBy のない前の記録は読め、形が違う記録は読めずに止まる", async () => {
    const { cli, common, body } = await withFixes();
    await cli("draft", "T01", "--thread", "PRRT_1", "--body-file", body);
    expect((await readDrafts(common, "T01")).prs["7"]!.commentIds).toEqual([
      "C1",
    ]);
    expect((await cli("drafts", "T01")).code).toBe(0);
    await writeFile(
      draftsPath(common, "T01"),
      JSON.stringify({
        prs: {
          "7": { reviewId: "R1", commentIds: ["C1"], fixedBy: { C1: ["x"] } },
        },
      }),
    );
    const r = await cli("drafts", "T01");
    expect(r.code).toBe(1);
    expect(r.err).toContain("記録を読めませんでした");
  });
});
