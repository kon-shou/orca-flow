import { requireConfig } from "../config.ts";
import { requireRoot } from "../lib/git.ts";
import { createOrca, type OrcaWorktree } from "../lib/orca.ts";
import { samePath } from "../lib/paths.ts";
import { activeTasksWithDocs } from "../lib/tasks.ts";
import { FlowError, type Command } from "../types.ts";

export interface ActiveRow {
  id: string;
  branch: string;
  path: string;
  card: {
    workspaceStatus: string | null;
    comment: string;
    isUnread: boolean;
  } | null;
  allowed: string[] | null;
}

/** 作業中のタスクを並べる */
export const run: Command = async (ctx) => {
  if (ctx.argv.length > 0)
    throw new FlowError(1, `知らない引数です：${ctx.argv.join(" ")}`);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  const tasks = await activeTasksWithDocs(ctx.runner, root, config);

  let cards: OrcaWorktree[] | null = null;
  if (tasks.length > 0) {
    try {
      cards = await createOrca(ctx.runner, root).listWorktrees(
        undefined,
        5_000,
      );
    } catch {
      cards = null;
    }
  }

  const rows: ActiveRow[] = tasks.map((task) => {
    const card = cards?.find((c) => samePath(c.path, task.path)) ?? null;
    return {
      id: task.id,
      branch: task.branch,
      path: task.path,
      card: card
        ? {
            workspaceStatus: card.workspaceStatus,
            comment: card.comment,
            isUnread: card.isUnread,
          }
        : null,
      allowed: task.doc ? task.doc.allowed : null,
    };
  });

  if (!ctx.json) {
    if (rows.length === 0) ctx.stdout("作業中のタスクはありません");
    for (const row of rows) {
      const card = row.card
        ? `${row.card.workspaceStatus ?? "—"}「${row.card.comment}」${row.card.isUnread ? "（未読）" : ""}`
        : "（Orca のカードは取れませんでした）";
      const allowed = row.allowed
        ? row.allowed.length > 0
          ? row.allowed.map((p) => `\`${p}\``).join("、")
          : "（なし）"
        : "（設計書がまだありません）";
      ctx.stdout(
        `${row.id}  ${row.branch}\n  worktree：${row.path}\n  カード：${card}\n  書き込んでよい場所：${allowed}`,
      );
    }
  }
  return { code: 0, data: rows };
};
