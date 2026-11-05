import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { currentBootAt } from "../../src/lib/lock.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const done = (code: number, stdout = "") => ({
  code,
  stdout,
  stderr: "",
  timedOut: false,
});

const SECRET = "他人の文章 SECRET-TEXT";
const REASON = "理由 REASON-TEXT";
const PR_URL = "https://github.com/o/r/pull/7";

interface Fake {
  /** claude の答え。null なら棄権（unclear） */
  claude: string;
  claudeCalls: number;
}

function ghAnswer(args: readonly string[]) {
  if (args[0] === "repo") return done(0, '{"nameWithOwner":"o/r"}');
  if (args[0] === "pr" && args[1] === "list")
    return done(
      0,
      JSON.stringify([
        {
          number: 7,
          url: PR_URL,
          isDraft: false,
          state: "OPEN",
          headRefOid: "a".repeat(40),
          statusCheckRollup: [],
          isCrossRepository: false,
        },
      ]),
    );
  if (args[0] === "pr" && args[1] === "view")
    return done(0, JSON.stringify({ labels: [] }));
  if (args[0] === "api")
    return done(
      0,
      JSON.stringify({
        data: {
          viewer: { login: "me" },
          node: {
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
}

async function setup(claude = "fix", config: Record<string, unknown> = {}) {
  const root = await makeRepo(config);
  const task = await addTaskWorktree(root, "T01", "x", { "src/a.ts": "a\n" });
  const fake: Fake = { claude, claudeCalls: 0 };
  const orca = fakeOrca();
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "gh") return ghAnswer(args);
    if (cmd === "claude") {
      fake.claudeCalls++;
      return done(
        0,
        JSON.stringify({
          result: "",
          structured_output: { key: fake.claude, reason: REASON },
        }),
      );
    }
    return orca.runner(cmd, args, opts);
  };
  const cli = (...argv: string[]) =>
    runCli(["vote", ...argv], { cwd: root, runner });
  const inTask = (...argv: string[]) =>
    runCli(["vote", ...argv], { cwd: task.path, runner });
  const dir = `${root}/.git/orca-flow`;
  const autoFile = `${dir}/vote-auto.json`;
  const readAuto = async () => JSON.parse(await readFile(autoFile, "utf8"));
  const records = async () =>
    (await readFile(`${dir}/vote/T01.jsonl`, "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
  /** 2票が一致して人が答えた過去の件を置く（miss 件は人の答えが違う） */
  const seed = async (agreed: number, miss = 0) => {
    await mkdir(`${dir}/vote`, { recursive: true });
    const lines = Array.from({ length: agreed }, (_, i) =>
      JSON.stringify({
        at: "2026-01-01T00:00:00.000Z",
        id: "T90",
        target: `OLD_${i}`,
        kind: "comment",
        risk: { level: "normal", reason: "" },
        first: "fix",
        second: { status: "voted", key: "fix" },
        model: "claude-sonnet-5-5",
        human: i < miss ? "wontfix" : "fix",
      }),
    );
    await writeFile(`${dir}/vote/T90.jsonl`, lines.join("\n") + "\n");
  };
  return { root, fake, cli, inTask, autoFile, readAuto, records, seed, dir };
}

type Env = Awaited<ReturnType<typeof setup>>;

const cast = (
  env: Env,
  target = "PRRT_1",
  over: { kind?: string; first?: string } = {},
) =>
  env.cli(
    "cast",
    "T01",
    "--target",
    target,
    "--kind",
    over.kind ?? "comment",
    "--first",
    over.first ?? "fix",
  );

const answer = (env: Env, human: string, target = "PRRT_1") =>
  env.cli("answer", "T01", "--target", target, "--human", human);

/** 数を満たして入れた状態にする */
async function turnedOn(claude = "fix") {
  const env = await setup(claude);
  await env.seed(20);
  expect((await env.cli("auto", "on", "comment")).code).toBe(0);
  return env;
}

describe("vote auto: 入れる・切る", () => {
  it("引数なしは状態と数を出し、何も作らない", async () => {
    const env = await setup();
    await env.seed(3);
    const r = await env.cli("auto");
    expect(r.code).toBe(0);
    expect(r.out).toContain("comment：切");
    expect(r.out).toContain("3（20 以上）");
    await expect(readFile(env.autoFile, "utf8")).rejects.toThrow();
  });

  it("数を満たさないと終了コード1で、状態を変えない", async () => {
    const env = await setup();
    await env.seed(19);
    const r = await env.cli("auto", "on", "comment");
    expect(r.code).toBe(1);
    expect(r.err).toContain("19");
    await expect(readFile(env.autoFile, "utf8")).rejects.toThrow();
  });

  it("一致が95%に届かないと入れない（20件で2件の外れ）", async () => {
    const env = await setup();
    await env.seed(20, 2);
    expect((await env.cli("auto", "on", "comment")).code).toBe(1);
    await env.seed(20, 1);
    expect((await env.cli("auto", "on", "comment")).code).toBe(0);
  });

  it("タスクの worktree では終了コード2で、状態を変えない", async () => {
    const env = await setup();
    await env.seed(20);
    expect((await env.inTask("auto", "on", "comment")).code).toBe(2);
    await expect(readFile(env.autoFile, "utf8")).rejects.toThrow();
  });

  it("comment 以外の種類・知らない種類は終了コード1", async () => {
    const env = await setup();
    await env.seed(20);
    const security = await env.cli("auto", "on", "security");
    expect(security.code).toBe(1);
    expect(security.err).toContain("自動で決められません");
    await expect(readFile(env.autoFile, "utf8")).rejects.toThrow();
    expect((await env.cli("auto", "on", "foo")).code).toBe(1);
    expect((await env.cli("auto", "on")).code).toBe(1);
  });

  it("入れて、off はどこからでも切れる", async () => {
    const env = await turnedOn();
    expect((await env.readAuto()).kinds.comment.on).toBe(true);
    const r = await env.inTask("auto", "off", "comment");
    expect(r.code).toBe(0);
    const state = (await env.readAuto()).kinds.comment;
    expect(state.on).toBe(false);
    expect(state.why).toBe("human");
  });

  it("記録がないときの off は何も作らない", async () => {
    const env = await setup();
    expect((await env.cli("auto", "off", "comment")).code).toBe(0);
    await expect(readFile(env.autoFile, "utf8")).rejects.toThrow();
  });
});

describe("vote cast: 自動で決める", () => {
  it("自動の記録がないと、2票が一致しても自動で決めず、記録も作らない", async () => {
    const env = await setup();
    await env.seed(20);
    const r = await cast(env);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("自動で決めました");
    await expect(readFile(env.autoFile, "utf8")).rejects.toThrow();
  });

  it("入れてあり数を満たすと、2票が一致した件を自動で決める", async () => {
    const env = await turnedOn();
    const r = await cast(env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("自動で決めました（fix）");
    const [item] = (await env.readAuto()).items;
    expect(item).toMatchObject({
      id: "T01",
      target: "PRRT_1",
      kind: "comment",
      key: "fix",
      human: null,
    });
    const text = await readFile(env.autoFile, "utf8");
    expect(text).not.toContain("SECRET-TEXT");
    expect(text).not.toContain("REASON-TEXT");
  });

  it("割れた・棄権・とらなかったときは自動で決めず、2票目の答えも出さない", async () => {
    const env = await turnedOn("wontfix");
    const split = await cast(env, "PRRT_1");
    expect(split.out + split.err).not.toContain("自動で決めました");
    expect(split.out + split.err).not.toContain("wontfix");
    expect(split.out + split.err).not.toContain("割れ");
    env.fake.claude = "unclear";
    const abstain = await cast(env, "PRRT_2");
    expect(abstain.out).not.toContain("自動で決めました");
    const skipped = await cast(env, "PRRT_3", { kind: "security" });
    expect(skipped.out).not.toContain("自動で決めました");
    expect((await env.readAuto()).items).toEqual([]);
  });

  it("リスク区分が high で2票目をとらなかった cast は、入っていて数を満たしても自動で決めない", async () => {
    const env = await setup("fix", { risk: { paths: ["src/"], labels: [] } });
    await env.seed(20);
    expect((await env.cli("auto", "on", "comment")).code).toBe(0);
    const r = await cast(env);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("自動で決めました");
    expect(env.fake.claudeCalls).toBe(0);
    expect((await env.readAuto()).items).toEqual([]);
  });

  it("人が答える前に同じ対象へ cast し直しても、自動の件は1つのまま", async () => {
    const env = await turnedOn();
    await cast(env);
    await cast(env);
    expect((await env.readAuto()).items).toHaveLength(1);
    expect(await env.records()).toHaveLength(1);
  });

  it("やり直しで割れたら、前の自動の件を消して人に回す", async () => {
    const env = await turnedOn();
    await cast(env);
    env.fake.claude = "wontfix";
    const r = await cast(env);
    expect(r.out).not.toContain("自動で決めました");
    expect((await env.readAuto()).items).toEqual([]);
  });

  it("やり直しで別のキーで一致したら、件は1つで新しいキーになる", async () => {
    const env = await turnedOn();
    await cast(env);
    env.fake.claude = "wontfix";
    const r = await cast(env, "PRRT_1", { first: "wontfix" });
    expect(r.out).toContain("自動で決めました（wontfix）");
    const { items } = await env.readAuto();
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("wontfix");
  });

  it("確かめ待ちの自動の件が5件あると、6件目は自動で決めない", async () => {
    const env = await turnedOn();
    for (let i = 1; i <= 5; i++)
      expect((await cast(env, `PRRT_${i}`)).out).toContain("自動で決めました");
    const sixth = await cast(env, "PRRT_6");
    expect(sixth.out).not.toContain("自動で決めました");
    // 5件のうち1件を人が確かめると、また決められる
    await answer(env, "fix", "PRRT_1");
    expect((await cast(env, "PRRT_7")).out).toContain("自動で決めました");
  });

  it("入れた後に数を割ると、自動で決めない", async () => {
    const env = await turnedOn();
    await env.seed(10);
    const r = await cast(env);
    expect(r.out).not.toContain("自動で決めました");
  });
});

describe("vote answer: 外れ", () => {
  it("違うキーなら答えを記録し、その種類を切り、次の cast は自動で決めない", async () => {
    const env = await turnedOn();
    await cast(env);
    const r = await answer(env, "wontfix");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "自動で決めた件が外れたので、comment の自動を切りました",
    );
    expect((await env.records())[0].human).toBe("wontfix");
    const state = await env.readAuto();
    expect(state.kinds.comment).toMatchObject({ on: false, why: "miss" });
    expect(state.items[0].human).toBe("wontfix");
    const next = await cast(env, "PRRT_2");
    expect(next.out).not.toContain("自動で決めました");
  });

  it("同じキーなら切れず、確かめた件に数える", async () => {
    const env = await turnedOn();
    await cast(env);
    const r = await answer(env, "fix");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("切りました");
    const state = await env.readAuto();
    expect(state.kinds.comment.on).toBe(true);
    expect(state.items[0].human).toBe("fix");
  });

  it("自動でない件の答えは自動の記録を変えない", async () => {
    const env = await turnedOn();
    env.fake.claude = "wontfix";
    await cast(env);
    const before = await readFile(env.autoFile, "utf8");
    expect((await answer(env, "ask")).code).toBe(0);
    expect(await readFile(env.autoFile, "utf8")).toBe(before);
  });
});

describe("vote answer: 自動の記録に反映できなかったとき", () => {
  it("答えは記録して終了コード1で知らせ、流し直すと答え済みでも外れで切れる", async () => {
    const env = await turnedOn();
    await cast(env);
    const lock = `${env.dir}/vote-auto.lock`;
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    const failed = await answer(env, "wontfix");
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("自動の記録に反映できませんでした");
    expect(failed.err).toContain("もう一度流してください");
    expect((await env.records())[0].human).toBe("wontfix");
    expect((await env.readAuto()).items[0].human).toBeNull();
    await rm(lock);

    const again = await answer(env, "wontfix");
    expect(again.code).toBe(1);
    expect(again.err).toContain("答え済み");
    expect(again.out).toContain(
      "自動で決めた件が外れたので、comment の自動を切りました",
    );
    const state = await env.readAuto();
    expect(state.items[0].human).toBe("wontfix");
    expect(state.kinds.comment).toMatchObject({ on: false, why: "miss" });
  });

  it("答え済みの流し直しは、別のキーを渡しても記録済みの答えで反映する", async () => {
    const env = await turnedOn();
    await cast(env);
    const lock = `${env.dir}/vote-auto.lock`;
    await writeFile(lock, `${process.pid} ${currentBootAt()}\n`);
    await answer(env, "wontfix");
    await rm(lock);
    await answer(env, "fix");
    expect((await env.readAuto()).items[0].human).toBe("wontfix");
  });
});

describe("vote auto: 確かめ待ちの一覧", () => {
  it("確かめ待ちの件を、タスク・対象・キー・時刻で並べ、確かめた件と他人の文章は出さない", async () => {
    const env = await turnedOn();
    await cast(env, "PRRT_1");
    await cast(env, "PRRT_2");
    await answer(env, "fix", "PRRT_1");
    const r = await env.cli("auto");
    const at = (await env.readAuto()).items[1].at;
    expect(r.out).toContain("確かめ待ち 1");
    expect(r.out).toContain(`  確かめ待ち：T01 PRRT_2 fix ${at}`);
    expect(r.out).not.toContain("PRRT_1");
    expect(r.out + r.err).not.toContain("SECRET-TEXT");
    expect(r.out + r.err).not.toContain("REASON-TEXT");
    const j = JSON.parse((await env.cli("auto", "--json")).out);
    expect(j.waiting).toEqual([
      { id: "T01", target: "PRRT_2", kind: "comment", key: "fix", at },
    ]);
  });
});

describe("vote stats: 自動", () => {
  it("種類ごとの自動の件数・確かめた件数・外れた件数・状態が出る", async () => {
    const env = await turnedOn();
    await cast(env, "PRRT_1");
    await cast(env, "PRRT_2");
    await answer(env, "fix", "PRRT_1");
    await answer(env, "ask", "PRRT_2");
    const r = await env.cli("stats");
    expect(r.out).toContain(
      "自動：切（外れで切れた）（自動で決めた 2・確かめた 2・外れた 1）",
    );
    const j = JSON.parse((await env.cli("stats", "--json")).out);
    expect(j.auto.comment).toMatchObject({
      on: false,
      why: "miss",
      total: 2,
      checked: 2,
      missed: 1,
    });
  });

  it("合議の記録の行の形は今のまま", async () => {
    const env = await turnedOn();
    await cast(env);
    const [e] = await env.records();
    expect(Object.keys(e).sort()).toEqual(
      [
        "at",
        "id",
        "target",
        "kind",
        "risk",
        "first",
        "second",
        "model",
        "human",
      ].sort(),
    );
  });
});
