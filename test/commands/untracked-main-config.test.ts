import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { commandsFor, recordMismatch } from "../../src/lib/verified.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";

const CONFIG = ".orca-flow/config.json";

/** .orca-flow/ を git に入れない形。メインと worktree の写しで verify が食い違う */
async function setup(copyUntracked = true) {
  const root = await makeRepo({}, { ".gitignore": ".orca-flow/\n" });
  const wt = await addTaskWorktree(root, "T1", "a");
  await mkdir(path.join(wt.path, ".orca-flow"), { recursive: true });
  await writeFile(
    path.join(root, CONFIG),
    JSON.stringify({ untracked: true, verify: ["test -f README.md"] }),
  );
  await writeFile(
    path.join(wt.path, CONFIG),
    JSON.stringify({ untracked: copyUntracked, verify: ["test -f OLD.md"] }),
  );
  return { root, wt: wt.path };
}

describe("untracked のタスクの worktree は、メインの設定を読む", () => {
  it("config --json がメインの verify を出す", async () => {
    const { wt } = await setup();
    const result = await runCli(["config", "--json"], {
      cwd: wt,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).verify).toEqual(["test -f README.md"]);
  });

  it("写しが untracked でなければ、写しの verify を出す", async () => {
    const { wt } = await setup(false);
    const result = await runCli(["config", "--json"], {
      cwd: wt,
      runner: fakeOrca().runner,
    });
    expect(JSON.parse(result.out).verify).toEqual(["test -f OLD.md"]);
  });

  it("verify の記録はメインの verify になり、メインの設定で比べても食い違わない", async () => {
    const { root, wt } = await setup();
    const result = await runCli(["verify"], {
      cwd: wt,
      runner: fakeOrca().runner,
    });
    expect(result.code).toBe(0);
    const record = JSON.parse(
      await readFile(
        path.join(root, ".git/orca-flow/verified/T1.json"),
        "utf8",
      ),
    );
    expect(record.commands).toEqual(["test -f README.md"]);
    const main = (await loadConfig(root)).config;
    expect(
      recordMismatch(record, {
        head: await git(wt, "rev-parse", "HEAD"),
        base: await git(root, "rev-parse", "main"),
        commands: commandsFor(main, []),
      }),
    ).toBeNull();
  });
});

const ALLOWED = [
  "src/config.ts",
  "src/lib/flow-config.ts",
  "src/commands/init.ts",
  "src/lib/finish.ts",
  "src/lib/preview.ts",
  "src/lib/cross-depends.ts",
  "src/lib/app-bump.ts",
];

describe("設定を直接読むファイル", () => {
  it("requireConfig・loadConfig を呼ぶのは決めた一覧のファイルだけ", async () => {
    const src = path.resolve(import.meta.dirname, "../../src");
    const entries = await readdir(src, { recursive: true });
    const found: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      const text = await readFile(path.join(src, entry), "utf8");
      if (/\b(requireConfig|loadConfig)\(/.test(text))
        found.push(`src/${entry.split(path.sep).join("/")}`);
    }
    expect(found.sort()).toEqual([...ALLOWED].sort());
  });
});
