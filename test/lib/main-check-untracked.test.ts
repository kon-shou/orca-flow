import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireConfig } from "../../src/config.ts";
import { recordMerge, runMainCheck } from "../../src/lib/main-check.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

async function mergeTask(
  root: string,
  files: Record<string, string>,
  name = "task/T01-x",
) {
  await git(root, "switch", "--quiet", "-c", name);
  await writeFiles(root, files);
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", "T01: 作る");
  await git(root, "switch", "--quiet", "main");
  await git(
    root,
    "merge",
    "--no-ff",
    "--quiet",
    "-m",
    "統括役: マージ",
    "task/T01-x",
  );
  const commit = await git(root, "rev-parse", "HEAD");
  await recordMerge(testRunner, root, await requireConfig(root), {
    commit,
    id: "T01",
    sameTree: false,
    commands: [],
    at: "x",
  });
  return commit;
}

async function run(root: string) {
  const logs: string[] = [];
  const result = await runMainCheck(
    {
      runner: testRunner,
      cwd: root,
      config: await requireConfig(root),
      stdout: (line) => logs.push(line),
      stderr: () => {},
      now: () => new Date(),
    },
    root,
  );
  return { result, logs };
}

const status = async (root: string, commit: string) =>
  JSON.parse(
    await readFile(
      path.join(root, ".git", "orca-flow", "main-check", `${commit}.json`),
      "utf8",
    ),
  ).status;

describe("main-check の setup.sh（git に残さない導入）", () => {
  it("確かめ用の作業ツリーになく、メインにあれば、メインの setup.sh を絶対パスで流す", async () => {
    const root = await makeRepo({ verify: ["test -f setup-ran"] });
    await writeFiles(root, {
      ".orca-flow/setup.sh": "touch setup-ran\n",
    });
    await writeFile(
      path.join(root, ".git", "info", "exclude"),
      "/.orca-flow/setup.sh\n",
    );
    const commit = await mergeTask(root, { "a.txt": "1\n" });
    const { logs } = await run(root);
    expect(await status(root, commit)).toBe("passed");
    expect(logs.join("\n")).toContain(
      `流しています：bash ${path.join(root, ".orca-flow", "setup.sh")}`,
    );
  });

  it("メインの setup.sh が失敗したら、落ちたでなく確かめられなかった", async () => {
    const root = await makeRepo({ verify: ["true"] });
    await writeFiles(root, { ".orca-flow/setup.sh": "exit 3\n" });
    await writeFile(
      path.join(root, ".git", "info", "exclude"),
      "/.orca-flow/setup.sh\n",
    );
    const commit = await mergeTask(root, { "a.txt": "1\n" });
    const { logs } = await run(root);
    expect(await status(root, commit)).toBe("unchecked");
    expect(logs.join("\n")).toContain(path.join(root, ".orca-flow"));
  });

  it("どちらにもなければ流さない", async () => {
    const root = await makeRepo({ verify: ["true"] });
    const commit = await mergeTask(root, { "a.txt": "1\n" });
    const { logs } = await run(root);
    expect(await status(root, commit)).toBe("passed");
    expect(logs.join("\n")).not.toContain("setup.sh");
  });

  it("コミットの木に setup.sh があれば、今までどおり相対パスで流す", async () => {
    const root = await makeRepo({ verify: ["test -f setup-ran"] });
    const commit = await mergeTask(root, {
      ".orca-flow/setup.sh": "touch setup-ran\n",
    });
    const { logs } = await run(root);
    expect(await status(root, commit)).toBe("passed");
    expect(logs.join("\n")).toContain("流しています：bash .orca-flow/setup.sh");
  });

  it("確かめ用の作業ツリーが使い回されても、コミットになければ毎回メインの setup.sh を流す", async () => {
    const root = await makeRepo({ verify: ["test -f ran"] });
    const setup = path.join(root, ".orca-flow", "setup.sh");
    await writeFiles(root, {
      ".orca-flow/setup.sh":
        'echo one > ran\nmkdir -p .orca-flow\ncp "$0" .orca-flow/setup.sh\n',
    });
    await writeFile(
      path.join(root, ".git", "info", "exclude"),
      "/.orca-flow/setup.sh\n",
    );
    const first = await mergeTask(root, { "a.txt": "1\n" });
    await run(root);
    expect(await status(root, first)).toBe("passed");
    await writeFile(setup, "echo two > ran\n");
    const second = await mergeTask(root, { "b.txt": "1\n" }, "task/T02-x");
    const { logs } = await run(root);
    expect(await status(root, second)).toBe("passed");
    expect(logs.join("\n")).toContain(`流しています：bash ${setup}`);
    const tree = path.join(root, ".git", "orca-flow", "main-check", "tree");
    expect(await readFile(path.join(tree, "ran"), "utf8")).toBe("two\n");
  });
});
