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

const input = (over: Record<string, unknown> = {}) => ({
  command: "pnpm test:e2e --base-url {previewUrl:shop}",
  apps: [{ name: "shop", path: "/tmp/shop-main" }],
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

describe("伴う記録の形", () => {
  it("正しい値は、知っているキーだけを写して返す", () => {
    expect(parseCompanionJson(JSON.stringify(input()))).toEqual(input());
  });

  it("引用符の中の印は誤り、外の印は通る", () => {
    for (const command of [
      'X="{previewUrl:shop}" run',
      "run '{previewUrl:shop}'",
      'run "a $(x) {previewUrl:shop}"',
    ])
      expect(
        () => parseCompanionJson(JSON.stringify(input({ command }))),
        command,
      ).toThrow(expect.objectContaining({ code: 1 }));
    for (const command of [
      "run --base-url {previewUrl:shop}",
      "X={previewUrl:shop} run",
      "echo 'a' \"b\" {previewUrl:shop}",
    ])
      expect(
        parseCompanionJson(JSON.stringify(input({ command }))).command,
      ).toBe(command);
  });

  it("外れはまとめて終了コード1", () => {
    const bad = [
      "{",
      "[]",
      JSON.stringify(input({ apps: [] })),
      JSON.stringify(input({ apps: [{ name: "Shop", path: "/x" }] })),
      JSON.stringify(input({ apps: [{ name: "shop", path: "rel" }] })),
      JSON.stringify(
        input({
          apps: [
            { name: "shop", path: "/a" },
            { name: "shop", path: "/b" },
          ],
        }),
      ),
      JSON.stringify(input({ command: "pnpm test:e2e" })),
      JSON.stringify(input({ command: "run {previewUrl:other}" })),
      JSON.stringify(input({ extra: 1 })),
    ];
    for (const text of bad) {
      expect(() => parseCompanionJson(text), text).toThrow(
        expect.objectContaining({ code: 1 }),
      );
    }
  });
});

describe("伴う記録の capture", () => {
  const cap = (over: Record<string, unknown> = {}) => ({
    command: "pnpm test:e2e --video --base-url {previewUrl:shop}",
    output: "test-results",
    ...over,
  });

  it("正しい capture は写して返し、書いた記録から読める", async () => {
    expect(
      parseCompanionJson(JSON.stringify(input({ capture: cap() }))).capture,
    ).toEqual(cap());
    const { root, common } = await setup();
    await writeCompanionAt(
      common,
      "T01",
      input({ capture: cap() }),
      new Date(),
    );
    expect((await readCompanion(testRunner, root, "T01"))?.capture).toEqual(
      cap(),
    );
  });

  it("形の外れは終了コード1", () => {
    for (const capture of [
      cap({ command: "pnpm test:e2e" }),
      cap({ command: "run {previewUrl:other}" }),
      cap({ command: "run '{previewUrl:shop}'" }),
      cap({ output: "" }),
      cap({ output: "." }),
      cap({ output: "../x" }),
      cap({ output: "/abs" }),
      cap({ extra: 1 }),
      "x",
    ])
      expect(
        () => parseCompanionJson(JSON.stringify(input({ capture }))),
        JSON.stringify(capture),
      ).toThrow(expect.objectContaining({ code: 1 }));
  });

  it("壊れた capture の記録は読むと終了コード1", async () => {
    const { root, file } = await setup();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        id: "T01",
        at: "x",
        ...input({ capture: cap({ output: "/abs" }) }),
      }),
    );
    await expect(readCompanion(testRunner, root, "T01")).rejects.toMatchObject({
      code: 1,
    });
  });
});

describe("伴う記録の読み書き", () => {
  it("書いた記録を読め、input が null なら消える", async () => {
    const { root, common, file } = await setup();
    expect(await readCompanion(testRunner, root, "T01")).toBeNull();
    await writeCompanionAt(
      common,
      "T01",
      input(),
      new Date("2026-01-02T03:04:05Z"),
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      id: "T01",
      at: "2026-01-02T03:04:05.000Z",
      ...input(),
    });
    expect(await readCompanion(testRunner, root, "T01")).toEqual({
      id: "T01",
      at: "2026-01-02T03:04:05.000Z",
      ...input(),
    });
    await writeCompanionAt(common, "T01", null, new Date());
    expect(await readCompanion(testRunner, root, "T01")).toBeNull();
  });

  it("壊れた記録の文に、記録の実のパスが入る", async () => {
    const { root, file } = await setup();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{");
    await expect(readCompanion(testRunner, root, "T01")).rejects.toThrow(file);
  });

  it("ID の形が違えば null、壊れていれば終了コード1", async () => {
    const { root, file } = await setup();
    expect(await readCompanion(testRunner, root, "xx")).toBeNull();
    await mkdir(path.dirname(file), { recursive: true });
    for (const text of [
      "{",
      "[]",
      JSON.stringify({ id: "T02", at: "x", ...input() }),
      JSON.stringify({ id: "T01", ...input() }),
      JSON.stringify({ id: "T01", at: "x", ...input({ apps: [] }) }),
    ]) {
      await writeFile(file, text);
      await expect(
        readCompanion(testRunner, root, "T01"),
        text,
      ).rejects.toMatchObject({
        code: 1,
      });
    }
  });
});

describe("resolveCompanionArg", () => {
  const repos = [
    { name: "shop", path: "/ws/shop" },
    { name: "admin", path: "/ws/admin" },
    {
      name: "e2e-tests",
      path: "/ws/e2e",
      companion: {
        apps: ["shop", "admin"],
        when: "画面が変わるとき",
        command: "run {previewUrl:shop} {previewUrl:admin}",
      },
    },
  ];

  it("名前を設定のパスと command に解く。値がなければ null", () => {
    expect(resolveCompanionArg(repos, "e2e-tests", undefined)).toBeNull();
    expect(
      JSON.parse(resolveCompanionArg(repos, "e2e-tests", "shop,admin")!),
    ).toEqual({
      command: "run {previewUrl:shop} {previewUrl:admin}",
      apps: [
        { name: "shop", path: "/ws/shop" },
        { name: "admin", path: "/ws/admin" },
      ],
    });
  });

  it("command の印の名前が --companion に足りなくても止めず、足りないアプリを baseApps に実のパスつきで入れる", () => {
    expect(
      JSON.parse(resolveCompanionArg(repos, "e2e-tests", "shop")!),
    ).toEqual({
      command: "run {previewUrl:shop} {previewUrl:admin}",
      apps: [{ name: "shop", path: "/ws/shop" }],
      baseApps: [{ name: "admin", path: "/ws/admin" }],
    });
  });

  it("companion のない子・apps にない名前・空は終了コード1", () => {
    for (const [child, value] of [
      ["shop", "admin"],
      ["e2e-tests", "nope"],
      ["e2e-tests", ""],
    ] as const)
      expect(() => resolveCompanionArg(repos, child, value)).toThrow(
        expect.objectContaining({ code: 1 }),
      );
  });
});

describe("resolveCompanionArg：capture", () => {
  const capture = {
    command: "run --video {previewUrl:shop} {previewUrl:admin}",
    output: "videos",
  };
  const repos = [
    { name: "shop", path: "/ws/shop" },
    { name: "admin", path: "/ws/admin" },
    {
      name: "e2e-tests",
      path: "/ws/e2e",
      companion: {
        apps: ["shop", "admin"],
        when: "画面が変わるとき",
        command: "run {previewUrl:shop}",
        capture,
      },
    },
  ];

  it("子への JSON に capture を入れる。capture の印のアプリが --companion に足りなければ baseApps に入れる", () => {
    expect(
      JSON.parse(resolveCompanionArg(repos, "e2e-tests", "shop,admin")!)
        .capture,
    ).toEqual(capture);
    expect(
      JSON.parse(resolveCompanionArg(repos, "e2e-tests", "shop")!),
    ).toEqual({
      command: "run {previewUrl:shop}",
      apps: [{ name: "shop", path: "/ws/shop" }],
      baseApps: [{ name: "admin", path: "/ws/admin" }],
      capture,
    });
  });

  it("capture のない設定の JSON に capture のキーは出ない", () => {
    const plain = repos.map((r) =>
      r.name === "e2e-tests"
        ? { ...r, companion: { ...r.companion!, capture: undefined } }
        : r,
    );
    expect(
      Object.keys(JSON.parse(resolveCompanionArg(plain, "e2e-tests", "shop")!)),
    ).toEqual(["command", "apps"]);
  });
});
