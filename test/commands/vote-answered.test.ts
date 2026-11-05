import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { fakeOrca, runCli } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const SECRET = "他人の文章 SECRET-TEXT";

const entry = (target: string, human: string | null) => ({
  at: "2026-01-01T00:00:00.000Z",
  id: "T01",
  target,
  kind: "comment",
  risk: { level: "normal", reason: "r" },
  first: "fix",
  second: { status: "voted", key: "fix" },
  model: "claude-sonnet-5-5",
  human,
});

async function setup(lines: unknown[]) {
  const root = await makeRepo({});
  await addTaskWorktree(root, "T01", "x", { "src/a.ts": "a\n" });
  const file = path.join(root, ".git", "orca-flow", "vote", "T01.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const before = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
  await writeFile(file, before);
  const external: string[] = [];
  const orca = fakeOrca();
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd === "gh" || cmd === "claude") {
      external.push(`${cmd} ${args.join(" ")}`);
      return {
        code: 0,
        stdout: JSON.stringify({ body: SECRET }),
        stderr: "",
        timedOut: false,
      };
    }
    return orca.runner(cmd, args, opts);
  };
  const cli = (...argv: string[]) =>
    runCli(["vote", ...argv], { cwd: root, runner });
  const cast = (target: string, kind = "comment") =>
    cli("cast", "T01", "--target", target, "--kind", kind, "--first", "ask");
  return { cli, cast, file, before, external };
}

describe("vote cast: 答え済みの対象は断る", () => {
  it.each(["comment", "design"])(
    "答え済みの件がある対象（%s）は終了コード1で、記録も外への呼び出しも変わらない",
    async (kind) => {
      const { cast, file, before, external } = await setup([
        entry("PRRT_1", "fix"),
        entry("PRRT_2", null),
      ]);
      const r = await cast("PRRT_1", kind);
      expect(r.code).toBe(1);
      expect(await readFile(file, "utf8")).toBe(before);
      expect(external).toEqual([]);
      const all = r.out + r.err;
      expect(all).not.toContain("SECRET-TEXT");
      expect(all).toContain("答え済み");
      expect(all).toContain("人には聞");
      expect(all).toContain("vote answer");
    },
  );

  it("--json でも終了コード1で、記録は変わらない", async () => {
    const { cli, file, before, external } = await setup([
      entry("PRRT_1", "ask"),
    ]);
    const r = await cli(
      "cast",
      "T01",
      "--target",
      "PRRT_1",
      "--kind",
      "comment",
      "--first",
      "fix",
      "--json",
    );
    expect(r.code).toBe(1);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(external).toEqual([]);
  });

  it("ロックの前の確かめのあとで別の会話が答えたら、cast は記録せず断る", async () => {
    const root = await makeRepo({});
    await addTaskWorktree(root, "T01", "x", { "src/a.ts": "a\n" });
    const file = path.join(root, ".git", "orca-flow", "vote", "T01.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(entry("PRRT_2", null))}\n`);
    const answered = `${JSON.stringify(entry("PRRT_1", "fix"))}\n`;
    const orca = fakeOrca();
    let injected = false;
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "gh" || cmd === "claude") {
        if (!injected) {
          injected = true;
          // 前の確かめを通ったあと、GitHub を読んでいる間に別の会話が答える
          await writeFile(file, (await readFile(file, "utf8")) + answered);
        }
        return {
          code: 0,
          stdout: JSON.stringify({ body: SECRET }),
          stderr: "",
          timedOut: false,
        };
      }
      return orca.runner(cmd, args, opts);
    };
    const r = await runCli(
      [
        "vote",
        "cast",
        "T01",
        "--target",
        "PRRT_1",
        "--kind",
        "design",
        "--first",
        "ask",
      ],
      { cwd: root, runner },
    );
    expect(injected).toBe(true);
    expect(r.code).toBe(1);
    const all = r.out + r.err;
    expect(all).toContain("答え済み");
    expect(all).toContain("vote answer");
    expect(all).not.toContain("記録しました");
    expect(all).not.toContain("SECRET-TEXT");
    expect(await readFile(file, "utf8")).toBe(
      `${JSON.stringify(entry("PRRT_2", null))}\n${answered}`,
    );
  });

  it("答えのない対象・記録のない対象は断らない", async () => {
    const { cast, file } = await setup([entry("PRRT_2", null)]);
    expect((await cast("PRRT_2", "design")).code).toBe(0);
    expect((await cast("PRRT_3", "design")).code).toBe(0);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
