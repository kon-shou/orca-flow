import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { git, makeRepo, writeFiles } from "./helpers/repo.ts";
import { testRunner } from "./helpers/runner.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

// ---- 構文木で、リポジトリの根から組み立てたパスを集める ----

/** 式の値。located は「リポジトリの根からの相対パス」（テストのファイルの場所から組み立てた値）、そうでなければ ただの文字列 */
type Val = { located: boolean; vals: string[] };

type Ctx = {
  /** テストのファイルのあるディレクトリ（根からの相対、/ 区切り） */
  dir: string;
  /** 手元の関数を呼んだときの、仮引数の宣言 → 実引数の値 */
  bindings: Map<ts.Node, string[]>;
  /** bindings の仮引数を使ったか */
  used: { value: boolean };
  depth: number;
};

const MAX_VALUES = 200;
const PLACEHOLDER = "x";
/** 手元の関数を重ねてたどる深さの上限 */
const MAX_HELPER_DEPTH = 5;

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isTypeAssertionExpression(n)
    )
      n = n.expression;
    else return n;
  }
}

/** 名前の束縛（分割代入を含む）の中に name があれば、その宣言（分割代入なら束縛の要素）を返す */
function bindingDecl(
  binding: ts.BindingName,
  name: string,
  decl: ts.Node,
): ts.Node | undefined {
  if (ts.isIdentifier(binding)) return binding.text === name ? decl : undefined;
  for (const el of binding.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const found = bindingDecl(el.name, name, el);
    if (found) return found;
  }
  return undefined;
}

function declsOfStatements(
  statements: readonly ts.Statement[],
  name: string,
): ts.Node | undefined {
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const found = bindingDecl(d.name, name, d);
        if (found) return found;
      }
    } else if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
      st.name?.text === name
    )
      return st;
    else if (ts.isImportDeclaration(st) && st.importClause) {
      const clause = st.importClause;
      if (clause.name?.text === name) return clause;
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) return nb;
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements) if (el.name.text === name) return el;
    }
  }
  return undefined;
}

/** 識別子の宣言を、内側のスコープから外へたどって探す（同じ名前の隠しは内側が勝つ） */
function findDecl(from: ts.Node, name: string): ts.Node | undefined {
  for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
    if (ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n)) {
      const found = declsOfStatements(n.statements, name);
      if (found) return found;
    } else if (ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      const found = declsOfStatements(n.statements, name);
      if (found) return found;
    } else if (
      (ts.isForStatement(n) ||
        ts.isForOfStatement(n) ||
        ts.isForInStatement(n)) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.initializer)
    ) {
      for (const d of n.initializer.declarations) {
        const found = bindingDecl(d.name, name, d);
        if (found) return found;
      }
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      const found = bindingDecl(
        n.variableDeclaration.name,
        name,
        n.variableDeclaration,
      );
      if (found) return found;
    } else if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) {
        const found = bindingDecl(p.name, name, p);
        if (found) return found;
      }
      if (ts.isFunctionExpression(n) && n.name?.text === name) return n;
    }
  }
  return undefined;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function isImportMeta(node: ts.Expression, prop: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === prop &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/** 直積（多すぎるときは諦める） */
function product(lists: string[][]): string[][] | undefined {
  let out: string[][] = [[]];
  for (const list of lists) {
    if (out.length * list.length > MAX_VALUES) return undefined;
    out = out.flatMap((head) => list.map((v) => [...head, v]));
  }
  return out;
}

function evalList(
  nodes: readonly ts.Expression[],
  ctx: Ctx,
): Val[] | undefined {
  const out: Val[] = [];
  for (const n of nodes) {
    const v = evalExpr(n, ctx);
    if (!v) return undefined;
    out.push(v);
  }
  return out;
}

/** join／resolve の引数から、根からのパスを作る。最初が根（located）で、あとが文字列のときだけ */
function joinValue(args: readonly ts.Expression[], ctx: Ctx): Val | undefined {
  const vals = evalList(args, ctx);
  if (!vals || vals.length === 0) return undefined;
  const [first, ...rest] = vals as [Val, ...Val[]];
  if (!first.located || rest.some((v) => v.located)) return undefined;
  const combos = product([first.vals, ...rest.map((v) => v.vals)]);
  if (!combos) return undefined;
  return {
    located: true,
    vals: combos.map((c) => path.posix.normalize(path.posix.join(...c))),
  };
}

function evalExpr(raw: ts.Expression, ctx: Ctx): Val | undefined {
  if (ctx.depth > 20) return undefined;
  const sub = { ...ctx, depth: ctx.depth + 1 };
  const node = unwrap(raw);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { located: false, vals: [node.text] };
  if (ts.isTemplateExpression(node)) {
    const lists: string[][] = [[node.head.text]];
    for (const span of node.templateSpans) {
      const v = evalExpr(span.expression, sub);
      // 決まらない ${} は仮の1語に置く
      lists.push(v && !v.located ? v.vals : [PLACEHOLDER]);
      lists.push([span.literal.text]);
    }
    const combos = product(lists);
    return combos && { located: false, vals: combos.map((c) => c.join("")) };
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const l = evalExpr(node.left, sub);
    const r = evalExpr(node.right, sub);
    if (!l || !r || l.located || r.located) return undefined;
    const combos = product([l.vals, r.vals]);
    return combos && { located: false, vals: combos.map((c) => c.join("")) };
  }
  if (isImportMeta(node, "dirname")) return { located: true, vals: [ctx.dir] };
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name === "join" || name === "resolve")
      return joinValue(node.arguments, sub);
    if (name === "dirname" && node.arguments.length === 1) {
      // path.dirname(fileURLToPath(import.meta.url))
      const arg = unwrap(node.arguments[0] as ts.Expression);
      if (
        ts.isCallExpression(arg) &&
        calleeName(arg) === "fileURLToPath" &&
        arg.arguments.length === 1 &&
        isImportMeta(unwrap(arg.arguments[0] as ts.Expression), "url")
      )
        return { located: true, vals: [ctx.dir] };
    }
    return undefined;
  }
  if (ts.isIdentifier(node)) {
    const decl = findDecl(node, node.text);
    if (!decl) return undefined;
    const bound = ctx.bindings.get(decl);
    if (bound) {
      ctx.used.value = true;
      return { located: false, vals: bound };
    }
    if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name))
      return undefined;
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list)) return undefined;
    // for (const x of [...]) の x は、配列の要素ごと
    if (ts.isForOfStatement(list.parent) && list.parent.initializer === list) {
      const elements = arrayElements(list.parent.expression, sub);
      if (!elements) return undefined;
      const vals = evalList(elements, sub);
      if (!vals || vals.some((v) => v.located)) return undefined;
      return { located: false, vals: vals.flatMap((v) => v.vals) };
    }
    if (!(list.flags & ts.NodeFlags.Const) || !decl.initializer)
      return undefined;
    return evalExpr(decl.initializer, sub);
  }
  return undefined;
}

/** 配列の式（配列そのものか、配列を入れた const）の要素 */
function arrayElements(
  raw: ts.Expression,
  ctx: Ctx,
): readonly ts.Expression[] | undefined {
  const node = unwrap(raw);
  if (ts.isArrayLiteralExpression(node)) return node.elements;
  if (ts.isIdentifier(node) && ctx.depth < 20) {
    const decl = findDecl(node, node.text);
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      ts.isIdentifier(decl.name) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent) &&
      decl.parent.flags & ts.NodeFlags.Const
    )
      return arrayElements(decl.initializer, { ...ctx, depth: ctx.depth + 1 });
  }
  return undefined;
}

/** 呼び出しの相手が、手元の関数（function 宣言か、const に入れた関数式）なら、その関数 */
function localFunction(call: ts.CallExpression): LocalFn | undefined {
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee)) return undefined;
  const decl = findDecl(callee, callee.text);
  if (decl && ts.isFunctionDeclaration(decl)) return decl;
  if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isVariableDeclarationList(decl.parent) &&
    decl.parent.flags & ts.NodeFlags.Const
  ) {
    const init = unwrap(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

type LocalFn =
  ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

export type RootedPath = { line: number; path: string };

/**
 * テストのソースから、リポジトリの根から組み立てたパス（根からの相対）を行番号つきで集める。
 * fileRel は、そのソースのファイルの根からの相対パス。
 * 見るのは、テストのファイルの場所（import.meta.dirname など）につないだ path.join／path.resolve と、
 * 引数を根につなぐ手元の関数の呼び出し。決まらないものは見ない
 */
export function findRootedPaths(source: string, fileRel: string): RootedPath[] {
  const sf = ts.createSourceFile(
    fileRel,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const dir = path.posix.dirname(fileRel);
  const base: Ctx = {
    dir,
    bindings: new Map(),
    used: { value: false },
    depth: 0,
  };
  const found: RootedPath[] = [];
  const add = (node: ts.Node, vals: string[]) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    for (const v of vals) {
      // 根そのものと、根の外は見ない
      if (v === "." || v === ".." || v.startsWith("../")) continue;
      found.push({ line, path: v });
    }
  };
  /** 手元の関数の連なりの、いちばん外の呼び出し（報告する行） */
  let root: ts.Node = sf;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === "join" || name === "resolve") {
        const v = evalExpr(node, base);
        if (v?.located) add(node, v.vals);
      } else {
        const fn = localFunction(node);
        if (fn) {
          root = node;
          helperCall(node, fn, base, { value: false }, new Set());
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  /**
   * 手元の関数 fn を call で呼んだとき、引数を仮引数に束ねて本体を調べる。
   * 本体の中の join／resolve は、仮引数を使って根につなぐなら call の行で報告する。
   * 本体の中でさらに手元の関数を呼ぶなら、外の束縛で引数を決めて中へたどる。
   * 無限の再帰を避けるため、たどっている関数の Set と深さの上限で止める
   */
  const helperCall = (
    call: ts.CallExpression,
    fn: LocalFn,
    outer: Ctx,
    outerUsed: { value: boolean },
    chain: ReadonlySet<LocalFn>,
  ) => {
    if (chain.has(fn) || chain.size >= MAX_HELPER_DEPTH || !fn.body) return;
    const bindings = new Map<ts.Node, string[]>();
    fn.parameters.forEach((p, i) => {
      const arg = call.arguments[i];
      if (!arg || !ts.isIdentifier(p.name)) return;
      const v = evalExpr(arg, outer);
      if (v && !v.located) bindings.set(p, v.vals);
    });
    // 外の束縛を使っていない（定数だけの）呼び出しは、外側の走査が直に見る
    if (bindings.size === 0 || (chain.size > 0 && !outerUsed.value)) return;
    const inner = new Set([...chain, fn]);
    const search = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const n = calleeName(node);
        if (n === "join" || n === "resolve") {
          const used = { value: false };
          const v = evalExpr(node, { ...base, bindings, used });
          if (v?.located && used.value) {
            add(root, v.vals);
            return;
          }
        } else {
          const next = localFunction(node);
          if (next) {
            const used = { value: false };
            helperCall(node, next, { ...base, bindings, used }, used, inner);
          }
        }
      }
      ts.forEachChild(node, search);
    };
    search(fn.body);
  };
  visit(sf);
  return found;
}

// ---- git check-ignore ----

/**
 * 無視される（かつ追跡中のファイルそのものではない）パスを返す。ディレクトリも当たるよう、末尾に / をつけた形も確かめる。
 *
 * - 追跡中のファイルは、git の既定でも無視に当たらないが、`K1.md/` のように / をつけた形は
 *   親ディレクトリの無視（`/docs/tasks/`）に当たってしまう。だから追跡中のファイルそのもの（完全一致）は先に外す。
 * - 追跡中のファイルを含むディレクトリ（`docs/tasks`）は、既定の check-ignore では当たらない。
 *   けれど新しい worktree では中身が減るので、無視と判じたい。だから --no-index で、
 *   追跡中かどうかを見ずに、.gitignore の規則だけで確かめる。
 */
export async function findIgnored(
  repo: string,
  paths: string[],
): Promise<string[]> {
  const run = async (args: string[], input?: string) =>
    testRunner("git", args, { cwd: repo, input });
  const listed = await run(["ls-files", "-z"]);
  if (listed.code !== 0)
    throw new Error(`git ls-files が失敗：${listed.stderr}`);
  const tracked = new Set(listed.stdout.split("\0").filter(Boolean));
  const candidates = [...new Set(paths)].filter((p) => !tracked.has(p));
  const asked = candidates.flatMap((p) => [p, `${p}/`]);
  if (asked.length === 0) return [];
  // 当たらないと終了コード1。当たったものは標準出力に出る
  const res = await run(
    ["check-ignore", "--no-index", "-z", "--stdin"],
    asked.join("\0") + "\0",
  );
  if (res.code !== 0 && res.code !== 1)
    throw new Error(`git check-ignore が失敗：${res.stderr}`);
  const hit = new Set(res.stdout.split("\0").filter(Boolean));
  return candidates.filter((p) => hit.has(p) || hit.has(`${p}/`));
}

// ---- テスト ----

const FIXTURE = "test/plugin/x.test.ts";
const paths = (source: string, file = FIXTURE) =>
  findRootedPaths(source, file).map((r) => r.path);

describe("findRootedPaths（根から組み立てたパスの拾い方）", () => {
  it("fileURLToPath(import.meta.url) から作った ROOT につないだ path.join", () => {
    const src = `
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
readFileSync(path.join(ROOT, "docs/tasks/X1.md"));
`;
    expect(findRootedPaths(src, FIXTURE)).toEqual([
      { line: 6, path: "docs/tasks/X1.md" },
    ]);
  });

  it("import.meta.dirname から作った ROOT と、直に書いたパス", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
a(path.join(ROOT, "docs/tasks/X1.md"));
b(path.join(import.meta.dirname, "../../docs/tasks/X2.md"));
`;
    expect(findRootedPaths(src, FIXTURE)).toEqual([
      { line: 3, path: "docs/tasks/X1.md" },
      { line: 4, path: "docs/tasks/X2.md" },
    ]);
  });

  it("名前は問わない（root でも、宣言の中身が根なら根）", () => {
    const src = `
const root = path.resolve(import.meta.dirname, "../..");
a(path.join(root, "docs/tasks/X1.md"));
`;
    expect(paths(src)).toEqual(["docs/tasks/X1.md"]);
  });

  it("根をつないだ別の定数にさらにつなぐ", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
const DOCS = path.join(ROOT, "docs");
a(path.join(DOCS, "tasks/X1.md"));
`;
    expect(paths(src)).toEqual(["docs", "docs/tasks/X1.md"]);
  });

  it("手元の関数（アロー・function）を呼んだときの引数", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");
async function readDefinition(rel: string) {
  return parse(await readFile(path.join(ROOT, rel), "utf8"));
}
read("docs/tasks/X1.md");
readDefinition("docs/tasks/X2.md");
`;
    expect(findRootedPaths(src, FIXTURE)).toEqual([
      { line: 7, path: "docs/tasks/X1.md" },
      { line: 8, path: "docs/tasks/X2.md" },
    ]);
  });

  it("手元の関数を2段に重ねても、外の呼び出しの引数を中へたどる", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel));
function readAll(name: string) {
  return readJson(name);
}
readJson("docs/tasks/X1.md");
readAll("docs/tasks/X2.md");
`;
    expect(findRootedPaths(src, FIXTURE)).toEqual([
      { line: 8, path: "docs/tasks/X1.md" },
      { line: 9, path: "docs/tasks/X2.md" },
    ]);
  });

  it("手元の関数が自分や互いを呼んでも止まる", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
function a(rel: string): string { return b(rel) + path.join(ROOT, rel); }
function b(rel: string): string { return a(rel); }
a("docs/tasks/X1.md");
`;
    expect(paths(src)).toEqual(["docs/tasks/X1.md"]);
  });

  it("複数行の for (const rel of [...]) で回す変数は、要素ごとに両方返す", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
describe("文書", () => {
  for (const rel of [
    "docs/spec.md",
    "docs/tasks/X1.md",
  ]) {
    it(rel, () => {
      readFileSync(path.join(ROOT, rel), "utf8");
    });
  }
});
`;
    expect(findRootedPaths(src, FIXTURE)).toEqual([
      { line: 9, path: "docs/spec.md" },
      { line: 9, path: "docs/tasks/X1.md" },
    ]);
  });

  it("配列を入れた const を回すときも要素ごと", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
const FILES = ["docs/a.md", "docs/b.md"];
for (const f of FILES) read(path.join(ROOT, f));
`;
    expect(paths(src)).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("テンプレート文字列：${} は回す配列の要素。分からなければ仮の1語", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
for (const id of ["X1", "X2"]) {
  a(path.join(ROOT, \`docs/tasks/\${id}.md\`));
}
b(path.join(ROOT, \`docs/tasks/\${compute()}.md\`));
`;
    expect(findRootedPaths(src, FIXTURE)).toEqual([
      { line: 4, path: "docs/tasks/X1.md" },
      { line: 4, path: "docs/tasks/X2.md" },
      { line: 6, path: "docs/tasks/x.md" },
    ]);
  });

  it("readdir に渡すディレクトリも拾う", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
await readdir(path.join(ROOT, "docs/tasks"));
`;
    expect(paths(src)).toEqual(["docs/tasks"]);
  });

  it("テストのファイルの深さを数える", () => {
    const src = `a(path.join(import.meta.dirname, "docs/tasks/X1.md"));`;
    expect(paths(src, "test/x.test.ts")).toEqual(["test/docs/tasks/X1.md"]);
    expect(paths(src, "test/a/b/x.test.ts")).toEqual([
      "test/a/b/docs/tasks/X1.md",
    ]);
  });

  it("一時リポジトリの root（名前が root でも根ではない）は拾わない", () => {
    const src = `
it("a", async () => {
  const root = await makeRepo({});
  await readFile(path.join(root, "docs/tasks/T10.md"));
});
`;
    expect(paths(src)).toEqual([]);
  });

  it("根を同じ名前で隠した一時ディレクトリは拾わない", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
read(path.join(ROOT, "docs/spec.md"));
it("a", async () => {
  const ROOT = await tempDir();
  await readFile(path.join(ROOT, "docs/tasks/X1.md"));
});
function f(ROOT: string) {
  return path.join(ROOT, "docs/tasks/X2.md");
}
`;
    expect(findRootedPaths(src, FIXTURE)).toEqual([
      { line: 3, path: "docs/spec.md" },
    ]);
  });

  it("同じ名前の手元の関数を隠した場合も拾わない", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFile(path.join(ROOT, rel));
it("a", () => {
  const read = (rel: string) => other(rel);
  read("docs/tasks/X1.md");
});
`;
    expect(paths(src)).toEqual([]);
  });

  it("writeFiles の鍵・文字列・コメント・import は拾わない", () => {
    const src = `
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "../..");
// path.join(ROOT, "docs/tasks/X1.md")
/* read("docs/tasks/X1.md") */
await writeFiles(dir, { "docs/tasks/T10.md": "x" });
expect(text).toContain("docs/tasks/");
const s = 'path.join(ROOT, "docs/tasks/X1.md")';
`;
    expect(paths(src)).toEqual([]);
  });

  it("決まらないもの（実行時に決まる引数・環境変数）は見ない", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
a(path.join(ROOT, process.env.X ?? "y"));
b(path.join(ROOT, name));
let rel = "docs/a.md";
c(path.join(ROOT, rel));
`;
    expect(paths(src)).toEqual([]);
  });

  it("根そのものと、根の外は見ない", () => {
    const src = `
const ROOT = path.resolve(import.meta.dirname, "../..");
a(path.join(ROOT, "."));
b(path.join(ROOT, "../other"));
`;
    expect(paths(src)).toEqual([]);
  });
});

describe("findIgnored（git check-ignore での確かめ）", () => {
  it(".gitignore に当たるファイル・ディレクトリは無視と判じ、そうでないものと追跡中のファイルは判じない", async () => {
    const repo = await makeRepo();
    await writeFiles(repo, {
      ".gitignore": "/docs/tasks/\n",
      "docs/spec.md": "# 仕様\n",
      "docs/tasks/K1.md": "追跡中\n",
      "docs/tasks/X1.md": "無視\n",
    });
    await git(repo, "add", "docs/spec.md", ".gitignore");
    await git(repo, "add", "-f", "docs/tasks/K1.md");
    await git(repo, "commit", "--quiet", "-m", "files");
    const ignored = await findIgnored(repo, [
      "docs/tasks/X1.md",
      "docs/tasks/none.md",
      "docs/tasks",
      "docs/spec.md",
      "docs/tasks/K1.md",
      "docs",
      "README.md",
    ]);
    expect(ignored).toEqual([
      "docs/tasks/X1.md",
      "docs/tasks/none.md",
      "docs/tasks",
    ]);
  });

  it("手元にあるディレクトリで、中身が無視されたファイルだけのものも無視と判じる", async () => {
    const repo = await makeRepo();
    await writeFiles(repo, {
      ".gitignore": "/docs/tasks/\n",
      "docs/spec.md": "# 仕様\n",
      "docs/tasks/X1.md": "無視\n",
    });
    await git(repo, "add", "docs/spec.md", ".gitignore");
    await git(repo, "commit", "--quiet", "-m", "files");
    expect(await findIgnored(repo, ["docs/tasks", "docs"])).toEqual([
      "docs/tasks",
    ]);
  });

  it("手元にないディレクトリも、末尾の / をつけた形で当たる", async () => {
    const repo = await makeRepo();
    await writeFiles(repo, { ".gitignore": "/docs/tasks/\n" });
    expect(await findIgnored(repo, ["docs/tasks", "docs"])).toEqual([
      "docs/tasks",
    ]);
  });
});

describe("このリポジトリのテスト", () => {
  it("無視されたファイルを根から読んでいない", async (ctx) => {
    // git の外（git archive の展開・ZIP）や、外側の別のリポジトリの中では、この根の無視を確かめられない
    const top = await testRunner("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
    });
    const topReal = top.code === 0 ? await realpath(top.stdout.trim()) : "";
    if (top.code !== 0 || topReal !== (await realpath(repoRoot)))
      ctx.skip(
        "この根は git のリポジトリの根ではないので、無視の確かめを飛ばす",
      );
    const testDir = path.join(repoRoot, "test");
    const files = (await readdir(testDir, { recursive: true }))
      .filter((f) => f.endsWith(".ts"))
      .sort();
    const where = new Map<string, string[]>();
    for (const f of files) {
      const rel = path.posix.join("test", f.split(path.sep).join("/"));
      const text = await readFile(path.join(testDir, f), "utf8");
      for (const hit of findRootedPaths(text, rel)) {
        const list = where.get(hit.path) ?? [];
        list.push(`${rel}:${hit.line}`);
        where.set(hit.path, list);
      }
    }
    // 何も拾えていないなら、見張りが働いていない
    expect(where.size).toBeGreaterThan(0);
    const ignored = await findIgnored(repoRoot, [...where.keys()]);
    const report = ignored.flatMap((p) =>
      (where.get(p) ?? []).map(
        (at) =>
          `${at}：${p}\n  無視されたファイルは、新しい worktree にない。テストが一時ディレクトリに作るか、追跡中のファイルを読む`,
      ),
    );
    expect(report).toEqual([]);
  });
});
