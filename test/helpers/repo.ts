import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { testRunner as realRunner } from "./runner.ts";
import { makeTmpDir } from "./tmp/index.ts";

let gitCalls = 0;

/** git() を呼んだ回数（makeRepo が起こす git の数を確かめるため） */
export function gitCallCount(): number {
  return gitCalls;
}

/** テストの git。失敗したら投げる */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  gitCalls++;
  const result = await realRunner("git", args, { cwd });
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} が失敗：${result.stderr}`);
  return result.stdout.trim();
}

export async function tempDir(prefix = "orca-flow-"): Promise<string> {
  return makeTmpDir(prefix);
}

export async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
  }
}

export const PROGRESS = `# 進捗

状態は統括役が更新する。

| ID  | タスク | 依存 | 状態     | ブランチ     | メモ |
| --- | ------ | ---- | -------- | ------------ | ---- |
| T01 | 雛形   | —    | 統合済み | main         |      |

表のうしろの文。
`;

/** 一時ディレクトリに本物の git リポジトリを作り、設定とファイルを置いてコミットする */
export async function makeRepo(
  config: Record<string, unknown> = {},
  files: Record<string, string> = {},
): Promise<string> {
  const base = await tempDir("orca-flow-repo-");
  const root = path.join(base, "main");
  await mkdir(root);
  await git(root, "init", "--quiet", "-b", "main");
  // git config を3回起こす代わりに、.git/config へ直接書き足す
  await appendFile(
    path.join(root, ".git", "config"),
    "[user]\n\tname = テスト\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n",
  );
  await writeFiles(root, {
    ".orca-flow/config.json": JSON.stringify(config, null, 2),
    "README.md": "# テスト\n",
    ...files,
  });
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", "init");
  return root;
}

/** タスクの worktree を手で作る（task/〈ID〉-〈slug〉） */
export async function addTaskWorktree(
  root: string,
  id: string,
  slug: string,
  files: Record<string, string> = {},
  message = `${id}: 設計書を書く`,
): Promise<{ path: string; branch: string }> {
  const branch = `task/${id}-${slug}`;
  const wt = path.join(path.dirname(root), `${id}-${slug}`);
  await git(root, "worktree", "add", "--quiet", "-b", branch, wt, "main");
  if (Object.keys(files).length > 0) {
    await writeFiles(wt, files);
    await git(wt, "add", "-A");
    await git(wt, "commit", "--quiet", "-m", message);
  }
  return { path: wt, branch };
}

/** 設計書の中身を組み立てる */
export function specDoc(
  id: string,
  options: {
    allowed: string[];
    workers?: { name: string; paths: string[] }[];
    prechanges?: string[];
  },
): string {
  const workers = options.workers ?? [
    { name: "担当A：本体", paths: options.allowed },
  ];
  return `# タスク ${id}：テスト

## 目的

テストのため。

## 書き込んでよい場所

${options.allowed.map((p) => `- \`${p}\``).join("\n")}
- これ以外のファイルは読むだけにする。

## 担当の分け方

${workers
  .map(
    (w) =>
      `### ${w.name}\n\n- 書き込む場所：${w.paths.map((p) => `\`${p}\``).join("、")}\n- 作るもの：1`,
  )
  .join("\n\n")}

## 作業中のほかのタスクとの重なり

- なし

## main への事前変更

${(options.prechanges ?? ["なし"]).map((p) => `- ${p}`).join("\n")}

## 作るもの

1. 何か
`;
}
