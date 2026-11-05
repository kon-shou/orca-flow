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
    expect(io.out.join("")).toContain("[--skip-cross-depends]");
    expect(io.out.join("")).toContain("order [<ID>,<ID>,...]");
    expect(io.out.join("")).toContain("rebase-review <取り込みの前のコミット>");
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

  it("outbox と send が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("outbox");
    expect(Object.keys(COMMANDS)).toContain("send");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain("outbox <add|list|show|withdraw> <ID>");
    expect(io.out.join("")).toContain(
      "GitHub に送る案を積む・見る・取り下げる",
    );
    expect(io.out.join("")).toContain(
      "send <ID> --expect <束の指紋> --head <先頭>",
    );
    expect(io.out.join("")).toContain("人が見た送りの案を GitHub に送る");
  });

  it("pstack が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("pstack");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain(
      "pstack <pstack の中の相対パス> [--json]",
    );
    expect(io.out.join("")).toContain(
      "入手元を確かめて pstack のファイルの場所を出す",
    );
  });

  it("pr-watch が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("pr-watch");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain("pr-watch [usage|install|uninstall]");
    expect(io.out.join("")).not.toContain("pr-watch background");
  });

  it("merge が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("merge");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain(
      "merge <ID> [--show | --head <先頭> | --drop-depend <ID|名前:ID>,...]",
    );
    expect(io.out.join("")).toContain(
      "確かめのあと PR をマージして後始末をする",
    );
  });

  it("respond が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("respond");
    const io = capture();
    await main([], io);
    expect(io.out.join("")).toContain(
      "respond <input|draft|drafts|ci-fix|open> <ID>",
    );
    expect(io.out.join("")).toContain(
      "PR の指摘と CI の赤を読み、保留中のレビューに返信を下書きする",
    );
  });

  it("workspace が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("workspace");
    const io = capture();
    await main([], io);
    const out = io.out.join("");
    expect(out).toContain("親の統括役（ワークスペースのフォルダ）");
    expect(out).toContain("workspace [--json]");
    expect(out).toContain(
      "子ごとの統括役の場所と init 済みかを出す（読むだけ）",
    );
    expect(out).toContain("workspace <名前> <config|active|merged|new> [引数]");
    expect(out).toContain("その子のフォルダで子の CLI を流す");
    expect(out).toContain(
      "workspace --setup [<設定のファイル>] [--marketplace <入手元>] [--yes]",
    );
    expect(out).toContain(
      "ワークスペースを用意する（ない子の clone・プラグインの導入）",
    );
  });

  it("intake が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("intake");
    const io = capture();
    await main([], io);
    const out = io.out.join("");
    expect(out).toContain("intake <URL>");
    expect(out).toContain(
      "新しいタブで intake の本体を始める（ワークスペースのフォルダでも）",
    );
  });

  it("vote が登録され、使い方に出る", async () => {
    expect(Object.keys(COMMANDS)).toContain("vote");
    const io = capture();
    await main([], io);
    const out = io.out.join("");
    expect(out).toContain(
      "vote cast <ID> --target <ID> --kind <種類> --first <キー>",
    );
    expect(out).toContain("vote answer <ID> --target <ID> --human <キー>");
    expect(out).toContain("vote stats [--json]");
    expect(out).toContain("合議の記録を種類ごとに数え、一致の割合を出す");
  });

  it("new の --allow-branch-push と push の --branch が使い方に出る", async () => {
    const io = capture();
    await main([], io);
    const out = io.out.join("");
    expect(out).toContain(
      "[--request-file <パス>] [--allow-branch-push] [--auto]",
    );
    expect(out).toContain("push <ID> --branch");
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
