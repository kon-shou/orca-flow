import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const done = (code: number, stdout = "", stderr = "", timedOut = false) => ({
  code,
  stdout,
  stderr,
  timedOut,
});

const SECRET = "他人の文章 SECRET-TEXT";
const PR_URL = "https://github.com/o/r/pull/7";

interface Fake {
  labels: string[];
  labelsFail: boolean;
  noPr: boolean;
  /** claude の答え（structured_output）。raw があればそれを標準出力にする */
  claude: { key: string } | null;
  claudeRaw: string | null;
  claudeCode: number;
  claudeTimedOut: boolean;
  /** GraphQL の node を差し替える（undefined なら既定のスレッド） */
  node: unknown;
  viewer: string;
  apiFail: boolean;
  apiNotFound: boolean;
  claudeCalls: {
    args: readonly string[];
    input: string;
    env: NodeJS.ProcessEnv | undefined;
  }[];
}

function setupFake(over: Partial<Fake> = {}): Fake {
  return {
    labels: [],
    labelsFail: false,
    noPr: false,
    claude: { key: "fix" },
    claudeRaw: null,
    claudeCode: 0,
    claudeTimedOut: false,
    node: undefined,
    viewer: "me",
    apiFail: false,
    apiNotFound: false,
    claudeCalls: [],
    ...over,
  };
}

function fakeGh(fake: Fake): Runner {
  return async (_cmd, args) => {
    if (args[0] === "repo") return done(0, '{"nameWithOwner":"o/r"}');
    if (args[0] === "pr" && args[1] === "list")
      return done(
        0,
        JSON.stringify(
          fake.noPr
            ? []
            : [
                {
                  number: 7,
                  url: PR_URL,
                  isDraft: false,
                  state: "OPEN",
                  headRefOid: "a".repeat(40),
                  statusCheckRollup: [],
                  isCrossRepository: false,
                },
              ],
        ),
      );
    if (args[0] === "pr" && args[1] === "view")
      return fake.labelsFail
        ? done(1, "", "boom")
        : done(
            0,
            JSON.stringify({ labels: fake.labels.map((name) => ({ name })) }),
          );
    if (args[0] === "api" && fake.apiFail) return done(1, "", "boom");
    if (args[0] === "api" && fake.apiNotFound)
      return done(
        0,
        JSON.stringify({
          data: null,
          errors: [
            { message: "Could not resolve to a node with the global id" },
          ],
        }),
      );
    if (args[0] === "api")
      return done(
        0,
        JSON.stringify({
          data: {
            viewer: { login: fake.viewer },
            node:
              fake.node !== undefined
                ? fake.node
                : {
                    __typename: "PullRequestReviewThread",
                    path: "src/a.ts",
                    line: 3,
                    pullRequest: { url: PR_URL, title: "PR の題" },
                    head: {
                      nodes: [
                        {
                          body: SECRET,
                          diffHunk: "@@ -1 +1 @@\n+x",
                          author: { login: "bob" },
                        },
                      ],
                    },
                    tail: {
                      totalCount: 1,
                      nodes: [{ body: SECRET, author: { login: "bob" } }],
                    },
                  },
          },
        }),
      );
    return done(0);
  };
}

async function setup(
  over: Partial<Fake> = {},
  config: Record<string, unknown> = {},
  files: Record<string, string> = { "src/a.ts": "a\n" },
) {
  const root = await makeRepo(config);
  await addTaskWorktree(root, "T01", "x", files);
  const fake = setupFake(over);
  const gh = fakeGh(fake);
  const orca = fakeOrca();
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "gh") return gh(cmd, args, opts);
    if (cmd === "claude") {
      fake.claudeCalls.push({ args, input: opts?.input ?? "", env: opts?.env });
      if (fake.claudeTimedOut)
        return done(
          0,
          JSON.stringify({ structured_output: { key: "fix", reason: "r" } }),
          "",
          true,
        );
      if (fake.claudeCode !== 0) return done(fake.claudeCode, "", "err");
      return done(
        0,
        fake.claudeRaw ??
          JSON.stringify({
            result: "",
            structured_output: { ...fake.claude, reason: "理由 REASON-TEXT" },
          }),
      );
    }
    return orca.runner(cmd, args, opts);
  };
  const cli = (...argv: string[]) =>
    runCli(["vote", ...argv], { cwd: root, runner });
  const file = `${root}/.git/orca-flow/vote/T01.jsonl`;
  const records = async () =>
    (await readFile(file, "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
  return { root, fake, cli, file, records };
}

const cast = (
  cli: (...a: string[]) => ReturnType<typeof runCli>,
  over: { kind?: string; first?: string; target?: string } = {},
) =>
  cli(
    "cast",
    "T01",
    "--target",
    over.target ?? "PRRT_1",
    "--kind",
    over.kind ?? "comment",
    "--first",
    over.first ?? "fix",
  );

describe("vote cast: 区分", () => {
  it("risk.paths に当たる差分の PR は high で、claude を呼ばない", async () => {
    const { fake, cli, records } = await setup(
      {},
      { risk: { paths: ["src/"], labels: [] } },
    );
    const r = await cast(cli);
    expect(r.code).toBe(0);
    expect(fake.claudeCalls).toHaveLength(0);
    const [e] = await records();
    expect(e.risk.level).toBe("high");
    expect(e.second).toEqual({ status: "skipped", why: "high_risk" });
  });

  it("risk.labels のラベル（大文字小文字は区別しない）がある PR は high", async () => {
    const { fake, cli, records } = await setup(
      { labels: ["Security"] },
      { risk: { paths: [], labels: ["security"] } },
    );
    await cast(cli);
    expect(fake.claudeCalls).toHaveLength(0);
    expect((await records())[0].risk.level).toBe("high");
  });

  it("ラベルが読めない・PR がない PR は high", async () => {
    const a = await setup({ labelsFail: true });
    await cast(a.cli);
    expect(a.fake.claudeCalls).toHaveLength(0);
    expect((await a.records())[0].risk.level).toBe("high");
    const b = await setup({ noPr: true });
    expect((await cast(b.cli)).code).toBe(0);
    expect(b.fake.claudeCalls).toHaveLength(0);
    expect((await b.records())[0].risk.level).toBe("high");
  });

  it("comment でない種類は、normal でも claude を呼ばず、とらなかったと種類が残る", async () => {
    const { fake, cli, records } = await setup();
    const r = await cast(cli, { kind: "security" });
    expect(r.code).toBe(0);
    expect(fake.claudeCalls).toHaveLength(0);
    const [e] = await records();
    expect(e.kind).toBe("security");
    expect(e.second).toEqual({ status: "skipped", why: "kind" });
    expect(e.model).toBeNull();
  });

  it("知らない種類・キーは終了コード1", async () => {
    const { cli } = await setup();
    expect((await cast(cli, { kind: "foo" })).code).toBe(1);
    expect((await cast(cli, { first: "maybe" })).code).toBe(1);
  });
});

describe("vote cast: 2票目", () => {
  it("normal の comment で claude を呼び、材料に --first のキーと理由が入らない", async () => {
    const { fake, cli, records } = await setup();
    const r = await cast(cli, { first: "wontfix" });
    expect(r.code).toBe(0);
    expect(fake.claudeCalls).toHaveLength(1);
    const call = fake.claudeCalls[0]!;
    expect(call.input).toContain(SECRET);
    expect(call.input).not.toContain("1票目");
    expect(call.input).not.toContain("REASON");
    expect(call.args).toContain("--strict-mcp-config");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe(
      "claude-sonnet-5-5",
    );
    const [e] = await records();
    expect(e.second).toEqual({ status: "voted", key: "fix" });
    expect(e.first).toBe("wontfix");
    expect(e.model).toBe("claude-sonnet-5-5");
    expect(e.human).toBeNull();
  });

  it("子の環境から GH_TOKEN・GITHUB_TOKEN を外す", async () => {
    const { fake, cli } = await setup();
    vi.stubEnv("GH_TOKEN", "ghp_abcdefghijklmnop");
    vi.stubEnv("GITHUB_TOKEN", "ghp_abcdefghijklmnop");
    try {
      await cast(cli);
    } finally {
      vi.unstubAllEnvs();
    }
    const env = fake.claudeCalls[0]!.env!;
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("標準出力に 2票目のキー・理由・他人の文章が入らない", async () => {
    const { cli } = await setup({ claude: { key: "wontfix" } });
    const r = await cast(cli);
    const all = r.out + r.err;
    expect(all).not.toContain("wontfix");
    expect(all).not.toContain("REASON");
    expect(all).not.toContain("SECRET-TEXT");
    const j = await cli(
      "cast",
      "T01",
      "--target",
      "PRRT_9",
      "--kind",
      "comment",
      "--first",
      "fix",
      "--json",
    );
    expect(j.out + j.err).not.toContain("wontfix");
    expect(j.out + j.err).not.toContain("SECRET-TEXT");
  });

  it.each([
    ["unclear", { claude: { key: "unclear" } }, "unclear"],
    ["選択肢にないキー", { claude: { key: "delete" } }, "failed"],
    ["形の違い", { claudeRaw: "not json" }, "failed"],
    ["0以外の終了コード", { claudeCode: 2 }, "failed"],
    ["打ち切り", { claudeTimedOut: true }, "failed"],
  ] as const)(
    "%s は棄権になり、終了コード0で記録が残る",
    async (_name, over, why) => {
      const { cli, records } = await setup(over as Partial<Fake>);
      const r = await cast(cli);
      expect(r.code).toBe(0);
      const [e] = await records();
      expect(e.second).toEqual({ status: "abstained", why });
    },
  );
});

describe("vote cast / answer: 記録", () => {
  it("答える前のやり直しは件を置き換え、答えのあとの cast は断る", async () => {
    const { cli, records } = await setup();
    await cast(cli, { first: "fix" });
    await cast(cli, { first: "ask" });
    expect(await records()).toHaveLength(1);
    expect((await records())[0].first).toBe("ask");
    expect(
      (await cli("answer", "T01", "--target", "PRRT_1", "--human", "fix")).code,
    ).toBe(0);
    expect((await cast(cli, { first: "wontfix" })).code).toBe(1);
    const all = await records();
    expect(all).toHaveLength(1);
    expect(all[0].human).toBe("fix");
    expect(all[0].first).toBe("ask");
  });

  it("別の対象は別の件", async () => {
    const { cli, records } = await setup();
    await cast(cli, { target: "PRRT_1" });
    await cast(cli, { target: "PRRT_2" });
    expect(await records()).toHaveLength(2);
  });

  it("answer は答えのない件がなければ終了コード1", async () => {
    const { cli, records } = await setup();
    expect(
      (await cli("answer", "T01", "--target", "PRRT_1", "--human", "fix")).code,
    ).toBe(1);
    await cast(cli);
    expect(
      (await cli("answer", "T01", "--target", "PRRT_1", "--human", "fix")).code,
    ).toBe(0);
    expect(
      (await cli("answer", "T01", "--target", "PRRT_1", "--human", "ask")).code,
    ).toBe(1);
    // 答えのない件がある状態で不正なキーを渡しても、記録は変わらない
    await cast(cli, { target: "PRRT_2" });
    expect(
      (await cli("answer", "T01", "--target", "PRRT_2", "--human", "zzz")).code,
    ).toBe(1);
    const rec = (await records()).find((e) => e.target === "PRRT_2");
    expect(rec.human).toBeNull();
  });

  it("答え済みの対象への answer は「答え済み」の文、件がないときは cast を促す文で、上書きしない", async () => {
    const { cli, records } = await setup();
    const none = await cli(
      "answer",
      "T01",
      "--target",
      "PRRT_1",
      "--human",
      "fix",
    );
    expect(none.code).toBe(1);
    expect(none.err).toContain("先に vote cast");
    await cast(cli);
    await cli("answer", "T01", "--target", "PRRT_1", "--human", "fix");
    const again = await cli(
      "answer",
      "T01",
      "--target",
      "PRRT_1",
      "--human",
      "ask",
    );
    expect(again.code).toBe(1);
    expect(again.err).toContain("答え済み");
    expect(again.err).not.toContain("先に vote cast");
    expect((await records())[0].human).toBe("fix");
  });

  it("cast は人の答えを書かない。記録に他人の文章・2票目の理由が入らない", async () => {
    const { cli, file, records } = await setup();
    await cast(cli);
    expect((await records())[0].human).toBeNull();
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("SECRET-TEXT");
    expect(text).not.toContain("REASON");
  });

  it("形の外れた ID は終了コード1", async () => {
    const { cli } = await setup();
    expect(
      (await cli("answer", "../x", "--target", "A", "--human", "fix")).code,
    ).toBe(1);
  });
});

describe("vote stats", () => {
  it("記録から種類ごとの件数と2つの一致の割合を出す", async () => {
    const { cli } = await setup();
    // comment：1票目 fix・2票目 fix・人 fix（2票一致・人も一致）
    await cast(cli, { target: "A", first: "fix" });
    await cli("answer", "T01", "--target", "A", "--human", "fix");
    // 1票目 fix・2票目 fix・人 ask（2票一致・人は違う）
    await cast(cli, { target: "B", first: "fix" });
    await cli("answer", "T01", "--target", "B", "--human", "ask");
    // 1票目 ask・2票目 fix・人 ask（割れた）
    await cast(cli, { target: "C", first: "ask" });
    await cli("answer", "T01", "--target", "C", "--human", "ask");
    // 答え待ち
    await cast(cli, { target: "D", first: "fix" });
    // security：とらなかった
    await cast(cli, { target: "E", kind: "security", first: "fix" });
    await cli("answer", "T01", "--target", "E", "--human", "fix");

    const r = await cli("stats", "--json");
    expect(r.code).toBe(0);
    const { kinds } = JSON.parse(r.out);
    expect(kinds.comment).toMatchObject({
      total: 4,
      answered: 3,
      pending: 1,
      firstAgree: 2,
      voted: 3,
      votedFirstAgree: 2,
      bothAgree: 2,
      bothAgreeHuman: 1,
      split: 1,
    });
    expect(kinds.comment.firstRate).toBeCloseTo(2 / 3);
    expect(kinds.comment.votedFirstRate).toBeCloseTo(2 / 3);
    expect(kinds.comment.bothAgreeRate).toBeCloseTo(1 / 2);
    expect(kinds.security).toMatchObject({
      answered: 1,
      skipped: 1,
      voted: 0,
      bothAgree: 0,
    });
    expect(kinds.security.bothAgreeRate).toBeNull();
    const text = await cli("stats");
    expect(text.code).toBe(0);
    expect(text.out).toContain("comment");
  });

  it("棄権・とらなかった件は「2票が一致」に数えない", async () => {
    const a = await setup({ claude: { key: "unclear" } });
    await cast(a.cli, { target: "A", first: "fix" });
    await a.cli("answer", "T01", "--target", "A", "--human", "fix");
    const { kinds } = JSON.parse((await a.cli("stats", "--json")).out);
    expect(kinds.comment).toMatchObject({
      abstained: 1,
      unclear: 1,
      bothAgree: 0,
      voted: 0,
      split: 0,
    });
  });

  it("記録がなければ空で終了コード0", async () => {
    const { cli } = await setup();
    const r = await cli("stats");
    expect(r.code).toBe(0);
    expect(r.out).toContain("まだありません");
  });
});

describe("vote cast: 材料と対象の読み", () => {
  const stripNonce = (text: string) =>
    text.replace(/⟦(\/?)データ [^⟧]+⟧/g, "⟦$1データ N⟧");

  it("--first が違っても、子に渡る材料は（乱数の区切りを除いて）同じ", async () => {
    const { fake, cli } = await setup();
    await cast(cli, { first: "fix", target: "PRRT_1" });
    await cast(cli, { first: "wontfix", target: "PRRT_2" });
    expect(fake.claudeCalls).toHaveLength(2);
    expect(stripNonce(fake.claudeCalls[0]!.input)).toEqual(
      stripNonce(fake.claudeCalls[1]!.input),
    );
  });

  it("設計書の「書き込んでよい場所」のパスが材料に入る", async () => {
    const { fake, cli } = await setup(
      {},
      {},
      {
        "src/a.ts": "a\n",
        "docs/tasks/T01.md":
          "# タスク T01\n\n## 書き込んでよい場所\n\n- `lib/zzz-allowed/`\n",
      },
    );
    await cast(cli);
    const input = fake.claudeCalls[0]!.input;
    expect(input).toContain("lib/zzz-allowed");
    expect(input).toContain("src/a.ts");
  });

  it("対象が別の PR のものなら、記録せず終了コード1で、他人の文章を出さない", async () => {
    const { fake, cli, records } = await setup({
      node: {
        __typename: "IssueComment",
        body: SECRET,
        author: { login: "bob" },
        pullRequest: { url: "https://github.com/o/r/pull/99", title: "x" },
      },
    });
    const r = await cast(cli);
    expect(r.code).toBe(1);
    expect(r.err).toContain("この PR のものではありません");
    expect(r.out + r.err).not.toContain("SECRET-TEXT");
    expect(await records()).toHaveLength(0);
    expect(fake.claudeCalls).toHaveLength(0);
  });

  it("ID の形の誤り・見つからない対象は、記録せず終了コード1", async () => {
    const a = await setup();
    const bad = await cast(a.cli, { target: "x y" });
    expect(bad.code).toBe(1);
    expect(await a.records()).toHaveLength(0);
    const b = await setup({ apiNotFound: true });
    const nf = await cast(b.cli);
    expect(nf.code).toBe(1);
    expect(nf.err).toContain("見つけられません");
    expect(await b.records()).toHaveLength(0);
  });

  it("gh の読み失敗は棄権（failed）で記録し、claude を呼ばず model は null、原因を標準エラーに出す", async () => {
    const { fake, cli, records } = await setup({ apiFail: true });
    const r = await cast(cli);
    expect(r.code).toBe(0);
    expect(fake.claudeCalls).toHaveLength(0);
    expect(r.err).toContain("読めませんでした");
    const [e] = await records();
    expect(e.second).toEqual({ status: "abstained", why: "failed" });
    expect(e.model).toBeNull();
  });

  it("自分の返信と保留中の下書きしかなければ、2票目をとらず棄権にする", async () => {
    const mine = (body: string, extra = {}) => ({
      body,
      author: { login: "me" },
      ...extra,
    });
    const { fake, cli, records } = await setup({
      node: {
        __typename: "PullRequestReviewThread",
        path: "src/a.ts",
        line: 3,
        pullRequest: { url: PR_URL, title: "t" },
        head: { nodes: [mine("自分の返信 MINE-TEXT", { diffHunk: "h" })] },
        tail: {
          totalCount: 2,
          nodes: [
            mine("自分の返信 MINE-TEXT"),
            {
              body: "下書き DRAFT-TEXT",
              state: "PENDING",
              author: { login: "bob" },
            },
          ],
        },
      },
    });
    const r = await cast(cli);
    expect(r.code).toBe(0);
    expect(fake.claudeCalls).toHaveLength(0);
    const [e] = await records();
    expect(e.second).toEqual({ status: "abstained", why: "failed" });
    expect(e.model).toBeNull();
  });
});

describe("vote stats: 複数タスク", () => {
  it("vote/ の複数の記録を合算し、読めない行を標準エラーで警告する", async () => {
    const { root, cli } = await setup();
    await cast(cli, { target: "A" });
    const dir = `${root}/.git/orca-flow/vote`;
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      at: "2026-01-01T00:00:00.000Z",
      id: "T02",
      target: "Z",
      kind: "comment",
      risk: { level: "normal", reason: "r" },
      first: "fix",
      second: { status: "voted", key: "fix" },
      model: "m",
      human: "fix",
    });
    await writeFile(`${dir}/T02.jsonl`, `${line}\n壊れた行\n`);
    const r = await cli("stats", "--json");
    expect(r.code).toBe(0);
    const { kinds, broken } = JSON.parse(r.out);
    expect(kinds.comment.total).toBe(2);
    expect(broken).toBe(1);
    expect(r.err).toContain("読めない行");
  });
});
