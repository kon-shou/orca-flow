import { describe, expect, it } from "vitest";
import { requireIdShape as autoRequireIdShape } from "../../src/lib/auto.ts";
import { escapeId, hasIdShape, requireIdShape } from "../../src/lib/task-id.ts";
import { FlowError } from "../../src/types.ts";

describe("ID の形の確かめ", () => {
  it.each(["T12", "Q945", "T92d", "ISS-12", "a_b-3x"])("%s を通す", (id) => {
    expect(() => requireIdShape(id)).not.toThrow();
    expect(hasIdShape(id)).toBe(true);
  });

  it.each([
    "../T1",
    "T1/x",
    "T1 x",
    ".T1",
    "T",
    "12",
    "",
    "T1\n",
    "T1\u0000",
    "T\u00071",
    "\tT1",
    "T1..",
    "T1.md",
  ])("%j を FlowError(1) で断る", (id) => {
    expect(hasIdShape(id)).toBe(false);
    try {
      requireIdShape(id);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FlowError);
      expect((error as FlowError).code).toBe(1);
      expect((error as FlowError).message).toBe(
        `ID の形が正しくありません：${escapeId(id)}`,
      );
    }
  });

  it("auto.ts の同じ名前の関数は同じ形で断る", () => {
    expect(() => autoRequireIdShape("T12")).not.toThrow();
    expect(() => autoRequireIdShape("../T1")).toThrow(FlowError);
    expect(() => autoRequireIdShape("12")).toThrow(FlowError);
  });
});
