import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const testDir = path.join(root, "test");
const allowedDir = path.join(testDir, "helpers/tmp") + path.sep;

async function tsFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await tsFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** mkdtemp・mkdtempSync の呼び出し（fs.mkdtemp(...) も含む）の行番号。構文木で読むので、文字列とコメントは呼び出しと見なさない */
export function findMkdtempCalls(source: string): number[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (name === "mkdtemp" || name === "mkdtempSync")
        lines.push(
          sf.getLineAndCharacterOfPosition(callee.getStart(sf)).line + 1,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe("test/ の下の mkdtemp", () => {
  it("直接呼ぶのは test/helpers/tmp/ だけ", async () => {
    const direct: string[] = [];
    for (const file of await tsFiles(testDir)) {
      if (file.startsWith(allowedDir)) continue;
      for (const line of findMkdtempCalls(await readFile(file, "utf8")))
        direct.push(`${path.relative(root, file)}:${line}`);
    }
    expect(direct).toEqual([]);
  });

  it("findMkdtempCalls は呼び出しだけを行番号つきで拾う", () => {
    expect(findMkdtempCalls("\nawait mkdtemp(a);\nfs.mkdtempSync(b);")).toEqual(
      [2, 3],
    );
    expect(
      findMkdtempCalls(
        'import { mkdtemp } from "x";\n// mkdtemp(a)\nconst s = "mkdtemp(a)";',
      ),
    ).toEqual([]);
  });
});
