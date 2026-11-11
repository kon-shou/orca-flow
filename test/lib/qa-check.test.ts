import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeTaskWorktree } from "../../src/lib/finish.ts";
import { createOrca } from "../../src/lib/orca.ts";
import {
  clearQaChecks,
  isShotName,
  parseRecordInput,
  qaChecksDir,
  renderResultMd,
  writeProfile,
} from "../../src/lib/qa-check.ts";
import type { Runner } from "../../src/lib/exec.ts";
import { FlowError, type CommandContext } from "../../src/types.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo } from "../helpers/repo.ts";

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const item = (over: Record<string, unknown> = {}) => ({
  text: "一覧に新しい行が出る",
  weight: "必須",
  kind: "事実",
  result: "pass",
  ...over,
});

const reject = (raw: unknown, shots: string[] = []) => {
  try {
    parseRecordInput(raw, new Set(shots));
  } catch (error) {
    expect(error).toBeInstanceOf(FlowError);
    expect((error as FlowError).code).toBe(1);
    return (error as FlowError).message;
  }
  throw new Error("断られませんでした");
};

describe("撮った名前の形", () => {
  it("英小文字・数字・ハイフンだけを受ける", () => {
    expect(isShotName("list-row-2")).toBe(true);
    for (const bad of [
      "",
      "-x",
      "A",
      "a_b",
      "a.b",
      "a/b",
      "a b",
      "x".repeat(65),
    ])
      expect(isShotName(bad), bad).toBe(false);
  });
});

describe("--record の入力", () => {
  it("4つの結果を受け、目で見る項目の前と後の名前を残す", () => {
    const parsed = parseRecordInput(
      {
        items: [
          item(),
          item({ result: "fail", reason: "行が出ない", after: "list" }),
          item({ result: "unverified", reason: "試しのデータがない" }),
          item({
            kind: "目で見る",
            weight: "できれば",
            result: "human",
            before: "list",
            after: "list",
          }),
        ],
        notices: [{ text: "画像が読めない", shot: "list" }],
      },
      new Set(["list-before.png", "list-after.png"]),
    );
    expect(parsed.items.map((i) => i.result)).toEqual([
      "pass",
      "fail",
      "unverified",
      "human",
    ]);
    expect(parsed.items[3]).toMatchObject({ before: "list", after: "list" });
    expect(parsed.notices).toEqual([{ text: "画像が読めない", shot: "list" }]);
  });

  it("notices は省いてよい", () => {
    expect(parseRecordInput({ items: [item()] }, new Set()).notices).toEqual(
      [],
    );
  });

  it("知らない result・理由のない fail と unverified を断る", () => {
    expect(reject({ items: [item({ result: "skip" })] })).toContain("result");
    expect(reject({ items: [item({ result: "fail" })] })).toContain("理由");
    expect(
      reject({ items: [item({ result: "unverified", reason: "" })] }),
    ).toContain("理由");
  });

  it("置き場にない画像の名前を断る", () => {
    expect(reject({ items: [item({ after: "list" })] })).toContain("list");
    expect(
      reject({ items: [item({ before: "list" })] }, ["list-after.png"]),
    ).toContain("list-before.png");
  });

  it("目で見る項目を pass・fail にしない、事実の項目を human にしない", () => {
    reject({ items: [item({ kind: "目で見る", result: "pass" })] });
    reject({ items: [item({ result: "human" })] });
  });

  it("項目が空・形が違う入力を断る", () => {
    reject({ items: [] });
    reject([]);
    reject({ items: [item({ text: "" })] });
    reject({ items: [item()], notices: [{ text: "x" }] });
  });
});

describe("result.md", () => {
  it("項目ごとの結果と理由、目で見る項目の前と後の画像を相対パスで並べる", () => {
    const md = renderResultMd({
      id: "T7",
      at: "2026-11-01T00:00:00.000Z",
      items: [
        {
          ...item(),
          weight: "必須",
          kind: "事実",
          result: "fail",
          reason: "行が出ない",
        },
        {
          ...item({ text: "一覧の見た目" }),
          weight: "できれば",
          kind: "目で見る",
          result: "human",
          before: "list",
          after: "list",
        },
      ],
      notices: [{ text: "横にはみ出す", shot: "list" }],
    });
    expect(md).toContain("行が出ない");
    expect(md).toContain("](list-before.png)");
    expect(md).toContain("](list-after.png)");
    expect(md).toContain("横にはみ出す");
    expect(md).not.toMatch(/\]\(\//);
  });
});

describe("置き場の掃除", () => {
  async function setup() {
    const root = await makeRepo({ idPrefix: "T" });
    const wt = await addTaskWorktree(root, "T7", "shop");
    const common = path.join(root, ".git");
    const fake = fakeOrca();
    const errs: string[] = [];
    const deletes: string[] = [];
    const profileDelete = { fails: false };
    const runner: Runner = async (cmd, args, opts) => {
      if (
        cmd === "orca" &&
        args.slice(0, 3).join(" ") === "tab profile delete"
      ) {
        deletes.push(args[args.indexOf("--profile") + 1]!);
        return {
          code: profileDelete.fails ? 1 : 0,
          stdout: JSON.stringify(
            profileDelete.fails
              ? { ok: false, error: { message: "boom" } }
              : { ok: true, result: { deleted: true } },
          ),
          stderr: "",
          timedOut: false,
        };
      }
      return fake.runner(cmd, args, opts);
    };
    const ctx = {
      argv: [],
      cwd: root,
      json: false,
      runner,
      env: {},
      stdout: () => {},
      stderr: (t: string) => errs.push(t),
      now: () => new Date(),
    } as CommandContext;
    const place = async (id: string) => {
      const dir = qaChecksDir(common, id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "a-after.png"), "x");
      return dir;
    };
    return {
      root,
      wt,
      common,
      ctx,
      errs,
      place,
      deletes,
      profileDelete,
      orca: createOrca(runner, root),
    };
  }

  it("統合の仕上げで worktree を消すと、その ID の置き場が消え、ほかの ID の置き場は残る", async () => {
    const s = await setup();
    const mine = await s.place("T7");
    const other = await s.place("T8");
    expect(await removeTaskWorktree(s.ctx, s.orca, "T7", s.wt.path)).toBe(true);
    expect(await exists(mine)).toBe(false);
    expect(await exists(other)).toBe(true);
  });

  it("記録の profile を消し、消せなくても例外を投げずに警告に ID を出して置き場を消す。記録がなければ消しに行かない", async () => {
    const s = await setup();
    const at = "2026-11-01T00:00:00.000Z";
    await writeProfile(await s.place("T7"), "prof-a", at);
    expect(await clearQaChecks(s.ctx, s.common, "T7")).toBe(true);
    expect(s.deletes).toEqual(["prof-a"]);
    expect(s.errs).toEqual([]);

    s.profileDelete.fails = true;
    const dir = await s.place("T7");
    await writeProfile(dir, "prof-b", at);
    expect(await clearQaChecks(s.ctx, s.common, "T7")).toBe(true);
    expect(s.errs.join("\n")).toContain(
      "orca tab profile delete --profile prof-b",
    );
    expect(await exists(dir)).toBe(false);

    await s.place("T8");
    expect(await clearQaChecks(s.ctx, s.common, "T8")).toBe(true);
    expect(s.deletes).toEqual(["prof-a", "prof-b"]);
  });

  it("記録の profile が既定なら、消しに行かず警告も出さずに置き場を消す", async () => {
    const s = await setup();
    const dir = await s.place("T7");
    await writeProfile(dir, " Default ", "2026-11-01T00:00:00.000Z");
    expect(await clearQaChecks(s.ctx, s.common, "T7")).toBe(true);
    expect(s.deletes).toEqual([]);
    expect(s.errs).toEqual([]);
    expect(await exists(dir)).toBe(false);
  });

  it("ID の形が外れていれば何も消さない", async () => {
    const s = await setup();
    const other = await s.place("T8");
    expect(await clearQaChecks(s.ctx, s.common, "")).toBe(false);
    expect(await clearQaChecks(s.ctx, s.common, "../T8")).toBe(false);
    expect(await exists(other)).toBe(true);
  });
});

describe("Orca の呼び出しの寄せ先", () => {
  it("QA の確かめの部品とコマンドは orca を Runner で直に呼ばず、Orca の部品を通す", async () => {
    for (const rel of ["src/lib/qa-check.ts", "src/commands/qa-check.ts"]) {
      const text = await readFile(
        new URL(`../../${rel}`, import.meta.url),
        "utf8",
      );
      expect(text, rel).not.toMatch(/runner\(\s*["'`]orca["'`]/);
      expect(text, rel).not.toContain("orcaCall");
      expect(text, rel).toContain("createOrca(");
    }
  });
});
