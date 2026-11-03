import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  requireConfig,
} from "../../src/config.ts";
import { FlowError } from "../../src/types.ts";

describe("config", () => {
  it("空のオブジェクトは既定値になる", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("progress は file だけ書けば列と状態の言葉が既定値で埋まる", () => {
    const config = parseConfig({
      progress: {
        file: "docs/progress.md",
        stateLabels: { working: "実装中" },
      },
    });
    expect(config.progress?.columns.id).toBe("ID");
    expect(config.progress?.stateLabels).toEqual({
      designing: "設計中",
      working: "実装中",
      integrated: "統合済み",
    });
  });

  it("lead は書いたキーだけ上書きする", () => {
    expect(parseConfig({ lead: { effort: "xhigh" } }).lead).toEqual({
      agent: "claude",
      model: "claude-opus-5-5",
      effort: "xhigh",
    });
  });

  it("知らないキーと型の違いをまとめて FlowError(1) にする", () => {
    try {
      parseConfig({
        typo: 1,
        maxActiveTasks: 0,
        verify: "pnpm test",
        lead: { foo: "x" },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FlowError);
      expect((error as FlowError).code).toBe(1);
      const message = (error as FlowError).message;
      expect(message).toContain("typo");
      expect(message).toContain("maxActiveTasks");
      expect(message).toContain("verify");
      expect(message).toContain("lead.foo");
    }
  });

  it("verifySkipPaths は既定で空、文字列の配列なら読む", () => {
    expect(parseConfig({}).verifySkipPaths).toEqual([]);
    expect(parseConfig({ verifySkipPaths: ["docs/"] }).verifySkipPaths).toEqual(
      ["docs/"],
    );
  });

  it("verifySkipPaths が文字列の配列でなければ直すところに出す", () => {
    expect(() => parseConfig({ verifySkipPaths: "docs/" })).toThrow(
      /verifySkipPaths は文字列の配列にしてください/,
    );
  });

  it("verifySkipPaths に空の文字列があれば直すところに出す", () => {
    for (const blank of ["", "  "]) {
      expect(() => parseConfig({ verifySkipPaths: ["docs/", blank] })).toThrow(
        /verifySkipPaths に空の文字列は書けません/,
      );
    }
  });

  it("codeReview は既定で full、full・light・off を読む", () => {
    expect(parseConfig({}).codeReview).toBe("full");
    for (const mode of ["full", "light", "off"] as const) {
      expect(parseConfig({ codeReview: mode }).codeReview).toBe(mode);
    }
  });

  it("codeReview がほかの値なら FlowError(1) にする", () => {
    for (const value of ["", 1, "none"]) {
      try {
        parseConfig({ codeReview: value });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(FlowError);
        expect((error as FlowError).code).toBe(1);
        expect((error as FlowError).message).toContain(
          'codeReview は "full"・"light"・"off" のどれかにしてください',
        );
      }
    }
  });

  it("reviewBackend は既定で claude、claude・local を読む", () => {
    expect(parseConfig({}).reviewBackend).toBe("claude");
    expect(parseConfig({ reviewBackend: "local" }).reviewBackend).toBe("local");
    expect(() => parseConfig({ reviewBackend: "other" })).toThrow(
      /reviewBackend は "claude"・"local"/,
    );
  });

  it("integrateVerify は既定で after-merge、after-merge・before-merge を読む", () => {
    expect(parseConfig({}).integrateVerify).toBe("after-merge");
    for (const mode of ["after-merge", "before-merge"]) {
      expect(parseConfig({ integrateVerify: mode }).integrateVerify).toBe(mode);
    }
    expect(() => parseConfig({ integrateVerify: "other" })).toThrow(
      /integrateVerify は "after-merge"・"before-merge"/,
    );
  });

  it("autoOrderOnOverlap は既定で true、true・false を読み、真偽値でなければ止まる", () => {
    expect(parseConfig({}).autoOrderOnOverlap).toBe(true);
    expect(parseConfig({ autoOrderOnOverlap: false }).autoOrderOnOverlap).toBe(
      false,
    );
    expect(parseConfig({ autoOrderOnOverlap: true }).autoOrderOnOverlap).toBe(
      true,
    );
    for (const value of ["true", 1, null]) {
      expect(() => parseConfig({ autoOrderOnOverlap: value })).toThrow(
        /autoOrderOnOverlap は true か false/,
      );
    }
  });

  it("prReady は既定で manual、manual・after-ci を読み、ほかの値は止まる", () => {
    expect(parseConfig({}).prReady).toBe("manual");
    for (const mode of ["manual", "after-ci"]) {
      expect(parseConfig({ prReady: mode }).prReady).toBe(mode);
    }
    for (const value of ["other", "", true, null]) {
      expect(() => parseConfig({ prReady: value })).toThrow(
        /prReady は "manual"・"after-ci"/,
      );
    }
  });

  it("decisionsFile は既定で null、appendOnlyFiles に入った空でない文字列だけを読む", () => {
    expect(parseConfig({}).decisionsFile).toBeNull();
    expect(parseConfig({ decisionsFile: null }).decisionsFile).toBeNull();
    expect(
      parseConfig({
        decisionsFile: "docs/decisions.md",
        appendOnlyFiles: ["docs/decisions.md"],
      }).decisionsFile,
    ).toBe("docs/decisions.md");
    // 書く順によらず appendOnlyFiles と照らす
    expect(
      parseConfig({
        appendOnlyFiles: ["docs/decisions.md"],
        decisionsFile: "docs/decisions.md",
      }).decisionsFile,
    ).toBe("docs/decisions.md");
    expect(() => parseConfig({ decisionsFile: "docs/decisions.md" })).toThrow(
      /decisionsFile は appendOnlyFiles/,
    );
    expect(() =>
      parseConfig({ decisionsFile: "", appendOnlyFiles: [""] }),
    ).toThrow(/decisionsFile は null か空でない文字列/);
    expect(() => parseConfig({ decisionsFile: 3 })).toThrow(
      /decisionsFile は null か空でない文字列/,
    );
  });

  it("localReview は既定値で埋まり、書いたキーだけ上書きする", () => {
    const localReview = parseConfig({
      localReview: {
        stageLimits: [4, 2],
        fallback: "human",
        stopOnNoMustFix: false,
      },
    }).localReview;
    expect(localReview.stageLimits).toEqual([4, 2]);
    expect(localReview.fallback).toBe("human");
    expect(localReview.stopOnNoMustFix).toBe(false);
    expect(localReview.model).toBe(DEFAULT_CONFIG.localReview.model);
    expect(DEFAULT_CONFIG.localReview.opusChecks).toBe(2);
  });

  it("localReview の型違いと知らないキーをまとめて FlowError(1) にする", () => {
    try {
      parseConfig({
        localReview: {
          stageLimits: [5],
          fullReviewAt: [],
          runner: "other",
          fallback: "other",
          stopOnNoMustFix: "yes",
          repeatLimit: 0,
          unknown: 1,
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FlowError);
      expect((error as FlowError).code).toBe(1);
      const message = (error as FlowError).message;
      expect(message).toContain("stageLimits");
      expect(message).toContain("fullReviewAt");
      expect(message).toContain("runner");
      expect(message).toContain("fallback");
      expect(message).toContain("stopOnNoMustFix");
      expect(message).toContain("repeatLimit");
      expect(message).toContain("localReview.unknown");
    }
  });

  it("ファイルがなければ exists: false、requireConfig は FlowError(2)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orca-flow-config-"));
    expect((await loadConfig(root)).exists).toBe(false);
    await expect(requireConfig(root)).rejects.toMatchObject({ code: 2 });
  });

  it("ファイルを読んで検証する", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orca-flow-config-"));
    await mkdir(path.join(root, ".orca-flow"));
    await writeFile(
      path.join(root, ".orca-flow/config.json"),
      JSON.stringify({ verify: ["pnpm test"] }),
    );
    const loaded = await loadConfig(root);
    expect(loaded.exists).toBe(true);
    expect(loaded.config.verify).toEqual(["pnpm test"]);
  });
});
