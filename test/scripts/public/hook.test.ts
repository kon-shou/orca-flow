import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMAIL,
  cleanupSandboxes,
  NAME,
  git,
  gitRaw,
  makeSandbox,
  readyBox,
  runScript,
  type Sandbox,
} from "./support.ts";

async function addBare(box: Sandbox, name = "origin"): Promise<string> {
  const bare = path.join(box.base, `${name}.git`);
  await git(box, box.base, "init", "--quiet", "--bare", "-b", "main", bare);
  await git(box, box.repo, "remote", "add", name, bare);
  return bare;
}

const SETUP = ["setup", "--name", NAME, "--email", EMAIL];

async function bareRefs(box: Sandbox, bare: string): Promise<string> {
  return git(box, bare, "for-each-ref", "--format=%(refname)");
}

describe("setup", () => {
  afterEach(cleanupSandboxes);

  it("名前とメールアドレスを設定に書き、実行できるフックを置く", async () => {
    const box = await makeSandbox();
    const result = await runScript(box, SETUP);
    expect(result.code).toBe(0);
    expect(await git(box, box.repo, "config", "orca-flow.publicName")).toBe(
      NAME,
    );
    expect(await git(box, box.repo, "config", "orca-flow.publicEmail")).toBe(
      EMAIL,
    );
    const hook = path.join(box.repo, ".git", "hooks", "pre-push");
    // 実行ビットは Windows のファイルシステムにないので、Windows では確かめない
    if (process.platform !== "win32")
      expect((await stat(hook)).mode & 0o111).not.toBe(0);
    expect(await readFile(hook, "utf8")).toContain("pre-push");
  });

  it("remote がなければ remote.〈名前〉.push を設定せず、足してからもう一度と案内する", async () => {
    const box = await makeSandbox();
    const result = await runScript(box, SETUP);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("remote を足したあとに setup をもう一度");
    const push = await gitRaw(box, box.repo, "config", "remote.origin.push");
    expect(push.code).not.toBe(0);
  });

  it("remote があれば remote.〈名前〉.push を public から main にする。もう一度流しても同じ", async () => {
    const box = await makeSandbox();
    await addBare(box);
    await addBare(box, "other");
    expect((await runScript(box, SETUP)).code).toBe(0);
    expect((await runScript(box, SETUP)).code).toBe(0);
    expect(await git(box, box.repo, "config", "remote.origin.push")).toBe(
      "refs/heads/public:refs/heads/main",
    );
    expect(
      (await gitRaw(box, box.repo, "config", "remote.other.push")).code,
    ).not.toBe(0);
    expect((await runScript(box, [...SETUP, "--remote", "other"])).code).toBe(
      0,
    );
    expect(await git(box, box.repo, "config", "remote.other.push")).toBe(
      "refs/heads/public:refs/heads/main",
    );
  });

  it("違うフックがすでにあると、書き換えずに終了コード2", async () => {
    const box = await makeSandbox();
    const hook = path.join(box.repo, ".git", "hooks", "pre-push");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, "#!/bin/sh\necho mine\n");
    const result = await runScript(box, SETUP);
    expect(result.code).toBe(2);
    expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(
      (await gitRaw(box, box.repo, "config", "orca-flow.publicName")).code,
    ).not.toBe(0);
  });

  it("core.hooksPath があると、書き換えずに終了コード2", async () => {
    const box = await makeSandbox();
    await git(
      box,
      box.repo,
      "config",
      "core.hooksPath",
      path.join(box.base, "hp"),
    );
    const result = await runScript(box, SETUP);
    expect(result.code).toBe(2);
    const hook = path.join(box.repo, ".git", "hooks", "pre-push");
    await expect(stat(hook)).rejects.toThrow();
    await expect(stat(path.join(box.base, "hp", "pre-push"))).rejects.toThrow();
    const name = await gitRaw(box, box.repo, "config", "orca-flow.publicName");
    expect(name.code).not.toBe(0);
  });

  it("使い方が違うと終了コード2", async () => {
    const box = await makeSandbox();
    expect((await runScript(box, ["setup", "--name", NAME])).code).toBe(2);
  });
});

describe("pre-push のフックと実際の git push", () => {
  afterEach(cleanupSandboxes);

  async function ready() {
    const box = await readyBox();
    const bare = await addBare(box);
    expect((await runScript(box, SETUP)).code).toBe(0);
    expect((await runScript(box, ["build"])).code).toBe(0);
    await git(box, box.repo, "branch", "task/x", "main");
    return { box, bare };
  }

  it("main・task のブランチ・public を main 以外へ送るものを止める", async () => {
    const { box, bare } = await ready();
    for (const refspec of [
      "main:main",
      "task/x:task/x",
      "public:public",
      "public:other",
      "task/x:main",
      "main:public",
    ]) {
      const result = await gitRaw(box, box.repo, "push", "origin", refspec);
      expect(result.code, refspec).not.toBe(0);
    }
    expect(await bareRefs(box, bare)).toBe("");
  });

  it("削除を止め、public を main へ送るものを通す", async () => {
    const { box, bare } = await ready();
    const pushed = await gitRaw(box, box.repo, "push", "origin", "public:main");
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(await git(box, bare, "rev-parse", "main")).toBe(
      await git(box, box.repo, "rev-parse", "public"),
    );
    const deleted = await gitRaw(box, box.repo, "push", "origin", ":main");
    expect(deleted.code).not.toBe(0);
    expect(await bareRefs(box, bare)).toBe("refs/heads/main");
  });

  it("remote に設定した push の既定で、引数なしの push が public を main へ送る", async () => {
    const { box, bare } = await ready();
    await git(box, box.repo, "checkout", "--quiet", "--detach");
    const result = await gitRaw(box, box.repo, "push", "origin");
    expect(result.code, result.stderr).toBe(0);
    expect(await bareRefs(box, bare)).toBe("refs/heads/main");
  });

  it("送る範囲に確かめに落ちるコミットがあると止める。送り済みのコミットは見ない", async () => {
    const { box, bare } = await ready();
    expect(
      (await gitRaw(box, box.repo, "push", "origin", "public:main")).code,
    ).toBe(0);

    const tree = await git(box, box.repo, "rev-parse", "public^{tree}");
    const bad = (
      await box.runner(
        "git",
        ["commit-tree", tree, "-p", "public", "-m", "別の人"],
        {
          cwd: box.repo,
          env: {
            GIT_AUTHOR_NAME: "Someone Else",
            GIT_AUTHOR_EMAIL: "else@example.invalid",
            GIT_COMMITTER_NAME: "Someone Else",
            GIT_COMMITTER_EMAIL: "else@example.invalid",
          },
        },
      )
    ).stdout.trim();
    const before = await git(box, bare, "rev-parse", "main");
    await git(box, box.repo, "update-ref", "refs/heads/public", bad);
    const blocked = await gitRaw(
      box,
      box.repo,
      "push",
      "origin",
      "public:main",
    );
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("公開用の名前と違います");
    expect(await git(box, bare, "rev-parse", "main")).toBe(before);
  });

  /** public の先頭に、指定した作者のコミットを重ねる（push はしない） */
  async function stack(
    box: Sandbox,
    author: { name: string; email: string },
    message: string,
  ): Promise<string> {
    const tree = await git(box, box.repo, "rev-parse", "public^{tree}");
    const sha = (
      await box.runner(
        "git",
        ["commit-tree", tree, "-p", "public", "-m", message],
        {
          cwd: box.repo,
          env: {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: author.name,
            GIT_COMMITTER_EMAIL: author.email,
          },
        },
      )
    ).stdout.trim();
    await git(box, box.repo, "update-ref", "refs/heads/public", sha);
    return sha;
  }

  it("悪いコミットの上に良いコミットを重ねても、悪いコミットが範囲にあれば止める", async () => {
    const { box, bare } = await ready();
    await stack(
      box,
      { name: "Someone Else", email: "else@example.invalid" },
      "悪い",
    );
    await stack(box, { name: NAME, email: EMAIL }, "良い");
    const blocked = await gitRaw(
      box,
      box.repo,
      "push",
      "origin",
      "public:main",
    );
    expect(blocked.code).not.toBe(0);
    expect(await bareRefs(box, bare)).toBe("");
  });

  it("送り済みのコミットは見ない", async () => {
    const { box, bare } = await ready();
    await stack(
      box,
      { name: "Someone Else", email: "else@example.invalid" },
      "悪い",
    );
    // フックを通さずに、悪いコミットを送り先へ入れておく
    const forced = await gitRaw(
      box,
      box.repo,
      "push",
      "--no-verify",
      "origin",
      "public:main",
    );
    expect(forced.code).toBe(0);
    await stack(box, { name: NAME, email: EMAIL }, "良い");
    const pushed = await gitRaw(box, box.repo, "push", "origin", "public:main");
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(await git(box, bare, "rev-parse", "main")).toBe(
      await git(box, box.repo, "rev-parse", "public"),
    );
  });

  it("作業ツリーの main.ts ではなく、setup した場所の main.ts を使う", async () => {
    const { box } = await ready();
    await writeFile(
      path.join(box.repo, "scripts", "public", "main.ts"),
      "process.exit(1);\n",
    ).catch(async () => {
      await mkdir(path.join(box.repo, "scripts", "public"), {
        recursive: true,
      });
      await writeFile(
        path.join(box.repo, "scripts", "public", "main.ts"),
        "process.exit(1);\n",
      );
    });
    const pushed = await gitRaw(box, box.repo, "push", "origin", "public:main");
    expect(pushed.code, pushed.stderr).toBe(0);
  });

  it("書いた node が実行できなければ PATH の node を使い、どちらもなければ日本語で止める", async () => {
    const box = await readyBox();
    expect(
      (
        await runScript(box, SETUP, {
          nodePath: path.join(box.base, "no-node"),
        })
      ).code,
    ).toBe(0);
    const hook = path.join(box.repo, ".git", "hooks", "pre-push");
    const viaPath = await box.runner("/bin/sh", [hook], {
      cwd: box.repo,
      input: "",
    });
    expect(viaPath.code, viaPath.stderr).toBe(0);
    const noNode = await box.runner("/bin/sh", [hook], {
      cwd: box.repo,
      input: "",
      env: { PATH: path.join(box.base, "empty") },
    });
    expect(noNode.code).toBe(1);
    expect(noNode.stderr).toContain("node が見つかりません。setup をもう一度");
  });

  it("語の一覧が消えていると、push は止まる", async () => {
    const { box, bare } = await ready();
    await writeFile(
      path.join(box.repo, ".git", "orca-flow", "public-words.txt"),
      "# だけ\n",
    );
    const result = await gitRaw(box, box.repo, "push", "origin", "public:main");
    expect(result.code).not.toBe(0);
    expect(await bareRefs(box, bare)).toBe("");
  });
});

describe("pre-push の直接呼び出し", () => {
  afterEach(cleanupSandboxes);

  it("標準入力が空なら通す", async () => {
    const box = await readyBox();
    expect((await runScript(box, ["pre-push"], { stdin: "" })).code).toBe(0);
  });
});
