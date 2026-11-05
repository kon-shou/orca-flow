import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireIdShape } from "../lib/auto.ts";
import { findPr, type GhContext } from "../lib/github.ts";
import { gitCommonDir, requireActiveTask, requireRoot } from "../lib/git.ts";
import {
  fetchTargetSource,
  TargetInputError,
  type TargetSource,
} from "../lib/respond-input.ts";
import { classifyRisk } from "../lib/risk.ts";
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
  recordAnswer,
  recordCast,
  votePath,
  type KindStats,
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
  const config = await requireConfig(root);
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
  const ok = await recordAnswer(votePath(common, id), target, human);
  if (!ok) {
    if (await hasAnsweredEntry(votePath(common, id), target))
      throw new FlowError(
        1,
        `${id} のこの対象は答え済みです。cast をやり直さないでください（答えは上書きしません）`,
      );
    throw new FlowError(
      1,
      `${id} に、答えのない合議の件がありません（先に vote cast を流してください）`,
    );
  }
  if (!ctx.json) ctx.stdout("人の答えを記録しました");
  return { code: 0, data: { id, target, human } };
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

async function stats(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), []);
  if (args.positionals.length > 0) throw new FlowError(1, USAGE);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);
  const { entries, broken } = await readAllVotes(common);
  const byKind = computeStats(entries);
  if (broken > 0)
    ctx.stderr(`読めない行が ${broken} 行ありました（数えていません）`);
  if (!ctx.json) {
    const kinds = Object.keys(byKind);
    if (kinds.length === 0) ctx.stdout("合議の記録はまだありません");
    for (const kind of kinds)
      for (const line of statsLines(kind, byKind[kind]!)) ctx.stdout(line);
  }
  return { code: 0, data: { kinds: byKind, broken } };
}

export const run: Command = async (ctx) => {
  const sub = ctx.argv[0];
  if (sub === "cast") return cast(ctx);
  if (sub === "answer") return answer(ctx);
  if (sub === "stats") return stats(ctx);
  throw new FlowError(1, USAGE);
};
