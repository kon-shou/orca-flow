import { existsSync } from "node:fs";
import { mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPush } from "../../src/commands/push.ts";
import { createSend } from "../../src/commands/send.ts";
import { writePushRecord } from "../../src/lib/finish.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { readItems } from "../../src/lib/outbox.ts";
import {
  buildCapturesSection,
  collectCaptures,
} from "../../src/lib/pr-captures.ts";
import type { CommandContext } from "../../src/types.ts";
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
import { testRunner } from "../helpers/runner.ts";

const progressWith = (row: string) =>
  PROGRESS.replace(
    "| T01 | 雛形   | —    | 統合済み | main         |      |\n",
    `| T01 | 雛形   | —    | 統合済み | main         |      |\n${row}\n`,
  );

const ALLOW_EDIT = {
  outbound: { allow: ["push", "pr-create", "pr-ready", "pr-edit"] },
};

interface GhCall {
  args: string[];
  cwd: string | undefined;
  /** 書き込みのとき、gh を流した場所にあった録画のファイル名 */
  staged?: string[];
  /** 書き込みのとき、--body-file の中身 */
  body?: string;
}

/** orca は偽物、gh は偽物（版・ホスト・PR の本文を変えられる）、git push は記録するだけ、ほかの git は本物 */
function harness() {
  const orca = fakeOrca();
  const gh = {
    version: "2.99.0",
    url: "https://github.com/o/r",
    prs: [] as Record<string, unknown>[],
    prBody: "",
    /** true のとき、PR の本文の読み取りが失敗する */
    viewFails: false,
    calls: [] as GhCall[],
  };
  const done = (code: number, stdout = "", stderr = "") => ({
    code,
    stdout,
    stderr,
    timedOut: false,
  });
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "gh") {
      const call: GhCall = { args: [...args], cwd: opts?.cwd };
      gh.calls.push(call);
      if (args[0] === "--version")
        return done(0, `gh version ${gh.version} (2026-10-01)\n`);
      if (args[0] === "auth") return done(0, "ok");
      if (args[0] === "repo")
        return done(0, JSON.stringify({ nameWithOwner: "o/r", url: gh.url }));
      if (args[0] === "pr" && args[1] === "list")
        return done(0, JSON.stringify(gh.prs));
      if (args[0] === "pr" && args[1] === "view")
        return gh.viewFails
          ? done(1, "", "HTTP 502: Bad Gateway")
          : done(0, JSON.stringify({ body: gh.prBody }));
      if (args[0] === "pr" && (args[1] === "create" || args[1] === "edit")) {
        const dir = opts?.cwd ?? "";
        call.staged = args.flatMap((a, i) =>
          args[i - 1] === "--attach" && existsSync(path.join(dir, a))
            ? [a]
            : [],
        );
        call.body = await readFile(
          path.resolve(dir, args[args.indexOf("--body-file") + 1]!),
          "utf8",
        );
        if (args[1] === "edit") gh.prBody = call.body;
        return done(0, "https://github.com/o/r/pull/7\n");
      }
      return done(0);
    }
    if (cmd === "git" && args[0] === "push") return done(0);
    return orca.runner(cmd, args, opts);
  };
  const writes = () =>
    gh.calls.filter(
      (c) => c.args[0] === "pr" && ["create", "edit"].includes(c.args[1]!),
    );
  return { orca, gh, runner, writes };
}

type Harness = ReturnType<typeof harness>;

beforeEach(() => {
  vi.stubEnv("WSL_DISTRO_NAME", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup(config: Record<string, unknown> = {}) {
  const root = await makeRepo(
    {
      integrateVerify: "before-merge",
      progress: { file: "docs/progress.md" },
      verify: ["test -f src/shop/a.ts"],
      ...config,
    },
    {
      "docs/progress.md": progressWith(
        "| T12 | 買い物 | — | 作業中 | task/T12-shop | |",
      ),
    },
  );
  const wt = await addTaskWorktree(root, "T12", "shop", {
    "docs/tasks/T12.md": specDoc("T12", { allowed: ["src/shop/"] }),
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
  const body = path.join(await tempDir(), "body.md");
  await writeFile(body, "## 概要\n本文\n");
  const head = await git(wt.path, "rev-parse", "HEAD");
  const common = path.join(root, ".git");
  const captures = path.join(common, "orca-flow", "e2e-captures", "T12");
  return { root, wt, body, head, common, captures };
}

async function placeCaptures(dir: string, files: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(dir, name), content);
}

const CART = {
  "cart-before.webm": "before-bytes",
  "cart-after.webm": "after-bytes",
};

const ctxFor = (
  h: Harness,
  root: string,
  argv: string[],
  out: string[],
  err: string[],
): CommandContext => ({
  argv,
  cwd: root,
  json: false,
  runner: h.runner,
  env: {},
  stdout: (t) => out.push(t),
  stderr: (t) => err.push(t),
  now: () => new Date("2026-11-03T00:00:00Z"),
});

async function run(
  command: (ctx: CommandContext) => Promise<{ code: number; data?: unknown }>,
  h: Harness,
  root: string,
  argv: string[],
) {
  const out: string[] = [];
  const err: string[] = [];
  try {
    const result = await command(ctxFor(h, root, argv, out, err));
    return {
      code: result.code,
      data: result.data as Record<string, unknown>,
      out: out.join("\n"),
      err: err.join("\n"),
    };
  } catch (error) {
    const e = error as { code?: number; message: string };
    return {
      code: e.code ?? 1,
      data: {} as Record<string, unknown>,
      out: out.join("\n"),
      err: [...err, e.message].join("\n"),
    };
  }
}

const push = (h: Harness, root: string, extra: string[] = []) =>
  run(createPush(), h, root, ["T12", ...extra]);

const send = (h: Harness, root: string, fingerprint: string, head: string) =>
  run(
    createSend({
      clock: { now: () => 1_700_000_000_000, sleep: async () => {} },
    }),
    h,
    root,
    ["T12", "--expect", fingerprint, "--head", head],
  );

/** push のあと gh が呼ぶのは読むものだけ */
const ghOnlyReads = (h: Harness) => {
  for (const c of h.gh.calls) {
    const read =
      c.args[0] === "--version" ||
      c.args[0] === "auth" ||
      (c.args[0] === "repo" && c.args[1] === "view") ||
      (c.args[0] === "pr" && (c.args[1] === "list" || c.args[1] === "view"));
    expect(read, `gh ${c.args.join(" ")}`).toBe(true);
  }
};

const openPr = (head: string) => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  isDraft: false,
  state: "OPEN",
  headRefOid: head,
  statusCheckRollup: [],
});

describe("push が録画を PR の作成の案に載せる", () => {
  it("前と後がそろった流れがあると、PR の作成の案に録画の一覧と本文の節が入り、send が録画ごとの --attach 〈ファイル名〉 で PR を作る", async () => {
    const { root, body, head, captures } = await setup();
    await placeCaptures(captures, CART);
    const h = harness();
    const stacked = await push(h, root, ["--body-file", body]);
    expect(stacked.err).toBe("");
    expect(stacked.code).toBe(0);
    ghOnlyReads(h);
    const items = await readItems(path.join(root, ".git"), "T12");
    const create = items.find((i) => i.kind === "pr-create")!;
    expect(create.target.captures?.map((c) => [c.name, c.size])).toEqual([
      ["cart-before.webm", 12],
      ["cart-after.webm", 11],
    ]);
    const section = buildCapturesSection(
      (await collectCaptures(captures)).captures,
    );
    expect(create.body).toBe(`## 概要\n本文\n\n${section}\n`);
    expect(create.body).not.toContain(root);
    // 人が送る前に録画を開けるよう、手元のパスを見せる
    expect(stacked.out).toContain(path.join(captures, "cart-before.webm"));

    const fingerprint = (stacked.data as { bundleFingerprint: string })
      .bundleFingerprint;
    const sent = await send(h, root, fingerprint, head);
    expect(sent.err).toBe("");
    expect(sent.code).toBe(0);
    const [call] = h.writes();
    expect(call!.args.slice(0, 2)).toEqual(["pr", "create"]);
    expect(
      call!.args.flatMap((a, i) =>
        call!.args[i - 1] === "--attach" ? [a] : [],
      ),
    ).toEqual(["cart-before.webm", "cart-after.webm"]);
    expect(call!.staged).toEqual(["cart-before.webm", "cart-after.webm"]);
    // 本文の参照と --attach の値はファイル名だけ
    expect(call!.body).toContain("![](cart-before.webm)");
    for (const text of [...call!.args, call!.body!]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain(captures);
    }
  });

  it("録画がないとき、PR の作成の案の中身は今までどおり（録画の一覧も節もない）", async () => {
    const { root, body } = await setup();
    const h = harness();
    const stacked = await push(h, root, ["--body-file", body]);
    expect(stacked.code).toBe(0);
    const create = (await readItems(path.join(root, ".git"), "T12")).find(
      (i) => i.kind === "pr-create",
    )!;
    expect(create.body).toBe("## 概要\n本文\n");
    expect(create.target.captures).toBeUndefined();
    // 録画がなければ gh の版もリポジトリも読みに行かない
    expect(h.gh.calls.some((c) => c.args[0] === "repo")).toBe(false);
  });

  it("積んだあとに録画が変わる・消えると、send は gh の書き込みを呼ばず「送らなかった」にする", async () => {
    for (const change of ["edit", "remove"] as const) {
      const { root, body, head, captures } = await setup();
      await placeCaptures(captures, CART);
      const h = harness();
      const stacked = await push(h, root, ["--body-file", body]);
      const file = path.join(captures, "cart-after.webm");
      if (change === "edit") await writeFile(file, "other-bytes");
      else await rm(file);
      const sent = await send(
        h,
        root,
        (stacked.data as { bundleFingerprint: string }).bundleFingerprint,
        head,
      );
      expect(sent.code).toBe(1);
      expect(sent.err).toContain("cart-after.webm");
      expect(sent.err).not.toContain(captures);
      expect(h.writes()).toEqual([]);
      const create = (await readItems(path.join(root, ".git"), "T12")).find(
        (i) => i.kind === "pr-create",
      )!;
      expect(create.state).toBe("skipped");
    }
  });

  it("gh が 2.99.0 より古いとき・ホストが github.com でないとき、録画なしで案を積み、警告を出して終了コード0", async () => {
    for (const set of [
      (h: Harness) => (h.gh.version = "2.98.1"),
      (h: Harness) => (h.gh.url = "https://ghe.example.com/o/r"),
    ]) {
      const { root, body, captures } = await setup();
      await placeCaptures(captures, CART);
      const h = harness();
      set(h);
      const stacked = await push(h, root, ["--body-file", body]);
      expect(stacked.code).toBe(0);
      expect(stacked.err).toMatch(/警告：録画を PR に載せません（.+）/);
      expect(stacked.err).toMatch(/2\.99\.0|github\.com ではありません/);
      const create = (await readItems(path.join(root, ".git"), "T12")).find(
        (i) => i.kind === "pr-create",
      )!;
      expect(create.target.captures).toBeUndefined();
      expect(create.body).toBe("## 概要\n本文\n");
    }
  });

  it("片方だけの流れと 10,000,000 バイトを超える録画は載らず、警告に流れの名前が出る", async () => {
    const { root, body, captures } = await setup();
    await placeCaptures(captures, {
      ...CART,
      "login-before.webm": "x",
      "huge-before.webm": "x",
      "huge-after.webm": "",
    });
    await truncate(path.join(captures, "huge-after.webm"), 10_000_001);
    const h = harness();
    const stacked = await push(h, root, ["--body-file", body]);
    expect(stacked.code).toBe(0);
    expect(stacked.err).toContain("流れ login");
    expect(stacked.err).toContain("流れ huge");
    expect(stacked.err).not.toContain(captures);
    const create = (await readItems(path.join(root, ".git"), "T12")).find(
      (i) => i.kind === "pr-create",
    )!;
    expect(create.target.captures?.map((c) => c.name)).toEqual([
      "cart-before.webm",
      "cart-after.webm",
    ]);
  });

  it("本文に始まりの印だけがあると、録画を載せずに警告し、本文はそのまま積む", async () => {
    const { root, body, captures } = await setup();
    await placeCaptures(captures, CART);
    const text = `## 概要\n<!-- orca-flow:captures ${"a".repeat(16)} -->\n人の文\n`;
    await writeFile(body, text);
    const h = harness();
    const stacked = await push(h, root, ["--body-file", body]);
    expect(stacked.code).toBe(0);
    expect(stacked.err).toContain("終わりの印がない");
    const create = (await readItems(path.join(root, ".git"), "T12")).find(
      (i) => i.kind === "pr-create",
    )!;
    expect(create.body).toBe(text);
    expect(create.target.captures).toBeUndefined();
  });

  it("outbox show に録画の一覧（流れ・前か後か・大きさ・手元のパス）が出る", async () => {
    const { root, body, captures } = await setup();
    await placeCaptures(captures, CART);
    const h = harness();
    await push(h, root, ["--body-file", body]);
    const shown = await runCli(["outbox", "show", "T12"], {
      cwd: root,
      runner: fakeOrca().runner,
    });
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(
      `cart 前：12 バイト  ${path.join(captures, "cart-before.webm")}`,
    );
    expect(shown.out).toContain(
      `cart 後：11 バイト  ${path.join(captures, "cart-after.webm")}`,
    );
    expect(shown.out).not.toContain("before-bytes");
  });
});

describe("push が開いた PR の本文の録画の節を直す案 pr-edit を積む", () => {
  const humanBody = "## 概要\r\n人が GitHub で直した本文\r\n";

  it("本文の印の値が今の録画と違えば pr-edit を積み、send は印の中だけを差し替える。ほかの本文は1文字も変わらない", async () => {
    const { root, head, captures } = await setup(ALLOW_EDIT);
    await placeCaptures(captures, CART);
    const h = harness();
    h.gh.prs = [openPr("0".repeat(40))];
    const old = `<!-- orca-flow:captures ${"f".repeat(16)} -->\n古い録画\n<!-- /orca-flow:captures -->`;
    h.gh.prBody = `${humanBody}\r\n${old}\r\n\r\n## あと\r\n`;
    const before = h.gh.prBody;
    const stacked = await push(h, root);
    expect(stacked.err).toBe("");
    expect(stacked.code).toBe(0);
    ghOnlyReads(h);
    expect((stacked.data as { stacked: string[] }).stacked).toEqual([
      "push-v1",
      "pr-edit-v1",
    ]);
    const section = buildCapturesSection(
      (await collectCaptures(captures)).captures,
    );
    const sent = await send(
      h,
      root,
      (stacked.data as { bundleFingerprint: string }).bundleFingerprint,
      head,
    );
    expect(sent.err).toBe("");
    expect(sent.code).toBe(0);
    const [edit] = h.writes();
    expect(edit!.args.slice(0, 3)).toEqual(["pr", "edit", "7"]);
    expect(edit!.staged).toEqual(["cart-before.webm", "cart-after.webm"]);
    expect(h.gh.prBody).toBe(before.replace(old, section));
    expect(h.gh.prBody.startsWith(`${humanBody}\r\n`)).toBe(true);
    expect(h.gh.prBody.endsWith("\r\n\r\n## あと\r\n")).toBe(true);
  });

  it("印の値が今の録画と同じなら積まない", async () => {
    const { root, captures } = await setup(ALLOW_EDIT);
    await placeCaptures(captures, CART);
    const h = harness();
    h.gh.prs = [openPr("0".repeat(40))];
    h.gh.prBody = `${humanBody}\n${buildCapturesSection(
      (await collectCaptures(captures)).captures,
    )}\n`;
    const stacked = await push(h, root);
    expect(stacked.code).toBe(0);
    expect((stacked.data as { stacked: string[] }).stacked).toEqual([
      "push-v1",
    ]);
  });

  it("outbound.allow に pr-edit がなく、本文の録画の節が今と違えば（節がないときも）積まず、本文を読むだけで、統括役が設定に足せば載ると案内する", async () => {
    const old = `<!-- orca-flow:captures ${"f".repeat(16)} -->\n古い録画\n<!-- /orca-flow:captures -->`;
    for (const prBody of [humanBody, `${humanBody}\n${old}\n`]) {
      const { root, captures } = await setup();
      await placeCaptures(captures, CART);
      const h = harness();
      h.gh.prs = [openPr("0".repeat(40))];
      h.gh.prBody = prBody;
      const stacked = await push(h, root);
      expect(stacked.code).toBe(0);
      expect(stacked.err).toBe("");
      expect((stacked.data as { stacked: string[] }).stacked).toEqual([
        "push-v1",
      ]);
      expect(stacked.out).toContain("outbound.allow に pr-edit がない");
      expect(stacked.out).toContain("統括役");
      expect(stacked.out).toContain("PR #7 の本文の録画");
      // 本文は読むが、書かない
      expect(
        h.gh.calls.some((c) => c.args[0] === "pr" && c.args[1] === "view"),
      ).toBe(true);
      ghOnlyReads(h);
      expect(h.gh.prBody).toBe(prBody);
      expect(
        (await readItems(path.join(root, ".git"), "T12")).some(
          (i) => i.kind === "pr-edit",
        ),
      ).toBe(false);
    }
  });

  it("outbound.allow に pr-edit がなく、本文の印の値が今の録画と同じなら、初回も先頭が変わっていない2回目も案内を出さずに積まない", async () => {
    for (const when of ["first", "same-head"] as const) {
      const { root, wt, head, captures } = await setup();
      await placeCaptures(captures, CART);
      if (when === "same-head")
        await writePushRecord(testRunner, root, "T12", {
          id: "T12",
          branch: wt.branch,
          base: "main",
          pushedHead: head,
          pushedAt: "2026-11-03T00:00:00Z",
          pr: { number: 7, url: "https://github.com/o/r/pull/7" },
        });
      const h = harness();
      h.gh.prs = [openPr(when === "same-head" ? head : "0".repeat(40))];
      h.gh.prBody = `${humanBody}\n${buildCapturesSection(
        (await collectCaptures(captures)).captures,
      )}\n`;
      const stacked = await push(h, root);
      expect(stacked.code, when).toBe(0);
      expect(stacked.err, when).toBe("");
      expect(stacked.out, when).not.toContain("pr-edit");
      expect(stacked.out, when).not.toContain("統括役");
      expect(
        (stacked.data as { stacked?: string[] }).stacked ?? [],
        when,
      ).toEqual(when === "first" ? ["push-v1"] : []);
      ghOnlyReads(h);
      expect(
        (await readItems(path.join(root, ".git"), "T12")).some(
          (i) => i.kind === "pr-edit",
        ),
        when,
      ).toBe(false);
    }
  });

  it("outbound.allow に pr-edit がなく本文を読めないときは、読めない警告を出さずに案内だけを出し、積まずに終了コード0", async () => {
    for (const when of ["first", "same-head"] as const) {
      const { root, wt, head, captures } = await setup();
      await placeCaptures(captures, CART);
      if (when === "same-head")
        await writePushRecord(testRunner, root, "T12", {
          id: "T12",
          branch: wt.branch,
          base: "main",
          pushedHead: head,
          pushedAt: "2026-11-03T00:00:00Z",
          pr: { number: 7, url: "https://github.com/o/r/pull/7" },
        });
      const h = harness();
      h.gh.prs = [openPr(when === "same-head" ? head : "0".repeat(40))];
      h.gh.viewFails = true;
      const stacked = await push(h, root);
      expect(stacked.code, when).toBe(0);
      expect(stacked.err, when).toBe("");
      expect(stacked.out, when).toContain("outbound.allow に pr-edit がない");
      expect(stacked.out, when).toContain("統括役");
      ghOnlyReads(h);
      expect(
        (await readItems(path.join(root, ".git"), "T12")).some(
          (i) => i.kind === "pr-edit",
        ),
        when,
      ).toBe(false);
    }
  });

  it("録画がなければ何もしない（今の節は消さない）", async () => {
    const { root } = await setup(ALLOW_EDIT);
    const h = harness();
    h.gh.prs = [openPr("0".repeat(40))];
    h.gh.prBody = `<!-- orca-flow:captures ${"f".repeat(16)} -->\nx\n<!-- /orca-flow:captures -->`;
    const stacked = await push(h, root);
    expect((stacked.data as { stacked: string[] }).stacked).toEqual([
      "push-v1",
    ]);
  });

  it("積んだあとに PR の本文が変わっていれば送らない", async () => {
    const { root, head, captures } = await setup(ALLOW_EDIT);
    await placeCaptures(captures, CART);
    const h = harness();
    h.gh.prs = [openPr("0".repeat(40))];
    h.gh.prBody = humanBody;
    const stacked = await push(h, root);
    h.gh.prBody = `${humanBody}追記\r\n`;
    const sent = await send(
      h,
      root,
      (stacked.data as { bundleFingerprint: string }).bundleFingerprint,
      head,
    );
    expect(sent.code).toBe(1);
    expect(h.writes()).toEqual([]);
    expect(h.gh.prBody).toBe(`${humanBody}追記\r\n`);
    const edit = (await readItems(path.join(root, ".git"), "T12")).find(
      (i) => i.kind === "pr-edit",
    )!;
    expect(edit.state).toBe("skipped");
  });

  it("先頭が変わっていない2回目の push も、録画が本文と違えば pr-edit だけを積む", async () => {
    const { root, wt, head, captures } = await setup(ALLOW_EDIT);
    await placeCaptures(captures, CART);
    await writePushRecord(testRunner, root, "T12", {
      id: "T12",
      branch: wt.branch,
      base: "main",
      pushedHead: head,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: { number: 7, url: "https://github.com/o/r/pull/7" },
    });
    const h = harness();
    h.gh.prs = [openPr(head)];
    h.gh.prBody = humanBody;
    const second = await push(h, root);
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    ghOnlyReads(h);
    expect((second.data as { stacked: string[] }).stacked).toEqual([
      "pr-edit-v1",
    ]);
    expect(second.out).toContain(path.join(captures, "cart-after.webm"));
    const set = h.orca.callsOf("worktree", "set").at(-1)!;
    expect(set.join(" ")).toContain("送る前の確認待ち：pr-edit-v1");

    // 送ったあとは、同じ録画でもう一度打っても積まない
    const sent = await send(
      h,
      root,
      (second.data as { bundleFingerprint: string }).bundleFingerprint,
      head,
    );
    expect(sent.code).toBe(0);
    const third = await push(h, root);
    expect((third.data as { stacked?: string[] }).stacked ?? []).toEqual([]);
  });

  /** タスクの枝にコミットを足して verify し直す（先頭が進む） */
  async function advance(wt: { path: string }) {
    await writeFiles(wt.path, { "src/shop/b.ts": "export const b = 2;\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "T12: 足す");
    const verify = await runCli(["verify"], {
      cwd: wt.path,
      runner: fakeOrca().runner,
    });
    expect(verify.code).toBe(0);
    return git(wt.path, "rev-parse", "HEAD");
  }

  const fingerprintOf = (r: { data: unknown }) =>
    (r.data as { bundleFingerprint: string }).bundleFingerprint;
  const withdrawnOf = (r: { data: unknown }) =>
    (r.data as { withdrawn?: string[] }).withdrawn ?? [];

  it("先頭を進めて push し直し、pr-edit を積まない道に入ると、前の pr-edit を取り下げ、新しい束で send が通る", async () => {
    for (const change of ["remove", "old-gh", "closed"] as const) {
      const { root, wt, body, captures } = await setup(ALLOW_EDIT);
      await placeCaptures(captures, CART);
      const h = harness();
      h.gh.prs = [openPr("0".repeat(40))];
      h.gh.prBody = humanBody;
      const first = await push(h, root);
      expect((first.data as { stacked: string[] }).stacked).toEqual([
        "push-v1",
        "pr-edit-v1",
      ]);

      const head = await advance(wt);
      if (change === "remove") await rm(path.join(captures, "cart-after.webm"));
      if (change === "old-gh") h.gh.version = "2.50.0";
      if (change === "closed") h.gh.prs = [];
      const again = await push(
        h,
        root,
        change === "closed" ? ["--body-file", body] : [],
      );
      expect(again.code, change).toBe(0);
      expect(withdrawnOf(again), change).toContain("pr-edit-v1");
      expect(again.out, change).toContain("前の案を取り下げました：pr-edit-v1");
      const items = await readItems(path.join(root, ".git"), "T12");
      expect(items.find((i) => i.id === "pr-edit-v1")?.state, change).toBe(
        "withdrawn",
      );
      expect(
        items.filter((i) => i.state === "queued").map((i) => i.kind),
        change,
      ).not.toContain("pr-edit");

      const sent = await send(h, root, fingerprintOf(again), head);
      expect(sent.err, change).toBe("");
      expect(sent.code, change).toBe(0);
      expect(
        h.writes().map((c) => c.args.slice(0, 2).join(" ")),
        change,
      ).toEqual(change === "closed" ? ["pr create"] : []);
    }
  });

  it("先頭が変わっていない2回目の push で pr-edit を積まない道に入ると、前の pr-edit を取り下げる", async () => {
    const { root, wt, head, captures } = await setup(ALLOW_EDIT);
    await placeCaptures(captures, CART);
    await writePushRecord(testRunner, root, "T12", {
      id: "T12",
      branch: wt.branch,
      base: "main",
      pushedHead: head,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: { number: 7, url: "https://github.com/o/r/pull/7" },
    });
    const h = harness();
    h.gh.prs = [openPr(head)];
    h.gh.prBody = humanBody;
    const second = await push(h, root);
    expect((second.data as { stacked: string[] }).stacked).toEqual([
      "pr-edit-v1",
    ]);
    await rm(path.join(captures, "cart-before.webm"));
    const third = await push(h, root);
    expect(third.code).toBe(0);
    expect(withdrawnOf(third)).toEqual(["pr-edit-v1"]);
    expect(third.out).toContain("前の案を取り下げました：pr-edit-v1");
    expect(
      (await readItems(path.join(root, ".git"), "T12")).find(
        (i) => i.id === "pr-edit-v1",
      )?.state,
    ).toBe("withdrawn");
  });

  it("下書きの PR で先頭が変わっていない2回目の push が pr-edit を積まない道に入ると、下書きを外す案を積んだうえで前の pr-edit を取り下げる", async () => {
    const { root, wt, head, captures } = await setup(ALLOW_EDIT);
    await placeCaptures(captures, CART);
    await writePushRecord(testRunner, root, "T12", {
      id: "T12",
      branch: wt.branch,
      base: "main",
      pushedHead: head,
      pushedAt: "2026-11-03T00:00:00Z",
      pr: { number: 7, url: "https://github.com/o/r/pull/7" },
    });
    const h = harness();
    h.gh.prs = [{ ...openPr(head), isDraft: true }];
    h.gh.prBody = humanBody;
    const second = await push(h, root);
    expect(second.code).toBe(0);
    expect((second.data as { stacked: string[] }).stacked).toEqual([
      "pr-ready-v1",
      "pr-edit-v1",
    ]);
    await rm(path.join(captures, "cart-before.webm"));
    const third = await push(h, root);
    expect(third.code).toBe(0);
    expect((third.data as { stacked: string[] }).stacked).toEqual([
      "pr-ready-v2",
    ]);
    expect(withdrawnOf(third)).toContain("pr-edit-v1");
    expect(third.out).toContain("前の案を取り下げました：pr-edit-v1");
    const items = await readItems(path.join(root, ".git"), "T12");
    expect(items.find((i) => i.id === "pr-edit-v1")?.state).toBe("withdrawn");
    expect(
      items.filter((i) => i.state === "queued").map((i) => i.kind),
    ).toEqual(["pr-ready"]);
  });

  it("本文がもう今の録画になっていれば、前の pr-edit を取り下げて withdrawn に出す", async () => {
    for (const same of ["advanced", "same-head"] as const) {
      const { root, wt, head, captures } = await setup(ALLOW_EDIT);
      await placeCaptures(captures, CART);
      const h = harness();
      if (same === "same-head")
        await writePushRecord(testRunner, root, "T12", {
          id: "T12",
          branch: wt.branch,
          base: "main",
          pushedHead: head,
          pushedAt: "2026-11-03T00:00:00Z",
          pr: { number: 7, url: "https://github.com/o/r/pull/7" },
        });
      h.gh.prs = [openPr(same === "same-head" ? head : "0".repeat(40))];
      h.gh.prBody = humanBody;
      const first = await push(h, root);
      expect((first.data as { stacked: string[] }).stacked, same).toContain(
        "pr-edit-v1",
      );
      if (same === "advanced") await advance(wt);
      h.gh.prBody = `${humanBody}\n${buildCapturesSection(
        (await collectCaptures(captures)).captures,
      )}\n`;
      const again = await push(h, root);
      expect(again.code, same).toBe(0);
      expect(withdrawnOf(again), same).toContain("pr-edit-v1");
      expect(again.out, same).toContain("前の案を取り下げました：pr-edit-v1");
      expect(
        (await readItems(path.join(root, ".git"), "T12")).find(
          (i) => i.id === "pr-edit-v1",
        )?.state,
        same,
      ).toBe("withdrawn");
    }
  });

  it("開いた PR の本文に手元のパスがあると、初回も先頭が変わっていない2回目も pr-edit を積まずに警告し、終了コード0", async () => {
    for (const when of ["first", "same-head"] as const) {
      const { root, wt, head, captures } = await setup(ALLOW_EDIT);
      await placeCaptures(captures, CART);
      if (when === "same-head")
        await writePushRecord(testRunner, root, "T12", {
          id: "T12",
          branch: wt.branch,
          base: "main",
          pushedHead: head,
          pushedAt: "2026-11-03T00:00:00Z",
          pr: { number: 7, url: "https://github.com/o/r/pull/7" },
        });
      const h = harness();
      h.gh.prs = [openPr(when === "same-head" ? head : "0".repeat(40))];
      h.gh.prBody = `${humanBody}見た場所：${root}/src\n`;
      const stacked = await push(h, root);
      expect(stacked.code, when).toBe(0);
      expect(stacked.err, when).toContain("リポジトリのパス");
      expect(stacked.err, when).toContain("録画の節を直す案は積みません");
      expect(stacked.err, when).not.toContain(root);
      expect(
        (stacked.data as { stacked?: string[] }).stacked ?? [],
        when,
      ).not.toContain("pr-edit-v1");
      expect(
        (await readItems(path.join(root, ".git"), "T12")).some(
          (i) => i.kind === "pr-edit",
        ),
        when,
      ).toBe(false);
    }
  });

  it("gh が古いときは pr-edit を積まず、警告を出して終了コード0", async () => {
    const { root, captures } = await setup(ALLOW_EDIT);
    await placeCaptures(captures, CART);
    const h = harness();
    h.gh.version = "2.50.0";
    h.gh.prs = [openPr("0".repeat(40))];
    h.gh.prBody = humanBody;
    const stacked = await push(h, root);
    expect(stacked.code).toBe(0);
    expect(stacked.err).toContain("警告：録画を PR に載せません");
    expect((stacked.data as { stacked: string[] }).stacked).toEqual([
      "push-v1",
    ]);
  });
});
