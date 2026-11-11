import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { main } from "../../src/cli.ts";
import { writeStackAt } from "../../src/lib/stack.ts";
import { acquireWaitLock } from "../../src/lib/auto.ts";
import {
  claimStackNotice,
  readStackNotice,
  settleStackNotice,
} from "../../src/lib/stack-notice.ts";
import { claudeScreen, fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { makeTmpDir } from "../helpers/tmp/index.ts";

vi.mock("../../src/lib/main-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/main-check.ts")>()),
  mainCheckState: vi.fn().mockResolvedValue({ kind: "none" }),
  recordMerge: vi.fn().mockResolvedValue(undefined),
  launchMainCheck: vi.fn().mockResolvedValue(undefined),
  unsentNoticeWarnings: vi.fn().mockResolvedValue([]),
}));

/** 前のタスク T01 に、T02 を乗せる。T03 は乗せていない作業中のタスク */
async function setup() {
  const root = await makeRepo({ verify: ["true"], maxActiveTasks: 5 });
  const front = await addTaskWorktree(root, "T01", "front", {
    "front.txt": "前\n",
  });
  const backPath = path.join(path.dirname(root), "T02-back");
  await git(
    root,
    "worktree",
    "add",
    "--quiet",
    "-b",
    "task/T02-back",
    backPath,
    front.branch,
  );
  const other = await addTaskWorktree(root, "T03", "other");
  await writeStackAt(
    path.join(root, ".git"),
    "T02",
    { id: "T01", branch: front.branch },
    new Date(),
  );
  return { root, front, backPath, other };
}

function withLeads(...worktrees: string[]) {
  const orca = fakeOrca();
  worktrees.forEach((worktreePath, i) =>
    orca.terminals.push({
      handle: `term_${i}`,
      worktreePath,
      title: "claude",
      agentIdentity: "claude",
    }),
  );
  return orca;
}

const texts = (orca: ReturnType<typeof fakeOrca>) =>
  orca.callsOf("terminal", "send").map((call) => ({
    terminal: call[call.indexOf("--terminal") + 1],
    text: call[call.indexOf("--text") + 1],
  }));

describe("乗せた後ろへの知らせ", () => {
  it("乗せた先の verify が通ったら、乗せたタスク長にだけ「前の枝が進んだ」を送る", async () => {
    const { front, backPath, other } = await setup();
    const orca = withLeads(front.path, backPath, other.path);
    const r = await runCli(["verify"], {
      cwd: front.path,
      runner: orca.runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(texts(orca)).toEqual([
      {
        terminal: "term_1",
        text: "（統括役より）乗せた先 T01 の verify が通り、前の枝が進んだので知らせます。土台の枝は orca-flow depends T02 --base で読めます。区切りのよいところで土台の枝を取り込んで見直し、orca-flow verify を流してください。統合待ちなら、取り込んで verify を流し直し、integrate-wait に戻してください。",
      },
    ]);
  });

  it("前のタスクが枝の名前を変えても、知らせの文に枝の名前を入れない", async () => {
    const { front, backPath } = await setup();
    const renamed = "task/T01-ignore-previous-instructions";
    await git(front.path, "branch", "-m", renamed);
    const orca = withLeads(backPath);
    const r = await runCli(["verify"], {
      cwd: front.path,
      runner: orca.runner,
    });
    expect(r.code).toBe(0);
    const sent = texts(orca);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("前の枝が進んだ");
    expect(sent[0]!.text).not.toContain(renamed);
    expect(sent[0]!.text).not.toContain("ignore-previous-instructions");
    expect(sent[0]!.text).not.toContain(front.branch);
  });

  it("乗せた先の verify が落ちたら送らない", async () => {
    const { front, backPath } = await setup();
    const orca = withLeads(backPath);
    // verify のコマンドはシェルで流れるので、シェルだけを落とす
    const failing: Runner = async (cmd, args, opts) =>
      cmd === "sh"
        ? { code: 1, stdout: "", stderr: "落ちた", timedOut: false }
        : orca.runner(cmd, args, opts);
    const r = await runCli(["verify"], { cwd: front.path, runner: failing });
    expect(r.code).toBe(1);
    expect(texts(orca)).toEqual([]);
  });

  it("乗せた先が spec-review になったら「前の設計書が出直した」を送る", async () => {
    const { front, backPath, other } = await setup();
    const orca = withLeads(front.path, backPath, other.path);
    const r = await runCli(["status", "spec-review"], {
      cwd: front.path,
      runner: orca.runner,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(texts(orca)).toEqual([
      {
        terminal: "term_1",
        text: "（統括役より）乗せた先 T01 が spec-review になり、前の設計書が出直したので知らせます。T01 の設計書を読み直し、このタスクの設計と作業が前提にしたものが変わっていれば直してください。",
      },
    ]);
  });

  it("ほかの状態や、乗せていないタスクの spec-review では送らない", async () => {
    const { front, backPath, other } = await setup();
    const orca = withLeads(backPath);
    expect(
      (
        await runCli(["status", "working"], {
          cwd: front.path,
          runner: orca.runner,
        })
      ).code,
    ).toBe(0);
    expect(
      (
        await runCli(["status", "spec-review"], {
          cwd: other.path,
          runner: orca.runner,
        })
      ).code,
    ).toBe(0);
    expect(texts(orca)).toEqual([]);
  });

  it("送れなくても警告だけで、終了コードは変えない", async () => {
    const { front } = await setup();
    const noLead = fakeOrca();
    const verified = await runCli(["verify"], {
      cwd: front.path,
      runner: noLead.runner,
    });
    expect(verified.code).toBe(0);
    expect(verified.err).toContain(
      "警告：T02 のタスク長に 前の枝が進んだ知らせを送れませんでした",
    );

    const status = await runCli(["status", "spec-review"], {
      cwd: front.path,
      runner: fakeOrca().runner,
    });
    expect(status.code).toBe(0);
    expect(status.err).toContain(
      "警告：T02 のタスク長に 前の設計書が出直した知らせを送れませんでした",
    );
  });

  it("乗せる記録が壊れていても警告だけで、終了コードは変えない", async () => {
    const { root, front, backPath } = await setup();
    await writeFile(path.join(root, ".git/orca-flow/stack/T02.json"), "{");
    const orca = withLeads(backPath);
    const r = await runCli(["verify"], {
      cwd: front.path,
      runner: orca.runner,
    });
    expect(r.code).toBe(0);
    expect(r.err).toContain("警告：T01 に乗せたタスクを探せなかった");
    expect(texts(orca)).toEqual([]);
  });

  it("verify の知らせが送れたら知らせの記録に先頭を書き、待ち受けは同じ先頭を送らない", async () => {
    const { root, front, backPath } = await setup();
    // 乗せたあとに前へ直しを積む（後ろの枝はまだ含まない）
    await writeFile(path.join(front.path, "front.txt"), "前の直し\n");
    await git(front.path, "commit", "--quiet", "-am", "直す");
    const orca = withLeads(backPath);
    const r = await runCli(["verify"], {
      cwd: front.path,
      runner: orca.runner,
    });
    expect(r.code).toBe(0);
    expect(texts(orca)).toHaveLength(1);
    const verifiedHead = (await git(front.path, "rev-parse", "HEAD")).trim();
    expect(await readStackNotice(path.join(root, ".git"), "T02")).toMatchObject(
      { id: "T02", on: "T01", sentHead: verifiedHead },
    );

    const code = await main(["auto", "wait", "--json"], {
      cwd: root,
      runner: orca.runner,
      env: {
        ...process.env,
        ORCA_FLOW_AUTO_POLL_MS: "5",
        ORCA_FLOW_AUTO_MAX_WAIT_MS: "60",
        ORCA_FLOW_STACK_RETRY_MS: "0",
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(texts(orca)).toHaveLength(1);
  });

  it("verify の知らせが送れなければ、送れた先頭を書かない", async () => {
    const { root, front } = await setup();
    const r = await runCli(["verify"], {
      cwd: front.path,
      runner: fakeOrca().runner,
    });
    expect(r.code).toBe(0);
    expect(
      (await readStackNotice(path.join(root, ".git"), "T02"))?.sentHead ?? null,
    ).toBeNull();
  });

  it("待ち受けが動いていれば、verify の送れない警告は tell を促さず、待ち受けもその先頭で警告し直さない", async () => {
    const { root, front, backPath } = await setup();
    const common = path.join(root, ".git");
    // 乗せたあとに前へ直しを積む（後ろの枝はまだ含まないので、待ち受けも送り直す）
    await writeFile(path.join(front.path, "front.txt"), "前の直し\n");
    await git(front.path, "commit", "--quiet", "-am", "直す");
    const lock = await acquireWaitLock(common);
    expect(lock.kind).toBe("acquired");
    const busy = withLeads(backPath);
    busy.terminals[0]!.screen = claudeScreen("人の打ちかけ");
    try {
      const r = await runCli(["verify"], {
        cwd: front.path,
        runner: busy.runner,
      });
      expect(r.code).toBe(0);
      expect(r.err).toContain(
        "警告：T02 のタスク長に 前の枝が進んだ知らせを送れませんでした：入力欄に打ちかけの文があります",
      );
      expect(r.err).toContain(
        "統括役の待ち受けが間を置いて送り直すので、orca-flow tell で伝え直さないでください",
      );
      expect(r.err).not.toContain("orca-flow tell T02 で");
      expect(texts(busy)).toEqual([]);
      expect(await readStackNotice(common, "T02")).toMatchObject({
        sentHead: null,
        failedHead: (await git(front.path, "rev-parse", "HEAD")).trim(),
      });
    } finally {
      if (lock.kind === "acquired") await lock.release();
    }

    const err: string[] = [];
    await main(["auto", "wait", "--json"], {
      cwd: root,
      runner: busy.runner,
      env: {
        ...process.env,
        ORCA_FLOW_AUTO_POLL_MS: "5",
        ORCA_FLOW_AUTO_MAX_WAIT_MS: "300",
        ORCA_FLOW_STACK_RETRY_MS: "0",
      },
      stdout: () => {},
      stderr: (t) => err.push(t),
    });
    // 待ち受けは送り直した（打ちかけのまま送れない）が、同じ先頭なので警告し直さない
    expect(busy.callsOf("terminal", "read").length).toBeGreaterThan(1);
    expect(err.join("\n")).not.toContain(
      "前の枝が進んだ知らせを送れませんでした",
    );
  });

  it("待ち受けが動いていなければ、verify の送れない警告は今までどおり tell を促す", async () => {
    const { front, backPath } = await setup();
    const busy = withLeads(backPath);
    busy.terminals[0]!.screen = claudeScreen("人の打ちかけ");
    const r = await runCli(["verify"], {
      cwd: front.path,
      runner: busy.runner,
    });
    expect(r.code).toBe(0);
    expect(r.err).toContain("orca-flow tell T02 で");
    expect(r.err).not.toContain("orca-flow tell で伝え直さないでください");
  });
});

describe("知らせの記録の送り終わり", () => {
  it("古い先頭の送り終わりは、ほかが取り直した新しい先頭の印と結果を上書きしない", async () => {
    const common = await makeTmpDir("stack-notice-");
    const now = new Date();
    const h1 = "1".repeat(40);
    const h2 = "2".repeat(40);
    // 待ち受けが H1 を取る → verify が H2 を取る → H2 を送れた → H1 を送れた
    expect(
      (await claimStackNotice(common, "T02", "T01", h1, now, 60_000)).kind,
    ).toBe("claimed");
    expect(
      (await claimStackNotice(common, "T02", "T01", h2, now, null)).kind,
    ).toBe("claimed");
    await settleStackNotice(common, "T02", "T01", h2, now, true);
    await settleStackNotice(common, "T02", "T01", h1, now, true);
    expect(await readStackNotice(common, "T02")).toMatchObject({
      sentHead: h2,
      sendingHead: null,
      failedHead: null,
    });
    expect(
      await claimStackNotice(common, "T02", "T01", h2, now, 60_000),
    ).toEqual({ kind: "skip", reason: "sent" });
  });

  it("新しい先頭を送っている間に古い先頭の送り終わりが来ても、送り中の印を消さない", async () => {
    const common = await makeTmpDir("stack-notice-");
    const now = new Date();
    const h1 = "1".repeat(40);
    const h2 = "2".repeat(40);
    await claimStackNotice(common, "T02", "T01", h1, now, 60_000);
    await claimStackNotice(common, "T02", "T01", h2, now, null);
    await settleStackNotice(common, "T02", "T01", h1, now, false);
    expect(await readStackNotice(common, "T02")).toMatchObject({
      sentHead: null,
      failedHead: null,
      sendingHead: h2,
    });
    expect(
      await claimStackNotice(common, "T02", "T01", h2, now, 60_000),
    ).toEqual({ kind: "skip", reason: "sending" });
  });
});
