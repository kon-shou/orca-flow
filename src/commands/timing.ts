import { parseArgs } from "../lib/args.ts";
import { gitCommonDir, requireRoot } from "../lib/git.ts";
import {
  aggregate,
  computeTiming,
  formatDuration,
  listStageIds,
  localDate,
  readStages,
  type Stat,
  type TaskTiming,
} from "../lib/stage-log.ts";
import {
  FlowError,
  type Command,
  type CommandContext,
  type CommandResult,
} from "../types.ts";

const USAGE = "使い方：orca-flow timing [〈ID〉 | --since 〈YYYY-MM-DD〉]";
const NONE = "段の記録はまだありません";

const mapObject = (m: Map<string, number>) =>
  Object.fromEntries([...m.entries()]);

const statLines = (title: string, stats: Stat[]): string[] => [
  title,
  ...(stats.length === 0
    ? ["  （なし）"]
    : stats.map(
        (s) =>
          `  ${s.key}  ${s.count}件  合計 ${formatDuration(s.totalSeconds)}  中央値 ${formatDuration(s.medianSeconds)}`,
      )),
];

const totalLines = (title: string, m: Map<string, number>): string[] => [
  title,
  ...(m.size === 0
    ? ["  （なし）"]
    : [...m.entries()].map(([k, v]) => `  ${k}  ${formatDuration(v)}`)),
];

function one(
  ctx: CommandContext,
  id: string,
  t: TaskTiming,
  broken: number,
): CommandResult {
  const turns = new Map<string, number>(t.byTurn);
  if (!ctx.json) {
    const lines = [
      t.integrated
        ? `${id}：最初から統合まで ${formatDuration(t.totalSeconds)}`
        : `${id}：統合前です。最初から今まで ${formatDuration(t.totalSeconds)}（今の段は今の時刻まで数えています）`,
      "",
      "段の並び",
      ...t.segments.map(
        (s) =>
          `  ${s.at}  ${s.state}${s.note ? `（${s.note}）` : ""}  ${formatDuration(s.seconds)}${s.open ? "  ← 今の段（今まで）" : ""}`,
      ),
      "",
      ...totalLines("段ごとの合計", t.byState),
      "",
      ...totalLines("working の一言ごと", t.byNote),
      "",
      ...totalLines("番ごとの合計", turns),
    ];
    if (broken > 0) lines.push("", `読めない行を ${broken} 行飛ばしました`);
    ctx.stdout(lines.join("\n"));
  }
  return {
    code: 0,
    data: {
      id,
      integrated: t.integrated,
      integratedAt: t.integratedAt,
      totalSeconds: t.totalSeconds,
      skippedLines: broken,
      segments: t.segments,
      stages: mapObject(t.byState),
      workingNotes: mapObject(t.byNote),
      turns: mapObject(turns),
    },
  };
}

/** 段ごとの時間を出す（8章 timing） */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, ["since"]);
  const [id, ...rest] = args.positionals;
  if (rest.length > 0) throw new FlowError(1, USAGE);
  const since = args.values.get("since");
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since))
    throw new FlowError(1, `--since は YYYY-MM-DD で書いてください。${USAGE}`);
  if (id !== undefined && since !== undefined) throw new FlowError(1, USAGE);
  if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new FlowError(1, USAGE);

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);

  if (id !== undefined) {
    const parsed = await readStages(common, id);
    if (!parsed || parsed.entries.length === 0)
      throw new FlowError(1, `${id} の段の記録はまだありません`);
    return one(
      ctx,
      id,
      computeTiming(parsed.entries, ctx.now()),
      parsed.broken,
    );
  }

  const timings: TaskTiming[] = [];
  let broken = 0;
  let noStart = 0;
  for (const name of await listStageIds(common)) {
    const parsed = await readStages(common, name);
    if (!parsed) continue;
    broken += parsed.broken;
    if (parsed.entries.length === 0) continue;
    const t = computeTiming(parsed.entries, ctx.now());
    if (!t.integrated) continue;
    if (since !== undefined && localDate(new Date(t.integratedAt!)) < since)
      continue;
    // 記録が途中から始まる（最初の行が new でない）タスクは、全体の時間が測れないので集計から外す
    if (parsed.entries[0]!.command !== "new") {
      noStart++;
      continue;
    }
    timings.push(t);
  }
  const noStartLine = `最初の記録が new でないタスク ${noStart} 件（記録が途中から始まる）は集計から外しました`;
  if (timings.length === 0) {
    if (!ctx.json) ctx.stdout(noStart > 0 ? `${NONE}\n${noStartLine}` : NONE);
    return {
      code: 0,
      data: {
        since: since ?? null,
        tasks: 0,
        skippedLines: broken,
        skippedNoStart: noStart,
        stages: [],
        workingNotes: [],
        turns: [],
        total: null,
      },
    };
  }
  const stages = aggregate(timings.map((t) => t.byState));
  const notes = aggregate(timings.map((t) => t.byNote));
  const turns = aggregate(
    timings.map((t) => new Map<string, number>(t.byTurn)),
  );
  const [total] = aggregate(
    timings.map((t) => new Map([["total", t.totalSeconds]])),
  );
  if (!ctx.json) {
    const lines = [
      `統合済みのタスク ${timings.length} 件${since ? `（${since} 以降）` : ""}：最初から統合まで 合計 ${formatDuration(total!.totalSeconds)}・中央値 ${formatDuration(total!.medianSeconds)}`,
      "",
      ...statLines("段ごと", stages),
      "",
      ...statLines("working の一言ごと", notes),
      "",
      ...statLines("番ごと", turns),
    ];
    if (noStart > 0) lines.push("", noStartLine);
    if (broken > 0) lines.push("", `読めない行を ${broken} 行飛ばしました`);
    ctx.stdout(lines.join("\n"));
  }
  return {
    code: 0,
    data: {
      since: since ?? null,
      tasks: timings.length,
      skippedLines: broken,
      skippedNoStart: noStart,
      stages,
      workingNotes: notes,
      turns,
      total,
    },
  };
};
