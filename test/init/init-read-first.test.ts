import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { capture, fakeOrcaRunner, makeRepo, ok } from "./helpers.ts";

async function plan(root: string) {
  const io = capture();
  const r = fakeOrcaRunner((args) =>
    args[0] === "repo" && args[1] === "list" ? ok({ repos: [] }) : ok({}),
  );
  const code = await main(["init"], { ...io, cwd: root, runner: r.runner });
  return { code, io, calls: r.calls };
}

describe("init の「人間と決めること」の readFirst の添え書き", () => {
  it("--yes なしの出力で、担当と確認役にも渡ることと、種類ごとの決まりは入れないことが出る", async () => {
    const root = makeRepo();
    const { code, io, calls } = await plan(root);
    expect(code).toBe(0);
    expect(calls.filter((c) => c.cmd === "orca")).toEqual([]);
    const line = io
      .text()
      .split("\n")
      .find((l) => l.startsWith("人間と決めること："));
    expect(line, "人間と決めること の行").toBeDefined();
    const note = /readFirst（([^）]*)）/.exec(line ?? "")?.[1];
    expect(note, "readFirst の添え書き").toBeDefined();
    expect(note).toContain("先に読む文書");
    expect(note).toContain("担当と確認役にも渡る");
    expect(note).toContain("種類ごとの決まりは入れず");
    expect(line).toContain("progress（進捗表）");
  });
});
