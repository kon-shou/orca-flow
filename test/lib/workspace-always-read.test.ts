import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testRunner } from "../helpers/runner.ts";
import { makeRepo, tempDir } from "../helpers/repo.ts";
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
const app = (name: string, p: string, extra: Record<string, unknown> = {}) => ({
  name,
  path: p,
  role: "app",
  keywords: ["注文"],
  ...extra,
});

async function setup(build: (p: Record<string, string>) => unknown[]) {
  const folder = await tempDir("orca-flow-ws-");
  const paths = {
    kit: await makeRepo(),
    shop: await makeRepo(),
    blog: await makeRepo(),
    docs: await makeRepo(),
  };
  await writeFile(
    path.join(folder, WORKSPACE_FILE),
    JSON.stringify({ repos: build(paths) }),
  );
  return folder;
}

async function problem(folder: string) {
  const error = await loadWorkspace(testRunner, folder).then(
    () => null,
    (e: unknown) => e as Error & { code: number },
  );
  expect(error?.code).toBe(1);
  return error?.message ?? "";
}

describe("workspace：alwaysRead", () => {
  it("true の子だけが印を持つ。false とキーなしは持たない。共通の true も通る", async () => {
    const folder = await setup((p) => [
      common(p.kit!, { alwaysRead: true }),
      app("shop", p.shop!, { alwaysRead: true }),
      app("blog", p.blog!, { alwaysRead: false }),
      app("docs", p.docs!),
    ]);
    const ws = await loadWorkspace(testRunner, folder);
    const by = Object.fromEntries(ws.repos.map((r) => [r.name, r]));
    expect(by.kit!.alwaysRead).toBe(true);
    expect(by.shop!.alwaysRead).toBe(true);
    expect(by.blog).not.toHaveProperty("alwaysRead");
    expect(by.docs).not.toHaveProperty("alwaysRead");
  });

  it("真偽でない値は、ほかの誤りとまとめて設定の誤りになる。文に子の名前とキーが出る", async () => {
    const folder = await setup((p) => [
      common(p.kit!),
      app("shop", p.shop!, { alwaysRead: "yes" }),
      app("blog", p.blog!, { alwaysRead: 1, bogus: 1 }),
    ]);
    const message = await problem(folder);
    expect(message).toContain("repos[1]（shop）.alwaysRead");
    expect(message).toContain("repos[2]（blog）.alwaysRead");
    expect(message).toContain("真偽");
    expect(message).toContain("知らないキー repos[2]（blog）.bogus");
  });

  it("共通の false は誤りで、共通はいつも読むと伝える", async () => {
    const folder = await setup((p) => [
      common(p.kit!, { alwaysRead: false }),
      app("shop", p.shop!),
    ]);
    const message = await problem(folder);
    expect(message).toContain("repos[0]（kit）.alwaysRead");
    expect(message).toContain("共通はいつも読む");
  });
});
