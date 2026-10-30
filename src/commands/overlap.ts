import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireRoot } from "../lib/git.ts";
import { checkOverlap } from "../lib/overlap.ts";
import { readabilityWarnings } from "../lib/readability.ts";
import { parseTaskDoc } from "../lib/task-doc.ts";
import {
  activeTasksWithDocs,
  sharedPathsOf,
  taskDocPath,
} from "../lib/tasks.ts";
import { FlowError, type Command } from "../types.ts";

/** 今の worktree の設計書について、9.2 の4つを確かめ、9.3 の読みやすさの警告を出す */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, []);
  const [id, ...rest] = args.positionals;
  if (!id || rest.length > 0)
    throw new FlowError(1, "使い方：orca-flow overlap 〈ID〉");
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  const file = taskDocPath(config, id);
  let text: string;
  try {
    text = await readFile(path.join(root, file), "utf8");
  } catch {
    throw new FlowError(1, `設計書 ${file} がありません`);
  }
  const doc = parseTaskDoc(text);
  for (const warning of doc.warnings) ctx.stderr(`警告：${warning}`);
  // 読みやすさは警告だけ。終了コードは変えない
  const readability = readabilityWarnings(text);
  for (const warning of readability) ctx.stderr(`読みやすさ：${warning}`);

  const others = (await activeTasksWithDocs(ctx.runner, root, config))
    .filter((task) => task.id !== id && task.doc)
    .map((task) => ({ id: task.id, allowed: task.doc!.allowed }));
  const problems = checkOverlap({
    doc,
    sharedPaths: sharedPathsOf(config),
    others,
  });
  if (doc.allowed.length === 0)
    problems.unshift({
      kind: "outside",
      message: "「書き込んでよい場所」にパスが1つもありません",
    });

  const data = {
    id,
    allowed: doc.allowed,
    problems,
    warnings: doc.warnings,
    readability,
  };
  if (problems.length > 0) {
    ctx.stderr(
      `${id} の設計書に直すところがあります：\n${problems.map((p) => `- ${p.message}`).join("\n")}`,
    );
    return { code: 1, data };
  }
  if (!ctx.json)
    ctx.stdout(
      `${id} の設計書の書き込む場所に重なりはありません（作業中のほかのタスク：${others.map((o) => o.id).join("、") || "なし"}）`,
    );
  return { code: 0, data };
};
