import { requireFlowConfig } from "../lib/flow-config.ts";
import { parseArgs } from "../lib/args.ts";
import { addDepends, dependentsOf, readDepends } from "../lib/depends.ts";
import {
  activeTasks,
  mainWorktreePath,
  requireIntegratorPlace,
  requireRoot,
} from "../lib/git.ts";
import type { Runner } from "../lib/exec.ts";
import {
  isSafeStackBranch,
  missingMessage,
  readStack,
  removeStack,
  stackState,
  stackTargetMerged,
} from "../lib/stack.ts";
import { escapeId, isTaskIdShape } from "../lib/task-id.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE =
  "使い方：orca-flow depends 〈ID〉 [--add 〈ID〉,〈ID〉 | --base | --unstack] ／ orca-flow depends --on 〈ID〉（どれも --json を受ける）";

/**
 * 依存の記録を見る・足す。見るだけならだれでも、足す（--add）のは統括役の場所だけ。
 * 乗せる記録の土台を出す（--base）のはだれでも、消す（--unstack）のは統括役の場所だけ。
 * 記録が壊れていれば空とみなさず終了コード1
 */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["add", "on"], ["base", "unstack"]);
  const [id, ...extra] = args.positionals;
  const add = args.values.get("add");
  const on = args.values.get("on");
  const base = args.flags.has("base");
  const unstack = args.flags.has("unstack");
  if (extra.length > 0) throw new FlowError(1, USAGE);
  if (
    on !== undefined &&
    (id !== undefined || add !== undefined || base || unstack)
  )
    throw new FlowError(1, USAGE);
  if ([add !== undefined, base, unstack].filter(Boolean).length > 1)
    throw new FlowError(1, USAGE);
  if (on === undefined && id === undefined) throw new FlowError(1, USAGE);

  const cwdRoot = await requireRoot(ctx.runner, ctx.cwd);
  const root = await mainWorktreePath(ctx.runner, cwdRoot);
  const config = await requireFlowConfig(ctx.runner, root);
  const checkShape = (value: string) => {
    if (!isTaskIdShape(value, config.idPrefix))
      throw new FlowError(
        1,
        `ID の形が違います：${escapeId(value)}（${config.idPrefix} と数字の形で書いてください）。${USAGE}`,
      );
  };

  if (on !== undefined) {
    checkShape(on);
    const active = await activeTasks(ctx.runner, root, config);
    const tasks = await dependentsOf(
      ctx.runner,
      root,
      on,
      active.map((t) => t.id),
    );
    if (!ctx.json)
      ctx.stdout(
        tasks.length === 0
          ? `${on} を依存に持つ作業中のタスクはありません`
          : `${on} を依存に持つ作業中のタスク：${tasks.join("、")}`,
      );
    return { code: 0, data: { on, tasks } };
  }

  checkShape(id!);
  if (base) {
    const state = await stackState(ctx.runner, root, config, id!);
    if (state.kind === "missing")
      throw new FlowError(2, missingMessage(id!, state.record));
    // スキルが読むので、--json でなければ土台の名前の1行だけを出す
    if (!ctx.json) ctx.stdout(state.base);
    return {
      code: 0,
      data: {
        id,
        base: state.base,
        state: state.kind,
        stackOn: state.kind === "none" ? null : state.record.on,
      },
    };
  }

  if (unstack) {
    const place = await requireIntegratorPlace(ctx.runner, ctx.cwd, config);
    // 壊れた記録は --unstack で消すのが抜け方なので、読めなくても消す
    const record = await readStack(ctx.runner, place, id!).catch(
      (error: unknown) => {
        if (error instanceof FlowError && error.code === 1) return null;
        throw error;
      },
    );
    const active = await activeTasks(ctx.runner, place, config);
    const back = active.find((t) => t.id === id);
    if (record !== null) {
      const merged = await stackTargetMerged(
        ctx.runner,
        place,
        config,
        record.on,
        record.branch,
      );
      const front = merged ? undefined : active.find((t) => t.id === record.on);
      // 乗せた先の枝の名前が崩れていれば土台に使えないので、抜け方として消すのは許す
      if (front && isSafeStackBranch(config, record.on, front.branch))
        throw new FlowError(
          2,
          `${id} を乗せた先 ${record.on} はまだ作業中です。乗せる記録を外すと、${record.on} が入る前の統合と push を止める守りが外れるので、消しません。${record.on} が入るか捨てられてから流してください`,
        );
    }
    const removed = await removeStack(ctx.runner, place, id!);
    const left =
      removed && record !== null
        ? await leftoverCommits(
            ctx.runner,
            place,
            config.baseBranch,
            record.branch,
            back?.branch ?? null,
          )
        : null;
    if (!ctx.json)
      ctx.stdout(
        removed
          ? [
              `${id} の乗せる記録を消しました（土台は ${config.baseBranch} に戻ります）`,
              ...(left !== null && left > 0
                ? [
                    `前の枝のコミットが後ろの枝に残っています（${left} 件）。外すか、自分の変更として扱うかを決めてください`,
                  ]
                : []),
              ...(record !== null
                ? [
                    `依存の記録とマージの順は残っています。要らなければ orca-flow order --remove ${id} と orca-flow merge ${id} --drop-depend ${record.on} で外してください`,
                  ]
                : []),
            ].join("\n")
          : `${id} の乗せる記録はありません`,
      );
    return {
      code: 0,
      data: {
        id,
        removed,
        ...(removed && record !== null
          ? { stackOn: record.on, leftoverCommits: left }
          : {}),
      },
    };
  }

  if (add === undefined) {
    const depends = await readDepends(ctx.runner, root, id!);
    const stack = await readStack(ctx.runner, root, id!);
    if (!ctx.json)
      ctx.stdout(
        (depends.length === 0
          ? `${id} の依存はありません`
          : `${id} の依存：${depends.join("、")}`) +
          (stack ? `\n${id} の乗せた先：${stack.on}（${stack.branch}）` : ""),
      );
    return {
      code: 0,
      data: {
        id,
        depends,
        ...(stack
          ? { stackOn: { id: stack.on, branch: stack.branch, at: stack.at } }
          : {}),
      },
    };
  }

  const ids = add
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (ids.length === 0) throw new FlowError(1, USAGE);
  for (const d of ids) checkShape(d);
  if (ids.includes(id!))
    throw new FlowError(1, `${id} を自分自身の依存には足せません`);

  const place = await requireIntegratorPlace(ctx.runner, ctx.cwd, config);
  const result = await addDepends(ctx.runner, place, id!, ids, ctx.now());
  if (!ctx.json)
    ctx.stdout(
      result.added.length === 0
        ? `${id} の依存の記録にはすでに入っています（依存：${result.depends.join("、")}）`
        : `${id} の依存の記録に ${result.added.join("、")} を足しました（依存：${result.depends.join("、")}）`,
    );
  return {
    code: 0,
    data: { id, added: result.added, depends: result.depends },
  };
};

/**
 * 後ろの枝に残る、乗せた先の枝のコミットの数（baseBranch に入っていないもの）。
 * どちらかの枝がない・数えられなければ null
 */
async function leftoverCommits(
  runner: Runner,
  cwd: string,
  baseBranch: string,
  frontBranch: string,
  backBranch: string | null,
): Promise<number | null> {
  if (backBranch === null) return null;
  const exists = async (branch: string) =>
    (
      await runner(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd },
      )
    ).code === 0;
  if (!(await exists(frontBranch)) || !(await exists(backBranch))) return null;
  const shared = await runner(
    "git",
    ["merge-base", `refs/heads/${frontBranch}`, `refs/heads/${backBranch}`],
    { cwd },
  );
  if (shared.code !== 0) return null;
  const count = await runner(
    "git",
    ["rev-list", "--count", `${baseBranch}..${shared.stdout.trim()}`],
    { cwd },
  );
  if (count.code !== 0) return null;
  const n = Number.parseInt(count.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n;
}
