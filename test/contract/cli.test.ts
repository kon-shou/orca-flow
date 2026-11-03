import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, main } from "../../src/cli.ts";
import { FlowError } from "../../src/types.ts";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
  };
};

describe("cli", () => {
  it("引数がなければ使い方を出して0", async () => {
    const io = capture();
    expect(await main([], io)).toBe(0);
    expect(io.out.join("")).toContain("使い方");
  });

  it("知らないサブコマンドは1", async () => {
    const io = capture();
    expect(await main(["nope"], io)).toBe(1);
    expect(io.err.join("")).toContain("知らないサブコマンド");
  });

  it("FlowError の終了コードとメッセージをそのまま返す", async () => {
    const io = capture();
    const code = await main(["approve", "T1"], {
      ...io,
      commands: {
        approve: async () => {
          throw new FlowError(3, "競合しました");
        },
      },
    });
    expect(code).toBe(3);
    expect(io.err.join("")).toContain("競合しました");
  });

  it("--json を取り除いて渡し、data を JSON で出す", async () => {
    const io = capture();
    let seen: string[] = [];
    const code = await main(["active", "--json", "x"], {
      ...io,
      commands: {
        active: async (ctx) => {
          seen = ctx.argv;
          return { code: 0, data: { ok: true } };
        },
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["x"]);
    expect(JSON.parse(io.out.join(""))).toEqual({ ok: true });
  });

  it("main-check が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("main-check");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain("main-check [run]");
    expect(io.out.join("")).toContain("[--fixes-main]");
  });

  it("order と rebase-review が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("order");
    expect(Object.keys(COMMANDS)).toContain("rebase-review");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain("[--skip-order]");
    expect(io.out.join("")).toContain("[--skip-decision]");
    expect(io.out.join("")).toContain("order [<ID>,<ID>,...]");
    expect(io.out.join("")).toContain("rebase-review <rebase の前のコミット>");
  });

  it("auto が登録され、使い方に auto と new の --auto が出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("auto");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain("auto [show");
    expect(io.out.join("")).toContain("[--auto]");
  });

  it("push が登録され、使い方に出る（背景の入口の --watch は出さない）", async () => {
    expect(Object.keys(COMMANDS)).toContain("push");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain(
      "push <ID> [--body-file <パス>] [--show]",
    );
    expect(io.out.join("")).not.toContain("--watch");
  });

  it("lessons が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("lessons");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain(
      "lessons [--path] | lessons add <ファイル> | lessons remove <番号>",
    );
    expect(io.out.join("")).toContain("教訓を出す・足す・消す");
  });

  it("timing が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("timing");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain("timing [<ID> | --since <日付>]");
    expect(io.out.join("")).toContain("段ごとの時間を出す");
  });

  it("merged が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("merged");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain("merged <ID>... [--ref <ref>]");
    expect(io.out.join("")).toContain("タスクが入ったかを出す");
  });

  it("すべてのサブコマンドのファイルが run を持つ", async () => {
    for (const load of Object.values(COMMANDS)) {
      expect(typeof (await load()).run).toBe("function");
    }
  });

  it("bin/orca-flow が Node で動く", () => {
    const bin = path.resolve(import.meta.dirname, "../../bin/orca-flow");
    const result = spawnSync(bin, ["--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("使い方");
    expect(result.stderr).toBe("");
  });
});
