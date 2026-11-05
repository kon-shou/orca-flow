import { describe, expect, it } from "vitest";
import { diffNames } from "../../src/lib/git.ts";
import { testRunner } from "../helpers/runner.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";

describe("diffNames", () => {
  it("日本語や引用符を含むパスも、引用符なしで返る", async () => {
    const root = await makeRepo();
    await git(root, "switch", "-c", "feature");
    await writeFiles(root, {
      "docs/設計.md": "x",
      'docs/a"b.md': "y",
      "src/plain.ts": "z",
    });
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "add");
    const names = await diffNames(testRunner, root, "main", "feature");
    expect([...names].sort()).toEqual(
      ['docs/a"b.md', "docs/設計.md", "src/plain.ts"].sort(),
    );
  });
});
