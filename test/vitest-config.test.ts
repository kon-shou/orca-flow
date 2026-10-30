import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.ts";
import { git, gitCallCount, makeRepo } from "./helpers/repo.ts";

const root = path.resolve(import.meta.dirname, "..");

async function testFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await testFiles(full)));
    else if (entry.name.endsWith(".test.ts")) found.push(full);
  }
  return found;
}

const TEST_NAMES = new Set(["it", "test", "describe"]);
// 呼び出しの結果がまた関数になる修飾（.each(表)(…)、.skipIf(条件)(…)）。この呼び出し自体の引数は時間切れではない
const CURRIED = new Set(["each", "for", "skipIf", "runIf"]);

/** it／test／describe とその .skip・.only・.each(…)・.skipIf(…) などの連なりか */
function isTestCallee(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return TEST_NAMES.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return isTestCallee(node.expression);
  if (ts.isCallExpression(node)) return isTestCallee(node.expression);
  return false;
}

/** it／test／describe（.each・.skip・.skipIf などを含む）の呼び出しに渡した時間切れ（ミリ秒）を行番号つきで集める。TypeScript の構文木で読むので、正規表現・文字列・コメントの中は呼び出しと見なさない */
export function findTimeouts(
  source: string,
): { line: number; raw: string; ms: number }[] {
  const sf = ts.createSourceFile(
    "x.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: { line: number; raw: string; ms: number }[] = [];
  const add = (call: ts.CallExpression, lit: ts.NumericLiteral) => {
    const raw = lit.getText(sf);
    const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
    found.push({ line, raw, ms: Number(raw.replaceAll("_", "")) });
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      isTestCallee(node.expression) &&
      !(
        ts.isPropertyAccessExpression(node.expression) &&
        CURRIED.has(node.expression.name.text)
      )
    ) {
      for (const arg of node.arguments) {
        if (ts.isNumericLiteral(arg)) add(node, arg);
        else if (ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (
              ts.isPropertyAssignment(p) &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
              p.name.text === "timeout" &&
              ts.isNumericLiteral(p.initializer)
            )
              add(node, p.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("vitest.config.ts", () => {
  it("testTimeout は60秒で、maxWorkers は 50%", () => {
    expect(config.test?.testTimeout).toBe(60_000);
    expect(config.test?.maxWorkers).toBe("50%");
  });

  it("test/ の下に、testTimeout より短い時間切れがない", async () => {
    const limit = config.test?.testTimeout ?? 0;
    const short: string[] = [];
    for (const file of await testFiles(path.join(root, "test"))) {
      const text = await readFile(file, "utf8");
      for (const t of findTimeouts(text)) {
        if (t.ms < limit)
          short.push(`${path.relative(root, file)}:${t.line}：${t.raw}`);
      }
    }
    expect(short).toEqual([]);
  });
});

describe("findTimeouts（時間切れの拾い方）", () => {
  const raws = (text: string) => findTimeouts(text).map((t) => t.raw);

  it("it・test・describe の最後の引数と、timeout オプションを拾う", () => {
    expect(raws('it("a", async () => {\n  x();\n}, 5_000);')).toEqual([
      "5_000",
    ]);
    expect(raws('test.skip("a", () => {}, 7);')).toEqual(["7"]);
    expect(raws('describe("a", () => {}, 9);')).toEqual(["9"]);
    expect(raws('it("a", { timeout: 10_000 }, () => {});')).toEqual(["10_000"]);
    expect(raws('it("a", () => {}, { timeout: 3000 });')).toEqual(["3000"]);
  });

  it("prettier が整形した it.each・describe.each（数のあとのカンマ）を拾う", () => {
    const each =
      'it.each([[1], [2]])("a %s", async (n) => {\n  f(n);\n},\n  10_000,\n);';
    expect(raws(each)).toEqual(["10_000"]);
    expect(
      raws('describe.each(["a"])("b", () => {\n  f();\n},\n  20_000,\n);'),
    ).toEqual(["20_000"]);
  });

  it("正規表現リテラル（引用符・バッククォートを含む）のあとのテストの時間切れも拾う", () => {
    const src =
      'const a = /["\'`]/;\nit("a", () => {\n  f();\n}, 5_000);\nconst b = /`/;\ndescribe("b", () => {}, 6_000);';
    expect(raws(src)).toEqual(["5_000", "6_000"]);
  });

  it(".skipIf(…)・.runIf(…) の2つめの呼び出しの時間切れを拾う", () => {
    expect(raws('describe.skipIf(!x)("a", () => {}, 240_000);')).toEqual([
      "240_000",
    ]);
    expect(raws('it.runIf(y)("a", () => {}, { timeout: 480_000 });')).toEqual([
      "480_000",
    ]);
    expect(raws('describe.skipIf(5)("a", () => {});')).toEqual([]);
  });

  it("行番号を返す", () => {
    expect(findTimeouts('\n\nit("a", () => {}, 1);')[0]?.line).toBe(3);
  });

  it("時間切れでない数は拾わない", () => {
    expect(raws("setTimeout(() => {\n  r();\n}, 50);")).toEqual([]);
    expect(raws("json({ ok: true }, 1);")).toEqual([]);
    expect(raws('it("a", () => {\n  json({ ok: true }, 1);\n});')).toEqual([]);
    expect(raws('it("a, 5", () => { f(2); });')).toEqual([]);
    expect(raws('it.each([[1, 2]])("a", (n) => {\n  f(n);\n});')).toEqual([]);
    expect(raws('expect(x).toBe(1);\n// it("a", () => {}, 1);')).toEqual([]);
  });
});

describe("makeRepo", () => {
  it("git を起こすのは init・add・commit の3回だけ", async () => {
    const before = gitCallCount();
    await makeRepo();
    expect(gitCallCount() - before).toBe(3);
  });

  it("user.name・user.email・commit.gpgsign と最初のコミットの件名 init がある", async () => {
    const repo = await makeRepo();
    expect(await git(repo, "config", "user.name")).toBe("テスト");
    expect(await git(repo, "config", "user.email")).toBe("test@example.com");
    expect(await git(repo, "config", "--type=bool", "commit.gpgsign")).toBe(
      "false",
    );
    expect(await git(repo, "log", "--format=%an <%ae> %s")).toBe(
      "テスト <test@example.com> init",
    );
  });
});
