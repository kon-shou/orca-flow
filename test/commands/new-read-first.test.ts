import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FROM_WORKSPACE_ENV,
  VERIFY_INTERVAL_ENV,
  VERIFY_WINDOW_ENV,
} from "../../src/commands/new.ts";
import { main } from "../../src/cli.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { git, makeRepo } from "../helpers/repo.ts";

beforeAll(() => {
  process.env[VERIFY_WINDOW_ENV] = "300";
  process.env[VERIFY_INTERVAL_ENV] = "50";
});
afterAll(() => {
  delete process.env[VERIFY_WINDOW_ENV];
  delete process.env[VERIFY_INTERVAL_ENV];
});

async function setup() {
  const root = await makeRepo();
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return { root, file: path.join(common, "orca-flow/read-first/T01.json") };
}

async function newTask(
  root: string,
  orca: ReturnType<typeof fakeOrca>,
  extra: string[],
  fromWorkspace: boolean,
) {
  const err: string[] = [];
  const code = await main(["new", "--title", "a", "--slug", "a", ...extra], {
    cwd: root,
    runner: orca.runner,
    env: fromWorkspace ? { [FROM_WORKSPACE_ENV]: "1" } : {},
    stdout: () => {},
    stderr: (t) => err.push(t),
  });
  return { code, err: err.join("\n") };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("new --read-first-json", () => {
  it("親の印があり形が正しければ、作業ツリーの外に記録ができる", async () => {
    const { root, file } = await setup();
    const paths = ["/docs/a.md", "/docs/b.md"];
    const r = await newTask(
      root,
      fakeOrca(),
      ["--read-first-json", JSON.stringify(paths)],
      true,
    );
    expect(r.code).toBe(0);
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record).toMatchObject({ id: "T01", paths });
    expect(typeof record.at).toBe("string");
  });

  it("親の印がなければ、Orca を呼ばず何も作らず終了コード1", async () => {
    const { root, file } = await setup();
    const orca = fakeOrca();
    const r = await newTask(
      root,
      orca,
      ["--read-first-json", JSON.stringify(["/docs/a.md"])],
      false,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("--read-first-json");
    expect(orca.calls).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  it.each([
    ["JSON でない", "not json"],
    ["並びでない", JSON.stringify({ a: 1 })],
    ["空の並び", "[]"],
    ["相対パス", JSON.stringify(["docs/a.md"])],
    ["空の文字列", JSON.stringify([""])],
    ["文字列でない", JSON.stringify([1])],
  ])("形の外れた値（%s）は Orca を呼ばず終了コード1", async (_, value) => {
    const { root, file } = await setup();
    const orca = fakeOrca();
    const r = await newTask(root, orca, ["--read-first-json", value], true);
    expect(r.code).toBe(1);
    expect(orca.calls).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  it("付けない new は、同じ ID の古い記録を消す", async () => {
    const { root, file } = await setup();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{}");
    const r = await newTask(root, fakeOrca(), [], true);
    expect(r.code).toBe(0);
    expect(await exists(file)).toBe(false);
  });
});
