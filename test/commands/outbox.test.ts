import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRecord, readAuto, writeAuto } from "../../src/lib/auto.ts";
import { addItem, readItem, updateState } from "../../src/lib/outbox.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";

const setup = async () => {
  const root = await makeRepo();
  const task = await addTaskWorktree(root, "T01", "x", { "a.txt": "a\n" });
  return { root, task };
};
const outbox = (args: string[], cwd: string) =>
  runCli(["outbox", ...args], { cwd, runner: fakeOrca().runner });

const bodyFile = async (text: string) => {
  const file = path.join(await tempDir(), "body.md");
  await writeFile(file, text);
  return file;
};

/** 置き場の全ファイルの中身（変わっていないことを確かめる） */
async function snapshot(root: string): Promise<Record<string, string>> {
  const base = path.join(root, ".git", "orca-flow", "outbox");
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(
      () => [],
    )) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out[p] = await readFile(p, "utf8");
    }
  };
  await walk(base);
  return out;
}

describe("outbox", () => {
  it("積み、見せ、取り下げる。どちらの場所でも動く", async () => {
    const { root, task } = await setup();
    const body = await bodyFile("PR の本文\n");
    const added = await outbox(
      ["add", "T01", "pr-create", "--body-file", body],
      task.path,
    );
    expect(added.code).toBe(0);
    expect(added.out).toContain("まだ書いていません");
    expect((await outbox(["add", "T01", "push"], root)).code).toBe(0);

    const list = await outbox(["list"], root);
    expect(list.out).toContain("pr-create-v1");
    expect(list.out).toContain("push-v1");

    const head = await git(task.path, "rev-parse", "HEAD");
    const show = JSON.parse(
      (await outbox(["show", "T01", "--json"], task.path)).out,
    );
    expect(show.items.map((i: { kind: string }) => i.kind)).toEqual([
      "push",
      "pr-create",
    ]);
    expect(show.head).toBe(head);
    expect(show.bundleFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const text = await outbox(["show", "T01"], root);
    expect(text.out).toContain(
      `--expect ${show.bundleFingerprint} --head ${head}`,
    );

    const withdrawn = await outbox(["withdraw", "T01", "push-v1"], root);
    expect(withdrawn.code).toBe(0);
    const after = JSON.parse(
      (await outbox(["show", "T01", "--json"], root)).out,
    );
    expect(after.items).toHaveLength(1);
  });

  it("同じ種類を積み直すと版が上がり、前の案を取り下げたと出る", async () => {
    const { root } = await setup();
    await outbox(["add", "T01", "push"], root);
    const again = await outbox(["add", "T01", "push"], root);
    expect(again.out).toContain("push-v2");
    expect(again.out).toContain("前の案を取り下げました：push-v1");
  });

  it("積むとき本文の秘密の形が伏せ字になる", async () => {
    const { root } = await setup();
    const secret = "ghp_" + "C".repeat(30);
    const body = await bodyFile(`token ${secret}\n`);
    await outbox(["add", "T01", "pr-create", "--body-file", body], root);
    const files = await snapshot(root);
    expect(JSON.stringify(files)).not.toContain(secret);
  });

  it("show は置き場に何も書かない", async () => {
    const { root } = await setup();
    await outbox(["add", "T01", "push"], root);
    const before = await snapshot(root);
    await outbox(["show", "T01"], root);
    await outbox(["show", "T01", "--json"], root);
    await outbox(["list"], root);
    expect(await snapshot(root)).toEqual(before);
  });

  it("作業中でない ID・知らない種類・足りない引数は終了コード1", async () => {
    const { root } = await setup();
    expect((await outbox(["add", "T99", "push"], root)).code).toBe(1);
    expect((await outbox(["add", "T01", "merge"], root)).code).toBe(1);
    expect((await outbox(["add", "T01", "pr-create"], root)).code).toBe(1);
    expect(
      (await outbox(["add", "T01", "push", "--after-ci"], root)).code,
    ).toBe(1);
    expect((await outbox(["withdraw", "T01", "nope"], root)).code).toBe(1);
    expect((await outbox([], root)).code).toBe(1);
  });

  it("--after-ci は使わなくなった：終了コード1で、案のファイルは増えない。なしなら今までどおり積める", async () => {
    const { root } = await setup();
    const before = await snapshot(root);
    const refused = await outbox(
      ["add", "T01", "pr-ready", "--after-ci"],
      root,
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--after-ci は使わなくなりました");
    expect(refused.err).toContain("PR は下書きでなく出します");
    expect(await snapshot(root)).toEqual(before);
    const usage = await outbox([], root);
    expect(usage.err).toContain("orca-flow outbox add");
    expect(usage.err).not.toContain("--after-ci");
    const ok = await outbox(["add", "T01", "pr-ready"], root);
    expect(ok.code).toBe(0);
    const item = await readItem(path.join(root, ".git"), "T01", "pr-ready-v1");
    expect(item).toMatchObject({ kind: "pr-ready", afterCi: false });
  });

  it("古い承認済み・CI 待ちの案は、list・show で読め、withdraw で取り下げられる", async () => {
    const { root, task } = await setup();
    const common = path.join(root, ".git");
    const head = await git(task.path, "rev-parse", "HEAD");
    const { item } = await addItem(
      common,
      {
        taskId: "T01",
        kind: "pr-ready",
        body: "",
        head,
        target: { remote: "origin", branch: task.branch, base: "main", pr: 7 },
        afterCi: true,
      },
      {},
      new Date(),
    );
    await updateState(common, item, "ci-wait", new Date(), {
      approvedHead: head,
      approvedFingerprint: item.fingerprint,
    });
    const list = await outbox(["list", "T01"], root);
    expect(list.code).toBe(0);
    expect(list.out).toContain("pr-ready-v1");
    expect(list.out).toContain("承認済み・CI 待ち");
    const shown = await outbox(["show", "T01"], root);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("送る案はありません");
    expect(shown.out).toContain("送らない古い案");
    expect(shown.out).toContain("pr-ready-v1");
    expect(shown.out).not.toContain("CI が通ったら外す");
    const shownJson = await outbox(["show", "T01", "--json"], root);
    const data = JSON.parse(shownJson.out) as {
      items: unknown[];
      stale: string[];
    };
    expect(data.items).toEqual([]);
    expect(data.stale).toEqual(["pr-ready-v1"]);
    const w = await outbox(["withdraw", "T01", "pr-ready-v1"], root);
    expect(w.code).toBe(0);
    expect((await readItem(common, "T01", "pr-ready-v1"))?.state).toBe(
      "withdrawn",
    );
  });

  it("add は GitHub を呼ばない（おまかせの印のあるタスクでも）", async () => {
    const { root } = await setup();
    const common = path.join(root, ".git");
    await writeAuto(common, newRecord("T01", new Date("2026-11-03T01:00:00Z")));
    expect((await readAuto(common, "T01"))?.auto).toBe(true);
    const orca = fakeOrca();
    const calls: string[] = [];
    const runner: typeof orca.runner = async (cmd, args, opts) => {
      calls.push(cmd);
      return orca.runner(cmd, args, opts);
    };
    const added = await runCli(["outbox", "add", "T01", "push"], {
      cwd: root,
      runner,
    });
    expect(added.code).toBe(0);
    expect(calls).not.toContain("gh");
    // git のほかは、カードを更新する orca だけ（GitHub にも origin にも書かない）
    expect(calls.filter((c) => c !== "git" && c !== "orca")).toEqual([]);
    expect(await git(root, "branch", "--list", "task/*")).toContain(
      "task/T01-x",
    );
  });

  it("pr-create の本文に手元のパスや秘密らしい値があると、終了コード1で案を積まない", async () => {
    const { root, task } = await setup();
    const bad: [string, string][] = [
      [`見て ${root}/src\n`, "リポジトリのパス"],
      [`作業は ${task.path} で\n`, "タスクの worktree のパス"],
      ["token ghp_abcdefghijklmnopqrstuvwxyz0123\n", "秘密らしい値"],
    ];
    for (const [text, kind] of bad) {
      const added = await outbox(
        ["add", "T01", "pr-create", "--body-file", await bodyFile(text)],
        root,
      );
      expect(added.code).toBe(1);
      expect(added.err).toContain(kind);
      expect(added.err).not.toContain("ghp_");
    }
    expect(await snapshot(root)).toEqual({});
    // 直せば積める
    expect(
      (
        await outbox(
          ["add", "T01", "pr-create", "--body-file", await bodyFile("本文\n")],
          root,
        )
      ).code,
    ).toBe(0);
  });

  it("add で積むと、カードが「送る前の確認待ち：〈案の種類と版〉」で未読になる。Orca が落ちても案は残る", async () => {
    const { root } = await setup();
    const orca = fakeOrca();
    const added = await runCli(["outbox", "add", "T01", "push"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(added.code).toBe(0);
    const set = orca.callsOf("worktree", "set").at(-1)!;
    expect(set.join(" ")).toContain("送る前の確認待ち：push-v1");
    expect(set).toContain("--unread");
    await runCli(["outbox", "add", "T01", "push"], {
      cwd: root,
      runner: orca.runner,
    });
    expect(orca.callsOf("worktree", "set").at(-1)!.join(" ")).toContain(
      "送る前の確認待ち：push-v2",
    );
    const down = fakeOrca();
    down.unavailable = true;
    const again = await runCli(["outbox", "add", "T01", "push"], {
      cwd: root,
      runner: down.runner,
    });
    expect(again.code).toBe(0);
    expect(again.err).toContain("カードを更新できませんでした");
    expect(
      await readItem(path.join(root, ".git"), "T01", "push-v3"),
    ).not.toBeNull();
  });

  it("add push も、rebase のあと（記録の先頭が今の先頭の祖先でない）は期待値を決める", async () => {
    const { root, task } = await setup();
    const common = path.join(root, ".git");
    const first = await git(task.path, "rev-parse", "HEAD");
    await mkdir(path.join(common, "orca-flow", "push"), { recursive: true });
    const record = path.join(common, "orca-flow", "push", "T01.json");
    await writeFile(
      record,
      JSON.stringify({ id: "T01", pushedHead: first, pr: null }),
    );
    // 早送り：期待値なし
    await writeFiles(task.path, { "b.txt": "b\n" });
    await git(task.path, "add", "-A");
    await git(task.path, "commit", "--quiet", "-m", "足す");
    await outbox(["add", "T01", "push"], root);
    expect(
      (await readItem(common, "T01", "push-v1"))!.target.expectedRemoteHead ??
        null,
    ).toBeNull();
    // 書き換え：期待値あり
    const second = await git(task.path, "rev-parse", "HEAD");
    await writeFile(
      record,
      JSON.stringify({ id: "T01", pushedHead: second, pr: null }),
    );
    await git(task.path, "commit", "--quiet", "--amend", "-m", "直す");
    const shown = await outbox(["add", "T01", "push"], root);
    expect(
      (await readItem(common, "T01", "push-v2"))!.target.expectedRemoteHead,
    ).toBe(second);
    expect(shown.out).toContain(second.slice(0, 8));
    const text = await outbox(["show", "T01"], root);
    expect(text.out).toContain(second);
  });

  it("add push は GitHub を読まず、記録がなければ期待値を付けない（PR の先頭に頼る道は push が持つ）", async () => {
    const { root, task } = await setup();
    const common = path.join(root, ".git");
    await git(task.path, "commit", "--quiet", "--amend", "-m", "直す");
    const orca = fakeOrca();
    const calls: string[] = [];
    const runner: typeof orca.runner = async (cmd, args, opts) => {
      calls.push(cmd);
      return orca.runner(cmd, args, opts);
    };
    const added = await runCli(["outbox", "add", "T01", "push"], {
      cwd: root,
      runner,
    });
    expect(added.code).toBe(0);
    expect(calls).not.toContain("gh");
    expect(
      (await readItem(common, "T01", "push-v1"))!.target.expectedRemoteHead ??
        null,
    ).toBeNull();
  });

  it("確かでない・送っている・送らなかった案は、人が確かめたあと outbox withdraw で片づき、警告から消える", async () => {
    const { root } = await setup();
    const common = path.join(root, ".git");
    await outbox(["add", "T01", "push"], root);
    await outbox(
      ["add", "T01", "pr-create", "--body-file", await bodyFile("本文\n")],
      root,
    );
    await outbox(["add", "T01", "pr-ready"], root);
    const items = ["push-v1", "pr-create-v1", "pr-ready-v1"];
    const states = ["uncertain", "sending", "skipped"] as const;
    for (const [i, id] of items.entries()) {
      const item = (await readItem(common, "T01", id))!;
      await updateState(common, item, states[i]!, new Date());
    }
    const shown = JSON.parse(
      (await outbox(["show", "T01", "--json"], root)).out,
    );
    expect(shown.uncertain.sort()).toEqual(["pr-create-v1", "push-v1"]);
    const text = (await outbox(["show", "T01"], root)).out;
    expect(text).toContain("outbox withdraw");

    for (const id of items) {
      const r = await outbox(["withdraw", "T01", id], root);
      expect(r.code).toBe(0);
      expect((await readItem(common, "T01", id))?.state).toBe("withdrawn");
    }
    expect((await readItem(common, "T01", "push-v1"))?.note).toContain(
      "GitHub を確かめて",
    );
    const after = JSON.parse(
      (await outbox(["show", "T01", "--json"], root)).out,
    );
    expect(after.uncertain).toEqual([]);
    // 送った案と取り下げ済みの案は取り下げられない
    expect((await outbox(["withdraw", "T01", "push-v1"], root)).code).toBe(1);
  });

  it("積み直しても前の確かでない案は取り下げにならず、警告が残る", async () => {
    const { root } = await setup();
    const common = path.join(root, ".git");
    await outbox(["add", "T01", "push"], root);
    const item = (await readItem(common, "T01", "push-v1"))!;
    await updateState(common, item, "uncertain", new Date());
    await outbox(["add", "T01", "push"], root);
    expect((await readItem(common, "T01", "push-v1"))?.state).toBe("uncertain");
    const shown = JSON.parse(
      (await outbox(["show", "T01", "--json"], root)).out,
    );
    expect(shown.uncertain).toEqual(["push-v1"]);
  });

  it("pr-create の題は設計書から決めて案に入れ、show に出て指紋に入る。--title で渡せる", async () => {
    const root = await makeRepo();
    const task = await addTaskWorktree(root, "T01", "x", {
      "docs/tasks/T01.md": "# タスク T01：買い物の画面\n\n本文\n",
    });
    const body = await bodyFile("PR の本文\n");
    const added = JSON.parse(
      (
        await outbox(
          ["add", "T01", "pr-create", "--body-file", body, "--json"],
          task.path,
        )
      ).out,
    );
    expect(added.item.target.title).toBe("T01: 買い物の画面");
    const text = (await outbox(["show", "T01"], root)).out;
    expect(text).toContain("題：T01: 買い物の画面");
    const again = JSON.parse(
      (
        await outbox(
          [
            "add",
            "T01",
            "pr-create",
            "--body-file",
            body,
            "--title",
            "別の題",
            "--json",
          ],
          root,
        )
      ).out,
    );
    expect(again.item.target.title).toBe("別の題");
    expect(again.item.fingerprint).not.toBe(added.item.fingerprint);
    expect(
      (await outbox(["add", "T01", "push", "--title", "x"], root)).code,
    ).toBe(1);
  });

  it("pr-create の題は、設計書が git に無視されている設定でも worktree のファイルから読む", async () => {
    const root = await makeRepo({}, { ".gitignore": "docs/tasks/\n" });
    const task = await addTaskWorktree(root, "T01", "x");
    await writeFiles(task.path, {
      "docs/tasks/T01.md": "# タスク T01：無視された設計書\n",
    });
    const added = JSON.parse(
      (
        await outbox(
          [
            "add",
            "T01",
            "pr-create",
            "--body-file",
            await bodyFile("本文\n"),
            "--json",
          ],
          root,
        )
      ).out,
    );
    expect(added.item.target.title).toBe("T01: 無視された設計書");
  });
});
