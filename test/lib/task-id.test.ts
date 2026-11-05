import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.ts";
import {
  escapeId,
  hasIdShape,
  idFromBranch,
  idProblem,
  isTaskIdShape,
  nextTaskId,
  requireIdShape,
  type IdSources,
} from "../../src/lib/task-id.ts";

const sources = (partial: Partial<IdSources> = {}): IdSources => ({
  idPrefix: "T",
  branchPrefix: "task/",
  taskFiles: ["T91.md", "T92d.md", "README.md"],
  progressIds: [],
  branches: ["main", "task/T93-x"],
  ...partial,
});

describe("task-id", () => {
  it("T91 と T92d のファイルと task/T93-x のブランチがあるとき次は T94", () => {
    expect(nextTaskId(sources())).toBe("T94");
  });

  it("進捗表の ID も数える", () => {
    expect(nextTaskId(sources({ progressIds: ["T96"] }))).toBe("T97");
  });

  it("何もなければ2桁の 01", () => {
    expect(
      nextTaskId(sources({ taskFiles: [], branches: [], progressIds: [] })),
    ).toBe("T01");
  });

  it("すでにある ID の指定は理由を返す", () => {
    expect(idProblem("T91", sources())).toContain("すでに");
    expect(idProblem("T92d", sources())).toContain("すでに");
    expect(idProblem("T93", sources())).toContain("すでに");
    expect(idProblem("T95", sources())).toBeNull();
    expect(idProblem("X1", sources())).not.toBeNull();
  });

  it("idPrefix を変えても動く", () => {
    const s = sources({
      idPrefix: "ISS-",
      branchPrefix: "feat/",
      taskFiles: ["ISS-7.md", "T99.md"],
      branches: ["feat/ISS-12-login", "task/T200-x"],
    });
    expect(nextTaskId(s)).toBe("ISS-13");
    expect(idProblem("ISS-12", s)).toContain("すでに");
    expect(idFromBranch("feat/ISS-12-login", "feat/", "ISS-")).toBe("ISS-12");
  });

  it("ブランチから ID を読む", () => {
    expect(idFromBranch("task/T12-shopping-fix", "task/", "T")).toBe("T12");
    expect(idFromBranch("task/T92d-x", "task/", "T")).toBe("T92d");
    expect(idFromBranch("task/Tx-1", "task/", "T")).toBeNull();
    expect(idFromBranch("main", "task/", "T")).toBeNull();
  });
});

describe("isTaskIdShape（依存の ID の形）", () => {
  it("idPrefix と数字（と後ろの英字）だけが合う", () => {
    expect(isTaskIdShape("T12", "T")).toBe(true);
    expect(isTaskIdShape("T92d", "T")).toBe(true);
    expect(isTaskIdShape("Q943", "Q")).toBe(true);
  });

  it("形の外れたものは合わない", () => {
    for (const bad of [
      "X12",
      "T",
      "T1;x",
      "../T1",
      "T1 x",
      "$(id)",
      "",
      "T1\n",
    ])
      expect(isTaskIdShape(bad, "T"), JSON.stringify(bad)).toBe(false);
  });

  it("idPrefix の記号は文字として扱う", () => {
    expect(isTaskIdShape("A.1", "A.")).toBe(true);
    expect(isTaskIdShape("AB1", "A.")).toBe(false);
  });
});

describe("ID の形と設定の頭の文字", () => {
  it("parseConfig が通す頭の文字に12をつけた ID は ID の形に当たり、通さない頭の文字は当たらない", () => {
    for (const prefix of ["T", "ISS-", "a_b"]) {
      expect(parseConfig({ idPrefix: prefix }).idPrefix).toBe(prefix);
      expect(hasIdShape(`${prefix}12`)).toBe(true);
    }
    for (const prefix of ["1A", "T."]) {
      expect(() => parseConfig({ idPrefix: prefix })).toThrow();
      expect(hasIdShape(`${prefix}12`)).toBe(false);
    }
  });
});

describe("誤りの文に出す ID", () => {
  it("制御文字・書式文字・行の区切りを \\u{16進} にする", () => {
    expect(escapeId("a\u001bb\u0007c\u202ed\u2028e\u2029f")).toBe(
      "a\\u{1b}b\\u{7}c\\u{202e}d\\u{2028}e\\u{2029}f",
    );
    expect(escapeId("T12 日本語")).toBe("T12 日本語");
  });

  it("ID の形の誤りと作成の ID の誤りに、制御文字が入らない", () => {
    expect(() => requireIdShape("\u001b[31mx1\u202e")).toThrow(
      /\\u\{1b\}.*\\u\{202e\}/,
    );
    const problem = idProblem("T\u0007\u202e9", sources());
    expect(problem).toContain("\\u{7}");
    expect(problem).toContain("\\u{202e}");
    // eslint-disable-next-line no-control-regex
    expect(problem).not.toMatch(/[\u0007\u202e]/);
  });
});
