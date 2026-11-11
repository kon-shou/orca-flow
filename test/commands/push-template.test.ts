import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { Runner } from "../../src/lib/exec.ts";
import type { CommandContext } from "../../src/types.ts";
import { createPush } from "../../src/commands/push.ts";
import { readPushRecord } from "../../src/lib/finish.ts";
import { readItems } from "../../src/lib/outbox.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import {
  addTaskWorktree,
  git,
  makeRepo,
  PROGRESS,
  specDoc,
  tempDir,
  writeFiles,
} from "../helpers/repo.ts";

beforeEach(() => {
  vi.stubEnv("WSL_DISTRO_NAME", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** orca は偽物、gh と git push は記録するだけ、ほかの git は本物 */
function harness() {
  const orca = fakeOrca();
  const ghCalls: string[][] = [];
  const pushes: string[][] = [];
  const runner: Runner = async (cmd, args, opts) => {
    const ok = (stdout = "") => ({
      code: 0,
      stdout,
      stderr: "",
      timedOut: false,
    });
    if (cmd === "gh") {
      ghCalls.push([...args]);
      if (args[0] === "pr" && args[1] === "list") return ok("[]");
      return ok("ok");
    }
    if (cmd === "git" && args[0] === "push") {
      pushes.push([...args]);
      return ok();
    }
    return orca.runner(cmd, args, opts);
  };
  return { orca, ghCalls, pushes, runner };
}

const PROGRESS_ROW = PROGRESS.replace(
  "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
  "| T01 | 雛形   | —    | 統合済み | main         |      |\n| T12 | 買い物 | — | 作業中 | task/T12-shop | |\n",
);

const TEMPLATE =
  "## 概要\n<!-- 何を変えたか -->\n\n## 確認\n- [ ] テストした\n";

async function setupRepo(rootFiles: Record<string, string> = {}) {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      progress: { file: "docs/progress.md" },
      verify: ["test -f src/shop/a.ts"],
    },
    { "docs/progress.md": PROGRESS_ROW, ...rootFiles },
  );
  return root;
}

async function setupTask(root: string) {
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }).replace(
      "# タスク T12：テスト",
      "# タスク T12：買い物かご",
    ),
  });
  await writeFiles(wt.path, {
    "src/shop/a.ts": "export const a = 1;\n",
    "docs/tasks/reports/T12.md": "# 報告\n",
  });
  await git(wt.path, "add", "-A");
  await git(wt.path, "commit", "--quiet", "-m", "T12: 作る");
  const verify = await runCli(["verify"], {
    cwd: wt.path,
    runner: fakeOrca().runner,
  });
  expect(verify.code).toBe(0);
  return wt;
}

async function run(
  h: ReturnType<typeof harness>,
  cwd: string,
  argv: string[],
  json = false,
) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    argv,
    cwd,
    json,
    runner: h.runner,
    env: {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => new Date("2026-11-03T00:00:00Z"),
  };
  try {
    const result = await createPush({})(ctx);
    return {
      code: result.code,
      out: out.join("\n"),
      err: err.join("\n"),
      data: result.data,
    };
  } catch (error) {
    const e = error as { code?: number; message: string };
    return {
      code: e.code ?? 1,
      out: out.join("\n"),
      err: [...err, e.message].join("\n"),
      data: null,
    };
  }
}

describe("push --template", () => {
  it("baseBranch のテンプレートのパスと中身を出し、案も gh も触らない", async () => {
    const root = await setupRepo({
      ".github/pull_request_template.md": TEMPLATE,
    });
    const h = harness();
    const r = await run(h, root, ["T12", "--template"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "PR のテンプレート：.github/pull_request_template.md",
    );
    expect(r.out).toContain("- [ ] テストした");
    expect(h.ghCalls).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(h.orca.callsOf("worktree", "set")).toEqual([]);
    expect(await readItems(path.join(root, ".git"), "T12")).toEqual([]);
    expect(await readPushRecord(h.runner, root, "T12")).toBeNull();
  });

  it("作業ツリーだけにあるテンプレートは出さない", async () => {
    const root = await setupRepo();
    await writeFiles(root, { ".github/pull_request_template.md": TEMPLATE });
    const r = await run(harness(), root, ["T12", "--template"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PR のテンプレートはありません");
  });

  it("タスクのブランチだけにあるテンプレートは出さない", async () => {
    const root = await setupRepo();
    const wt = await addTaskWorktree(root, "T12", "shop", {
      ".github/pull_request_template.md": TEMPLATE,
    });
    const r = await run(harness(), wt.path, ["T12", "--template"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PR のテンプレートはありません");
  });

  it("複数あるときは全部を出し、終了コード0", async () => {
    const root = await setupRepo({
      ".github/PULL_REQUEST_TEMPLATE/a.md": "## 甲\n",
      ".github/PULL_REQUEST_TEMPLATE/b.md": "## 乙\n",
    });
    const r = await run(harness(), root, ["T12", "--template"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PR のテンプレートが複数あります");
    expect(r.out).toContain(
      "PR のテンプレート：.github/PULL_REQUEST_TEMPLATE/a.md",
    );
    expect(r.out).toContain("## 乙");
  });

  it("--json では候補を data に入れ、文は出さない", async () => {
    const root = await setupRepo({ "pull_request_template.md": TEMPLATE });
    const r = await run(harness(), root, ["T12", "--template"], true);
    expect(r.out).toBe("");
    expect(r.data).toMatchObject({
      found: "one",
      templates: [{ path: "pull_request_template.md", content: TEMPLATE }],
    });
  });

  it("2つのリポジトリでそれぞれ自分のテンプレートを出す", async () => {
    const a = await setupRepo({ "pull_request_template.md": "## 甲\n" });
    const b = await setupRepo({ "pull_request_template.md": "## 乙\n" });
    const ra = await run(harness(), a, ["T12", "--template"]);
    const rb = await run(harness(), b, ["T12", "--template"]);
    expect(ra.out).toContain("## 甲");
    expect(ra.out).not.toContain("## 乙");
    expect(rb.out).toContain("## 乙");
  });

  it("--body-file と一緒には使えない", async () => {
    const root = await setupRepo();
    const r = await run(harness(), root, [
      "T12",
      "--template",
      "--body-file",
      "x",
    ]);
    expect(r.code).toBe(1);
  });
});

describe("push の本文とテンプレートの見出し", () => {
  async function pushWith(rootFiles: Record<string, string>, body: string) {
    const root = await setupRepo(rootFiles);
    await setupTask(root);
    const file = path.join(await tempDir(), "body.md");
    await writeFiles(path.dirname(file), { "body.md": body });
    const h = harness();
    const r = await run(h, root, ["T12", "--body-file", file]);
    return { r, h, root, body };
  }

  it("見出しが欠けると警告を出すが、終了コード0で案を積む", async () => {
    const body = "## 概要\n本文\n";
    const { r, root } = await pushWith(
      { ".github/pull_request_template.md": TEMPLATE },
      body,
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain("本文に PR のテンプレートの見出しがありません");
    expect(r.err).toContain("確認");
    const items = await readItems(path.join(root, ".git"), "T12");
    expect(items.map((i) => i.kind)).toContain("pr-create");
    const created = items.find((i) => i.kind === "pr-create");
    expect(created?.body).toBe(body);
  });

  it("見出しが揃えば警告しない", async () => {
    const { r } = await pushWith(
      { ".github/pull_request_template.md": TEMPLATE },
      "## 概要\n本文\n\n## 確認\nテストした\n\n## 補足\nなし\n",
    );
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("テンプレート");
  });

  it("テンプレートがなければ警告しない", async () => {
    const { r } = await pushWith({}, "本文だけ\n");
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("テンプレート");
  });

  it("候補が複数のとき、どれか1つが揃えば警告しない", async () => {
    const files = {
      ".github/PULL_REQUEST_TEMPLATE/a.md": "## 甲\n",
      ".github/PULL_REQUEST_TEMPLATE/b.md": "## 乙\n",
    };
    const ok = await pushWith(files, "## 乙\nx\n");
    expect(ok.r.err).not.toContain("テンプレート");
    const ng = await pushWith(files, "## 丙\nx\n");
    expect(ng.r.code).toBe(0);
    expect(ng.r.err).toContain("本文に PR のテンプレートの見出しがありません");
  });
});
