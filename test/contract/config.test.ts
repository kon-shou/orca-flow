import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ID_PREFIX_PATTERN,
  loadConfig,
  parseConfig,
  requireConfig,
} from "../../src/config.ts";
import { FlowError } from "../../src/types.ts";
import { makeTmpDir } from "../helpers/tmp/index.ts";

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

  it("appendOnlyFiles に空の文字列・「.」・グロブだけの値があれば直すところに出す", () => {
    for (const bad of [
      "",
      " ",
      ".",
      "./",
      "/",
      "*",
      "**",
      "**/*",
      "./*",
      "?",
    ]) {
      expect(() =>
        parseConfig({ appendOnlyFiles: ["docs/decisions.md", bad] }),
      ).toThrow(
        /appendOnlyFiles に空の文字列・「\.」・グロブだけの値は書けません/,
      );
    }
    // ほかの文字列の配列の設定には、この確かめを効かせない
    expect(parseConfig({ readFirst: ["."] }).readFirst).toEqual(["."]);
    expect(parseConfig({ verify: [""] }).verify).toEqual([""]);
    expect(parseConfig({ sharedPaths: ["*"] }).sharedPaths).toEqual(["*"]);
    expect(
      parseConfig({ appendOnlyFiles: ["docs/decisions.md", ".github/log.md"] })
        .appendOnlyFiles,
    ).toEqual(["docs/decisions.md", ".github/log.md"]);
  });

  it("ID_PREFIX_PATTERN は idPrefix の確かめと同じ形を出す", () => {
    const whole = new RegExp(`^${ID_PREFIX_PATTERN}$`);
    for (const ok of ["T", "P", "ISS-", "Ab_c"])
      expect(whole.test(ok)).toBe(true);
    for (const bad of ["../", "T1", "1T", "T.", "-x"])
      expect(whole.test(bad)).toBe(false);
  });

  it("idPrefix・branchPrefix・baseBranch は形を確かめ、パスの外に出る値は止まる", () => {
    for (const idPrefix of ["T", "P", "ISS-", "Ab_c"]) {
      expect(parseConfig({ idPrefix }).idPrefix).toBe(idPrefix);
    }
    for (const branchPrefix of ["task/", "feat/", "x-y.z/"]) {
      expect(parseConfig({ branchPrefix }).branchPrefix).toBe(branchPrefix);
    }
    for (const baseBranch of ["main", "release/1.2", "dev_x"]) {
      expect(parseConfig({ baseBranch }).baseBranch).toBe(baseBranch);
    }
    for (const idPrefix of [
      "../",
      "a/b",
      "T 1",
      "T\n",
      "-x",
      "T1",
      "T.",
      "1T",
    ]) {
      expect(() => parseConfig({ idPrefix })).toThrow(
        /idPrefix は英字で始まり/,
      );
    }
    for (const branchPrefix of [
      "../",
      "a b/",
      "a\tb",
      "-x/",
      "/x",
      ".x/",
      "a..b/",
      "a//b",
      "a/.b",
      "x.lock/",
    ]) {
      expect(() => parseConfig({ branchPrefix })).toThrow(
        /branchPrefix は英数字/,
      );
    }
    for (const baseBranch of [
      "../main",
      "main/",
      "main.",
      "a..b",
      "-main",
      "x.lock",
      "ma in",
    ]) {
      expect(() => parseConfig({ baseBranch })).toThrow(/baseBranch は英数字/);
    }
    for (const key of ["idPrefix", "branchPrefix", "baseBranch"]) {
      expect(() => parseConfig({ [key]: "" })).toThrow(/空でない文字列/);
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

  it("outbound は既定で6章の outbound の値、正しい値を読み、誤りは止まる", () => {
    expect(parseConfig({}).outbound).toEqual({
      allow: ["push", "pr-create", "pr-ready"],
      window: { days: [1, 2, 3, 4, 5], from: "09:00", to: "20:00" },
      interval: { seconds: 1, perBatch: 5 },
    });
    const read = parseConfig({
      outbound: {
        allow: ["push"],
        window: { days: [0, 6], from: "00:00", to: "23:59" },
        interval: { seconds: 0.5, perBatch: 2 },
      },
    }).outbound;
    expect(read).toEqual({
      allow: ["push"],
      window: { days: [0, 6], from: "00:00", to: "23:59" },
      interval: { seconds: 0.5, perBatch: 2 },
    });
    // 一部だけ書けば、残りは既定値
    expect(parseConfig({ outbound: { allow: [] } }).outbound.window).toEqual({
      days: [1, 2, 3, 4, 5],
      from: "09:00",
      to: "20:00",
    });
    const bad: [unknown, RegExp][] = [
      [[], /outbound はオブジェクト/],
      [
        { allow: ["merge"] },
        /outbound\.allow は "push"・"pr-create"・"pr-ready"・"reply"・"rerequest"/,
      ],
      [{ allow: "push" }, /outbound\.allow は/],
      [{ window: { days: [7] } }, /outbound\.window\.days は 0/],
      [{ window: { days: [1.5] } }, /outbound\.window\.days は 0/],
      [{ window: { from: "9:00" } }, /outbound\.window\.from は HH:MM/],
      [{ window: { to: "24:00" } }, /outbound\.window\.to は HH:MM/],
      [
        { interval: { seconds: 0 } },
        /outbound\.interval\.seconds は0より大きい/,
      ],
      [
        { interval: { seconds: -1 } },
        /outbound\.interval\.seconds は0より大きい/,
      ],
      [{ interval: { perBatch: 0 } }, /outbound\.interval\.perBatch は1以上/],
      [{ other: 1 }, /知らないキー outbound\.other/],
      [{ window: { other: 1 } }, /知らないキー outbound\.window\.other/],
      [{ interval: { other: 1 } }, /知らないキー outbound\.interval\.other/],
    ];
    for (const [value, message] of bad) {
      expect(() => parseConfig({ outbound: value })).toThrow(message);
    }
  });

  it("prWatch は既定で5分・1000、正しい値を読み、誤りは止まる", () => {
    expect(parseConfig({}).prWatch).toEqual({
      intervalMinutes: 5,
      minRemaining: 1000,
      maxLaunches: 3,
    });
    expect(
      parseConfig({ prWatch: { maxLaunches: 1 } }).prWatch.maxLaunches,
    ).toBe(1);
    expect(
      parseConfig({ prWatch: { intervalMinutes: 10, minRemaining: 0 } })
        .prWatch,
    ).toEqual({ intervalMinutes: 10, minRemaining: 0, maxLaunches: 3 });
    expect(parseConfig({ prWatch: { minRemaining: 50 } }).prWatch).toEqual({
      intervalMinutes: 5,
      minRemaining: 50,
      maxLaunches: 3,
    });
    const bad: [unknown, RegExp][] = [
      [[], /prWatch はオブジェクト/],
      [{ intervalMinutes: 0 }, /prWatch\.intervalMinutes は1以上/],
      [{ intervalMinutes: 1.5 }, /prWatch\.intervalMinutes は1以上/],
      [{ minRemaining: -1 }, /prWatch\.minRemaining は0以上/],
      [{ minRemaining: 0.5 }, /prWatch\.minRemaining は0以上/],
      [{ maxLaunches: 0 }, /prWatch\.maxLaunches は1以上の整数にしてください/],
      [
        { maxLaunches: 2.5 },
        /prWatch\.maxLaunches は1以上の整数にしてください/,
      ],
      [{ other: 1 }, /知らないキー prWatch\.other/],
    ];
    for (const [value, message] of bad) {
      expect(() => parseConfig({ prWatch: value })).toThrow(message);
    }
  });

  it("risk は既定で空、正しい値を読み、誤りは止まる", () => {
    expect(parseConfig({}).risk).toEqual({ paths: [], labels: [] });
    expect(
      parseConfig({ risk: { paths: ["migrations/", "src/auth/**"] } }).risk,
    ).toEqual({ paths: ["migrations/", "src/auth/**"], labels: [] });
    expect(parseConfig({ risk: { labels: ["security"] } }).risk).toEqual({
      paths: [],
      labels: ["security"],
    });
    const bad: [unknown, RegExp][] = [
      [[], /risk はオブジェクト/],
      [{ paths: "src/" }, /risk\.paths は空でない文字列の配列/],
      [{ paths: [1] }, /risk\.paths は空でない文字列の配列/],
      [{ paths: [""] }, /risk\.paths は空でない文字列の配列/],
      [{ labels: ["  "] }, /risk\.labels は空でない文字列の配列/],
      [{ labels: null }, /risk\.labels は空でない文字列の配列/],
      [{ other: [] }, /知らないキー risk\.other/],
    ];
    for (const [value, message] of bad) {
      expect(() => parseConfig({ risk: value })).toThrow(message);
    }
  });

  it("taskEnd は既定で integrate、integrate・pr を読み、ほかの値は止まる", () => {
    expect(parseConfig({}).taskEnd).toBe("integrate");
    for (const mode of ["integrate", "pr"]) {
      expect(parseConfig({ taskEnd: mode }).taskEnd).toBe(mode);
    }
    for (const value of ["other", "", true, null]) {
      expect(() => parseConfig({ taskEnd: value })).toThrow(
        /taskEnd は "integrate"・"pr"/,
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
    const root = await makeTmpDir("orca-flow-config-");
    expect((await loadConfig(root)).exists).toBe(false);
    await expect(requireConfig(root)).rejects.toMatchObject({ code: 2 });
  });

  it("ファイルを読んで検証する", async () => {
    const root = await makeTmpDir("orca-flow-config-");
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
