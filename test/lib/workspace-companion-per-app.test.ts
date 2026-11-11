import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testRunner as realRunner } from "../helpers/runner.ts";
import { makeRepo, tempDir } from "../helpers/repo.ts";
import { WORKSPACE_FILE, loadWorkspace } from "../../src/lib/workspace.ts";

const app = (name: string, p: string) => ({
  name,
  path: p,
  role: "app",
  keywords: [name],
});

const companion = (extra: Record<string, unknown> = {}) => ({
  apps: ["app-a", "app-b"],
  when: "利用者から見た画面の動きが変わるとき",
  command: {
    "app-a": "run-a --base {previewUrl:app-a}",
    "app-b": "run-b --base {previewUrl:app-b} --other {previewUrl:app-a}",
  },
  ...extra,
});

async function withE2e(c: unknown) {
  const folder = await tempDir("orca-flow-ws-");
  const repos = [
    {
      name: "kit",
      path: await makeRepo(),
      role: "common",
      keywords: ["共通部品"],
      scope: "画面の部品",
      package: "@example/kit",
      bumpCommand: "pnpm up @example/kit",
    },
    app("app-a", await makeRepo()),
    app("app-b", await makeRepo()),
    { ...app("e2e", await makeRepo()), companion: c },
  ];
  await writeFile(
    path.join(folder, WORKSPACE_FILE),
    JSON.stringify({ repos }, null, 2),
  );
  return folder;
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

describe("設定：アプリごとのコマンド", () => {
  it("オブジェクトの command と capture.command が読める", async () => {
    const capture = {
      command: { "app-b": "run-b --video {previewUrl:app-b}" },
      output: "videos",
    };
    const folder = await withE2e(companion({ capture }));
    const ws = await load(folder);
    expect(ws.repos.find((r) => r.name === "e2e")?.companion).toEqual(
      companion({ capture }),
    );
  });

  it("キーのないアプリは、ほかのコマンドの印の相手としてだけ使える", async () => {
    const folder = await withE2e(
      companion({
        command: {
          "app-a": "run-a {previewUrl:app-a} {previewUrl:app-b}",
        },
      }),
    );
    await load(folder);
  });

  it("文字列の command はこれまでどおり通る", async () => {
    const folder = await withE2e(
      companion({ command: "run {previewUrl:app-a} {previewUrl:app-b}" }),
    );
    await load(folder);
  });

  const cases: [string, unknown, string][] = [
    [
      "キーが apps にない",
      { "app-c": "run {previewUrl:app-a}" },
      "command のキー app-c が apps にありません",
    ],
    ["空のオブジェクト", {}, "command は空でない文字列か"],
    ["値が空", { "app-a": " " }, "command.app-a は空でない文字列"],
    ["値が文字列でない", { "app-a": 1 }, "command.app-a は空でない文字列"],
    [
      "自分のキーの印がない",
      { "app-a": "run {previewUrl:app-b}" },
      "command.app-a に {previewUrl:app-a}",
    ],
    [
      "apps にない印",
      { "app-a": "run {previewUrl:app-a} {previewUrl:other}" },
      "{previewUrl:other} の名前が apps にありません",
    ],
    [
      "引用符で囲んだ印",
      { "app-a": "run '{previewUrl:app-a}'" },
      "引用符で囲まないでください",
    ],
    ["配列", ["run {previewUrl:app-a}"], "command は空でない文字列か"],
  ];

  for (const [label, command, part] of cases) {
    it(`command：${label}は設定の誤り`, async () => {
      await expectProblem(await withE2e(companion({ command })), part);
    });
    it(`capture.command：${label}は設定の誤り`, async () => {
      await expectProblem(
        await withE2e(companion({ capture: { command, output: "videos" } })),
        "capture.command",
        part,
      );
    });
  }
});
