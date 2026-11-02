import { describe, expect, it } from "vitest";
import { DEFAULT_SHARED_PATHS } from "../../src/config.ts";
import {
  checkOverlap,
  filesOutsideRange,
  matchesShared,
  matchingPathVerify,
  pathsOverlap,
} from "../../src/lib/overlap.ts";
import type { TaskDoc } from "../../src/lib/task-doc.ts";

const doc = (partial: Partial<TaskDoc>): TaskDoc => ({
  allowed: [],
  workers: [],
  prechanges: [],
  warnings: [],
  ...partial,
});

describe("overlap", () => {
  it("ディレクトリの区切りで比べる", () => {
    expect(pathsOverlap("scripts/review", "scripts/review/rules/")).toBe(true);
    expect(pathsOverlap("scripts/review/rules/", "scripts/review")).toBe(true);
    expect(pathsOverlap("scripts/review", "scripts/review-account")).toBe(
      false,
    );
    expect(pathsOverlap("./src/a/", "src/a")).toBe(true);
  });

  it("ファイル名だけの共有のファイルはどの階層にも当たる", () => {
    expect(matchesShared("apps/x/package.json", "package.json")).toBe(true);
    expect(matchesShared("package.json", "package.json")).toBe(true);
    expect(matchesShared("apps/x/", "package.json")).toBe(false);
    expect(matchesShared(".claude/settings.json", ".claude/")).toBe(true);
    expect(matchesShared("docs/progress.md", "docs/progress.md")).toBe(true);
    expect(matchesShared("docs/", "docs/progress.md")).toBe(true);
    expect(matchesShared("src/claude/", ".claude/")).toBe(false);
  });

  it("担当同士の重なりを見つける", () => {
    const problems = checkOverlap({
      doc: doc({
        allowed: ["src/a"],
        workers: [
          { name: "A", paths: ["src/a"] },
          { name: "B", paths: ["src/a/ui"] },
        ],
      }),
      sharedPaths: [],
      others: [],
    });
    expect(problems.map((p) => p.kind)).toEqual(["workers"]);
  });

  it("「書き込んでよい場所」の外の担当の場所を見つける", () => {
    const problems = checkOverlap({
      doc: doc({
        allowed: ["src/a"],
        workers: [{ name: "A", paths: ["src/b"] }],
      }),
      sharedPaths: [],
      others: [],
    });
    expect(problems.map((p) => p.kind)).toEqual(["outside"]);
  });

  it("sharedPaths（package.json は apps/x/package.json にも当たる）を見つける", () => {
    const problems = checkOverlap({
      doc: doc({ allowed: ["apps/x/package.json", "apps/x/src"] }),
      sharedPaths: DEFAULT_SHARED_PATHS,
      others: [],
    });
    expect(problems.map((p) => p.kind)).toEqual(["shared"]);
    expect(problems[0]!.message).toContain("apps/x/package.json");
  });

  it("作業中のほかのタスクとの重なりを見つける", () => {
    const problems = checkOverlap({
      doc: doc({ allowed: ["scripts/review"] }),
      sharedPaths: [],
      others: [
        { id: "T91", allowed: ["scripts/review/rules"] },
        { id: "T92", allowed: ["scripts/review-account"] },
      ],
    });
    expect(problems.map((p) => p.kind)).toEqual(["active"]);
    expect(problems[0]!.message).toContain("T91");
  });

  it("重ならなければ空", () => {
    expect(
      checkOverlap({
        doc: doc({
          allowed: ["src/a", "test/a"],
          workers: [
            { name: "A", paths: ["src/a"] },
            { name: "B", paths: ["test/a"] },
          ],
        }),
        sharedPaths: DEFAULT_SHARED_PATHS,
        others: [{ id: "T9", allowed: ["src/b"] }],
      }),
    ).toEqual([]);
  });

  it("integrate の範囲：設計書・報告・appendOnlyFiles は通り、外は返す", () => {
    expect(
      filesOutsideRange({
        files: [
          "src/a/x.ts",
          "docs/tasks/T1.md",
          "docs/tasks/reports/T1.md",
          "docs/decisions.md",
          "src/b/y.ts",
          "docs/tasks/T2.md",
        ],
        allowed: ["src/a"],
        docs: ["docs/tasks/T1.md", "docs/tasks/reports/T1.md"],
        appendOnlyFiles: ["docs/decisions.md"],
      }),
    ).toEqual(["src/b/y.ts", "docs/tasks/T2.md"]);
  });

  it("pathVerify は差分が当たるものだけ", () => {
    expect(
      matchingPathVerify(
        ["services/backend/a.py", "src/x.ts"],
        [
          { paths: ["services/backend/"], commands: ["uv run pytest"] },
          { paths: ["apps/"], commands: ["pnpm e2e"] },
        ],
      ),
    ).toEqual(["uv run pytest"]);
  });
});

describe("overlap のバッククォートの中の書き添え", () => {
  it("自分の設計書の書き添えを、直すところ（note）に入れる", () => {
    const problems = checkOverlap({
      doc: doc({
        allowed: ["src/a.ts（新規）"],
        workers: [{ name: "担当A：本体", paths: ["src/a.ts（新規）"] }],
        notes: [
          { where: "書き込んでよい場所", content: "src/a.ts（新規）" },
          { where: "担当「担当A：本体」", content: "src/a.ts（新規）" },
        ],
      }),
      sharedPaths: DEFAULT_SHARED_PATHS,
      others: [],
    });
    expect(problems.map((p) => p.kind)).toEqual(["note", "note"]);
    expect(problems[0]!.message).toContain("書き込んでよい場所");
    expect(problems[0]!.message).toContain("src/a.ts（新規）");
    expect(problems[0]!.message).toContain(
      "書き添えはバッククォートの外に書いてください",
    );
    expect(problems[1]!.message).toContain("担当「担当A：本体」");
  });

  it("書き添えがなければ note は出さない", () => {
    const problems = checkOverlap({
      doc: doc({
        allowed: ["src/a.ts"],
        workers: [{ name: "担当A：本体", paths: ["src/a.ts"] }],
      }),
      sharedPaths: DEFAULT_SHARED_PATHS,
      others: [],
    });
    expect(problems).toEqual([]);
  });
});

describe("checkOverlap と マージの順", () => {
  const item = (id: string) => ({ id, integrated: false, mergeCommit: null });
  const input = (selfId: string) => ({
    doc: doc({ allowed: ["src/a/"] }),
    sharedPaths: [],
    others: [
      { id: "T01", allowed: ["src/a/x"] },
      { id: "T03", allowed: ["src/a/y"] },
    ],
    order: { chains: [[item("T01"), item("T02"), item("T04")]] },
    selfId,
  });

  it("同じ鎖の相手は kind order（前後つき）、鎖にない相手は active", () => {
    const problems = checkOverlap(input("T02"));
    expect(problems.map((p) => [p.kind, p.order])).toEqual([
      ["order", { id: "T01", position: "after" }],
      ["active", undefined],
    ]);
    expect(problems[0]!.message).toContain("マージの順");
    // active の問題は重なる相手の ID を持つ（自動で足すときに使う）
    expect(problems[1]!.other).toBe("T03");
  });

  it("自分より後ろで重なる相手は position が before、文に「の前」が入る", () => {
    const problems = checkOverlap({
      ...input("T02"),
      others: [{ id: "T04", allowed: ["src/a/z"] }],
    });
    expect(problems.map((p) => [p.kind, p.order])).toEqual([
      ["order", { id: "T04", position: "before" }],
    ]);
    expect(problems[0]!.message).toContain("T02 は T04 の前です");
  });

  it("順がなければ今までどおり active", () => {
    const { order: _order, ...rest } = input("T02");
    expect(checkOverlap(rest).map((p) => p.kind)).toEqual(["active", "active"]);
  });
});
