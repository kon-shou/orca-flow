import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_PATH,
  loadConfig,
  parseConfig,
  type FlowConfig,
  type LoadedConfig,
} from "../config.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import { mainWorktreePath } from "./git.ts";

/** .git がファイルなら、リンクした worktree（メインでは .git はディレクトリ）。git を呼ばずに見分ける */
async function isLinkedWorktree(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, ".git"))).isFile();
  } catch {
    return false;
  }
}

/**
 * root の設定を読む。git に残さない形（untracked）のリンクした worktree では、
 * .orca-flow/ が git で届かず写しが古くなるので、メインの config.json を読む（なければ写し）。
 * コミットする形では git を呼ばない
 */
export async function loadFlowConfig(
  runner: Runner,
  root: string,
): Promise<LoadedConfig> {
  const local = await loadConfig(root);
  if (!local.exists || !local.config.untracked) return local;
  if (!(await isLinkedWorktree(root))) return local;

  const main = await mainWorktreePath(runner, root);
  const file = path.join(main, CONFIG_PATH);
  if (path.resolve(file) === path.resolve(local.path)) return local;

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return local;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FlowError(1, `${file} が JSON として読めません`);
  }
  try {
    return { config: parseConfig(raw), exists: true, path: file };
  } catch (error) {
    // 文の頭の相対パスは worktree の写しに見えるので、直す先のメインのパスに替える
    if (error instanceof FlowError && error.message.startsWith(CONFIG_PATH)) {
      throw new FlowError(
        error.code,
        `${file}${error.message.slice(CONFIG_PATH.length)}`,
      );
    }
    throw error;
  }
}

/** init と context 以外のサブコマンドが使う。設定がなければ FlowError(2) */
export async function requireFlowConfig(
  runner: Runner,
  root: string,
): Promise<FlowConfig> {
  const loaded = await loadFlowConfig(runner, root);
  if (!loaded.exists) {
    throw new FlowError(
      2,
      "このリポジトリには orca-flow の設定がありません。メインのチェックアウトのタブで /orca-flow:init を流してください",
    );
  }
  return loaded.config;
}
