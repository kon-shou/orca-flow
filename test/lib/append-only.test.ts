import { describe, expect, it } from "vitest";
import type { FlowConfig } from "../../src/config.ts";
import {
  otherAppendOnlyFiles,
  restoreAppendOnlyFile,
  restoreAppendedLines,
} from "../../src/lib/append-only.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const reason = (r: ReturnType<typeof restoreAppendedLines>) =>
  r.ok ? null : r.reason;

describe("restoreAppendedLines", () => {
  it("両側が末尾に足したとき、main の行のあとにタスクの行を置く", () => {
    const r = restoreAppendedLines("a\nm1\nm2\n", "a\n", "a\nt1\nt2\n");
    expect(r).toEqual({ ok: true, text: "a\nm1\nm2\nt1\nt2\n" });
  });

  it("main の末尾に改行がなくても、タスクの行が前の行にくっつかない", () => {
    const r = restoreAppendedLines("a\nm", "a\n", "a\nt\n");
    expect(r).toEqual({ ok: true, text: "a\nm\nt\n" });
  });

  it("取り込みの前の中身が分かれ目の中身で始まらないときは、理由を返す", () => {
    const r = restoreAppendedLines("a\nm\n", "a\n", "t\na\n");
    expect(reason(r)).toContain(
      "取り込みの前の中身が分かれ目の中身で始まりません",
    );
  });

  it("main の中身が分かれ目の中身で始まらないときは、理由を返す", () => {
    const r = restoreAppendedLines("m\na\n", "a\n", "a\nt\n");
    expect(reason(r)).toContain("main の中身が分かれ目の中身で始まりません");
  });

  it("タスクの足した部分が空のときは、理由を返す", () => {
    expect(reason(restoreAppendedLines("a\nm\n", "a\n", "a\n"))).toContain(
      "空",
    );
    expect(reason(restoreAppendedLines("a\nm\n", "a\n", "a\n\n"))).toContain(
      "空",
    );
  });

  it("タスクの足した空でない行が main の足した部分にもあるときは、理由を返す", () => {
    const r = restoreAppendedLines("a\nm\nsame\n", "a\n", "a\nt\nsame\n");
    expect(reason(r)).toContain("「same」");
  });

  it("空行だけが重なるときは重なりに数えない", () => {
    const r = restoreAppendedLines("a\n\nm\n", "a\n", "a\n\nt\n");
    expect(r.ok).toBe(true);
  });
});

describe("otherAppendOnlyFiles", () => {
  it("appendOnlyFiles から decisionsFile を除く", () => {
    const config = {
      appendOnlyFiles: ["docs/decisions.md", "docs/log.md"],
      decisionsFile: "docs/decisions.md",
    } as FlowConfig;
    expect(otherAppendOnlyFiles(config)).toEqual(["docs/log.md"]);
  });
});

describe("restoreAppendOnlyFile", () => {
  it("main が動いていない（分かれ目が main の先頭）ときは、警告も戻しもしない", async () => {
    const root = await makeRepo({}, { "docs/log.md": "a\n" });
    await git(root, "checkout", "-q", "-b", "task");
    await writeFiles(root, { "docs/log.md": "t1\na\n" });
    await git(root, "commit", "-q", "-am", "task");
    const head = await git(root, "rev-parse", "HEAD");
    const warnings: string[] = [];
    const restored = await restoreAppendOnlyFile(
      testRunner,
      root,
      "docs/log.md",
      "main",
      head,
      "T1",
      "T1",
      (m) => warnings.push(m),
    );
    expect(restored).toBe(false);
    expect(warnings).toEqual([]);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });
});
