import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  acquireWaitLock,
  autoSkillPath,
  listAuto,
  MAX_WAIT_ENV,
  newRecord,
  POLL_ENV,
  POLL_MS,
  MAX_WAIT_MS,
  readAuto,
  requireIdShape,
  TURN_LABEL,
  waitForTurn,
  waitState,
  withOff,
  withTurn,
  writeAuto,
  type TurnKind,
} from "../lib/auto.ts";
import {
  activeTasks,
  gitCommonDir,
  isMainWorktree,
  requireActiveTask,
  requireRoot,
} from "../lib/git.ts";
import { cardForState, createOrca } from "../lib/orca.ts";
import { canonicalPath } from "../lib/paths.ts";
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

async function list(ctx: CommandContext, root: string, common: string) {
  const config = await requireConfig(root);
  const active = new Set(
    (await activeTasks(ctx.runner, root, config)).map((t) => t.id),
  );
  const records = (await listAuto(common)).filter((r) => r.auto);
  const wait = await waitState(common);
  const tasks = records.map((r) => ({
    id: r.id,
    active: active.has(r.id),
    turn: r.turn
      ? { kind: r.turn.kind, at: r.turn.at, picked: r.turn.picked }
      : null,
    decisions: r.decisions.length,
  }));
  const data = { waiting: wait, tasks };
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
        `${t.id}：おまかせ・${t.active ? "作業中" : "作業中ではありません"}・${turn}・決めたこと ${t.decisions} 件`,
      );
    }
  }
  return { code: 0 as const, data };
}

async function show(ctx: CommandContext, common: string, id: string) {
  const record = await readAuto(common, id);
  if (!record) throw new FlowError(1, `${id} のおまかせの記録はありません`);
  if (!ctx.json) {
    ctx.stdout(
      `${id}：${record.auto ? "おまかせ" : `おまかせを外しました${record.offReason ? `（${record.offReason}）` : ""}`}`,
    );
    if (record.decisions.length === 0) ctx.stdout("決めたことはまだありません");
    for (const d of record.decisions) ctx.stdout(`${stamp(d.at)}  ${d.text}`);
  }
  return { code: 0 as const, data: record };
}

async function on(
  ctx: CommandContext,
  root: string,
  common: string,
  id: string,
) {
  const config = await requireConfig(root);
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
  if (kind) record = withTurn(record, kind, now);
  await writeAuto(common, record);
  if (!ctx.json)
    ctx.stdout(
      `${id} をおまかせにしました${kind ? `（${TURN_LABEL[kind]}の番を立てました）` : ""}`,
    );
  return { code: 0 as const, data: record };
}

async function off(
  ctx: CommandContext,
  common: string,
  rest: string[],
  reason: string | undefined,
  all: boolean,
) {
  const now = ctx.now();
  const reasonText = reason?.replace(/\s+/g, " ").trim() || null;
  let ids: string[];
  if (all) {
    if (rest.length > 0) throw new FlowError(1, USAGE);
    ids = (await listAuto(common)).filter((r) => r.auto).map((r) => r.id);
  } else {
    const [id, ...more] = rest;
    if (!id || more.length > 0) throw new FlowError(1, USAGE);
    requireIdShape(id);
    if (!(await readAuto(common, id)))
      throw new FlowError(1, `${id} のおまかせの記録はありません`);
    ids = [id];
  }
  for (const id of ids) {
    const record = await readAuto(common, id);
    if (record) await writeAuto(common, withOff(record, reasonText, now));
  }
  if (!ctx.json)
    ctx.stdout(
      ids.length > 0
        ? `おまかせを外しました：${ids.join("、")}`
        : "外すおまかせのタスクはありません",
    );
  return { code: 0 as const, data: { off: ids, reason: reasonText } };
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
  const config = await requireConfig(root);
  const lock = await acquireWaitLock(common);
  if (lock.kind === "held")
    throw new FlowError(
      2,
      `待ち受けはもう動いています${lock.pid ? `（pid ${lock.pid}）` : ""}。流し直す必要はありません`,
    );
  try {
    const picked = await waitForTurn({
      common,
      activeIds: async () =>
        (await activeTasks(ctx.runner, root, config)).map((t) => t.id),
      now: ctx.now,
      sleep,
      pollMs: Math.max(1, envMs(ctx.env[POLL_ENV], POLL_MS)),
      maxWaitMs: envMs(ctx.env[MAX_WAIT_ENV], MAX_WAIT_MS),
    });
    if (!picked) {
      if (!ctx.json)
        ctx.stdout(
          "拾う番はありませんでした（おまかせのタスクがないか、時間切れです）",
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
      return show(ctx, common, rest[0]);
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
