import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  makeRepo,
  specDoc,
  writeFiles,
} from "../helpers/repo.ts";

describe("active", () => {
  it("作業中のタスクと、ブランチの設計書の書き込んでよい場所を出す", async () => {
    const root = await makeRepo();
    const t1 = await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": specDoc("T01", { allowed: ["src/a/"] }),
    });
    await addTaskWorktree(root, "T02", "b");
    const result = await runCli(["active", "--json"], {
      cwd: t1.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.out);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["T01", "T02"]);
    expect(rows[0].allowed).toEqual(["src/a"]);
    expect(rows[0].path).toBe(t1.path);
    expect(rows[1].allowed).toBeNull();
  });

  it("Orca につながらなくても動く", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T01", "a");
    const orca = fakeOrca();
    orca.unavailable = true;
    const result = await runCli(["active"], { cwd: root, runner: orca.runner });
    expect(result.code).toBe(0);
    expect(result.out).toContain("T01");
  });
});

describe("overlap", () => {
  it("作業中のほかのタスクと重なれば一覧を出して終了コード1", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": specDoc("T01", {
        allowed: ["scripts/review/rules/"],
      }),
    });
    const t2 = await addTaskWorktree(root, "T02", "b");
    await writeFiles(t2.path, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["scripts/review"] }),
    });
    const result = await runCli(["overlap", "T02"], {
      cwd: path.join(t2.path, "docs"),
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("T01");
  });

  it("重ならなければ終了コード0、共有のファイルは終了コード1", async () => {
    const root = await makeRepo({ progress: { file: "docs/progress.md" } });
    await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": specDoc("T01", {
        allowed: ["scripts/review-account/"],
      }),
    });
    const t2 = await addTaskWorktree(root, "T02", "b");
    await writeFiles(t2.path, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["scripts/review"] }),
    });
    const ok = await runCli(["overlap", "T02"], {
      cwd: t2.path,
      runner: fakeOrca().runner,
    });
    expect(ok.code).toBe(0);

    await writeFiles(t2.path, {
      "docs/tasks/T02.md": specDoc("T02", {
        allowed: ["scripts/review", "docs/"],
      }),
    });
    const shared = await runCli(["overlap", "T02"], {
      cwd: t2.path,
      runner: fakeOrca().runner,
    });
    expect(shared.code).toBe(1);
    expect(shared.err).toContain("docs/progress.md");
  });

  it("要点のない古い設計書でも終了コードは変えず、読みやすさの警告を標準エラーに出す", async () => {
    const root = await makeRepo();
    const t1 = await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": specDoc("T01", { allowed: ["src/a/"] }),
    });
    const ok = await runCli(["overlap", "T01", "--json"], {
      cwd: t1.path,
      runner: fakeOrca().runner,
    });
    expect(ok.code).toBe(0);
    expect(ok.err).toMatch(/^読みやすさ：.*要点/m);
    const data = JSON.parse(ok.out);
    expect(data.readability).toHaveLength(1);
    expect(data.readability[0]).toContain("要点");
    expect(data.problems).toEqual([]);

    const t2 = await addTaskWorktree(root, "T02", "b");
    await writeFiles(t2.path, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["src/a/b"] }),
    });
    const overlapping = await runCli(["overlap", "T02"], {
      cwd: t2.path,
      runner: fakeOrca().runner,
    });
    expect(overlapping.code).toBe(1);
    expect(overlapping.err).toContain("読みやすさ：");
    expect(overlapping.err).toContain("T01");
  });

  it("目的の行がない設計書でも終了コードは変えず、読みやすさの警告を標準エラーに出す", async () => {
    const root = await makeRepo();
    const text = specDoc("T01", { allowed: ["src/a/"] }).replace(
      "## 目的\n\nテストのため。",
      "## 要点\n\n- 変わること：テストのため。\n- 決めてほしいこと：なし\n- 気をつけること：なし",
    );
    const t1 = await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": text,
    });
    const result = await runCli(["overlap", "T01", "--json"], {
      cwd: t1.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/^読みやすさ：.*目的/m);
    expect(JSON.parse(result.out).readability).toHaveLength(1);
  });

  it("要点のある設計書では読みやすさの警告を出さない", async () => {
    const root = await makeRepo();
    const text = specDoc("T01", { allowed: ["src/a/"] }).replace(
      "## 目的\n\nテストのため。",
      "## 要点\n\n- 目的：テストのため。\n- 変わること：テストのため。\n- 決めてほしいこと：なし\n- 気をつけること：なし",
    );
    expect(text).toContain("## 要点");
    const t1 = await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": text,
    });
    const result = await runCli(["overlap", "T01", "--json"], {
      cwd: t1.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("読みやすさ");
    expect(JSON.parse(result.out).readability).toEqual([]);
  });

  it("かっこを含むパス（Expo Router のグループ）を、かっこを残したまま比べる", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": specDoc("T01", {
        allowed: ["apps/mobile/app/(account)/"],
      }),
    });
    const t2 = await addTaskWorktree(root, "T02", "b");
    await writeFiles(t2.path, {
      "docs/tasks/T02.md": specDoc("T02", {
        allowed: ["apps/mobile/app/(core)/"],
        workers: [{ name: "担当A：画面", paths: ["apps/mobile/app/(core)/"] }],
      }).replace(
        "- `apps/mobile/app/(core)/`\n",
        "- `apps/mobile/app/(core)/`（新しく作る）\n",
      ),
    });
    const result = await runCli(["overlap", "T02", "--json"], {
      cwd: t2.path,
      runner: fakeOrca().runner,
    });
    expect(result.err).not.toContain("警告：");
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out);
    expect(data.allowed).toEqual(["apps/mobile/app/(core)"]);
    expect(data.problems).toEqual([]);
    expect(data.warnings).toEqual([]);
  });

  it("書き添えがバッククォートの中にあれば、警告と直すところを出して終了コード1", async () => {
    const root = await makeRepo();
    const t1 = await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": specDoc("T01", {
        allowed: ["src/a.ts（新規）", "src/b/"],
        workers: [
          { name: "担当A：本体", paths: ["src/a.ts（新規）", "src/b/"] },
        ],
      }),
    });
    const result = await runCli(["overlap", "T01", "--json"], {
      cwd: t1.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^警告：.*src\/a\.ts（新規）.*書き添えはバッククォートの外に書いてください/m,
    );
    expect(result.err).toContain("直すところがあります");
    const data = JSON.parse(result.out);
    expect(data.allowed).toEqual(["src/a.ts（新規）", "src/b"]);
    const notes = data.problems.filter(
      (p: { kind: string }) => p.kind === "note",
    );
    expect(notes).toHaveLength(2);
    expect(notes[0].message).toContain("src/a.ts（新規）");
  });

  it("作業中のほかのタスクの設計書の書き添えでは、終了コード1にしない", async () => {
    const root = await makeRepo();
    await addTaskWorktree(root, "T01", "a", {
      "docs/tasks/T01.md": specDoc("T01", {
        allowed: ["src/a.ts（新規）"],
      }),
    });
    const t2 = await addTaskWorktree(root, "T02", "b");
    await writeFiles(t2.path, {
      "docs/tasks/T02.md": specDoc("T02", { allowed: ["src/b/"] }),
    });
    const result = await runCli(["overlap", "T02", "--json"], {
      cwd: t2.path,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).problems).toEqual([]);
  });

  it("設計書がなければ終了コード1", async () => {
    const root = await makeRepo();
    const result = await runCli(["overlap", "T09"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(1);
  });
});

describe("config", () => {
  it("既定値を埋めた設定を JSON で出す", async () => {
    const root = await makeRepo({ idPrefix: "P" });
    const result = await runCli(["config", "--json"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    const config = JSON.parse(result.out);
    expect(config.idPrefix).toBe("P");
    expect(config.baseBranch).toBe("main");
  });
});
