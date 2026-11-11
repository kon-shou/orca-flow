import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { realRunner } from "../../src/lib/exec.ts";
import { capture, git, makeRepo, tempDir } from "../init/helpers.ts";

interface Draft {
  name: string | null;
  path: string;
  url: string | null;
  package: string | null;
  manager: string | null;
  e2e: string | null;
  role: string;
  users: string[] | null;
  problems: string[];
}

const pkg = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify({ name, dependencies: deps });

/** 親のフォルダの中に、ワークスペースのフォルダと子のリポジトリを置く */
function layout(children: Record<string, Record<string, string>>) {
  const parent = tempDir("orca-flow-draft-");
  const ws = path.join(parent, "ws");
  mkdirSync(ws);
  const paths: Record<string, string> = {};
  for (const [name, files] of Object.entries(children)) {
    const repo = makeRepo(files);
    execFileSync("mv", [repo, path.join(parent, name)]);
    paths[name] = path.join(parent, name);
  }
  return { parent, ws, paths };
}

async function draft(cwd: string, args: string[] = []) {
  const io = capture();
  const code = await main(["workspace", "--draft", ...args, "--json"], {
    ...io,
    cwd,
    runner: realRunner,
  });
  const text = io.text();
  return {
    code,
    text,
    err: io.errText(),
    data:
      code === 0 ? (JSON.parse(text) as { dir: string; repos: Draft[] }) : null,
  };
}

function snapshot(root: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const f = path.join(d, e);
      if (statSync(f).isDirectory()) {
        out.push(`${f}/`);
        if (e === ".git") {
          for (const g of ["config", "HEAD", "index"])
            out.push(
              `${f}/${g}:${readFileSync(path.join(f, g)).toString("base64")}`,
            );
        } else walk(f);
      } else out.push(`${f}:${readFileSync(f, "utf8")}`);
    }
  };
  walk(root);
  return out.join("\n");
}

describe("workspace --draft", () => {
  it("子ごとの欄を、親のフォルダの直下から出す", async () => {
    const { ws, paths } = layout({
      "demo-core": {
        "package.json": pkg("@demo/core"),
        "pnpm-lock.yaml": "lock\n",
      },
      "Demo App": {
        "package.json": pkg("demo-app", { "@demo/core": "1.0.0" }),
        "yarn.lock": "",
      },
      "demo-php": {
        "composer.json": JSON.stringify({ name: "demo/php" }),
        "composer.lock": "{}",
      },
    });
    mkdirSync(path.join(path.dirname(ws), "not-a-repo"));
    git(
      paths["demo-core"]!,
      "remote",
      "add",
      "origin",
      "https://example.invalid/demo/core.git",
    );
    const r = await draft(ws);
    expect(r.code).toBe(0);
    const byPath = Object.fromEntries(r.data!.repos.map((x) => [x.path, x]));
    expect(Object.keys(byPath).sort()).toEqual([
      "../Demo App",
      "../demo-core",
      "../demo-php",
    ]);
    expect(byPath["../demo-core"]).toMatchObject({
      name: "demo-core",
      url: "https://example.invalid/demo/core.git",
      package: "@demo/core",
      manager: "pnpm",
      role: "common",
      users: ["Demo App"],
      problems: [],
    });
    expect(byPath["../Demo App"]).toMatchObject({
      name: null,
      url: null,
      package: "demo-app",
      manager: "yarn",
      role: "app",
      users: [],
    });
    expect(byPath["../demo-php"]).toMatchObject({
      package: "demo/php",
      manager: "composer",
      role: "app",
    });
    expect(path.basename(r.data!.dir)).toBe("ws");
  });

  it("パスを渡せばそれだけを対象にし、パッケージ名は HEAD から読む", async () => {
    const { ws, paths } = layout({
      core: { "package.json": pkg("@demo/core") },
      other: { "package.json": pkg("other") },
    });
    writeUncommitted(paths["core"]!);
    const r = await draft(ws, [paths["core"]!]);
    expect(r.data!.repos).toHaveLength(1);
    expect(r.data!.repos[0]!.package).toBe("@demo/core");
  });

  it("共通のパッケージ名は、アプリの作業ツリーの未コミットの変更では users に出ない", async () => {
    const { ws, paths } = layout({
      core: { "package.json": pkg("@demo/core") },
      app: { "package.json": pkg("a") },
    });
    execFileSync(
      "sh",
      ["-c", `printf '%s' '${pkg("a", { "@demo/core": "1" })}' > package.json`],
      { cwd: paths["app"]! },
    );
    const r = await draft(ws);
    const core = r.data!.repos.find((x) => x.path === "../core")!;
    expect(core.users).toEqual([]);
    expect(core.role).toBe("app");
  });

  it("コミットのない git init が隣にあっても、ほかの users と role は変わらない", async () => {
    const { ws, paths } = layout({
      core: { "package.json": pkg("@demo/core") },
      app: { "package.json": pkg("a", { "@demo/core": "1" }) },
    });
    const empty = path.join(path.dirname(ws), "empty");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    const r = await draft(ws);
    expect(r.code).toBe(0);
    const by = Object.fromEntries(r.data!.repos.map((x) => [x.path, x]));
    expect(by["../core"]).toMatchObject({ role: "common", users: ["app"] });
    expect(by["../empty"]!.problems.join("")).toContain("コミットがありません");
    expect(Object.keys(paths)).toHaveLength(2);
  });

  it("git の呼び出しは対象の数に比例する", async () => {
    const count = async (n: number) => {
      const files: Record<string, Record<string, string>> = {};
      for (let i = 0; i < n; i++)
        files[`r${i}`] = { "package.json": pkg(`@demo/p${i}`) };
      const { ws } = layout(files);
      let greps = 0;
      const io = capture();
      await main(["workspace", "--draft", "--json"], {
        ...io,
        cwd: ws,
        runner: (cmd, args, opts) => {
          if (cmd === "git" && args[0] === "grep") greps++;
          return realRunner(cmd, args, opts);
        },
      });
      return greps;
    };
    expect(await count(3)).toBe(3);
    expect(await count(6)).toBe(6);
  });

  it("探すのは親のフォルダの直下だけで、ワークスペースの下のフォルダは候補に出ない", async () => {
    const { parent, ws } = layout({ core: {} });
    mkdirSync(path.join(parent, "plain"));
    const r = await draft(ws);
    expect(r.data!.repos.map((x) => x.path)).toEqual(["../core"]);
  });

  it("渡したパスに使えないものがあれば、1件ずつ problems に理由が出る", async () => {
    const { parent, ws, paths } = layout({ core: {}, outer: {}, fine: {} });
    const sub = path.join(paths["core"]!, "sub");
    mkdirSync(sub);
    const plain = path.join(parent, "plain");
    mkdirSync(plain);
    const missing = path.join(parent, "missing");
    const inner = path.join(paths["outer"]!, "inner");
    git(paths["outer"]!, "init", "-q", "-b", "main", inner);
    const r = await draft(ws, [
      sub,
      missing,
      plain,
      ws,
      paths["outer"]!,
      inner,
    ]);
    expect(r.code).toBe(0);
    const by = Object.fromEntries(r.data!.repos.map((x) => [x.path, x]));
    const prob = (p: string) => by[p]!.problems.join("");
    expect(prob("../core/sub")).toContain("一番上ではありません");
    expect(prob("../missing")).toContain("見つかりません");
    expect(prob("../plain")).toContain("git のリポジトリではありません");
    expect(prob(".")).toContain("入れ子か同じ場所");
    expect(prob("../outer")).toContain("入れ子");
    expect(prob("../outer/inner")).toContain("入れ子");
  });

  it("トークンだけの clone 元は url が null になり、どこにも値が出ない", async () => {
    const { ws, paths } = layout({ core: { "package.json": pkg("c") } });
    git(
      paths["core"]!,
      "remote",
      "add",
      "origin",
      "https://tok3nvalue99@example.invalid/demo/core.git",
    );
    for (const json of [true, false]) {
      const io = capture();
      const code = await main(
        ["workspace", "--draft", ...(json ? ["--json"] : [])],
        { ...io, cwd: ws, runner: realRunner },
      );
      expect(code).toBe(0);
      expect(io.text() + io.errText()).not.toContain("tok3nvalue99");
    }
    const r = await draft(ws);
    expect(r.data!.repos[0]!.url).toBeNull();
    expect(r.data!.repos[0]!.problems.join("")).toContain("認証");
  });

  it("「-」で始まる clone 元は url が null になり、理由が出る", async () => {
    const { ws, paths } = layout({ core: {} });
    git(
      paths["core"]!,
      "config",
      "remote.origin.url",
      "-oProxy=example.invalid",
    );
    const r = await draft(ws);
    expect(r.data!.repos[0]!.url).toBeNull();
    expect(r.data!.repos[0]!.problems.join("")).toContain("「-」");
  });

  it("両方の定義に name があれば package.json を取り、どちらもなければ null", async () => {
    const { ws } = layout({
      both: {
        "package.json": pkg("from-npm"),
        "composer.json": JSON.stringify({ name: "from/composer" }),
      },
      none: {},
    });
    const r = await draft(ws);
    const by = Object.fromEntries(r.data!.repos.map((x) => [x.path, x]));
    expect(by["../both"]!.package).toBe("from-npm");
    expect(by["../none"]!.package).toBeNull();
    expect(by["../none"]!.manager).toBeNull();
  });

  it("認証の値の入った clone 元は url が null になり、どこにも値が出ない", async () => {
    const { ws, paths } = layout({ core: { "package.json": pkg("c") } });
    git(
      paths["core"]!,
      "remote",
      "add",
      "origin",
      "https://alice:s3cretvalue@example.invalid/demo/core.git",
    );
    for (const json of [true, false]) {
      const io = capture();
      const code = await main(
        ["workspace", "--draft", ...(json ? ["--json"] : [])],
        {
          ...io,
          cwd: ws,
          runner: realRunner,
        },
      );
      expect(code).toBe(0);
      const all = io.text() + io.errText();
      expect(all).not.toContain("s3cretvalue");
      expect(all).not.toContain("alice");
    }
    const r = await draft(ws);
    expect(r.data!.repos[0]!.url).toBeNull();
    expect(r.data!.repos[0]!.problems.join("")).toContain("認証");
  });

  it("ユーザー名だけの ssh の clone 元はそのまま出す", async () => {
    const { ws, paths } = layout({ core: {} });
    git(
      paths["core"]!,
      "remote",
      "add",
      "origin",
      "ssh://git@example.invalid/demo/core.git",
    );
    const r = await draft(ws);
    expect(r.data!.repos[0]!.url).toBe(
      "ssh://git@example.invalid/demo/core.git",
    );
  });

  it("メインでない作業ツリーを渡すと problems に出し、探すときは除く", async () => {
    const { ws, paths } = layout({ core: {}, app: {} });
    const linked = path.join(path.dirname(ws), "linked");
    git(paths["core"]!, "worktree", "add", "-q", "-b", "side", linked);
    const found = await draft(ws);
    expect(found.data!.repos.map((x) => x.path).sort()).toEqual([
      "../app",
      "../core",
    ]);
    const given = await draft(ws, [linked]);
    expect(given.data!.repos[0]!.problems.join("")).toContain("worktree");
  });

  it("何も書かない", async () => {
    const { parent, ws, paths } = layout({
      core: { "package.json": pkg("@demo/core") },
      app: { "package.json": pkg("a", { "@demo/core": "1" }) },
    });
    const before = snapshot(parent);
    const heads = Object.values(paths).map((p) => git(p, "rev-parse", "HEAD"));
    const r = await draft(ws);
    expect(r.code).toBe(0);
    expect(snapshot(parent)).toBe(before);
    expect(
      Object.values(paths).map((p) => git(p, "rev-parse", "HEAD")),
    ).toEqual(heads);
    await draft(ws, [paths["core"]!, paths["app"]!]);
    expect(snapshot(parent)).toBe(before);
    expect(git(paths["core"]!, "status", "--porcelain")).toBe("");
  });

  it("対象がなければ 2、--setup と一緒なら 1、知らない旗も 1", async () => {
    const { ws } = layout({});
    expect((await draft(ws)).code).toBe(2);
    expect((await draft(ws, ["--setup"])).code).toBe(1);
    expect((await draft(ws, ["--nope"])).code).toBe(1);
  });
});

function writeUncommitted(repo: string) {
  execFileSync(
    "sh",
    ["-c", `printf '%s' '{"name":"changed"}' > package.json`],
    { cwd: repo },
  );
}

describe("workspace --draft の e2e", () => {
  it("HEAD の一番上の Playwright か Cypress の設定のファイル名を出し、なければ null", async () => {
    const { ws } = layout({
      "demo-pw": { "package.json": pkg("pw"), "playwright.config.ts": "x\n" },
      "demo-cy": { "package.json": pkg("cy"), "cypress.config.js": "x\n" },
      "demo-sub": {
        "package.json": pkg("sub"),
        "tests/playwright.config.ts": "x\n",
      },
      "demo-none": { "package.json": pkg("none") },
    });
    const r = await draft(ws);
    const by = Object.fromEntries(r.data!.repos.map((x) => [x.path, x]));
    expect(by["../demo-pw"]!.e2e).toBe("playwright.config.ts");
    expect(by["../demo-cy"]!.e2e).toBe("cypress.config.js");
    expect(by["../demo-sub"]!.e2e).toBeNull();
    expect(by["../demo-none"]!.e2e).toBeNull();
  });
});
