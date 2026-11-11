import { createHash } from "node:crypto";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testRunner as realRunner } from "../helpers/runner.ts";
import { addTaskWorktree, makeRepo, tempDir } from "../helpers/repo.ts";
import { WORKSPACE_FILE, loadWorkspace } from "../../src/lib/workspace.ts";

const common = (p: string, extra: Record<string, unknown> = {}) => ({
  name: "kit",
  path: p,
  role: "common",
  keywords: ["共通部品"],
  scope: "画面の部品",
  package: "@example/kit",
  bumpCommand: "pnpm up @example/kit",
  ...extra,
});
const app = (p: string, extra: Record<string, unknown> = {}) => ({
  name: "shop",
  path: p,
  role: "app",
  keywords: ["注文"],
  ...extra,
});

async function setup() {
  const folder = await tempDir("orca-flow-ws-");
  const kit = await makeRepo();
  const shop = await makeRepo();
  return { folder, kit, shop };
}

async function put(folder: string, repos: unknown, extra = {}) {
  const text = JSON.stringify({ repos, ...extra }, null, 2);
  await writeFile(path.join(folder, WORKSPACE_FILE), text);
  return text;
}

const load = (folder: string) => loadWorkspace(realRunner, folder);

async function expectProblem(folder: string, ...parts: string[]) {
  const error = await load(folder).then(
    () => null,
    (e: unknown) => e as Error & { code: number },
  );
  expect(error).not.toBeNull();
  expect(error?.code).toBe(1);
  for (const part of parts) expect(error?.message).toContain(part);
}

describe("workspace：設定の読み出し", () => {
  it("実のパス・役割・要件の言葉・共通の欄・sha256 を返し、相対パスはフォルダから解く", async () => {
    const { folder, kit, shop } = await setup();
    const rel = path.relative(folder, shop);
    const text = await put(folder, [common(kit), app(rel)]);
    const ws = await load(folder);
    expect(ws.dir).toBe(await realpath(folder));
    expect(ws.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(ws.repos).toEqual([
      {
        name: "kit",
        path: await realpath(kit),
        role: "common",
        keywords: ["共通部品"],
        scope: "画面の部品",
        package: "@example/kit",
        bumpCommand: "pnpm up @example/kit",
      },
      {
        name: "shop",
        path: await realpath(shop),
        role: "app",
        keywords: ["注文"],
      },
    ]);
  });

  it("リンクを通したパスも実のパスに直す", async () => {
    const { folder, kit, shop } = await setup();
    const link = path.join(folder, "link");
    await symlink(shop, link);
    await put(folder, [common(kit), app(link)]);
    expect((await load(folder)).repos[1]?.path).toBe(await realpath(shop));
  });

  it("名前の重なり・slug でない名前・ないパスは名前つきで終了コード1", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [common(kit), app(shop, { name: "kit" })]);
    await expectProblem(folder, "kit", "重なっ");
    await put(folder, [common(kit), app(shop, { name: "Bad_Name" })]);
    await expectProblem(folder, "Bad_Name");
    await put(folder, [common(kit), app(path.join(folder, "nowhere"))]);
    await expectProblem(folder, "shop", "nowhere");
  });

  it("slug でない名前の誤りの文の全体が決まっている", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [common(kit), app(shop, { name: "Bad_Name" })]);
    const error = await load(folder).then(
      () => null,
      (e: unknown) => e as Error & { code: number },
    );
    expect(error?.code).toBe(1);
    expect(error?.message).toBe(
      [
        "orca-flow-workspace.json に直すところがあります：",
        "- repos[1]（Bad_Name）.name は英小文字・数字・「-」にしてください（先頭は英小文字か数字）：Bad_Name",
      ].join("\n"),
    );
  });

  it("リポジトリの下のフォルダとリンクした worktree は終了コード1", async () => {
    const { folder, kit, shop } = await setup();
    await mkdir(path.join(shop, "sub"));
    await put(folder, [common(kit), app(path.join(shop, "sub"))]);
    await expectProblem(folder, "shop", "一番上");
    const wt = await addTaskWorktree(shop, "lnk", "linked");
    await put(folder, [common(kit), app(wt.path)]);
    await expectProblem(folder, "shop", "worktree");
  });

  it("git でないフォルダは終了コード1", async () => {
    const { folder, kit } = await setup();
    const plain = await tempDir("orca-flow-plain-");
    await put(folder, [common(kit), app(plain)]);
    await expectProblem(folder, "shop", "git");
  });

  it("入れ子（リポジトリ同士・フォルダがリポジトリの下・リポジトリがフォルダの下・同じ場所）は終了コード1", async () => {
    const { folder, kit, shop } = await setup();
    // リポジトリ同士：kit の中に別のリポジトリ
    const inner = path.join(kit, "inner");
    await mkdir(inner);
    await realRunner("git", ["init", "--quiet"], { cwd: inner });
    await put(folder, [common(kit), app(inner)]);
    await expectProblem(folder, "kit", "shop", "入れ子");
    // 同じ場所
    await put(folder, [common(kit), app(kit)]);
    await expectProblem(folder, "kit", "shop", "入れ子");
    // フォルダがリポジトリの下
    const below = path.join(shop, "ws");
    await mkdir(below);
    await put(below, [common(kit), app(shop)]);
    await expectProblem(below, "shop", "入れ子");
    // リポジトリがフォルダの下
    const parent = await makeRepo();
    const nested = path.join(parent, "nested");
    await mkdir(nested);
    await realRunner("git", ["init", "--quiet"], { cwd: nested });
    await put(parent, [common(kit), app(nested)]);
    await expectProblem(parent, "shop", "入れ子");
  });

  it("フォルダの下の「..a」という名前の子も入れ子として止める", async () => {
    const { folder, kit } = await setup();
    const odd = path.join(folder, "..a");
    await mkdir(odd);
    await realRunner("git", ["init", "--quiet"], { cwd: odd });
    await put(folder, [common(kit), app(odd)]);
    await expectProblem(folder, "shop", "入れ子");
  });

  it("知らないキーと共通の欠けが1つのメッセージに出る", async () => {
    const { folder, shop } = await setup();
    await put(folder, [app(shop)], { extra: 1 });
    await expectProblem(folder, "extra", "common");
  });

  it("設定は今の場所だけで探し、上の階層へは探しに行かない", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [common(kit), app(shop)]);
    const sub = path.join(folder, "sub");
    await mkdir(sub);
    const error = await load(sub).then(
      () => null,
      (e: unknown) => e as Error & { code: number },
    );
    expect(error?.code).toBe(2);
  });

  it("共通がない・アプリがない・知らない役割は終了コード1", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [app(kit, { name: "a1" }), app(shop)]);
    await expectProblem(folder, "common");
    await put(folder, [common(kit), common(shop, { name: "kit2" })]);
    await expectProblem(folder, "app");
    await put(folder, [common(kit), app(shop, { role: "tool" })]);
    await expectProblem(folder, "role");
  });

  it("共通の欄の欠け・アプリの共通だけの欄・知らないキー・空の要件の言葉は終了コード1", async () => {
    const { folder, kit, shop } = await setup();
    for (const key of ["scope", "package", "bumpCommand"]) {
      const lacking = common(kit) as Record<string, unknown>;
      delete lacking[key];
      await put(folder, [lacking, app(shop)]);
      await expectProblem(folder, key);
      await put(folder, [common(kit), app(shop, { [key]: "x" })]);
      await expectProblem(folder, key);
    }
    await put(folder, [common(kit), app(shop, { color: "red" })]);
    await expectProblem(folder, "color");
    await put(folder, [common(kit), app(shop)], { extra: 1 });
    await expectProblem(folder, "extra");
    await put(folder, [common(kit), app(shop, { keywords: [] })]);
    await expectProblem(folder, "keywords");
    await put(folder, [common(kit), app(shop, { keywords: ["a", ""] })]);
    await expectProblem(folder, "keywords");
  });

  it("誤りが2つなら両方が1つのメッセージに出る", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [
      common(kit, { keywords: [] }),
      app(shop, { name: "Bad_Name" }),
    ]);
    await expectProblem(folder, "keywords", "Bad_Name");
  });

  it("設定のファイルがなければ2、JSON として読めなければ1", async () => {
    const folder = await tempDir("orca-flow-ws-");
    await expect(load(folder)).rejects.toMatchObject({ code: 2 });
    const { kit } = await setup();
    await expect(load(kit)).rejects.toMatchObject({ code: 2 });
    await writeFile(path.join(folder, WORKSPACE_FILE), "{ nope");
    await expect(load(folder)).rejects.toMatchObject({ code: 1 });
    await writeFile(path.join(folder, WORKSPACE_FILE), "[]");
    await expect(load(folder)).rejects.toMatchObject({ code: 1 });
  });
});

describe("workspace：設定の url", () => {
  it("url のある設定を今までどおり読み、url を子の欄に持つ", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [
      common(kit, { url: "https://example.com/kit.git" }),
      app(shop),
    ]);
    const ws = await load(folder);
    expect(ws.repos[0]?.url).toBe("https://example.com/kit.git");
    expect(ws.repos[1]).not.toHaveProperty("url");
  });

  it("url が空・文字列でない・「-」始まりなら設定の誤り（終了コード1）", async () => {
    const { folder, kit, shop } = await setup();
    for (const bad of ["", 5, null, ["x"], "--upload-pack=evil"]) {
      await put(folder, [common(kit, { url: bad }), app(shop)]);
      await expectProblem(folder, "kit", "url");
    }
  });

  it("url があっても、パスのない子は一覧の読み方では今までどおり誤り", async () => {
    const { folder, kit } = await setup();
    await put(folder, [
      common(kit),
      app(path.join(folder, "nowhere"), { url: "https://example.com/s.git" }),
    ]);
    await expectProblem(folder, "shop", "nowhere");
  });
});

describe("nextIdOf", () => {
  it("設定の答えの idPrefix・tasksDir・ブランチから次の ID を出す。読めなければ null", async () => {
    const { nextIdOf } = await import("../../src/lib/workspace.ts");
    const repo = await makeRepo();
    await mkdir(path.join(repo, "plans"), { recursive: true });
    await writeFile(path.join(repo, "plans", "Z08.md"), "x\n");
    expect(
      await nextIdOf(realRunner, repo, { idPrefix: "Z", tasksDir: "plans" }),
    ).toBe("Z09");
    expect(await nextIdOf(realRunner, repo, { idPrefix: 3 })).toBeNull();
    expect(await nextIdOf(realRunner, repo, null)).toBeNull();
  });
});

describe("workspace：companion", () => {
  const e2e = (p: string, extra: Record<string, unknown> = {}) => ({
    name: "e2e-tests",
    path: p,
    role: "app",
    keywords: ["e2e"],
    ...extra,
  });
  const companion = (extra: Record<string, unknown> = {}) => ({
    apps: ["shop"],
    when: "利用者から見た画面の動きが変わるとき",
    command: "pnpm test:e2e --base-url {previewUrl:shop}",
    ...extra,
  });

  async function withE2e(c: unknown, apps = true) {
    const { folder, kit, shop } = await setup();
    const tests = await makeRepo();
    await put(folder, [
      common(kit),
      app(shop),
      e2e(tests, c === undefined ? {} : { companion: c }),
    ]);
    return { folder, tests, shop, apps };
  }

  it("正しい形が読め、書いた子だけに companion が付く", async () => {
    const { folder } = await withE2e(companion());
    const ws = await load(folder);
    expect(ws.repos.find((r) => r.name === "e2e-tests")?.companion).toEqual(
      companion(),
    );
    expect(ws.repos.find((r) => r.name === "shop")?.companion).toBeUndefined();
  });

  it("同じ名前の印を複数使える", async () => {
    const { folder } = await withE2e(
      companion({ command: "run {previewUrl:shop} {previewUrl:shop}" }),
    );
    await load(folder);
  });

  it("誤りはまとめて設定の誤りになる", async () => {
    const { folder } = await withE2e({ when: "", extra: 1, apps: [] });
    await expectProblem(
      folder,
      "知らないキー repos[2]（e2e-tests）.companion.extra",
      "companion.command がありません",
      "companion.apps は",
      "companion.when は",
    );
  });

  it("共通の子には書けない", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [common(kit, { companion: companion() }), app(shop)]);
    await expectProblem(folder, "companion は共通（common）には書けません");
  });

  it("apps の外れ（自分・ない名前・共通・重なり）", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ apps: ["e2e-tests"] }, "自分（e2e-tests）"],
      [{ apps: ["nope"] }, "設定にありません：nope"],
      [{ apps: ["kit"] }, "アプリ（app）の子だけです：kit"],
      [{ apps: ["shop", "shop"] }, "重なり"],
    ];
    for (const [extra, part] of cases) {
      const { folder } = await withE2e(companion(extra));
      await expectProblem(folder, part);
    }
  });

  it("引用符の中の印は誤り、外の印は通る", async () => {
    for (const command of [
      'X="{previewUrl:shop}" run',
      "run '{previewUrl:shop}'",
    ]) {
      const { folder } = await withE2e(companion({ command }));
      await expectProblem(folder, "引用符で囲まないでください");
    }
    for (const command of [
      "run --base-url {previewUrl:shop}",
      "X={previewUrl:shop} run",
    ]) {
      const { folder } = await withE2e(companion({ command }));
      await load(folder);
    }
  });

  it("印のないコマンドと、apps にない印は誤り", async () => {
    const a = await withE2e(companion({ command: "pnpm test:e2e" }));
    await expectProblem(a.folder, "{previewUrl:〈名前〉}");
    const b = await withE2e(
      companion({ command: "run {previewUrl:shop} {previewUrl:other}" }),
    );
    await expectProblem(
      b.folder,
      "{previewUrl:other} の名前が apps にありません",
    );
    const c = await withE2e(["shop"]);
    await expectProblem(c.folder, "companion はオブジェクトにしてください");
  });

  describe("capture", () => {
    const cap = (extra: Record<string, unknown> = {}) => ({
      command: "pnpm test:e2e --video --base-url {previewUrl:shop}",
      output: "test-results",
      ...extra,
    });

    it("正しい形が読める", async () => {
      const { folder } = await withE2e(companion({ capture: cap() }));
      const ws = await load(folder);
      expect(
        ws.repos.find((r) => r.name === "e2e-tests")?.companion?.capture,
      ).toEqual(cap());
      const nested = await withE2e(
        companion({ capture: cap({ output: "out/videos/" }) }),
      );
      await load(nested.folder);
    });

    it("output の空・「.」・「..」・絶対パスは設定の誤り", async () => {
      for (const output of [
        "",
        " ",
        ".",
        "..",
        "a/../b",
        "./a",
        "/abs",
        "a//b",
        1,
      ]) {
        const { folder } = await withE2e(
          companion({ capture: cap({ output }) }),
        );
        await expectProblem(folder, "capture.output");
      }
    });

    it("command の印の外れと知らないキーは設定の誤り", async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ command: "pnpm test:e2e" }, "capture.command に {previewUrl"],
        [
          { command: "run {previewUrl:other}" },
          "{previewUrl:other} の名前が apps にありません",
        ],
        [{ command: "run '{previewUrl:shop}'" }, "引用符で囲まないでください"],
        [
          { extra: 1 },
          "知らないキー repos[2]（e2e-tests）.companion.capture.extra",
        ],
      ];
      for (const [extra, part] of cases) {
        const { folder } = await withE2e(companion({ capture: cap(extra) }));
        await expectProblem(folder, part);
      }
      const missing = await withE2e(companion({ capture: { output: "x" } }));
      await expectProblem(missing.folder, "capture.command がありません");
      const notObject = await withE2e(companion({ capture: "x" }));
      await expectProblem(
        notObject.folder,
        "capture はオブジェクトにしてください",
      );
    });
  });
});

describe("runChildCli", () => {
  it("node の警告を消す旗と main.ts を付け、子のパスを作業の場所にして env を渡す", async () => {
    const { runChildCli } = await import("../../src/lib/workspace.ts");
    const { ORCA_FLOW_MAIN } = await import("../../src/lib/background.ts");
    const seen: { cmd: string; args: string[]; opts: unknown }[] = [];
    const runner = async (
      cmd: string,
      args: readonly string[],
      opts?: unknown,
    ) => {
      seen.push({ cmd, args: [...args], opts });
      return { code: 0, stdout: "ok", stderr: "", timedOut: false };
    };
    const repo = { name: "shop", path: "/child/shop" } as never;
    const r = await runChildCli(runner, { A: "1" }, repo, ["config", "--json"]);
    expect(r.stdout).toBe("ok");
    expect(seen).toEqual([
      {
        cmd: process.execPath,
        args: [
          "--disable-warning=ExperimentalWarning",
          ORCA_FLOW_MAIN,
          "config",
          "--json",
        ],
        opts: { cwd: "/child/shop", env: { A: "1" } },
      },
    ]);
  });
});
