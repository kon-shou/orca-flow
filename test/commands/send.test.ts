import { readFile, writeFile } from "node:fs/promises";
import { readPushRecord } from "../../src/lib/finish.ts";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSend } from "../../src/commands/send.ts";
import { CARD_RESET } from "../../src/lib/pr-finish.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { newRecord, writeAuto } from "../../src/lib/auto.ts";
import {
  readItem,
  readItems,
  withOutboxLock,
  writeItem,
} from "../../src/lib/outbox.ts";
import type { Clock } from "../../src/lib/send-guard.ts";
import type { CommandContext } from "../../src/types.ts";
import { claudeScreen, fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo, tempDir } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const done = (code: number, stdout = "", stderr = "") => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

/** gh と git push だけを偽物にし、ほかの git は本物に回す */
function harness(
  options: {
    onPush?: () => Promise<void>;
    /** gh を呼ぶたびに呼ばれる（照らしのあと push の前に何かを起こすため） */
    onGh?: (args: readonly string[]) => Promise<void>;
    failOn?: (args: readonly string[]) => boolean;
    /** git push が断られたときの stderr */
    pushStderr?: string;
    /** gh pr list が返す PR の番号（既定は 7） */
    prs?: number[];
    /** gh pr create が作る PR の番号（既定は 7） */
    created?: number;
  } = {},
) {
  const calls: string[][] = [];
  const bodies: string[] = [];
  const orca = fakeOrca();
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "gh") {
      calls.push([cmd, ...args]);
      await options.onGh?.(args);
      if (options.failOn?.(args)) return done(1, "", "boom");
      if (args[0] === "--version" || args[0] === "auth") return done(0, "ok");
      if (args[0] === "pr" && args[1] === "create") {
        const i = args.indexOf("--body-file");
        bodies.push(await readFile(args[i + 1]!, "utf8"));
        return done(0, `https://github.com/o/r/pull/${options.created ?? 7}\n`);
      }
      if (args[0] === "pr" && args[1] === "list")
        return done(
          0,
          JSON.stringify(
            (options.prs ?? [7]).map((number) => ({
              number,
              url: `https://github.com/o/r/pull/${number}`,
              isDraft: true,
              state: "OPEN",
              headRefOid: "a".repeat(40),
              statusCheckRollup: [],
              isCrossRepository: false,
            })),
          ),
        );
      return done(0);
    }
    if (cmd === "git" && args[0] === "push") {
      calls.push([cmd, ...args]);
      await options.onPush?.();
      return options.pushStderr !== undefined
        ? done(1, "", options.pushStderr)
        : options.failOn?.(args)
          ? done(1, "", "rejected")
          : done(0);
    }
    return orca.runner(cmd, args, opts);
  };
  return { runner, calls, bodies, orca };
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { clock, sleeps };
}

async function setup(outbound: Record<string, unknown> = {}) {
  const root = await makeRepo({
    outbound: { interval: { seconds: 3, perBatch: 5 }, ...outbound },
  });
  const task = await addTaskWorktree(root, "T01", "x", { "a.txt": "a\n" });
  return { root, task, common: path.join(root, ".git") };
}

const bodyFile = async (text: string) => {
  const file = path.join(await tempDir(), "body.md");
  await writeFile(file, text);
  return file;
};

const add = async (root: string, kind: string, extra: string[] = []) => {
  const added = await runCli(["outbox", "add", "T01", kind, ...extra], {
    cwd: root,
    runner: fakeOrca().runner,
  });
  expect(added.code).toBe(0);
  return added;
};

/** outbox show --json の値（束の指紋と先頭）をそのまま使う */
async function showJson(root: string) {
  const shown = await runCli(["outbox", "show", "T01", "--json"], {
    cwd: root,
    runner: fakeOrca().runner,
  });
  expect(shown.code).toBe(0);
  return JSON.parse(shown.out) as {
    bundleFingerprint: string;
    head: string;
    items: { id: string }[];
    rest: string[];
    uncertain: string[];
  };
}

async function shown(root: string) {
  const v = await showJson(root);
  return { expect: v.bundleFingerprint, head: v.head };
}

async function send(
  cwd: string,
  argv: string[],
  h: ReturnType<typeof harness>,
  clock?: Clock,
  env: NodeJS.ProcessEnv = {},
  json = false,
) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    argv,
    cwd,
    json,
    runner: h.runner,
    env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => new Date("2026-11-03T00:00:00Z"),
  };
  try {
    const result = await createSend({
      clock,
    })(ctx);
    return {
      code: result.code,
      out: out.join("\n"),
      err: err.join("\n"),
      data: result.data as Record<string, unknown> | undefined,
    };
  } catch (error) {
    const e = error as { code?: number; message: string };
    return {
      code: e.code ?? 1,
      out: out.join("\n"),
      err: e.message,
      data: undefined,
    };
  }
}

const fullArgs = (v: { expect: string; head: string }) => [
  "T01",
  "--expect",
  v.expect,
  "--head",
  v.head,
];

describe("send", () => {
  it("--expect と --head がない、または違うと、GitHub を呼ばず終了コード1", async () => {
    const { root, common, task } = await setup();
    await add(root, "push");
    const v = await shown(root);
    const h = harness();
    for (const argv of [
      ["T01"],
      ["T01", "--expect", v.expect],
      ["T01", "--head", v.head],
    ]) {
      const out = await send(root, argv, h);
      expect(out.code).toBe(1);
      expect(out.err).toContain("使い方");
    }
    const wrongExpect = await send(
      root,
      fullArgs({ ...v, expect: "0".repeat(64) }),
      h,
    );
    expect(wrongExpect.code).toBe(1);
    expect(wrongExpect.err).toContain("束の指紋が違います");
    const wrongHead = await send(
      root,
      fullArgs({ ...v, head: "1".repeat(40) }),
      h,
    );
    expect(wrongHead.code).toBe(1);
    expect(wrongHead.err).toContain("先頭が違います");
    expect(h.calls).toEqual([]);
  });

  it("見せたあとに本文か先頭が変わると送らない", async () => {
    const { root, common, task } = await setup();
    await add(root, "pr-create", ["--body-file", await bodyFile("元\n")]);
    const v = await shown(root);
    const item = (await readItem(common, "T01", "pr-create-v1"))!;
    await writeItem(common, { ...item, body: "書き換え\n" });
    const h = harness();
    const changed = await send(root, fullArgs(v), h);
    expect(changed.code).toBe(1);
    expect(changed.err).toContain("束の指紋が違います");
    expect(h.calls).toEqual([]);

    // 先頭が動いた
    await writeItem(common, item);
    await writeFile(path.join(task.path, "b.txt"), "b\n");
    await git(task.path, "add", "-A");
    await git(task.path, "commit", "--quiet", "-m", "T01: 足す");
    const moved = await send(root, fullArgs(v), h);
    expect(moved.code).toBe(1);
    expect(moved.err).toContain("先頭が違います");
    expect(h.calls).toEqual([]);
  });

  it("見せたあとに足した案と、先頭の件数の外は送らない", async () => {
    const { root, common, task } = await setup({
      interval: { seconds: 1, perBatch: 2 },
    });
    await add(root, "push");
    await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
    await add(root, "pr-ready", ["--pr", "7"]);
    const v = await shown(root);
    const h = harness();
    const { clock } = fakeClock();
    const out = await send(root, fullArgs(v), h, clock, {}, true);
    expect(out.code).toBe(0);
    // うまく終わったとき、範囲の外で積んだままの案を伝える
    expect(out.data?.rest).toEqual(["pr-ready-v1"]);
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("sent");
    expect((await readItem(common, "T01", "pr-create-v1"))!.state).toBe("sent");
    expect((await readItem(common, "T01", "pr-ready-v1"))!.state).toBe(
      "queued",
    );
    expect(h.calls.some((c) => c[1] === "pr" && c[2] === "ready")).toBe(false);

    // 見せたあとに足した案は、束の指紋が変わるので送らない
    const h2 = harness();
    const v2 = await shown(root);
    await add(root, "push");
    const extra = await send(root, fullArgs(v2), h2, clock);
    expect(extra.code).toBe(1);
    expect(extra.err).toContain("束の指紋が違います");
    expect(h2.calls).toEqual([]);
  });

  it("push は承認した SHA を明示して呼ばれ、照らしのあとに動いた先頭は送られない", async () => {
    const { root, task } = await setup();
    await add(root, "push");
    const v = await shown(root);
    let moved = false;
    const h = harness({
      // 照らし（checkSendEntry）を通ったあと、push の前に、ブランチにコミットを足す
      onGh: async (args) => {
        if (moved || args[0] !== "auth") return;
        moved = true;
        await writeFile(path.join(task.path, "c.txt"), "c\n");
        await git(task.path, "add", "-A");
        await git(task.path, "commit", "--quiet", "-m", "T01: 動く");
      },
    });
    const out = await send(root, fullArgs(v), h, fakeClock().clock);
    expect(out.code).toBe(0);
    expect(moved).toBe(true);
    const pushes = h.calls.filter((c) => c[0] === "git");
    expect(pushes).toEqual([
      ["git", "push", "origin", `${v.head}:refs/heads/${task.branch}`],
    ]);
    expect(await git(task.path, "rev-parse", "HEAD")).not.toBe(v.head);
  });

  it("push → PR の作成 → 下書きを外す の順。同じ案の2回目は送らない", async () => {
    const { root, common, task } = await setup();
    await add(root, "pr-ready", ["--pr", "7"]);
    await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
    await add(root, "push");
    const v = await shown(root);
    const h = harness();
    const { clock } = fakeClock();
    expect((await send(root, fullArgs(v), h, clock)).code).toBe(0);
    expect(
      h.calls
        .filter((c) => c[0] === "git" || c[2] === "create" || c[2] === "ready")
        .map((c) => (c[0] === "git" ? "push" : c[2])),
    ).toEqual(["push", "create", "ready"]);
    const count = h.calls.length;
    expect((await send(root, fullArgs(v), h, clock)).code).toBe(1);
    expect(h.calls.length).toBe(count);
  });

  it("pr-ready の PR 番号がタスクのブランチの PR と違えば、送らなかったになり下書きを外さない", async () => {
    const { root, common } = await setup();
    await add(root, "pr-ready", ["--pr", "8"]);
    const v = await shown(root);
    const h = harness({ prs: [7] });
    const out = await send(root, fullArgs(v), h, fakeClock().clock);
    expect(out.code).toBe(1);
    expect(out.err).toContain("送らなかった");
    expect(h.calls.some((c) => c[1] === "pr" && c[2] === "ready")).toBe(false);
    expect((await readItem(common, "T01", "pr-ready-v1"))!.state).toBe(
      "skipped",
    );
  });

  it("途中の1件が落ちると残りは呼ばれず、確かでない案は打ち直しても送らない", async () => {
    const { root, common, task } = await setup();
    await add(root, "push");
    await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
    await add(root, "pr-ready", ["--pr", "7"]);
    const v = await shown(root);
    const h = harness({
      failOn: (args) => args[0] === "pr" && args[1] === "create",
    });
    const { clock } = fakeClock();
    const out = await send(root, fullArgs(v), h, clock);
    expect(out.code).toBe(1);
    expect(out.err).toContain("確かでない");
    expect(out.err).toContain("pr-ready-v1");
    expect(h.calls.some((c) => c[2] === "ready")).toBe(false);
    const states = Object.fromEntries(
      (await readItems(common, "T01")).map((i) => [i.id, i.state]),
    );
    expect(states).toEqual({
      "push-v1": "sent",
      "pr-create-v1": "uncertain",
      "pr-ready-v1": "queued",
    });
    // push は通っているので、記録の pushedHead は送った先頭
    expect((await readPushRecord(testRunner, root, "T01"))?.pushedHead).toBe(
      v.head,
    );

    // 打ち直しても、確かでない pr-create は送らない（残りの pr-ready だけが束になる）
    const before = h.calls.filter((c) => c[2] === "create").length;
    const v2 = await shown(root);
    await send(root, fullArgs(v2), h, clock);
    expect(h.calls.filter((c) => c[2] === "create").length).toBe(before);
    expect((await readItem(common, "T01", "pr-create-v1"))!.state).toBe(
      "uncertain",
    );
  });

  it("許可リストにない種類の案は送らない", async () => {
    const { root, common, task } = await setup({ allow: ["push"] });
    await add(root, "push");
    await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
    const v = await shown(root);
    const h = harness();
    const out = await send(root, fullArgs(v), h);
    expect(out.code).toBe(1);
    expect(out.err).toContain("許可リスト");
    expect(h.calls).toEqual([]);
  });

  it("送る関数に渡る本文に秘密の元の値がない", async () => {
    const { root, common, task } = await setup();
    await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
    const item = (await readItem(common, "T01", "pr-create-v1"))!;
    const secret = "my-very-secret-value-1234";
    await writeItem(common, { ...item, body: `token ${secret}\n` });
    const v = await shown(root);
    const h = harness();
    const out = await send(root, fullArgs(v), h, fakeClock().clock, {
      GH_TOKEN: secret,
    });
    expect(out.code).toBe(0);
    expect(h.bodies).toHaveLength(1);
    expect(h.bodies[0]).not.toContain(secret);
  });

  it("おまかせの印があっても、積んだだけでは GitHub を呼ばず、send を打つまで送られない", async () => {
    const { root, common } = await setup();
    await writeAuto(common, newRecord("T01", new Date("2026-11-03T00:00:00Z")));
    const h = harness();
    const added = await runCli(["outbox", "add", "T01", "push"], {
      cwd: root,
      runner: h.runner,
    });
    expect(added.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("queued");

    const out = await send(
      root,
      fullArgs(await shown(root)),
      h,
      fakeClock().clock,
    );
    expect(out.code).toBe(0);
    expect(h.calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(true);
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("sent");
  });

  it("書き込みの間が outbound.interval.seconds 空く", async () => {
    const { root, common, task } = await setup();
    await add(root, "push");
    await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
    await add(root, "pr-ready", ["--pr", "7"]);
    const v = await shown(root);
    const { clock, sleeps } = fakeClock();
    expect((await send(root, fullArgs(v), harness(), clock)).code).toBe(0);
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("時間帯の外でも送る", async () => {
    const { root, common, task } = await setup({
      window: { days: [], from: "09:00", to: "09:00" },
    });
    await add(root, "push");
    const v = await shown(root);
    const h = harness();
    expect((await send(root, fullArgs(v), h, fakeClock().clock)).code).toBe(0);
    expect(h.calls.some((c) => c[0] === "git")).toBe(true);
  });

  it("CI のあとに外す pr-ready は送らず、承認済み・CI 待ちにする", async () => {
    const { root, common, task } = await setup();
    await add(root, "pr-ready", ["--pr", "7", "--after-ci"]);
    const v = await shown(root);
    const h = harness();
    expect((await send(root, fullArgs(v), h, fakeClock().clock)).code).toBe(0);
    expect(h.calls.some((c) => c[2] === "ready")).toBe(false);
    const item = (await readItem(common, "T01", "pr-ready-v1"))!;
    expect(item.state).toBe("ci-wait");
    expect(item.approvedHead).toBe(v.head);
  });

  it("メインのチェックアウトの外では終了コード2", async () => {
    const { root, common, task } = await setup();
    await add(root, "push");
    const v = await shown(root);
    const h = harness();
    const out = await send(task.path, fullArgs(v), h);
    expect(out.code).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it("6件積むと既定の5件だけ送られ、残りは積んだまま", async () => {
    // 既定の perBatch（5）のまま。config に perBatch を書かない
    const root = await makeRepo({ outbound: { interval: { seconds: 1 } } });
    await addTaskWorktree(root, "T01", "x", { "a.txt": "a\n" });
    const common = path.join(root, ".git");
    await add(root, "pr-ready", ["--pr", "7"]);
    const first = (await readItem(common, "T01", "pr-ready-v1"))!;
    for (let n = 2; n <= 6; n++)
      await writeItem(common, { ...first, id: `pr-ready-v${n}`, version: n });
    const shownSet = await showJson(root);
    expect(shownSet.items).toHaveLength(5);
    expect(shownSet.rest).toEqual(["pr-ready-v6"]);

    const h = harness();
    const out = await send(
      root,
      fullArgs({
        expect: shownSet.bundleFingerprint,
        head: shownSet.head,
      }),
      h,
      fakeClock().clock,
    );
    expect(out.code).toBe(0);
    // 5件を越えて積んだままの案を伝える
    expect(out.out).toContain("pr-ready-v6");
    const states = (await readItems(common, "T01")).map((i) => i.state);
    expect(states.filter((x) => x === "sent")).toHaveLength(5);
    expect(states.filter((x) => x === "queued")).toHaveLength(1);
    expect((await readItem(common, "T01", "pr-ready-v6"))!.state).toBe(
      "queued",
    );
  });

  it("「送っている」のまま残った案は、send を打ち直しても送られず、確かでない側に出る", async () => {
    const { root, common } = await setup();
    await add(root, "push");
    const push = (await readItem(common, "T01", "push-v1"))!;
    await writeItem(common, { ...push, state: "sending" });
    await add(root, "pr-ready", ["--pr", "7"]);
    const before = await showJson(root);
    expect(before.items.map((i) => i.id)).toEqual(["pr-ready-v1"]);
    expect(before.uncertain).toEqual(["push-v1"]);

    const h = harness();
    const out = await send(
      root,
      fullArgs({ expect: before.bundleFingerprint, head: before.head }),
      h,
      fakeClock().clock,
    );
    expect(out.code).toBe(0);
    expect(h.calls.some((c) => c[0] === "git")).toBe(false);
    expect(out.out).toContain("送ったか確かでない");
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("sending");
    expect((await showJson(root)).uncertain).toEqual(["push-v1"]);
  });

  it("push が断られたら送らなかったになり、残りは送らない", async () => {
    const { root, common } = await setup();
    await add(root, "push");
    await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
    const v = await shown(root);
    const h = harness({
      pushStderr: "! [rejected] x -> x (non-fast-forward)",
    });
    const out = await send(root, fullArgs(v), h, fakeClock().clock);
    expect(out.code).toBe(1);
    expect(out.err).toContain("送らなかった");
    expect(out.err).toContain("pr-create-v1");
    expect(h.calls.some((c) => c[2] === "create")).toBe(false);
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("skipped");
    expect((await readItem(common, "T01", "pr-create-v1"))!.state).toBe(
      "queued",
    );
  });

  it("案の送り先（ブランチ）が今のタスクと違えば止まる", async () => {
    const { root, common } = await setup();
    await add(root, "push");
    const item = (await readItem(common, "T01", "push-v1"))!;
    await writeItem(common, {
      ...item,
      target: { ...item.target, branch: "task/T99-other" },
    });
    const v = await shown(root);
    const h = harness();
    const out = await send(root, fullArgs(v), h, fakeClock().clock);
    expect(out.code).toBe(1);
    expect(out.err).toContain("送り先が今のタスクと違います");
    expect(h.calls).toEqual([]);
  });

  it("ほかの send がロックを持っていると終了コード2で、何も送らない", async () => {
    const { root, common } = await setup();
    await add(root, "push");
    const v = await shown(root);
    const h = harness();
    const out = await withOutboxLock(common, () =>
      send(root, fullArgs(v), h, fakeClock().clock),
    );
    expect(out.code).toBe(2);
    expect(out.err).toContain("ほかの send が動いています");
    expect(h.calls.some((c) => c[0] === "git")).toBe(false);
    expect((await readItem(common, "T01", "push-v1"))!.state).toBe("queued");
  });

  describe("送ったあと", () => {
    const readyArgs = (h: ReturnType<typeof harness>) =>
      h.orca.callsOf("worktree", "set").filter((c) => c.includes("--pr"));

    it("push を送ると記録に先頭が、PR を作ると番号が書かれ、PR とカードが結ばれて CI 待ちになり、待ち受けが起きる", async () => {
      const { root, task } = await setup();
      await add(root, "push");
      await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
      const v = await shown(root);
      const h = harness();
      const out = await send(root, fullArgs(v), h, fakeClock().clock);
      expect(out.code).toBe(0);
      const record = await readPushRecord(testRunner, root, "T01");
      expect(record?.pushedHead).toBe(v.head);
      expect(record?.branch).toBe(task.branch);
      expect(record?.pr).toEqual({
        number: 7,
        url: "https://github.com/o/r/pull/7",
      });
      expect(readyArgs(h)).toEqual([
        ["worktree", "set", "--worktree", `path:${task.path}`, "--pr", "7"],
      ]);
      const cards = h.orca
        .callsOf("worktree", "set")
        .filter((c) => c.includes("--comment"));
      expect(cards).toHaveLength(1);
      expect(cards[0]![cards[0]!.indexOf("--comment") + 1]).toBe(
        "CI 待ち：PR #7",
      );
      expect(cards[0]).toContain("--read");
      // 送ったあとに背景の待ち受けは起こさない（見張りが見る）
      expect(h.orca.launches).toEqual([]);
    });

    it("PR の作成のあとの案が落ちても、記録に先頭と番号が残り、PR とカードは結ばれる。終了コードは1のまま", async () => {
      const { root } = await setup();
      await add(root, "push");
      await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
      await add(root, "pr-ready", ["--pr", "7"]);
      const v = await shown(root);
      const h = harness({
        failOn: (args) => args[0] === "pr" && args[1] === "ready",
      });
      const out = await send(root, fullArgs(v), h, fakeClock().clock);
      expect(out.code).toBe(1);
      const record = await readPushRecord(testRunner, root, "T01");
      expect(record?.pushedHead).toBe(v.head);
      expect(record?.pr?.number).toBe(7);
      expect(readyArgs(h)).toHaveLength(1);
      // 送ったあとに背景の待ち受けは起こさない（見張りが見る）
      expect(h.orca.launches).toEqual([]);
      expect(h.orca.callsOf("terminal", "close")).toEqual([]);
    });

    it("作った PR の番号が一覧の番号と違っても、作った番号が記録と結び付けに使われる", async () => {
      const { root, task } = await setup();
      await add(root, "push");
      await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
      const v = await shown(root);
      const h = harness({ created: 42, prs: [9] });
      const out = await send(root, fullArgs(v), h, fakeClock().clock);
      expect(out.code).toBe(0);
      expect(out.data?.pr).toEqual({
        number: 42,
        url: "https://github.com/o/r/pull/42",
      });
      expect((await readPushRecord(testRunner, root, "T01"))?.pr?.number).toBe(
        42,
      );
      expect(readyArgs(h)).toEqual([
        ["worktree", "set", "--worktree", `path:${task.path}`, "--pr", "42"],
      ]);
    });

    it("PR を結んだら、動いている待ち受けにカードの書き直しを頼む印を記録に置く", async () => {
      const { root } = await setup();
      await add(root, "push");
      await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
      const v = await shown(root);
      const h = harness();
      expect((await send(root, fullArgs(v), h, fakeClock().clock)).code).toBe(
        0,
      );
      const record = await readPushRecord(testRunner, root, "T01");
      expect(record?.watch).toMatchObject({
        status: "ci-wait",
        reason: CARD_RESET,
      });
    });

    it("push が断られて何も送れなければ、記録も Orca も触らない", async () => {
      const { root } = await setup();
      await add(root, "push");
      const v = await shown(root);
      const h = harness({ pushStderr: "! [rejected] x (non-fast-forward)" });
      const out = await send(root, fullArgs(v), h, fakeClock().clock);
      expect(out.code).toBe(1);
      expect(await readPushRecord(testRunner, root, "T01")).toBeNull();
      expect(h.orca.calls).toEqual([]);
      expect(h.orca.launches).toEqual([]);
    });

    it("Orca が落ちていても send は終了コード0で、警告だけ出る", async () => {
      const { root } = await setup();
      await add(root, "push");
      await add(root, "pr-create", ["--body-file", await bodyFile("本文\n")]);
      const v = await shown(root);
      const h = harness();
      h.orca.unavailable = true;
      const err: string[] = [];
      const ctxOut = await (async () => {
        const ctx: CommandContext = {
          argv: fullArgs(v),
          cwd: root,
          json: false,
          runner: h.runner,
          env: {},
          stdout: () => {},
          stderr: (t) => err.push(t),
          now: () => new Date("2026-11-03T00:00:00Z"),
        };
        return createSend({
          clock: fakeClock().clock,
        })(ctx);
      })();
      expect(ctxOut.code).toBe(0);
      expect(err.join("\n")).toContain("警告");
      expect(err.join("\n")).toContain("PR #7");
      // 記録は書かれる
      expect((await readPushRecord(testRunner, root, "T01"))?.pr?.number).toBe(
        7,
      );
      // 送ったあとに背景の待ち受けは起こさない（見張りが見る）
      expect(h.orca.launches).toEqual([]);
    });

    describe("会話を閉じる", () => {
      const leadTerminal = (
        h: ReturnType<typeof harness>,
        worktreePath: string,
        extra: Partial<(typeof h.orca.terminals)[number]> = {},
      ) => {
        h.orca.terminals.push(
          { handle: "setup_x", worktreePath, title: "Setup" },
          {
            handle: "lead_x",
            worktreePath,
            agentIdentity: "claude",
            screen: claudeScreen(),
            ...extra,
          },
        );
      };

      it("手が空いていて積んだままの案がなければ、タスク長のターミナルだけを閉じる（--tab・--all はつけない）", async () => {
        const { root, task } = await setup();
        await add(root, "push");
        const v = await shown(root);
        const h = harness();
        leadTerminal(h, task.path);
        const out = await send(
          root,
          fullArgs(v),
          h,
          fakeClock().clock,
          {},
          true,
        );
        expect(out.code).toBe(0);
        expect(h.orca.callsOf("terminal", "close")).toEqual([
          ["terminal", "close", "--terminal", "lead_x"],
        ]);
        expect(out.data?.closed).toBe("lead_x");
        expect(h.orca.terminals.map((t) => t.handle)).toEqual(["setup_x"]);
      });

      it("閉じたことを伝える", async () => {
        const { root, task } = await setup();
        await add(root, "push");
        const v = await shown(root);
        const h = harness();
        leadTerminal(h, task.path);
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.out).toContain("会話");
        expect(out.out).toContain("閉じました");
      });

      it("承認済み・CI 待ちの案だけが残るときは閉じる", async () => {
        const { root, task } = await setup();
        await add(root, "pr-ready", ["--pr", "7", "--after-ci"]);
        const v = await shown(root);
        const h = harness();
        leadTerminal(h, task.path);
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.code).toBe(0);
        expect(h.orca.callsOf("terminal", "close")).toHaveLength(1);
      });

      it("入力欄に打ちかけがあれば閉じず、理由と案内が出る", async () => {
        const { root, task } = await setup();
        await add(root, "push");
        const v = await shown(root);
        const h = harness();
        leadTerminal(h, task.path, { screen: claudeScreen("途中の文") });
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.code).toBe(0);
        expect(h.orca.callsOf("terminal", "close")).toEqual([]);
        expect(out.out).toContain("閉じませんでした");
        expect(out.out).toContain("打ちかけ");
      });

      it("ターミナルが2つ以上なら閉じず、候補を出す", async () => {
        const { root, task } = await setup();
        await add(root, "push");
        const v = await shown(root);
        const h = harness();
        leadTerminal(h, task.path);
        h.orca.terminals.push({
          handle: "lead_y",
          worktreePath: task.path,
          agentIdentity: "claude",
        });
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.code).toBe(0);
        expect(h.orca.callsOf("terminal", "close")).toEqual([]);
        expect(out.out).toContain("1つに決まりません");
        expect(out.out).toContain("lead_y");
      });

      it("ターミナルが0なら閉じる呼び出しをしない", async () => {
        const { root } = await setup();
        await add(root, "push");
        const v = await shown(root);
        const h = harness();
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.code).toBe(0);
        expect(h.orca.callsOf("terminal", "close")).toEqual([]);
        expect(out.out).toContain("閉じませんでした");
      });

      it("範囲の外で積んだままの案があれば閉じない", async () => {
        const { root, task } = await setup({
          interval: { seconds: 1, perBatch: 1 },
        });
        await add(root, "push");
        await add(root, "pr-ready", ["--pr", "7"]);
        const v = await shown(root);
        const h = harness();
        leadTerminal(h, task.path);
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.code).toBe(0);
        expect(h.orca.callsOf("terminal", "close")).toEqual([]);
        expect(out.out).toContain("pr-ready-v1");
      });

      it("確かでない案が残っていれば閉じない", async () => {
        const { root, common, task } = await setup();
        await add(root, "push");
        const push = (await readItem(common, "T01", "push-v1"))!;
        await writeItem(common, { ...push, state: "uncertain" });
        await add(root, "pr-ready", ["--pr", "7"]);
        const v = await shown(root);
        const h = harness();
        leadTerminal(h, task.path);
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.code).toBe(0);
        expect(h.orca.callsOf("terminal", "close")).toEqual([]);
        expect(out.out).toContain("閉じませんでした");
      });

      it("send が落ちたときは閉じない", async () => {
        const { root, task } = await setup();
        await add(root, "push");
        const v = await shown(root);
        const h = harness({ pushStderr: "! [rejected] x (non-fast-forward)" });
        leadTerminal(h, task.path);
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.code).toBe(1);
        expect(h.orca.callsOf("terminal", "close")).toEqual([]);
      });

      it("閉じる呼び出しが失敗しても終了コード0で、警告を出す", async () => {
        const { root, task } = await setup();
        await add(root, "push");
        const v = await shown(root);
        const h = harness();
        leadTerminal(h, task.path);
        h.orca.closeFails = true;
        const out = await send(root, fullArgs(v), h, fakeClock().clock);
        expect(out.code).toBe(0);
        expect(out.out).not.toContain("閉じました");
        expect(out.err).toContain("閉じられませんでした");
      });

      it.each(["sending", "skipped"] as const)(
        "%s の案が残っていれば閉じない",
        async (state) => {
          const { root, common, task } = await setup();
          await add(root, "push");
          const push = (await readItem(common, "T01", "push-v1"))!;
          await writeItem(common, { ...push, state });
          await add(root, "pr-ready", ["--pr", "7"]);
          const v = await shown(root);
          const h = harness();
          leadTerminal(h, task.path);
          const out = await send(root, fullArgs(v), h, fakeClock().clock);
          expect(out.code).toBe(0);
          expect(h.orca.callsOf("terminal", "close")).toEqual([]);
          expect(out.out).toContain("閉じませんでした");
        },
      );
    });
  });
});
