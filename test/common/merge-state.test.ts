import { describe, expect, it } from "vitest";
import { judgeMergeState } from "../../src/common/merge-state.ts";

const ok = { ok: true };
const no = (reason: string) => ({ ok: false, reason });

describe("judgeMergeState：判定の表", () => {
  const cases: [
    string | null | undefined,
    string | null | undefined,
    unknown,
  ][] = [
    ["CONFLICTING", "CLEAN", no("conflict")],
    ["CONFLICTING", "HAS_HOOKS", no("conflict")],
    ["CONFLICTING", null, no("conflict")],
    ["CONFLICTING", undefined, no("conflict")],
    ["UNKNOWN", "CLEAN", no("computing")],
    ["UNKNOWN", "DIRTY", no("computing")],
    ["UNKNOWN", null, no("computing")],
    ["MERGEABLE", "CLEAN", ok],
    ["MERGEABLE", null, ok],
    ["MERGEABLE", undefined, ok],
    [null, "CLEAN", ok],
    [undefined, "HAS_HOOKS", ok],
    [null, null, no("unknown")],
    [undefined, undefined, no("unknown")],
  ];
  for (const [mergeable, status, want] of cases) {
    it(`mergeable=${String(mergeable)} status=${String(status)}`, () => {
      expect(judgeMergeState({ mergeable, mergeStateStatus: status })).toEqual(
        want,
      );
    });
  }

  for (const mergeable of ["MERGEABLE", null, undefined]) {
    const j = (s: string) =>
      judgeMergeState({ mergeable, mergeStateStatus: s });
    it(`mergeable=${String(mergeable)} の mergeStateStatus ごと`, () => {
      expect(j("CLEAN")).toEqual(ok);
      expect(j("HAS_HOOKS")).toEqual(ok);
      expect(j("DIRTY")).toEqual(no("conflict"));
      expect(j("BLOCKED")).toEqual(no("protected"));
      expect(j("BEHIND")).toEqual(no("behind"));
      expect(j("DRAFT")).toEqual(no("draft"));
      expect(j("UNSTABLE")).toEqual(no("ci"));
      expect(j("UNKNOWN")).toEqual(no("computing"));
      expect(j("SOMETHING_NEW")).toEqual(no("unknown"));
      expect(j("")).toEqual(no("unknown"));
    });
  }

  it("入力を省いてもよい", () => {
    expect(judgeMergeState({})).toEqual(no("unknown"));
  });
});
