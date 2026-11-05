import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testRunner as realRunner } from "../helpers/runner.ts";
import { makeRepo, tempDir } from "../helpers/repo.ts";
import { WORKSPACE_FILE, loadWorkspace } from "../../src/lib/workspace.ts";

const common = (p: string, extra: Record<string, unknown> = {}) => ({
  name: "core-kit",
  path: p,
  role: "common",
  keywords: ["共通部品"],
  scope: "画面の部品",
  package: "acme/core-kit",
  bumpCommand: "composer require acme/core-kit:^1",
  ...extra,
});
const app = (p: string, extra: Record<string, unknown> = {}) => ({
  name: "shop-app",
  path: p,
  role: "app",
  keywords: ["注文"],
  ...extra,
});

async function setup() {
  return {
    folder: await tempDir("orca-flow-ws-"),
    kit: await makeRepo(),
    shop: await makeRepo(),
  };
}

async function put(folder: string, repos: unknown) {
  await writeFile(path.join(folder, WORKSPACE_FILE), JSON.stringify({ repos }));
}

async function problem(folder: string) {
  const e = await loadWorkspace(realRunner, folder).then(
    () => null,
    (x: unknown) => x as Error & { code: number },
  );
  expect(e?.code).toBe(1);
  return e!.message;
}

describe("設定の branchCommand", () => {
  it("共通の欄の branchCommand を読む。なければ undefined", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [
      common(kit, { branchCommand: "composer require core-kit:dev-{branch}" }),
      app(shop),
    ]);
    const ws = await loadWorkspace(realRunner, folder);
    expect(ws.repos[0]!.branchCommand).toBe(
      "composer require core-kit:dev-{branch}",
    );
    expect(ws.repos[1]!.branchCommand).toBeUndefined();
    await put(folder, [common(kit), app(shop)]);
    const plain = await loadWorkspace(realRunner, folder);
    expect("branchCommand" in plain.repos[0]!).toBe(false);
  });

  it("{branch} がない・空の文字列・アプリの欄にあるのは誤り", async () => {
    const { folder, kit, shop } = await setup();
    await put(folder, [
      common(kit, { branchCommand: "composer update" }),
      app(shop),
    ]);
    expect(await problem(folder)).toContain("{branch}");
    await put(folder, [common(kit, { branchCommand: "" }), app(shop)]);
    expect(await problem(folder)).toContain("branchCommand");
    await put(folder, [common(kit, { branchCommand: 3 }), app(shop)]);
    expect(await problem(folder)).toContain("branchCommand");
    await put(folder, [
      common(kit),
      app(shop, { branchCommand: "x {branch}" }),
    ]);
    expect(await problem(folder)).toContain("共通（common）だけの欄");
  });
});
