import type { Runner } from "./exec.ts";
import { readCompanion } from "./companion.ts";
import { readCrossDepends } from "./cross-depends.ts";
import { samePath } from "./paths.ts";
import type { Membership } from "./group-branch.ts";
import { escapeId } from "./task-id.ts";
import type { Workspace, WorkspaceRepo } from "./workspace.ts";

/** 組の外の子を飛ばすときの理由 */
export const OUTSIDE_GROUP_REASON =
  "組の外です（またぐ依存の記録に共通の同じ ID への依存がありません）";

/** 記録で見た、その子と組の当たり */
interface RecordMatch {
  inGroup: boolean;
  /** ID では当たったが、タスクのブランチ名が組のブランチ名と違った記録のブランチ名 */
  otherBranches: string[];
}

/**
 * 記録が ID で当たっても、記録のタスクのブランチ名が組のブランチ名と違えば当てない
 * （組のブランチを消したあと、番号だけ同じ別のタスクの記録に当たるため）。タスクのブランチ名のない古い記録は ID だけで見る
 */
async function matchRecords(
  runner: Runner,
  workspace: Workspace,
  repo: WorkspaceRepo,
  id: string,
  groupBranch: string,
): Promise<RecordMatch> {
  const otherBranches: string[] = [];
  const sameTask = (taskBranch: string | undefined): boolean => {
    if (taskBranch === undefined || taskBranch === groupBranch) return true;
    otherBranches.push(taskBranch);
    return false;
  };
  const commons = workspace.repos.filter((r) => r.role === "common");
  if (commons.length > 0) {
    const record = await readCrossDepends(runner, repo.path, id);
    if (
      record?.repos.some(
        (dep) =>
          dep.ids.includes(id) &&
          commons.some((c) => samePath(c.path, dep.path)),
      ) &&
      sameTask(record.taskBranch)
    )
      return { inGroup: true, otherBranches: [] };
  }
  for (const owner of workspace.repos.filter((r) => r.companion)) {
    const companion = await readCompanion(runner, owner.path, id);
    if (
      companion?.apps.some((a) => samePath(a.path, repo.path)) &&
      sameTask(companion.taskBranch)
    )
      return { inGroup: true, otherBranches: [] };
  }
  return { inGroup: false, otherBranches };
}

/**
 * ブランチ名の見分けを先に当て、決まらなければ記録で見る。組のアプリなら null、組の外なら理由。
 * 同じ ID で短い名前の違うブランチしかない子は、記録があっても組の外（番号だけ同じ別のタスク）。
 * 記録のタスクのブランチ名は groupBranch（組のブランチ名）と比べる。渡し忘れで別の組の記録に当たらないよう省けない
 */
export async function outsideGroupReason(
  runner: Runner,
  workspace: Workspace,
  repo: WorkspaceRepo,
  id: string,
  membership: Membership | undefined,
  groupBranch: string,
): Promise<string | null> {
  if (membership?.kind === "branch") return null;
  if (membership?.kind === "other")
    return `組の外です（同じ ID のブランチ ${membership.branches.map((b) => escapeId(b)).join("、")} は組のブランチ名と違います）`;
  const match = await matchRecords(runner, workspace, repo, id, groupBranch);
  if (match.inGroup) return null;
  if (match.otherBranches.length > 0)
    return `組の外です（記録のタスクのブランチ ${[...new Set(match.otherBranches)].map((b) => escapeId(b)).join("、")} は組のブランチ名と違います）`;
  return OUTSIDE_GROUP_REASON;
}
