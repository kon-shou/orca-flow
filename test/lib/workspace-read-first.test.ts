import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testRunner } from "../helpers/runner.ts";
import { makeRepo, tempDir } from "../helpers/repo.ts";
import {
  WORKSPACE_FILE,
  loadWorkspace,
  parseWorkspace,
} from "../../src/lib/workspace.ts";

async function setup(readFirst?: unknown) {
  const outer = await tempDir("orca-flow-ws-");
  const folder = path.join(outer, "ws");
  await mkdir(folder);
  const repos = [
    {
      name: "kit",
      path: await makeRepo(),
      role: "common",
      keywords: ["共通"],
      scope: "部品",
      package: "@example/kit",
      bumpCommand: "pnpm up @example/kit",
    },
    { name: "shop", path: await makeRepo(), role: "app", keywords: ["注文"] },
  ];
  const config = {
    repos,
    ...(readFirst === undefined ? {} : { readFirst }),
  };
  await writeFile(path.join(folder, WORKSPACE_FILE), JSON.stringify(config));
  await mkdir(path.join(folder, "docs"));
  await writeFile(path.join(folder, "docs", "a.md"), "a");
  await writeFile(path.join(outer, "b.md"), "b");
  return { outer, folder, config };
}

async function problem(folder: string) {
  const error = await loadWorkspace(testRunner, folder).then(
    () => null,
    (e: unknown) => e as Error & { code: number },
  );
  expect(error?.code).toBe(1);
  return error?.message ?? "";
}

describe("workspace：readFirst", () => {
  it("欄がなければ readFirst のキーがない", async () => {
    const { folder } = await setup();
    expect(await loadWorkspace(testRunner, folder)).not.toHaveProperty(
      "readFirst",
    );
  });

  it("空の配列でもキーがない", async () => {
    const { folder } = await setup([]);
    expect(await loadWorkspace(testRunner, folder)).not.toHaveProperty(
      "readFirst",
    );
  });

  it("相対（フォルダの外を含む）を実の絶対パスにし、重なりを1つにして順を保つ", async () => {
    const { outer, folder } = await setup([
      "../b.md",
      "docs/a.md",
      "./docs/../docs/a.md",
      "../b.md",
    ]);
    const ws = await loadWorkspace(testRunner, folder);
    expect(ws.readFirst).toEqual([
      path.join(await realpath(outer), "b.md"),
      path.join(ws.dir, "docs", "a.md"),
    ]);
  });

  it("シンボリックリンクは実のパスになる", async () => {
    const { outer, folder } = await setup(["link.md"]);
    await symlink(path.join(outer, "b.md"), path.join(folder, "link.md"));
    const ws = await loadWorkspace(testRunner, folder);
    expect(ws.readFirst).toEqual([path.join(await realpath(outer), "b.md")]);
  });

  it("ないファイルは、パスを書いた誤りで止まる", async () => {
    const { folder } = await setup(["docs/none.md"]);
    expect(await problem(folder)).toContain("docs/none.md");
  });

  it("フォルダは通常のファイルではない誤り", async () => {
    const { folder } = await setup(["docs"]);
    expect(await problem(folder)).toContain("readFirst[0]");
  });

  it("空の文字列・文字列でない値・配列でない値は誤り", async () => {
    const a = await problem((await setup([""])).folder);
    expect(a).toContain("readFirst[0]");
    const b = await problem((await setup([1])).folder);
    expect(b).toContain("readFirst[0]");
    const c = await problem((await setup("docs/a.md")).folder);
    expect(c).toContain("readFirst は文字列の配列");
  });

  it("ほかの誤りとまとめて止まる", async () => {
    const { folder } = await setup(["nope.md"]);
    const file = path.join(folder, WORKSPACE_FILE);
    const cfg = JSON.parse(await readFile(file, "utf8")) as {
      repos: Record<string, unknown>[];
    };
    cfg.repos[1]!.keywords = [];
    await writeFile(file, JSON.stringify(cfg));
    const message = await problem(folder);
    expect(message).toContain("nope.md");
    expect(message).toContain("keywords");
  });

  it("--setup の計画の読み方では、ないファイルを誤りにしない", async () => {
    const { folder, config } = await setup(["nope.md", "docs/a.md"]);
    const ws = await parseWorkspace(
      testRunner,
      await realpath(folder),
      Buffer.from(JSON.stringify(config)),
      { allowMissing: true },
    );
    expect(ws.readFirst).toEqual([path.join(ws.dir, "docs", "a.md")]);
  });

  it("--setup の計画の読み方でも、形の誤りは止まる", async () => {
    const { folder, config } = await setup([""]);
    const dir = await realpath(folder);
    await expect(
      parseWorkspace(testRunner, dir, Buffer.from(JSON.stringify(config)), {
        allowMissing: true,
      }),
    ).rejects.toMatchObject({ code: 1 });
  });
});

describe("workspace：readFirst のないことだけを許す読み方", () => {
  it("ない文書を誤りにせず、絶対パスで readFirstMissing に入れる", async () => {
    const { folder } = await setup(["nope.md", "docs/a.md", "./nope.md"]);
    const ws = await loadWorkspace(testRunner, folder, {
      allowMissingReadFirst: true,
    });
    expect(ws.readFirst).toEqual([path.join(ws.dir, "docs", "a.md")]);
    expect(ws.readFirstMissing).toEqual([path.join(ws.dir, "nope.md")]);
  });

  it("文書のほかの誤りは今までどおり止まる", async () => {
    const { folder } = await setup(["nope.md"]);
    const file = path.join(folder, WORKSPACE_FILE);
    const cfg = JSON.parse(await readFile(file, "utf8")) as {
      repos: Record<string, unknown>[];
    };
    cfg.repos[1]!.keywords = [];
    await writeFile(file, JSON.stringify(cfg));
    await expect(
      loadWorkspace(testRunner, folder, { allowMissingReadFirst: true }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("フォルダを指す文書や形の誤りは、許す読み方でも止まる", async () => {
    const a = await setup(["docs"]);
    await expect(
      loadWorkspace(testRunner, a.folder, { allowMissingReadFirst: true }),
    ).rejects.toMatchObject({ code: 1 });
    const b = await setup([""]);
    await expect(
      loadWorkspace(testRunner, b.folder, { allowMissingReadFirst: true }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("許さない読み方は、ない文書で今までどおり止まる", async () => {
    const { folder } = await setup(["nope.md"]);
    expect(await problem(folder)).toContain("nope.md");
  });

  it("計画の読み方は readFirst を変えず、ない文書を readFirstMissing に入れる", async () => {
    const { folder, config } = await setup(["nope.md", "docs/a.md"]);
    const dir = await realpath(folder);
    const ws = await parseWorkspace(
      testRunner,
      dir,
      Buffer.from(JSON.stringify(config)),
      { allowMissing: true },
    );
    expect(ws.readFirst).toEqual([path.join(dir, "docs", "a.md")]);
    expect(ws.readFirstMissing).toEqual([path.join(dir, "nope.md")]);
  });
});
