import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseList } from "../../../scripts/public/common.ts";
import { makeTmpDir } from "../../helpers/tmp/index.ts";

/** root の下のファイルを、root からの相対パスで返す（git に頼らず、ZIP・git archive の木でも動く） */
async function walk(root: string, dir = ""): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(root, rel)));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/**
 * 公開に残るコードとテストが、抜くパスの中に実在するファイルを文字のまま名指ししている所。
 * 公開の clone ではそのファイルがないので、読むとテストが落ちる
 */
async function namedExcluded(
  root: string,
  exclude: readonly string[],
): Promise<string[]> {
  const inside = (file: string) =>
    exclude.some((e) => file === e || file.startsWith(`${e}/`));
  const all = await walk(root);
  const hidden = all.filter((f) => inside(f));
  const kept = all.filter((f) => !inside(f) && /\.(?:ts|js|mjs|cjs)$/.test(f));
  const offenders: string[] = [];
  for (const file of kept) {
    const lines = (await readFile(path.join(root, file), "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      for (const target of hidden) {
        let at = line.indexOf(target);
        while (at >= 0) {
          const before = line[at - 1] ?? "";
          const after = line.slice(at + target.length, at + target.length + 2);
          // 名前の続き（別のファイル）でないときだけ当てる。文の終わりの . は続きと見ない
          if (
            !/[A-Za-z0-9_.-]/.test(before) &&
            !/^(?:[A-Za-z0-9_-]|\.[A-Za-z0-9_-])/.test(after)
          ) {
            offenders.push(`${file}：${index + 1}：${target}`);
            break;
          }
          at = line.indexOf(target, at + 1);
        }
      }
    }
  }
  return offenders.sort();
}

describe("抜くパスの中のファイルを名指しする所", () => {
  const PRIVATE = `docs/${"private"}`;

  async function fakeTree(files: Record<string, string>): Promise<string> {
    const root = await makeTmpDir("orca-flow-public-named-");
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return root;
  }

  it("実在のファイルを文字のまま書いたコードとテストに当たる", async () => {
    const root = await fakeTree({
      [`${PRIVATE}/notes.md`]: "私的な文書\n",
      "docs/memo.md": "抜くファイル\n",
      "test/a.test.ts": `read("${PRIVATE}/notes.md");\n`,
      "src/b.ts": `const p = "../docs/memo.md";\n`,
    });
    expect(await namedExcluded(root, [PRIVATE, "docs/memo.md"])).toEqual([
      `src/b.ts：1：docs/memo.md`,
      `test/a.test.ts：1：${PRIVATE}/notes.md`,
    ]);
  });

  it("ないファイル・つないで作ったパス・名前の続き・抜くパスの中のファイル・コードでないファイルは当たらない", async () => {
    const root = await fakeTree({
      [`${PRIVATE}/notes.md`]: "私的な文書\n",
      [`${PRIVATE}/self.test.ts`]: `read("${PRIVATE}/notes.md");\n`,
      "test/a.test.ts": [
        `read("${PRIVATE}/other.md");`,
        'read(`docs/${"private"}/notes.md`);',
        `read("${PRIVATE}/notes.md.bak");`,
        `read("x${PRIVATE}/notes.md");`,
        "",
      ].join("\n"),
      "README.md": `${PRIVATE}/notes.md\n`,
    });
    expect(await namedExcluded(root, [PRIVATE])).toEqual([]);
  });

  it("このリポジトリには当たりがない", async () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const exclude = parseList(
      await readFile(path.join(root, "scripts/public/exclude.txt"), "utf8"),
    ).map((l) => l.replace(/\/+$/, ""));
    expect(await namedExcluded(root, exclude)).toEqual([]);
  }, 60_000);
});
