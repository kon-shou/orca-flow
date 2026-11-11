import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCompanionJson,
  readCompanion,
  resolveCompanionArg,
  writeCompanionAt,
} from "../../src/lib/companion.ts";
import { git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const COMMANDS = {
  "app-a": "run-a --base {previewUrl:app-a}",
  "app-b": "run-b --base {previewUrl:app-b}",
};

const input = (over: Record<string, unknown> = {}) => ({
  command: COMMANDS,
  apps: [
    { name: "app-a", path: "/tmp/app-a-main" },
    { name: "app-b", path: "/tmp/app-b-main" },
  ],
  ...over,
});

async function setup() {
  const root = await makeRepo();
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return {
    root,
    common,
    file: path.join(common, "orca-flow/companion/T01.json"),
  };
}

describe("伴う記録：アプリごとのコマンド", () => {
  it("オブジェクトの command と capture.command を受けて返す", () => {
    const value = input({
      capture: {
        command: { "app-b": "run-b --video {previewUrl:app-b}" },
        output: "videos",
      },
    });
    expect(parseCompanionJson(JSON.stringify(value))).toEqual(value);
  });

  it("外れは終了コード1", () => {
    for (const command of [
      {},
      { "app-c": "run {previewUrl:app-a}" },
      { "app-a": "" },
      { "app-a": "run {previewUrl:app-b}" },
      { "app-a": "run {previewUrl:app-a} {previewUrl:other}" },
      { "app-a": "run '{previewUrl:app-a}'" },
    ]) {
      expect(
        () => parseCompanionJson(JSON.stringify(input({ command }))),
        JSON.stringify(command),
      ).toThrow(expect.objectContaining({ code: 1 }));
      expect(
        () =>
          parseCompanionJson(
            JSON.stringify(input({ capture: { command, output: "videos" } })),
          ),
        `capture ${JSON.stringify(command)}`,
      ).toThrow(expect.objectContaining({ code: 1 }));
    }
  });

  it("オブジェクトの記録を書いて読み直せる", async () => {
    const { root, common, file } = await setup();
    await writeCompanionAt(
      common,
      "T01",
      input(),
      new Date("2026-01-02T03:04:05Z"),
    );
    expect(JSON.parse(await readFile(file, "utf8")).command).toEqual(COMMANDS);
    expect(await readCompanion(testRunner, root, "T01")).toEqual({
      id: "T01",
      at: "2026-01-02T03:04:05.000Z",
      ...input(),
    });
  });

  it("古い文字列の記録はこれまでどおり読める", async () => {
    const { root, file } = await setup();
    await mkdir(path.dirname(file), { recursive: true });
    const old = {
      id: "T01",
      at: "2026-01-02T03:04:05.000Z",
      command: "run {previewUrl:app-a}",
      apps: [{ name: "app-a", path: "/tmp/app-a-main" }],
    };
    await writeFile(file, JSON.stringify(old));
    expect(await readCompanion(testRunner, root, "T01")).toEqual(old);
  });
});

describe("resolveCompanionArg：アプリごとのコマンド", () => {
  const capture = {
    command: {
      "app-a": "run-a --video {previewUrl:app-a}",
      "app-b": "run-b --video {previewUrl:app-b}",
    },
    output: "videos",
  };
  const repos = (command: unknown, cap?: unknown) =>
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
          ...(cap === undefined ? {} : { capture: cap }),
        },
      },
    ] as Parameters<typeof resolveCompanionArg>[0];

  it("渡したアプリのキーの分だけを command と capture.command に写す", () => {
    expect(
      JSON.parse(
        resolveCompanionArg(repos(COMMANDS, capture), "e2e", "app-b")!,
      ),
    ).toEqual({
      command: { "app-b": COMMANDS["app-b"] },
      apps: [{ name: "app-b", path: "/ws/app-b" }],
      capture: {
        command: { "app-b": capture.command["app-b"] },
        output: "videos",
      },
    });
    expect(
      JSON.parse(
        resolveCompanionArg(repos(COMMANDS, capture), "e2e", "app-a,app-b")!,
      ).command,
    ).toEqual(COMMANDS);
  });

  it("capture.command に写すものがなければ capture を書かない", () => {
    const cap = { command: { "app-a": capture.command["app-a"] }, output: "v" };
    expect(
      Object.keys(
        JSON.parse(resolveCompanionArg(repos(COMMANDS, cap), "e2e", "app-b")!),
      ),
    ).toEqual(["command", "apps"]);
  });

  it("写したコマンドの印のアプリが足りなければ、止めずに baseApps に入れる", () => {
    const command = {
      "app-a": "run-a {previewUrl:app-a} {previewUrl:app-c}",
      "app-b": "run-b {previewUrl:app-b}",
    };
    expect(
      JSON.parse(resolveCompanionArg(repos(command), "e2e", "app-a")!),
    ).toEqual({
      command: { "app-a": command["app-a"] },
      apps: [{ name: "app-a", path: "/ws/app-a" }],
      baseApps: [{ name: "app-c", path: "/ws/app-c" }],
    });
    expect(
      JSON.parse(resolveCompanionArg(repos(command), "e2e", "app-b")!).command,
    ).toEqual({ "app-b": command["app-b"] });
  });

  it("写した capture.command の印のアプリが足りなくても、止めずに baseApps に入れる", () => {
    const cap = {
      command: { "app-b": "run-b {previewUrl:app-b} {previewUrl:app-c}" },
      output: "v",
    };
    expect(
      JSON.parse(resolveCompanionArg(repos(COMMANDS, cap), "e2e", "app-b")!),
    ).toEqual({
      command: { "app-b": COMMANDS["app-b"] },
      apps: [{ name: "app-b", path: "/ws/app-b" }],
      baseApps: [{ name: "app-c", path: "/ws/app-c" }],
      capture: cap,
    });
  });

  it("写すコマンドが1つもなければ終了コード1", () => {
    expect(() => resolveCompanionArg(repos(COMMANDS), "e2e", "app-c")).toThrow(
      expect.objectContaining({
        code: 1,
        message: expect.stringContaining(
          `流すコマンドが1つもありません。キー：${Object.keys(COMMANDS).join("・")}`,
        ),
      }),
    );
  });

  it("文字列の command はそのまま写し、渡していない印のアプリを baseApps に入れる", () => {
    const command = "run {previewUrl:app-a} {previewUrl:app-b}";
    expect(
      JSON.parse(resolveCompanionArg(repos(command), "e2e", "app-a")!),
    ).toEqual({
      command,
      apps: [{ name: "app-a", path: "/ws/app-a" }],
      baseApps: [{ name: "app-b", path: "/ws/app-b" }],
    });
    expect(
      JSON.parse(resolveCompanionArg(repos(command), "e2e", "app-a,app-b")!),
    ).toEqual({
      command,
      apps: [
        { name: "app-a", path: "/ws/app-a" },
        { name: "app-b", path: "/ws/app-b" },
      ],
    });
  });
});
