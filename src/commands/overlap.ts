import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { idFromTaskFile } from "../lib/task-id.ts";
import { mainWorktreePath, requireRoot } from "../lib/git.ts";
import {
  applyAutoOrder,
  planAutoOrder,
  readMergeOrder,
  withOrderLock,
  writeMergeOrder,
} from "../lib/merge-order.ts";
import { createOrca } from "../lib/orca.ts";
import { checkOverlap, type OverlapProblem } from "../lib/overlap.ts";
import { readabilityWarnings } from "../lib/readability.ts";
import { parseTaskDoc } from "../lib/task-doc.ts";
import {
  activeTasksWithDocs,
  sharedPathsOf,
  taskDocPath,
} from "../lib/tasks.ts";
import { FlowError, type Command } from "../types.ts";

/** 自動で足した結果。足さなかったときは added が false で、足せなかった理由を持つ（試さなかったときは data に入れない） */
interface AutoOrderResult {
  added: boolean;
  /** 足した鎖の全体（前から後ろ）。足さなかったときは null */
  chain: string[] | null;
  /** 自動の印の時刻（ISO 8601）。足さなかったときは null */
  at: string | null;
  /** 足せなかった理由。足したときは null */
  reason: string | null;
}

/** 今の worktree の設計書について、9.2 の4つを確かめ、9.3 の読みやすさの警告を出す */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, []);
  const [id, ...rest] = args.positionals;
  if (!id || rest.length > 0)
    throw new FlowError(1, "使い方：orca-flow overlap 〈ID〉");
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  if (idFromTaskFile(`${id}.md`, config.idPrefix) !== id)
    throw new FlowError(
      1,
      `ID の形が違います：${id}（「${config.idPrefix}」と数字の ID を書いてください。例：${config.idPrefix}12）`,
    );
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

  const actives = await activeTasksWithDocs(ctx.runner, root, config);
  const selfActive = actives.some((task) => task.id === id);
  const others = actives
    .filter((task) => task.id !== id && task.doc)
    .map((task) => ({ id: task.id, allowed: task.doc!.allowed }));
  const check = (order: Awaited<ReturnType<typeof readMergeOrder>>) =>
    checkOverlap({
      doc,
      sharedPaths: sharedPathsOf(config),
      others,
      order,
      selfId: id,
    });
  let all = check(await readMergeOrder(ctx.runner, root));
  if (doc.allowed.length === 0)
    all.unshift({
      kind: "outside",
      message: "「書き込んでよい場所」にパスが1つもありません",
    });

  // 問題が「作業中のほかのタスクとの重なり」だけなら、マージの順に自動で足す
  let autoOrder: AutoOrderResult | null = null;
  const onlyActive = (list: OverlapProblem[]) => {
    const rest = list.filter((p) => p.kind !== "order");
    return rest.length > 0 && rest.every((p) => p.kind === "active");
  };
  if (config.autoOrderOnOverlap && onlyActive(all) && !selfActive) {
    autoOrder = {
      added: false,
      chain: null,
      at: null,
      reason: `${id} は作業中のタスクではないので、順には足しません`,
    };
  } else if (config.autoOrderOnOverlap && onlyActive(all)) {
    // 足すかどうかは、ロックを取ってから読み直した順で決める
    const decided = await withOrderLock(ctx.runner, root, async () => {
      const order = await readMergeOrder(ctx.runner, root);
      const fresh = check(order);
      if (!onlyActive(fresh)) return { all: fresh, result: null };
      const partners = fresh.flatMap((p) =>
        p.kind === "active" && p.other ? [p.other] : [],
      );
      const plan = planAutoOrder(order, id, partners);
      if (!plan.ok)
        return {
          all: fresh,
          result: { added: false, chain: null, at: null, reason: plan.reason },
        };
      const at = ctx.now().toISOString();
      const next = applyAutoOrder(order, plan, at, id);
      await writeMergeOrder(ctx.runner, root, next);
      return {
        all: check(next),
        result: { added: true, chain: plan.ids, at, reason: null },
      };
    });
    all = decided.all;
    autoOrder = decided.result;
  }
  if (autoOrder?.added && autoOrder.chain) {
    ctx.stderr(
      `警告（マージの順）：重なるので、マージの順に足しました：${autoOrder.chain.join(" → ")}。順を変えるときは統括役のタブで orca-flow order`,
    );
    // 統括役のタブのカードに未読の印だけをつける。届かなくても警告だけ
    try {
      await createOrca(ctx.runner, root).setCard(
        await mainWorktreePath(ctx.runner, root),
        { unread: true },
      );
    } catch (error) {
      ctx.stderr(
        `警告：統括役のタブに未読の印をつけられませんでした（${error instanceof Error ? error.message : String(error)}）。順は足してあります`,
      );
    }
  }
  // 同じ鎖の相手との重なりは問題に数えず、警告にする
  const problems = all.filter((p) => p.kind !== "order");
  const orderWarnings = all.filter((p) => p.kind === "order");
  for (const warning of orderWarnings)
    ctx.stderr(`警告（マージの順）：${warning.message}`);

  const data = {
    id,
    allowed: doc.allowed,
    problems,
    warnings: doc.warnings,
    readability,
    orderWarnings,
    autoOrder,
  };
  if (problems.length > 0) {
    ctx.stderr(
      `${id} の設計書に直すところがあります：\n${problems.map((p) => `- ${p.message}`).join("\n")}${autoOrder && !autoOrder.added ? `\n- マージの順には足せませんでした：${autoOrder.reason}` : ""}`,
    );
    return { code: 1, data };
  }
  if (!ctx.json)
    ctx.stdout(
      `${id} の設計書の書き込む場所に重なりはありません（作業中のほかのタスク：${others.map((o) => o.id).join("、") || "なし"}）`,
    );
  return { code: 0, data };
};
