import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function skillLines(): Promise<string[]> {
  const text = await readFile(
    path.join(ROOT, "skills/review/SKILL.md"),
    "utf8",
  );
  return text.split("\n");
}

async function thresholdLine(): Promise<string> {
  const lines = (await skillLines()).filter((l) =>
    l.startsWith("小さな差分のしきい値："),
  );
  expect(lines.length).toBe(1);
  return lines[0] as string;
}

/** しきい値の行のバッククォートの中の、数えるコマンドの引数（git のうしろ） */
function countArgs(line: string, range: string): string[] {
  const m = /`(git diff --numstat [^`]*)`/.exec(line);
  expect(m, "数えるコマンドが見つかりません").not.toBeNull();
  const cmd = (m as RegExpExecArray)[1] as string;
  const args: string[] = [];
  for (const t of cmd.replace(/^git /, "").matchAll(/'([^']*)'|(\S+)/g)) {
    args.push(((t[1] ?? t[2]) as string).replace("〈範囲〉", range));
  }
  return args;
}

describe("review のしきい値から md を外す", () => {
  it("しきい値の行は1つで、.md を数えないと書き、300 行のまま", async () => {
    const line = await thresholdLine();
    expect(line).toContain(".md");
    expect(line).toContain("数えない");
    expect(line).toMatch(/300 行/);
  });

  it("数えるコマンドは ts を数え、深い階層の .md と .MD を数えず、.mdx を数える", async () => {
    const dir = await makeRepo({}, { "README.txt": "base\n" });
    await git(dir, "checkout", "-q", "-b", "work");
    await writeFiles(dir, {
      "src/a.ts": "1\n2\n3\n",
      "docs/deep/er/spec.md": "1\n2\n3\n4\n5\n",
      "NOTES.MD": "1\n2\n3\n4\n5\n6\n",
      "docs/page.mdx": "1\n2\n",
    });
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "change");

    const args = countArgs(await thresholdLine(), "main...HEAD");
    const count = async (cwd: string) =>
      new Map(
        (await git(cwd, ...args)).split("\n").map((l) => {
          const [add, , file] = l.split("\t");
          return [file as string, Number(add)] as const;
        }),
      );
    const counted = await count(dir);
    // サブディレクトリから流しても、木全体で同じ数になる
    expect(await count(path.join(dir, "docs", "deep"))).toEqual(counted);
    expect([...counted.keys()].sort()).toEqual(["docs/page.mdx", "src/a.ts"]);
    expect(counted.get("src/a.ts")).toBe(3);
    expect(counted.get("docs/page.mdx")).toBe(2);
  });

  it("手順1の「差分なし」の判定は md を除かない", async () => {
    const step = (await skillLines()).find((l) => l.startsWith("1. "));
    expect(step).toBeDefined();
    expect(step).toContain("`git diff --name-only 〈範囲〉`");
    expect(step).not.toContain("exclude");
  });

  it("md だけの差分の扱いを書いた文がある", async () => {
    const line = (await skillLines()).find((l) => l.includes("md だけの差分"));
    expect(line).toBeDefined();
    expect(line).toContain("0行");
    expect(line).toContain("レビュー役1つと検証役1つ");
  });

  it("docs/spec.md の 10.1 の review の行にも md を数えないと書いてある", async () => {
    const spec = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    const row = spec
      .split("\n")
      .find((l) => l.startsWith("| `/orca-flow:review "));
    expect(row).toBeDefined();
    expect(row).toContain("拡張子が .md のファイルの行は数えない");
  });
});
