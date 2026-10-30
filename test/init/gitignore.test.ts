import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { capture, fakeOrcaRunner, git, makeRepo, ok } from "./helpers.ts";

async function init(cwd: string, argv: string[]) {
  const io = capture();
  const r = fakeOrcaRunner((args) =>
    args[0] === "repo" && args[1] === "list" ? ok({ repos: [] }) : ok({}),
  );
  const code = await main(["init", ...argv], {
    ...io,
    cwd,
    runner: r.runner,
  });
  return { code, io };
}

const gitignore = (root: string) =>
  readFileSync(path.join(root, ".gitignore"), "utf8");

const config = (value: Record<string, unknown>) => ({
  ".orca-flow/config.json": JSON.stringify(value),
});

describe("init の .gitignore", () => {
  it("--yes で tasksDir と、外にある reportsDir と、進捗表の行を足す", async () => {
    const root = makeRepo(
      config({
        tasksDir: "docs/tasks",
        reportsDir: "docs/reports",
        progress: { file: "docs/progress.md" },
      }),
    );
    const { code, io } = await init(root, ["--yes"]);
    expect(code).toBe(0);
    expect(gitignore(root)).toBe(
      "/docs/tasks/\n/docs/reports/\n/docs/progress.md\n",
    );
    expect(io.text()).toContain(".gitignore：次の行を足しました");
    expect(io.text()).toContain("公開に出さないため");
    expect(git(root, "check-ignore", "docs/tasks/X1.md").trim()).not.toBe("");
  });

  it("reportsDir が tasksDir の中なら足さず、進捗表がなければ行も足さない", async () => {
    const root = makeRepo(
      config({ tasksDir: "docs/tasks", reportsDir: "docs/tasks/reports" }),
    );
    await init(root, ["--yes"]);
    expect(gitignore(root)).toBe("/docs/tasks/\n");
  });

  it("config がなければ既定の tasksDir の行を足す", async () => {
    const root = makeRepo();
    await init(root, ["--yes"]);
    expect(gitignore(root)).toBe("/docs/tasks/\n");
  });

  it("--yes がなければ書かず、足す行を出す", async () => {
    const root = makeRepo();
    const { io } = await init(root, []);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(io.text()).toContain(".gitignore：次の行を足す");
    expect(io.text()).toContain("/docs/tasks/");
  });

  it("すでに無視されている場所は足さない。重ねて流しても増えない", async () => {
    const root = makeRepo({ ...config({}), ".gitignore": "docs/tasks/" });
    const first = await init(root, ["--yes"]);
    expect(gitignore(root)).toBe("docs/tasks/");
    expect(first.io.text()).toContain(".gitignore：足す行はありません");

    const other = makeRepo();
    await init(other, ["--yes"]);
    await init(other, ["--yes"]);
    expect(gitignore(other)).toBe("/docs/tasks/\n");
  });

  it("最後に改行がない .gitignore には改行を足してから追記する", async () => {
    const root = makeRepo({ ".gitignore": "node_modules" });
    await init(root, ["--yes"]);
    expect(gitignore(root)).toBe("node_modules\n/docs/tasks/\n");
  });

  it("追跡中のファイルがあるディレクトリでも、行がなければ足す", async () => {
    const root = makeRepo({ "docs/tasks/X1.md": "# x\n" });
    await init(root, ["--yes"]);
    expect(gitignore(root)).toBe("/docs/tasks/\n");
    writeFileSync(path.join(root, "docs/tasks/X2.md"), "# y\n");
    expect(git(root, "ls-files", "docs/tasks").trim()).toBe("docs/tasks/X1.md");
    expect(git(root, "status", "--porcelain", "docs/tasks")).toBe("");
  });

  it("--json に足す行が入る", async () => {
    const root = makeRepo();
    const io = capture();
    const r = fakeOrcaRunner(() => ok({}));
    await main(["init", "--json"], { ...io, cwd: root, runner: r.runner });
    const data = JSON.parse(io.text()) as { gitignore: string[] };
    expect(data.gitignore).toEqual(["/docs/tasks/"]);
  });

  it("追跡中の記録があれば、無視済みでも一覧と --json で知らせる", async () => {
    const root = makeRepo({ "docs/tasks/X1.md": "# x\n" });
    writeFileSync(path.join(root, ".gitignore"), "/docs/tasks/\n");
    const { io } = await init(root, []);
    expect(io.text()).toContain("すでに追跡中の記録が1件あります");
    expect(io.text()).toContain("git rm -r --cached");

    const json = capture();
    const r = fakeOrcaRunner(() => ok({}));
    await main(["init", "--json"], { ...json, cwd: root, runner: r.runner });
    const data = JSON.parse(json.text()) as { trackedRecords: string[] };
    expect(data.trackedRecords).toEqual(["docs/tasks/X1.md"]);
  });

  it("追跡中の記録がなければ知らせない", async () => {
    const root = makeRepo();
    const { io } = await init(root, []);
    expect(io.text()).not.toContain("追跡中の記録");
  });
});
