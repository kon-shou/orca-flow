import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import { capture, makeRepo, tempDir, writeFiles } from "../init/helpers.ts";

const done = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

const runner: Runner = async (cmd, args, opts) =>
  cmd === process.execPath
    ? done({ stdout: JSON.stringify({ baseBranch: "main" }) })
    : realRunner(cmd, args, opts);

function setup(extras: Record<string, Record<string, unknown>>) {
  const dir = tempDir("orca-flow-ws-");
  const repos: Record<string, unknown>[] = [
    {
      name: "kit",
      path: makeRepo(),
      role: "common",
      keywords: ["共通"],
      scope: "共通の処理",
      package: "@example/kit",
      bumpCommand: "pnpm up @example/kit",
      ...extras.kit,
    },
  ];
  for (const name of ["shop", "blog", "docs"])
    repos.push({
      name,
      path: makeRepo(),
      role: "app",
      keywords: ["画面"],
      ...extras[name],
    });
  writeFiles(dir, { "orca-flow-workspace.json": JSON.stringify({ repos }) });
  return dir;
}

describe("workspace --json の alwaysRead", () => {
  it("設定で true の子の要素だけに alwaysRead: true がある", async () => {
    const dir = setup({
      kit: { alwaysRead: true },
      shop: { alwaysRead: true },
      blog: { alwaysRead: false },
    });
    const io = capture();
    await main(["workspace", "--json"], { ...io, cwd: dir, runner });
    const data = JSON.parse(io.text()) as { repos: Record<string, unknown>[] };
    const by = Object.fromEntries(data.repos.map((r) => [r.name, r]));
    expect(by.kit!.alwaysRead).toBe(true);
    expect(by.shop!.alwaysRead).toBe(true);
    expect(by.blog).not.toHaveProperty("alwaysRead");
    expect(by.docs).not.toHaveProperty("alwaysRead");
  });

  it("文の一覧の出力は印があっても変わらない", async () => {
    const plain = capture();
    const marked = capture();
    const a = setup({});
    const b = setup({ shop: { alwaysRead: true } });
    await main(["workspace"], { ...plain, cwd: a, runner });
    await main(["workspace"], { ...marked, cwd: b, runner });
    const strip = (t: string, d: string) =>
      t
        .split(d)
        .join("DIR")
        .replace(/[0-9a-f]{64}/, "HASH");
    expect(plain.text()).toContain("shop");
    expect(strip(marked.text(), b).replace(/\/[^\s）]*/g, "P")).toBe(
      strip(plain.text(), a).replace(/\/[^\s）]*/g, "P"),
    );
  });
});
