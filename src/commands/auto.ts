import { requireFlowConfig } from "../lib/flow-config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  acquireWaitLock,
  approvedNow,
  approveNowNote,
  autoSkillPath,
  entryStateText,
  listAuto,
  listStackPairs,
  MAX_WAIT_ENV,
  newRecord,
  POLL_ENV,
  POLL_MS,
  MAX_WAIT_MS,
  PRE_APPROVAL_LABEL,
  preApprovalState,
  raiseStartAfterTurns,
  readAuto,
  requireIdShape,
  TURN_LABEL,
  waitForTurn,
  waitDetail,
  waitState,
  withOff,
  withTurn,
  writeAuto,
  type AutoRecord,
  type PreApproval,
  type TurnKind,
} from "../lib/auto.ts";
import type { FlowConfig } from "../config.ts";
import {
  activeTasks,
  gitCommonDir,
  isMainWorktree,
  requireActiveTask,
  requireRoot,
  type ActiveTask,
} from "../lib/git.ts";
import { cardForState, createOrca } from "../lib/orca.ts";
import { canonicalPath } from "../lib/paths.ts";
import {
  listStartAfterIds,
  newStartAfterCache,
  startAfterFile,
  startAfterReadiness,
  startAfterUnreadable,
  type StartAfterReadiness,
} from "../lib/start-after.ts";
import {
  STACK_RETRY_ENV,
  STACK_RETRY_MS,
  syncStackNotices,
} from "../lib/stack-sync.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

const USAGE =
  "使い方：orca-flow auto [show 〈ID〉|on 〈ID〉|off 〈ID〉 [--reason 〈文〉]|off --all|log 〈ID〉 〈文〉|wait]";

async function requireMain(ctx: CommandContext, root: string, what: string) {
  if (!(await isMainWorktree(ctx.runner, root)))
    throw new FlowError(
      2,
      `auto ${what} は統括役のメインの作業ツリーで流してください`,
    );
}

function envMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const stamp = (iso: string) => iso || "（時刻なし）";

/** 前を待つ印の整い具合を、人に見せる1行の後ろ半分にする */
function readinessText(readiness: StartAfterReadiness): string {
  if (readiness.problem !== null)
    return `前を待つ印が読めません（${readiness.problem}）`;
  return `${readiness.ready ? "前が整いました" : "前を待っています"}：${readiness.entries.map(entryStateText).join("、")}`;
}

/** --json に出す先の承認。valid は今の設計書が承認したときのままか */
type PreApprovalView = PreApproval & { valid: boolean };

/**
 * 先の承認の見せ方。作業中でない（統合済み・捨てた）タスクと、最後の spec-review のあとに承認が済んだタスクには
 * 出さない（先の承認はもう使われないので、有効・外れたと出し続けると人が迷う）
 */
async function preApprovalView(
  ctx: CommandContext,
  root: string,
  common: string,
  config: FlowConfig,
  task: ActiveTask | undefined,
  record: AutoRecord | null | undefined,
): Promise<PreApprovalView | null> {
  const pre = record?.auto ? record.preApproval : null;
  if (!pre || !task || (await approvedNow(common, task.id))) return null;
  let valid = false;
  try {
    valid =
      (await preApprovalState(ctx.runner, root, config, task, pre)) === "valid";
  } catch {
    // 設計書を読めなければ、人の承認として進めないよう外れたと見せる
  }
  return { ...pre, valid };
}

const preApprovalText = (view: PreApprovalView) =>
  PRE_APPROVAL_LABEL[view.valid ? "valid" : "stale"];

async function list(ctx: CommandContext, root: string, common: string) {
  const config = await requireFlowConfig(ctx.runner, root);
  const activeList = await activeTasks(ctx.runner, root, config);
  const active = new Set(activeList.map((t) => t.id));
  const all = await listAuto(common);
  const byId = new Map(all.map((r) => [r.id, r]));
  const records = all.filter((r) => r.auto);
  const offIds = new Set(all.filter((r) => !r.auto).map((r) => r.id));
  const wait = await waitState(common);
  const tasks = records.map((r) => ({
    id: r.id,
    active: active.has(r.id),
    approveOnly: r.approveOnly,
    turn: r.turn
      ? { kind: r.turn.kind, at: r.turn.at, picked: r.turn.picked }
      : null,
    decisions: r.decisions.length,
  }));
  const cache = newStartAfterCache();
  const startAfter: ({
    id: string;
    active: boolean;
    off: boolean;
    preApproval: PreApprovalView | null;
  } & StartAfterReadiness)[] = [];
  // 人が approve するまで待ち受けが進めないタスクだけに案内を添える。承認済みに添えると二度承認しうる
  const needsApprove = new Set<string>();
  for (const id of await listStartAfterIds(common)) {
    const readiness = await startAfterReadiness(
      ctx.runner,
      root,
      common,
      config,
      id,
      cache,
    );
    if (!readiness) continue;
    startAfter.push({
      id,
      active: active.has(id),
      off: offIds.has(id),
      preApproval: await preApprovalView(
        ctx,
        root,
        common,
        config,
        activeList.find((t) => t.id === id),
        byId.get(id),
      ),
      ...readiness,
    });
    if (offIds.has(id) && active.has(id) && !(await approvedNow(common, id)))
      needsApprove.add(id);
  }
  const data = { waiting: wait, tasks, startAfter };
  if (!ctx.json) {
    ctx.stdout(
      wait.running
        ? `待ち受け：動いています（pid ${wait.pid}）`
        : "待ち受け：動いていません",
    );
    if (tasks.length === 0) ctx.stdout("おまかせのタスクはありません");
    for (const t of tasks) {
      const turn = t.turn
        ? `${TURN_LABEL[t.turn.kind]}の番（${t.turn.picked ? `拾われました。進んでいなければ orca-flow auto on ${t.id} で番を立て直せます` : "待っています"}）`
        : "番なし";
      ctx.stdout(
        `${t.id}：${t.approveOnly ? "承認だけのおまかせ" : "おまかせ"}・${t.active ? "作業中" : "作業中ではありません"}・${turn}・決めたこと ${t.decisions} 件`,
      );
    }
    if (startAfter.length > 0) ctx.stdout("前を待つタスク：");
    for (const t of startAfter)
      ctx.stdout(
        `${t.id}：${t.active ? "作業中" : "作業中ではありません"}・${readinessText(t)}${needsApprove.has(t.id) ? "・おまかせを外してあります（/orca-flow:approve で承認）" : ""}${t.preApproval ? `・${preApprovalText(t.preApproval)}` : ""}`,
      );
  }
  return { code: 0 as const, data };
}

async function show(
  ctx: CommandContext,
  root: string,
  common: string,
  id: string,
) {
  const record = await readAuto(common, id);
  // 設定は印か先の承認があるときだけ読む（ない show は今までどおり設定なしでも読める）
  const marked = (await listStartAfterIds(common)).includes(id);
  const pre = record?.auto ? record.preApproval : null;
  const config =
    marked || pre ? await requireFlowConfig(ctx.runner, root) : null;
  const startAfter =
    marked && config
      ? await startAfterReadiness(ctx.runner, root, common, config, id)
      : null;
  if (!record && !startAfter)
    throw new FlowError(1, `${id} のおまかせの記録はありません`);
  const preApproval =
    pre && config
      ? await preApprovalView(
          ctx,
          root,
          common,
          config,
          (await activeTasks(ctx.runner, root, config)).find(
            (t) => t.id === id,
          ),
          record,
        )
      : null;
  if (!ctx.json) {
    if (record) {
      ctx.stdout(
        `${id}：${record.auto ? (record.approveOnly ? "承認だけのおまかせ（統合の番は立てません）" : "おまかせ") : `おまかせを外しました${record.offReason ? `（${record.offReason}）` : ""}`}`,
      );
    } else ctx.stdout(`${id}：おまかせの記録はまだありません`);
    if (startAfter) {
      ctx.stdout(
        startAfter.problem !== null
          ? `前を待つ印が読めません（${startAfter.problem}）`
          : startAfter.ready
            ? "前が整いました"
            : "前を待っています",
      );
      for (const e of startAfter.entries)
        ctx.stdout(`  ${e.ready ? "整った" : "まだ"}  ${entryStateText(e)}`);
    }
    if (preApproval)
      ctx.stdout(`${preApprovalText(preApproval)}（${stamp(preApproval.at)}）`);
    if (record) {
      if (record.decisions.length === 0)
        ctx.stdout("決めたことはまだありません");
      for (const d of record.decisions) ctx.stdout(`${stamp(d.at)}  ${d.text}`);
    }
  }
  return {
    code: 0 as const,
    data: record ? { ...record, preApproval, startAfter } : { id, startAfter },
  };
}

async function on(
  ctx: CommandContext,
  root: string,
  common: string,
  id: string,
) {
  const config = await requireFlowConfig(ctx.runner, root);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  const now = ctx.now();
  let record = (await readAuto(common, id)) ?? newRecord(id, now);
  record = { ...record, auto: true, offReason: null, offAt: null };
  let kind: TurnKind | null = null;
  try {
    const rows = await createOrca(ctx.runner, root).listWorktrees(root);
    const mine = canonicalPath(task.path);
    const row = rows.find((r) => r.path && canonicalPath(r.path) === mine);
    const review = cardForState("spec-review").comment;
    if (review !== undefined && row?.comment.startsWith(review))
      kind = "approve";
    else if (row?.comment.startsWith("統合待ち")) kind = "integrate";
  } catch (error) {
    ctx.stderr(
      `警告：Orca からカードを読めなかったので、番は立てていません（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  // 承認だけのおまかせは残す（auto のスキルが拾われた承認の番を on で立て直すため）。統合は人が確かめる
  let note: string | null = null;
  if (kind === "integrate" && record.approveOnly) {
    kind = null;
    note =
      "承認だけのおまかせなので統合の番は立てません。統合は /orca-flow:integrate で";
  }
  if (kind === "approve") {
    const readiness = await startAfterReadiness(
      ctx.runner,
      root,
      common,
      config,
      id,
    );
    if (readiness && !readiness.ready) {
      kind = null;
      // 読めない前は待っても整わないので、待ち受けに任せず今の抜け方を出す
      note = `前の実装完了を待っています（${waitDetail(readiness)}）。${startAfterUnreadable(readiness) ? approveNowNote(startAfterFile(common, id)) : "前が整ったら待ち受けが番を立てます"}`;
    }
  }
  if (kind) record = withTurn(record, kind, now);
  await writeAuto(common, record);
  if (!ctx.json) {
    ctx.stdout(
      `${id} をおまかせにしました${kind ? `（${TURN_LABEL[kind]}の番を立てました）` : ""}`,
    );
    if (note) ctx.stdout(note);
  }
  return { code: 0 as const, data: record };
}

async function off(
  ctx: CommandContext,
  root: string,
  common: string,
  rest: string[],
  reason: string | undefined,
  all: boolean,
) {
  const now = ctx.now();
  const reasonText = reason?.replace(/\s+/g, " ").trim() || null;
  let ids: string[];
  let marks: string[];
  if (all) {
    if (rest.length > 0) throw new FlowError(1, USAGE);
    ids = (await listAuto(common)).filter((r) => r.auto).map((r) => r.id);
    marks = await activeMarks(ctx, root, common);
  } else {
    const [id, ...more] = rest;
    if (!id || more.length > 0) throw new FlowError(1, USAGE);
    requireIdShape(id);
    const record = await readAuto(common, id);
    const marked = (await listStartAfterIds(common)).includes(id);
    if (!record && !marked)
      throw new FlowError(1, `${id} のおまかせの記録はありません`);
    ids = record ? [id] : [];
    marks = marked ? [id] : [];
  }
  for (const id of ids) {
    const record = await readAuto(common, id);
    if (record) await writeAuto(common, withOff(record, reasonText, now));
  }
  // 印は残す（人が決めた）。記録のない印だけのタスクには外した形の記録を書き、待ち受けに番を立てさせない
  const stopped: string[] = [];
  for (const id of marks) {
    if (!ids.includes(id) && !(await readAuto(common, id)))
      await writeAuto(
        common,
        withOff(newRecord(id, now, true), reasonText, now),
      );
    stopped.push(id);
  }
  if (!ctx.json) {
    if (ids.length > 0) ctx.stdout(`おまかせを外しました：${ids.join("、")}`);
    else if (stopped.length === 0)
      ctx.stdout("外すおまかせのタスクはありません");
    if (stopped.length > 0)
      ctx.stdout(
        `自動の承認を止めました（前を待つ印は残します）：${stopped.join("、")}`,
      );
  }
  return {
    code: 0 as const,
    data: { off: ids, reason: reasonText, startAfterStopped: stopped },
  };
}

/** 印のある作業中のタスク。作業中かを調べられなければ、印のある全部 */
async function activeMarks(
  ctx: CommandContext,
  root: string,
  common: string,
): Promise<string[]> {
  const marks = await listStartAfterIds(common);
  if (marks.length === 0) return marks;
  try {
    const config = await requireFlowConfig(ctx.runner, root);
    const active = new Set(
      (await activeTasks(ctx.runner, root, config)).map((t) => t.id),
    );
    return marks.filter((id) => active.has(id));
  } catch {
    return marks;
  }
}

async function log(ctx: CommandContext, common: string, rest: string[]) {
  const [id, ...words] = rest;
  const text = words.join(" ").replace(/\s+/g, " ").trim();
  if (!id || text === "")
    throw new FlowError(1, "使い方：orca-flow auto log 〈ID〉 〈文〉");
  requireIdShape(id);
  const record = await readAuto(common, id);
  if (!record) throw new FlowError(1, `${id} のおまかせの記録はありません`);
  const decision = { at: ctx.now().toISOString(), text };
  await writeAuto(common, {
    ...record,
    decisions: [...record.decisions, decision],
  });
  if (!ctx.json) ctx.stdout(`${id} に決めたことを残しました`);
  return { code: 0 as const, data: decision };
}

async function wait(ctx: CommandContext, root: string, common: string) {
  const config = await requireFlowConfig(ctx.runner, root);
  const lock = await acquireWaitLock(common);
  if (lock.kind === "held")
    throw new FlowError(
      2,
      `待ち受けはもう動いています${lock.pid ? `（pid ${lock.pid}）` : ""}。流し直す必要はありません`,
    );
  try {
    // waitForTurn は同じ見直しの中で activeIds のあとに syncStacks を呼ぶので、その回の一覧を使い回す
    let roundActive: ActiveTask[] = [];
    const picked = await waitForTurn({
      common,
      activeIds: async () => {
        roundActive = await activeTasks(ctx.runner, root, config);
        return roundActive.map((t) => t.id);
      },
      markedIds: () => listStartAfterIds(common),
      raise: async (ids) => {
        await raiseStartAfterTurns(
          {
            runner: ctx.runner,
            root,
            common,
            config,
            now: ctx.now(),
            cache: newStartAfterCache(),
          },
          ids,
        );
      },
      stackPairs: () => listStackPairs(common),
      syncStacks: async (ids) => {
        await syncStackNotices(
          {
            ctx,
            config,
            root,
            common,
            now: ctx.now(),
            retryMs: envMs(ctx.env[STACK_RETRY_ENV], STACK_RETRY_MS),
          },
          ids,
          roundActive,
        );
      },
      now: ctx.now,
      sleep,
      pollMs: Math.max(1, envMs(ctx.env[POLL_ENV], POLL_MS)),
      maxWaitMs: envMs(ctx.env[MAX_WAIT_ENV], MAX_WAIT_MS),
    });
    if (!picked) {
      if (!ctx.json)
        ctx.stdout(
          "拾う番はありませんでした（おまかせのタスクも前を待つタスクも、乗せた先が作業中の乗せたタスクもないか、時間切れです）",
        );
      return { code: 0 as const, data: { turn: null } };
    }
    const skill = autoSkillPath();
    const next = `${skill} を読み、${picked.id} の${TURN_LABEL[picked.kind]}を「おまかせの決まり」で進めてください。終わったら orca-flow auto wait を背景で流し直してください`;
    const data = {
      turn: { id: picked.id, kind: picked.kind, at: picked.at, next, skill },
    };
    if (!ctx.json)
      ctx.stdout(
        `ID：${picked.id}\n番：${TURN_LABEL[picked.kind]}（${picked.kind}）\n次にすること：${next}`,
      );
    return { code: 0 as const, data };
  } finally {
    await lock.release();
  }
}

/** おまかせの記録・待ち受け（8章 auto） */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["reason"], ["all"]);
  const [sub, ...rest] = args.positionals;
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);
  if (args.values.has("reason") && sub !== "off")
    throw new FlowError(1, "--reason は auto off でだけ使えます");
  if (args.flags.has("all") && sub !== "off")
    throw new FlowError(1, "--all は auto off でだけ使えます");

  switch (sub) {
    case undefined:
      return list(ctx, root, common);
    case "show": {
      if (rest.length !== 1 || !rest[0]) throw new FlowError(1, USAGE);
      requireIdShape(rest[0]);
      return show(ctx, root, common, rest[0]);
    }
    case "on": {
      if (rest.length !== 1 || !rest[0]) throw new FlowError(1, USAGE);
      requireIdShape(rest[0]);
      await requireMain(ctx, root, "on");
      return on(ctx, root, common, rest[0]);
    }
    case "off":
      await requireMain(ctx, root, "off");
      return off(
        ctx,
        root,
        common,
        rest,
        args.values.get("reason"),
        args.flags.has("all"),
      );
    case "log":
      await requireMain(ctx, root, "log");
      return log(ctx, common, rest);
    case "wait":
      if (rest.length > 0) throw new FlowError(1, USAGE);
      await requireMain(ctx, root, "wait");
      return wait(ctx, root, common);
    default:
      throw new FlowError(1, `知らない使い方です：${sub}。${USAGE}`);
  }
};
