import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  companionBaseApps,
  parseCompanionJson,
  readCompanion,
  resolveCompanionArg,
} from "../../src/lib/companion.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const commonOf = async (dir: string) =>
  (
    await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();

const repos = (command: unknown, capture?: unknown) =>
  [
    { name: "app-a", path: "/ws/app-a" },
    { name: "app-b", path: "/ws/app-b" },
    { name: "app-c", path: "/ws/app-c" },
    {
      name: "e2e",
      path: "/ws/e2e",
      companion: {
        apps: ["app-a", "app-b", "app-c"],
        when: "画面が変わるとき",
        command,
        ...(capture === undefined ? {} : { capture }),
      },
    },
  ] as Parameters<typeof resolveCompanionArg>[0];

describe("--companion の解決：ブランチにない印のアプリ", () => {
  it("文字列の command で印のアプリが足りなくても止めず、baseApps に実のパスつきで入れる", () => {
    const command = "run {previewUrl:app-b} {previewUrl:app-a}";
    expect(
      JSON.parse(resolveCompanionArg(repos(command), "e2e", "app-b")!),
    ).toEqual({
      command,
      apps: [{ name: "app-b", path: "/ws/app-b" }],
      baseApps: [{ name: "app-a", path: "/ws/app-a" }],
    });
  });

  it("オブジェクトの command で写したコマンドの印のアプリが足りなくても baseApps に入れる", () => {
    const command = {
      "app-a": "run-a {previewUrl:app-a}",
      "app-b": "run-b {previewUrl:app-b} {previewUrl:app-a}",
    };
    expect(
      JSON.parse(resolveCompanionArg(repos(command), "e2e", "app-b")!),
    ).toEqual({
      command: { "app-b": command["app-b"] },
      apps: [{ name: "app-b", path: "/ws/app-b" }],
      baseApps: [{ name: "app-a", path: "/ws/app-a" }],
    });
  });

  it("capture.command の印のアプリも baseApps に入れる（重ならない）", () => {
    const capture = {
      command: { "app-b": "rec {previewUrl:app-b} {previewUrl:app-c}" },
      output: "videos",
    };
    const command = { "app-b": "run-b {previewUrl:app-b} {previewUrl:app-c}" };
    const parsed = JSON.parse(
      resolveCompanionArg(repos(command, capture), "e2e", "app-b")!,
    );
    expect(parsed.baseApps).toEqual([{ name: "app-c", path: "/ws/app-c" }]);
    expect(parsed.capture).toEqual(capture);
  });

  it("印のアプリが全部渡されていれば baseApps のキーを出さない", () => {
    const command = "run {previewUrl:app-a} {previewUrl:app-b}";
    expect(
      Object.keys(
        JSON.parse(resolveCompanionArg(repos(command), "e2e", "app-a,app-b")!),
      ),
    ).toEqual(["command", "apps"]);
  });

  it("知らない名前・apps にない名前・写すものがないときは今と同じく終了コード1", () => {
    const command = { "app-a": "run-a {previewUrl:app-a}" };
    for (const value of ["nope", "app-a,e2e", "app-b"])
      expect(
        () => resolveCompanionArg(repos(command), "e2e", value),
        value,
      ).toThrow(expect.objectContaining({ code: 1 }));
    const narrow = repos("run {previewUrl:app-a}").map((r) =>
      r.name === "e2e"
        ? { ...r, companion: { ...r.companion!, apps: ["app-a"] } }
        : r,
    );
    expect(() => resolveCompanionArg(narrow, "e2e", "app-b")).toThrow(
      expect.objectContaining({ code: 1 }),
    );
  });
});

describe("伴う記録の baseApps", () => {
  const value = {
    command: { "app-b": "run-b {previewUrl:app-b} {previewUrl:app-a}" },
    apps: [{ name: "app-b", path: "/tmp/app-b-main" }],
    baseApps: [{ name: "app-a", path: "/tmp/app-a-main" }],
  };

  it("印が baseApps を指す値を受ける", () => {
    expect(parseCompanionJson(JSON.stringify(value))).toEqual(value);
    expect(
      companionBaseApps(parseCompanionJson(JSON.stringify(value))),
    ).toEqual(value.baseApps);
  });

  it("baseApps の形の外れは終了コード1", () => {
    for (const baseApps of [
      "app-a",
      [{ name: "app-a" }],
      [{ name: "App A", path: "/tmp/a" }],
      [{ name: "app-b", path: "/tmp/b" }],
      [
        { name: "app-a", path: "/tmp/a" },
        { name: "app-a", path: "/tmp/a" },
      ],
      [{ name: "app-a", path: "rel" }],
    ])
      expect(
        () => parseCompanionJson(JSON.stringify({ ...value, baseApps })),
        JSON.stringify(baseApps),
      ).toThrow(expect.objectContaining({ code: 1 }));
    expect(() =>
      parseCompanionJson(
        JSON.stringify({
          ...value,
          command: { "app-a": "run-a {previewUrl:app-a}" },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 1 }));
  });

  it("子の new --companion-json が baseApps を記録に書いて読み直せる", async () => {
    const root = await makeRepo();
    const r = await runCli(
      [
        "new",
        "--title",
        "a",
        "--slug",
        "a",
        "--companion-json",
        JSON.stringify(value),
      ],
      { cwd: root, runner: fakeOrca().runner },
    );
    expect(r.code).toBe(0);
    const file = path.join(
      await commonOf(root),
      "orca-flow/companion/T01.json",
    );
    expect(JSON.parse(await readFile(file, "utf8")).baseApps).toEqual(
      value.baseApps,
    );
    expect(await readCompanion(testRunner, root, "T01")).toMatchObject(value);
  });

  it("baseApps のない古い記録は今と同じに読み、空として扱う", async () => {
    const root = await makeRepo();
    const file = path.join(
      await commonOf(root),
      "orca-flow/companion/T01.json",
    );
    await mkdir(path.dirname(file), { recursive: true });
    const old = {
      id: "T01",
      at: "2026-01-02T03:04:05.000Z",
      command: "run {previewUrl:app-a}",
      apps: [{ name: "app-a", path: "/tmp/app-a-main" }],
    };
    await writeFile(file, JSON.stringify(old));
    const read = await readCompanion(testRunner, root, "T01");
    expect(read).toEqual(old);
    expect(companionBaseApps(read!)).toEqual([]);
  });

  it("baseApps の形が外れた記録は壊れているとする", async () => {
    const root = await makeRepo();
    const file = path.join(
      await commonOf(root),
      "orca-flow/companion/T01.json",
    );
    await mkdir(path.dirname(file), { recursive: true });
    for (const baseApps of [
      {},
      [{ name: "app-a", path: "rel" }],
      [{ name: "app-b", path: "/tmp/b" }],
    ]) {
      await writeFile(
        file,
        JSON.stringify({ id: "T01", at: "x", ...value, baseApps }),
      );
      await expect(
        readCompanion(testRunner, root, "T01"),
        JSON.stringify(baseApps),
      ).rejects.toMatchObject({ code: 1 });
    }
  });
});
