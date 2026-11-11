import { describe, expect, it } from "vitest";
import { appUsersOf } from "../../src/lib/workspace.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const PKG = "acme/core-kit";

async function app(files: Record<string, string>) {
  const root = await makeRepo({}, files);
  return { name: "app", path: root, baseBranch: "main" as string | null };
}

describe("appUsersOf", () => {
  it("パッケージ名を持つアプリだけが並ぶ。どの階層の定義でも数える", async () => {
    const a = await app({ "composer.json": `{"require":{"${PKG}":"^1"}}\n` });
    const b = await app({
      "web/package.json": `{"dependencies":{"${PKG}":"1"}}\n`,
    });
    const c = await app({
      "composer.json": `{"require":{"other/lib":"^1"}}\n`,
    });
    const users = await appUsersOf(testRunner, PKG, [
      { ...a, name: "a" },
      { ...b, name: "b" },
      { ...c, name: "c" },
    ]);
    expect(users).toEqual(["a", "b"]);
  });

  it("名前の一部だけの一致は数えない（前後にパッケージ名の文字が続くもの）", async () => {
    const longer = await app({
      "composer.json": `{"require":{"${PKG}-extra":"^1","x/${PKG}":"^1"}}\n`,
    });
    expect(
      await appUsersOf(testRunner, PKG, [{ ...longer, name: "longer" }]),
    ).toEqual([]);
  });

  it("定義でないファイルや作業ツリーの未コミットの変更は数えない。baseBranch の先頭を読む", async () => {
    const a = await app({ "notes.txt": `${PKG}\n` });
    await writeFiles(a.path, {
      "composer.json": `{"require":{"${PKG}":"^1"}}\n`,
    });
    expect(await appUsersOf(testRunner, PKG, [{ ...a, name: "a" }])).toEqual(
      [],
    );
    await git(a.path, "add", "-A");
    await git(a.path, "commit", "--quiet", "-m", "dep");
    expect(await appUsersOf(testRunner, PKG, [{ ...a, name: "a" }])).toEqual([
      "a",
    ]);
  });

  it("読めないアプリ（baseBranch が分からない・ブランチがない）が1つでもあれば null", async () => {
    const ok = await app({ "composer.json": `{"require":{"${PKG}":"^1"}}\n` });
    const unknown = { ...(await app({})), name: "u", baseBranch: null };
    expect(
      await appUsersOf(testRunner, PKG, [{ ...ok, name: "ok" }, unknown]),
    ).toBeNull();
    const nobranch = { ...(await app({})), name: "n", baseBranch: "nope" };
    expect(await appUsersOf(testRunner, PKG, [nobranch])).toBeNull();
  });

  it("アプリがなければ空の並び", async () => {
    expect(await appUsersOf(testRunner, PKG, [])).toEqual([]);
  });
});
