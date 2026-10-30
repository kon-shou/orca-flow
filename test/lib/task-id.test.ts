import { describe, expect, it } from "vitest";
import {
  idFromBranch,
  idProblem,
  nextTaskId,
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
