import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FROM_WORKSPACE_ENV,
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { main } from "../../src/cli.ts";
import { readReadFirstAt } from "../../src/lib/read-first-record.ts";
import { FlowError } from "../../src/types.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { git, makeRepo, tempDir } from "../helpers/repo.ts";

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

const PARENT = "T03";
const CHILD = "T03a";

async function setup() {
  const root = await makeRepo();
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const dir = path.join(common, "orca-flow/read-first");
  return {
    root,
    common,
    parent: path.join(dir, `${PARENT}.json`),
    child: path.join(dir, `${CHILD}.json`),
    request: path.join(common, "orca-flow/requests", `${CHILD}.md`),
  };
}

async function put(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

const record = (id: string, paths: unknown) =>
  JSON.stringify({ id, at: "2026-01-01T00:00:00.000Z", paths });

async function newChild(
  root: string,
  orca: ReturnType<typeof fakeOrca>,
  extra: string[],
  env: Record<string, string> = {},
) {
  const err: string[] = [];
  const requestFile = path.join(await tempDir(), "request.md");
  await writeFile(requestFile, "子の依頼\n");
  const code = await main(
    [
      "new",
      "--title",
      "子",
      "--slug",
      "child",
      "--id",
      CHILD,
      "--request-file",
      requestFile,
      ...extra,
    ],
    {
      cwd: root,
      runner: orca.runner,
      env,
      stdout: () => {},
      stderr: (t) => err.push(t),
    },
  );
  return { code, err: err.join("\n") };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const FIX_HINT = "直してからもう一度流してください";

/** worktree create が呼ばれた時点で、子の記録の中身を控える偽の Orca */
function watchingChild(file: string) {
  const orca = fakeOrca();
  const seen: { child: unknown } = { child: undefined };
  const inner = orca.runner;
  orca.runner = async (cmd, args, opts) => {
    if (cmd === "orca" && args[0] === "worktree" && args[1] === "create")
      seen.child = await readFile(file, "utf8").then(
        (t) => JSON.parse(t) as unknown,
        () => null,
      );
    return inner(cmd, args, opts);
  };
  return { orca, seen };
}

describe("new --read-first-from", () => {
  it("親の記録があれば、親の印がなくても子の ID で同じ並びの記録ができる", async () => {
    const s = await setup();
    const paths = ["/docs/b.md", "/docs/a.md"];
    await put(s.parent, record(PARENT, paths));
    const { orca, seen } = watchingChild(s.child);
    const r = await newChild(s.root, orca, ["--read-first-from", PARENT]);
    expect(r.code, r.err).toBe(0);
    expect(orca.calls.length).toBeGreaterThan(0);
    // Orca を呼んだ時点で子のタスク長が読み始めるので、その前に記録ができている
    expect(seen.child).toMatchObject({ id: CHILD, paths });
    const child = JSON.parse(await readFile(s.child, "utf8"));
    expect(child).toMatchObject({ id: CHILD, paths });
    expect(typeof child.at).toBe("string");
    // 親の記録はそのまま残る
    expect(JSON.parse(await readFile(s.parent, "utf8")).id).toBe(PARENT);
  });

  it("親の印があっても同じように写す", async () => {
    const s = await setup();
    const paths = ["/docs/a.md"];
    await put(s.parent, record(PARENT, paths));
    const r = await newChild(
      s.root,
      fakeOrca(),
      ["--read-first-from", PARENT],
      {
        [FROM_WORKSPACE_ENV]: "1",
      },
    );
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(await readFile(s.child, "utf8")).paths).toEqual(paths);
  });

  it("親の記録がなければ new は通り、子の記録はできない", async () => {
    const s = await setup();
    const r = await newChild(s.root, fakeOrca(), ["--read-first-from", PARENT]);
    expect(r.code, r.err).toBe(0);
    expect(await exists(s.child)).toBe(false);
  });

  it("親の記録がなければ、同じ子の ID の古い記録を消す", async () => {
    const s = await setup();
    await put(s.child, record(CHILD, ["/docs/old.md"]));
    const r = await newChild(s.root, fakeOrca(), ["--read-first-from", PARENT]);
    expect(r.code, r.err).toBe(0);
    expect(await exists(s.child)).toBe(false);
  });

  it.each([
    ["JSON でない", "not json"],
    ["オブジェクトでない", "[]"],
    ["id が違う", record("T09", ["/docs/a.md"])],
    ["paths に相対パス", record(PARENT, ["docs/a.md"])],
    ["paths が空", record(PARENT, [])],
    ["paths が並びでない", record(PARENT, "/docs/a.md")],
    ["paths に空の文字列", record(PARENT, [""])],
    ["paths に文字列でないもの", record(PARENT, [1])],
    ["paths がない", JSON.stringify({ id: PARENT })],
  ])(
    "親の記録が壊れている（%s）と、Orca を呼ばず何も作らず終了コード1",
    async (_, text) => {
      const s = await setup();
      await put(s.parent, text);
      const orca = fakeOrca();
      const r = await newChild(s.root, orca, ["--read-first-from", PARENT]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(PARENT);
      expect(r.err).toContain("先に読む文書の記録が壊れています");
      expect(r.err).toContain(FIX_HINT);
      expect(orca.calls).toEqual([]);
      expect(await exists(s.child)).toBe(false);
      expect(await exists(s.request)).toBe(false);
      expect(await git(s.root, "worktree", "list")).not.toContain("child");
    },
  );

  it("壊れた親の記録では、同じ子の ID の古い記録を残す（何も変えない）", async () => {
    const s = await setup();
    await put(s.parent, "not json");
    const old = record(CHILD, ["/docs/old.md"]);
    await put(s.child, old);
    const r = await newChild(s.root, fakeOrca(), ["--read-first-from", PARENT]);
    expect(r.code).toBe(1);
    expect(await readFile(s.child, "utf8")).toBe(old);
  });

  it("親の記録を読めない（場所がディレクトリ）と、理由を添えて Orca を呼ばず何も作らず終了コード1", async () => {
    const s = await setup();
    await mkdir(s.parent, { recursive: true });
    const orca = fakeOrca();
    const r = await newChild(s.root, orca, ["--read-first-from", PARENT]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("先に読む文書の記録を読めません");
    expect(r.err).toContain("（理由：EISDIR）");
    expect(r.err).toContain(FIX_HINT);
    expect(orca.calls).toEqual([]);
    expect(await exists(s.child)).toBe(false);
    expect(await exists(s.request)).toBe(false);
    expect(await git(s.root, "worktree", "list")).not.toContain("child");
  });

  it("--read-first-json と一緒に付けると、Orca を呼ばず終了コード1", async () => {
    const s = await setup();
    await put(s.parent, record(PARENT, ["/docs/a.md"]));
    const orca = fakeOrca();
    const r = await newChild(
      s.root,
      orca,
      [
        "--read-first-from",
        PARENT,
        "--read-first-json",
        JSON.stringify(["/docs/b.md"]),
      ],
      { [FROM_WORKSPACE_ENV]: "1" },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("--read-first-from");
    expect(r.err).toContain("--read-first-json");
    expect(orca.calls).toEqual([]);
    expect(await exists(s.child)).toBe(false);
    expect(await exists(s.request)).toBe(false);
  });

  it.each([
    ["頭の文字が違う", "X03"],
    ["数字がない", "T"],
    ["区切りを含む", "T03/../T04"],
    ["空", ""],
  ])(
    "親の ID の形が外れる（%s）と、Orca を呼ばず終了コード1",
    async (_, id) => {
      const s = await setup();
      const orca = fakeOrca();
      const r = await newChild(s.root, orca, ["--read-first-from", id]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("--read-first-from");
      expect(orca.calls).toEqual([]);
      expect(await exists(s.child)).toBe(false);
      expect(await exists(s.request)).toBe(false);
    },
  );

  it("使い方の文に --read-first-from がある", async () => {
    const s = await setup();
    const err: string[] = [];
    const code = await main(["new"], {
      cwd: s.root,
      runner: fakeOrca().runner,
      env: {},
      stdout: () => {},
      stderr: (t) => err.push(t),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("[--read-first-from 〈親の ID〉]");
  });
});

describe("先に読む文書の記録を読む", () => {
  it("ファイルがなければ null を返す", async () => {
    const s = await setup();
    expect(await readReadFirstAt(s.common, PARENT)).toBeNull();
  });

  it("形の正しい記録の paths を返す", async () => {
    const s = await setup();
    await put(s.parent, record(PARENT, ["/docs/a.md", "/docs/b.md"]));
    expect(await readReadFirstAt(s.common, PARENT)).toEqual([
      "/docs/a.md",
      "/docs/b.md",
    ]);
  });

  it("壊れた記録は終了コード1の誤りにする", async () => {
    const s = await setup();
    await put(s.parent, record(PARENT, ["docs/a.md"]));
    const error = await readReadFirstAt(s.common, PARENT).catch((e) => e);
    expect(error).toBeInstanceOf(FlowError);
    expect((error as FlowError).code).toBe(1);
  });
});
