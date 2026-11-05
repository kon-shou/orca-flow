import { describe, expect, it } from "vitest";
import { buildVoteMaterial } from "../../src/lib/vote.ts";
import type { TargetSource } from "../../src/lib/respond-input.ts";

const target = (body: string): TargetSource => ({
  kind: "thread",
  prTitle: "題",
  path: "src/a.ts",
  line: 3,
  diffHunk: null,
  comments: [{ author: "bob", body }],
});

describe("合議の材料：伏せてから切る", () => {
  it("4000字の手前にかかるトークンの一部が残らない", () => {
    const token = `ghp_${"A".repeat(36)}`;
    for (const offset of [3990, 3995, 3999]) {
      const body = "あ".repeat(offset) + token + "い".repeat(100);
      const text = buildVoteMaterial(
        { target: target(body), allowedPaths: [] },
        {},
        "N1",
      );
      expect(text).not.toContain("ghp_");
      expect(text).not.toContain("AAAA");
    }
  });
  it("差分の断片でも同じ", () => {
    const token = `ghp_${"B".repeat(36)}`;
    // "+" と空白の2字を足すので、トークンは offset+2 字目から始まる
    for (const offset of [3990, 3995, 3997]) {
      const t = target("x");
      t.diffHunk = "+" + "a".repeat(offset - 1) + " " + token;
      const text = buildVoteMaterial({ target: t, allowedPaths: [] }, {}, "N1");
      expect(text).not.toContain("ghp_");
      expect(text).not.toContain("BBBB");
    }
  });
});
