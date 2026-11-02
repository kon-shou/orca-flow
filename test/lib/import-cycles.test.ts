import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
);

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTs(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** 値の import / re-export の相手（`import type` と `export type` は除く） */
export function valueImports(file: string, text: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of text.matchAll(pattern)) {
    if (match[2]) continue;
    if (match[1] === "export" && !match[3]) continue;
    const spec = match[4]!;
    if (!spec.startsWith(".")) continue;
    found.push(path.resolve(path.dirname(file), spec));
  }
  return found;
}

function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1)
        return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of graph.keys()) {
    if (!state.has(node)) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

describe("src の読み込み", () => {
  it("値の import に循環がない（import type は除く）", () => {
    const graph = new Map<string, string[]>();
    for (const file of listTs(SRC))
      graph.set(file, valueImports(file, readFileSync(file, "utf8")));
    const cycle = findCycle(graph);
    expect(cycle?.map((f) => path.relative(SRC, f)).join(" -> ") ?? null).toBe(
      null,
    );
  });

  it("循環を見つけられる（見張り自体の確かめ）", () => {
    expect(
      findCycle(
        new Map([
          ["a", ["b"]],
          ["b", ["c"]],
          ["c", ["a"]],
        ]),
      ),
    ).toEqual(["a", "b", "c", "a"]);
    expect(
      findCycle(
        new Map([
          ["a", ["b"]],
          ["b", []],
        ]),
      ),
    ).toBeNull();
  });

  it("import type は数えない", () => {
    const file = path.join(SRC, "x.ts");
    expect(
      valueImports(
        file,
        'import type { A } from "./a.ts";\nimport { b } from "./b.ts";\nexport type { C } from "./c.ts";\nexport { d } from "./d.ts";\n',
      ).map((f) => path.basename(f)),
    ).toEqual(["b.ts", "d.ts"]);
  });
});
