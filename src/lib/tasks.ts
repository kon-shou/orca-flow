import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import type { CommandContext } from "../types.ts";
import type { Runner } from "./exec.ts";
import { activeTasks, commitFile, showFile, type ActiveTask } from "./git.ts";
import { ProgressError } from "./progress.ts";
import { parseTaskDoc, type TaskDoc } from "./task-doc.ts";

export const taskDocPath = (config: FlowConfig, id: string) =>
  path.posix.join(config.tasksDir, `${id}.md`);

export const reportPath = (config: FlowConfig, id: string) =>
  path.posix.join(config.reportsDir, `${id}.md`);

/** 共有のファイル（設定の sharedPaths と進捗表） */
export const sharedPathsOf = (config: FlowConfig): string[] =>
  config.progress
    ? [...config.sharedPaths, config.progress.file]
    : [...config.sharedPaths];

/** タスクのブランチの設計書を読む。なければ baseBranch のものを読む。どちらにもなければ null */
export async function readTaskDoc(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  task: { id: string; branch: string },
): Promise<TaskDoc | null> {
  const file = taskDocPath(config, task.id);
  const text =
    (await showFile(runner, cwd, task.branch, file)) ??
    (await showFile(runner, cwd, config.baseBranch, file));
  return text === null ? null : parseTaskDoc(text);
}

export interface ActiveTaskWithDoc extends ActiveTask {
  doc: TaskDoc | null;
}

export async function activeTasksWithDocs(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
): Promise<ActiveTaskWithDoc[]> {
  const tasks = await activeTasks(runner, cwd, config);
  const out: ActiveTaskWithDoc[] = [];
  for (const task of tasks)
    out.push({ ...task, doc: await readTaskDoc(runner, cwd, config, task) });
  return out;
}

export interface ProgressPlan {
  file: string;
  absolute: string;
  text: string;
}

/**
 * 進捗表の書き換えを先に組み立てる（確かめる → 書き換える の順を守るため）。
 * progress が null なら null。表や行がなければ警告を出して null
 */
export async function planProgress(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  change: (text: string) => string,
): Promise<ProgressPlan | null> {
  const progress = config.progress;
  if (!progress) return null;
  const absolute = path.join(root, progress.file);
  let before: string;
  try {
    before = await readFile(absolute, "utf8");
  } catch {
    ctx.stderr(
      `警告：進捗表 ${progress.file} が読めないので、進捗表は書き換えません`,
    );
    return null;
  }
  try {
    const text = change(before);
    if (text === before) return null;
    return { file: progress.file, absolute, text };
  } catch (error) {
    if (error instanceof ProgressError) {
      ctx.stderr(`警告：${error.message}。進捗表は書き換えません`);
      return null;
    }
    throw error;
  }
}

/** 組み立てた進捗表を書いてコミットする */
export async function applyProgress(
  runner: Runner,
  root: string,
  plan: ProgressPlan | null,
  message: string,
): Promise<boolean> {
  if (!plan) return false;
  await writeFile(plan.absolute, plan.text);
  await commitFile(runner, root, plan.file, message);
  return true;
}

/** 進捗表の今の中身（ID を決めるため）。なければ null */
export async function readProgressText(
  root: string,
  config: FlowConfig,
): Promise<string | null> {
  if (!config.progress) return null;
  try {
    return await readFile(path.join(root, config.progress.file), "utf8");
  } catch {
    return null;
  }
}

/** 「main が進んだ知らせ」 */
export const mainAdvancedNotice = (config: FlowConfig, id: string) =>
  `（${config.integratorName}より）main に ${id} が入りました。区切りのよいところで git rebase ${config.baseBranch} をして、テストを流してください。統合待ちなら、orca-flow verify を流し直して integrate-wait に戻してください。`;
