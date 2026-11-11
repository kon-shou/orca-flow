import { requireFlowConfig } from "../lib/flow-config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireIdShape } from "../lib/auto.ts";
import { findPr, type GhContext } from "../lib/github.ts";
import {
  gitCommonDir,
  isMainWorktree,
  requireActiveTask,
  requireRoot,
} from "../lib/git.ts";
import {
  fetchTargetSource,
  TargetInputError,
  type TargetSource,
} from "../lib/respond-input.ts";
import { classifyRisk } from "../lib/risk.ts";
import {
  AUTO_KINDS,
  AUTO_MAX_PENDING,
  AUTO_MIN_AGREED,
  AUTO_MIN_RATE_PERCENT,
  applyAutoAnswer,
  applyAutoCast,
  countAuto,
  currentAutoState,
  disableKind,
  enableKind,
  isAutoKind,
  meetsFloor,
  readAutoState,
  type AutoState,
} from "../lib/vote-auto.ts";
import { readTaskDoc } from "../lib/tasks.ts";
import {
  VOTE_KEYS,
  VOTE_KINDS,
  VOTE_MODEL,
  buildVoteMaterial,
  castSecondVote,
  computeStats,
  hasAnsweredEntry,
  isVoteKey,
  isVoteKind,
  readAllVotes,
  readVoteFile,
  recordAnswer,
  recordCast,
  votePath,
  type KindStats,
  type VoteKey,
  type VoteKind,
  type SecondRecord,
  type VoteEntry,
} from "../lib/vote.ts";
import { escapeId } from "../lib/task-id.ts";
import {
  FlowError,
  type Command,
  type CommandContext,
  type CommandResult,
} from "../types.ts";

const USAGE = `使い方：
  orca-flow vote cast <ID> --target <スレッド・コメント・レビューの ID> --kind <種類> --first <キー>
  orca-flow vote answer <ID> --target <ID> --human <キー>
  orca-flow vote stats [--json]
  orca-flow vote auto [on|off <種類>]
種類：${VOTE_KINDS.join("・")}
キー：${VOTE_KEYS.join("・")}`;

const requireKey = (value: string | undefined, flag: string) => {
  if (value === undefined)
    throw new FlowError(1, `--${flag} を渡してください\n${USAGE}`);
  if (!isVoteKey(value))
    throw new FlowError(
      1,
      `--${flag} は ${VOTE_KEYS.join("・")} のどれかにしてください：${escapeId(value)}`,
    );
  return value;
};

const requireTarget = (value: string | undefined) => {
  if (value === undefined || value === "")
    throw new FlowError(1, `--target を渡してください\n${USAGE}`);
  return value;
};

function oneId(positionals: string[]): string {
  const [id, ...rest] = positionals;
  if (!id || rest.length > 0) throw new FlowError(1, USAGE);
  requireIdShape(id);
  return id;
}

const answeredError = (id: string) =>
  new FlowError(
    1,
    `${id} のこの対象は答え済みなので、vote cast は記録しません。人には聞いてください（vote answer も流さないでください）`,
  );

async function cast(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), ["target", "kind", "first"]);
  const id = oneId(args.positionals);
  const target = requireTarget(args.values.get("target"));
  const kind = args.values.get("kind");
  if (kind === undefined)
    throw new FlowError(1, `--kind を渡してください\n${USAGE}`);
  if (!isVoteKind(kind))
    throw new FlowError(
      1,
      `--kind は ${VOTE_KINDS.join("・")} のどれかにしてください：${escapeId(kind)}`,
    );
  const first = requireKey(args.values.get("first"), "first");

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  const common = await gitCommonDir(ctx.runner, root);
  // 答え済みの対象は、GitHub もモデルも触らずに断る（会話が立て直されても2回数えない）
  const file = votePath(common, id);
  if (await hasAnsweredEntry(file, target)) throw answeredError(id);
  const g: GhContext = { runner: ctx.runner, cwd: root, env: ctx.env };
  // PR を読めないときは番号なしとして扱う（区分は high になる）
  const pr = await findPr(g, task.branch).catch(() => null);
  const risk = await classifyRisk({
    runner: ctx.runner,
    cwd: task.path,
    env: ctx.env,
    config,
    pr: pr ? pr.number : null,
  });

  let second: SecondRecord;
  let model: string | null = null;
  if (kind !== "comment") second = { status: "skipped", why: "kind" };
  else if (risk.level === "high" || !pr)
    second = { status: "skipped", why: "high_risk" };
  else {
    // 対象を読む。入力の誤りは記録せず終了コード1、GitHub の読み失敗は棄権として残す
    let source: TargetSource | null = null;
    try {
      source = await fetchTargetSource(g, pr.url, target);
    } catch (error) {
      if (error instanceof TargetInputError)
        throw new FlowError(1, error.message);
      ctx.stderr(
        "2票目の材料の指摘を GitHub から読めませんでした（棄権として記録します）",
      );
    }
    if (source === null) second = { status: "abstained", why: "failed" };
    else if (source.comments.length === 0) {
      ctx.stderr(
        "2票目の材料にできる他人の文章がありませんでした（棄権として記録します）",
      );
      second = { status: "abstained", why: "failed" };
    } else {
      const doc = await readTaskDoc(ctx.runner, root, config, task).catch(
        () => null,
      );
      const material = buildVoteMaterial(
        { target: source, allowedPaths: doc?.allowed ?? [] },
        ctx.env,
      );
      model = VOTE_MODEL;
      second = await castSecondVote(ctx.runner, material, ctx.env);
    }
  }

  const entry: VoteEntry = {
    at: ctx.now().toISOString(),
    id,
    target,
    kind,
    risk,
    first,
    second,
    model,
    human: null,
  };
  const how = await recordCast(file, entry);
  if (how === "answered") throw answeredError(id);

  // 自動で決めるか。入っていて、2票が一致し、数を今も満たすときだけ（それ以外は人に回す）
  const autoRead = await readAutoState(common);
  if (autoRead.status === "broken")
    ctx.stderr(
      "自動の記録が読めないので、自動で決めません（全部切りとして扱います）",
    );
  let autoKey: VoteKey | null = null;
  if (autoRead.status === "ok") {
    const agreed = second.status === "voted" && second.key === first;
    const on = autoRead.state.kinds[kind]?.on === true;
    const floorMet =
      agreed && on
        ? meetsFloor(computeStats((await readAllVotes(common)).entries)[kind])
        : false;
    const auto = await applyAutoCast(common, {
      id,
      target,
      kind,
      key: first,
      now: entry.at,
      agreed,
      floorMet,
    });
    if (auto) autoKey = first;
  }

  const taken = second.status !== "skipped";
  const note =
    second.status === "skipped"
      ? second.why === "kind"
        ? `判断事項（${kind}）なので、2票目はとりませんでした`
        : `リスク区分が high なので、2票目はとりませんでした（${risk.reason}）`
      : second.status === "abstained"
        ? `2票目をとりましたが棄権でした（${second.why}）`
        : "2票目をとりました（答えは人が答えるまで出しません）";
  if (!ctx.json) {
    ctx.stdout(`${note}（リスク区分：${risk.level}）`);
    ctx.stdout(
      how === "replaced" ? "前の件を置き換えて記録しました" : "記録しました",
    );
    if (autoKey !== null) ctx.stdout(`自動で決めました（${autoKey}）`);
  }
  return {
    code: 0,
    data: {
      id,
      target,
      kind,
      risk,
      taken,
      ...(second.status === "skipped" ? { skipped: second.why } : {}),
      ...(second.status === "abstained" ? { abstained: second.why } : {}),
      recorded: how,
      ...(autoKey !== null ? { auto: autoKey } : {}),
    },
  };
}

async function answer(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), ["target", "human"]);
  const id = oneId(args.positionals);
  const target = requireTarget(args.values.get("target"));
  const human = requireKey(args.values.get("human"), "human");
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);
  const file = votePath(common, id);
  const ok = await recordAnswer(file, target, human);
  // 自動の記録への反映。人の答えは先に記録済みなので、失敗しても流し直せる（自動の側は冪等）
  const reflect = async (key: VoteKey) => {
    let checked;
    try {
      checked = await applyAutoAnswer(common, {
        id,
        target,
        human: key,
        now: ctx.now().toISOString(),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new FlowError(
        1,
        `人の答えは記録しましたが、自動の記録に反映できませんでした：${why}\n直したら同じ vote answer をもう一度流してください（自動で決めた件の確かめと、外れたときの自動の切りが続きます）`,
      );
    }
    if (checked?.missed && !ctx.json)
      ctx.stdout(
        `自動で決めた件が外れたので、${checked.kind} の自動を切りました`,
      );
    return checked;
  };
  if (!ok) {
    const { entries } = await readVoteFile(file);
    const recorded = entries.find(
      (e) => e.target === target && e.human !== null,
    );
    if (recorded?.human) {
      // 答え済みでも、自動の記録に届いていない件があれば人の答えで反映してから断る
      const checked = await reflect(recorded.human);
      if (checked && !ctx.json)
        ctx.stdout("記録済みの人の答えを自動の記録に反映しました");
      throw new FlowError(
        1,
        `${id} のこの対象は答え済みです。cast をやり直さないでください（答えは上書きしません）`,
      );
    }
    throw new FlowError(
      1,
      `${id} に、答えのない合議の件がありません（先に vote cast を流してください）`,
    );
  }
  if (!ctx.json) ctx.stdout("人の答えを記録しました");
  // 自動で決めた件なら、違うキーのときにその種類を切る
  const checked = await reflect(human);
  return {
    code: 0,
    data: {
      id,
      target,
      human,
      ...(checked?.missed ? { autoOff: checked.kind } : {}),
    },
  };
}

const pct = (v: number | null) =>
  v === null ? "—" : `${Math.round(v * 1000) / 10}%`;

function statsLines(kind: string, s: KindStats): string[] {
  return [
    `${kind}：件数 ${s.total}（答え済み ${s.answered}・答え待ち ${s.pending}）`,
    `  1票目と人の一致：${pct(s.firstRate)}（${s.firstAgree}/${s.answered}）`,
    `  2票目をとった件だけの、1票目と人の一致：${pct(s.votedFirstRate)}（${s.votedFirstAgree}/${s.voted}）`,
    `  2票が一致した件のうち、人とも一致：${pct(s.bothAgreeRate)}（${s.bothAgreeHuman}/${s.bothAgree}）`,
    `  割れた ${s.split}・棄権 ${s.abstained}（unclear ${s.unclear}・failed ${s.failed}）・とらなかった ${s.skipped}`,
  ];
}

const OFF_WHY = { human: "人が切った", miss: "外れで切れた" } as const;

function autoSummary(state: AutoState, kind: VoteKind) {
  const k = state.kinds[kind];
  return {
    on: k?.on === true,
    at: k?.at ?? null,
    why: k?.why ?? null,
    ...countAuto(state, kind),
  };
}

function autoStateText(state: AutoState, kind: VoteKind): string {
  const k = state.kinds[kind];
  if (k?.on) return "入";
  return k?.why ? `切（${OFF_WHY[k.why]}）` : "切";
}

function autoLine(state: AutoState, kind: VoteKind): string {
  const c = countAuto(state, kind);
  return `  自動：${autoStateText(state, kind)}（自動で決めた ${c.total}・確かめた ${c.checked}・外れた ${c.missed}）`;
}

async function stats(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), []);
  if (args.positionals.length > 0) throw new FlowError(1, USAGE);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);
  const { entries, broken } = await readAllVotes(common);
  const byKind = computeStats(entries);
  const auto = await currentAutoState(common);
  if (broken > 0)
    ctx.stderr(`読めない行が ${broken} 行ありました（数えていません）`);
  if (!ctx.json) {
    const kinds = Object.keys(byKind);
    if (kinds.length === 0) ctx.stdout("合議の記録はまだありません");
    for (const kind of kinds) {
      for (const line of statsLines(kind, byKind[kind]!)) ctx.stdout(line);
      ctx.stdout(autoLine(auto, kind as VoteKind));
    }
  }
  return {
    code: 0,
    data: {
      kinds: byKind,
      broken,
      auto: Object.fromEntries(
        AUTO_KINDS.map((kind) => [kind, autoSummary(auto, kind)]),
      ),
    },
  };
}

const AUTO_USAGE = "使い方：orca-flow vote auto [on|off <種類>]";

const pctInt = (n: number, d: number) =>
  d === 0 ? "—" : `${Math.round((n / d) * 1000) / 10}%`;

function floorText(kind: VoteKind, s: ReturnType<typeof computeStats>) {
  const k = s[kind];
  const agreed = k?.bothAgree ?? 0;
  const human = k?.bothAgreeHuman ?? 0;
  return `2票が一致して人が答えた件 ${agreed}（${AUTO_MIN_AGREED} 以上）・人とも一致 ${pctInt(human, agreed)}（${human}/${agreed}・${AUTO_MIN_RATE_PERCENT}% 以上）`;
}

async function auto(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), []);
  const [action, kind, ...rest] = args.positionals;
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);

  if (action === undefined) {
    const state = await currentAutoState(common);
    const { entries } = await readAllVotes(common);
    const byKind = computeStats(entries);
    const data: Record<string, unknown> = {};
    const waiting = state.items
      .filter((i) => i.human === null)
      .map((i) => ({
        id: i.id,
        target: i.target,
        kind: i.kind,
        key: i.key,
        at: i.at,
      }));
    for (const k of AUTO_KINDS) {
      const c = countAuto(state, k);
      data[k] = {
        ...autoSummary(state, k),
        agreed: byKind[k]?.bothAgree ?? 0,
        agreedHuman: byKind[k]?.bothAgreeHuman ?? 0,
        meetsFloor: meetsFloor(byKind[k]),
      };
      if (!ctx.json) {
        ctx.stdout(`${k}：${autoStateText(state, k)}`);
        ctx.stdout(`  ${floorText(k, byKind)}`);
        ctx.stdout(
          `  自動で決めた ${c.total}・確かめた ${c.checked}・外れた ${c.missed}・確かめ待ち ${c.pending}（${AUTO_MAX_PENDING} 件以上で自動で決めません）`,
        );
        for (const w of waiting.filter((i) => i.kind === k))
          ctx.stdout(`  確かめ待ち：${w.id} ${w.target} ${w.key} ${w.at}`);
      }
    }
    return { code: 0, data: { kinds: data, waiting } };
  }

  if (
    (action !== "on" && action !== "off") ||
    kind === undefined ||
    rest.length > 0
  )
    throw new FlowError(1, AUTO_USAGE);
  if (!isVoteKind(kind))
    throw new FlowError(
      1,
      `種類は ${VOTE_KINDS.join("・")} のどれかにしてください：${escapeId(kind)}`,
    );

  if (action === "off") {
    const changed = await disableKind(
      common,
      kind,
      ctx.now().toISOString(),
      "human",
    );
    if (!ctx.json)
      ctx.stdout(
        changed
          ? `${kind} の自動を切りました`
          : `${kind} の自動は切ったままです`,
      );
    return { code: 0, data: { kind, on: false } };
  }

  if (!isAutoKind(kind))
    throw new FlowError(
      1,
      `${kind} は自動で決められません（入れられる種類：${AUTO_KINDS.join("・")}。判断事項は2票目をとらないため）`,
    );
  if (!(await isMainWorktree(ctx.runner, root)))
    throw new FlowError(
      2,
      "vote auto on はメインのチェックアウト（統括役のタブ）だけで流せます。タスクの worktree では流せません",
    );
  const { entries } = await readAllVotes(common);
  const byKind = computeStats(entries);
  if (!meetsFloor(byKind[kind]))
    throw new FlowError(
      1,
      `${kind} は数が足りないので入れません（${floorText(kind, byKind)}）`,
    );
  await enableKind(common, kind, ctx.now().toISOString());
  if (!ctx.json) ctx.stdout(`${kind} の自動を入れました`);
  return { code: 0, data: { kind, on: true } };
}

export const run: Command = async (ctx) => {
  const sub = ctx.argv[0];
  if (sub === "cast") return cast(ctx);
  if (sub === "answer") return answer(ctx);
  if (sub === "stats") return stats(ctx);
  if (sub === "auto") return auto(ctx);
  throw new FlowError(1, USAGE);
};
