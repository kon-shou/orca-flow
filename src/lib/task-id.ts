/** タスクの ID の決め方（6章の末尾） */

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 「T92d」「T92d-slug」の頭から数を読む。当たらなければ null */
export function idNumber(text: string, idPrefix: string): number | null {
  const match = new RegExp(
    `^${escapeRegExp(idPrefix)}(\\d+)[A-Za-z]*(?:$|[-_.])`,
  ).exec(text);
  return match ? Number(match[1]) : null;
}

/** ブランチ名から ID を読む（`task/T12-slug` → `T12`）。タスクのブランチでなければ null */
export function idFromBranch(
  branch: string,
  branchPrefix: string,
  idPrefix: string,
): string | null {
  if (!branch.startsWith(branchPrefix)) return null;
  const rest = branch.slice(branchPrefix.length);
  const match = new RegExp(
    `^(${escapeRegExp(idPrefix)}\\d+[A-Za-z]*)(?:$|-)`,
  ).exec(rest);
  return match ? match[1]! : null;
}

/** 設計書のファイル名から ID を読む（`T12.md` → `T12`） */
export function idFromTaskFile(file: string, idPrefix: string): string | null {
  const match = new RegExp(
    `^(${escapeRegExp(idPrefix)}\\d+[A-Za-z]*)\\.md$`,
  ).exec(file);
  return match ? match[1]! : null;
}

export interface IdSources {
  idPrefix: string;
  branchPrefix: string;
  /** tasksDir のファイル名 */
  taskFiles: readonly string[];
  /** 進捗表の ID の列 */
  progressIds: readonly string[];
  /** ブランチ名（refs/heads/ は取ったもの） */
  branches: readonly string[];
}

/** すでにある ID の一覧 */
export function existingIds(sources: IdSources): string[] {
  const ids = new Set<string>();
  for (const file of sources.taskFiles) {
    const id = idFromTaskFile(file, sources.idPrefix);
    if (id) ids.add(id);
  }
  for (const id of sources.progressIds) {
    if (idNumber(id.trim(), sources.idPrefix) !== null) ids.add(id.trim());
  }
  for (const branch of sources.branches) {
    const id = idFromBranch(branch, sources.branchPrefix, sources.idPrefix);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** 最大の数＋1。2桁以上にそろえる */
export function nextTaskId(sources: IdSources): string {
  let max = 0;
  for (const id of existingIds(sources)) {
    const n = idNumber(id, sources.idPrefix);
    if (n !== null && n > max) max = n;
  }
  return `${sources.idPrefix}${String(max + 1).padStart(2, "0")}`;
}

/** 指定の ID が使えるか。使えなければ理由を返す */
export function idProblem(id: string, sources: IdSources): string | null {
  const rest = id.startsWith(sources.idPrefix)
    ? id.slice(sources.idPrefix.length)
    : "";
  if (!/^\d+[A-Za-z]*$/.test(rest))
    return `ID は「${sources.idPrefix}」と数（例：${sources.idPrefix}12）にしてください：${id}`;
  if (existingIds(sources).includes(id))
    return `${id} はすでにあります（設計書・進捗表・ブランチのどれか）`;
  return null;
}
