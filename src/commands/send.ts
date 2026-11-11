import { requireFlowConfig } from "../lib/flow-config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireIdShape } from "../lib/auto.ts";
import { readPushRecord, writePushRecord } from "../lib/finish.ts";
import {
  REMOTE,
  envSecrets,
  findPr,
  redactSecrets,
  requireGh,
  type GhContext,
} from "../lib/github.ts";
import {
  gitCommonDir,
  requireActiveTask,
  requireIntegratorPlace,
  requireRoot,
} from "../lib/git.ts";
import {
  cardForPushWatch,
  createOrca,
  describeSendBlock,
} from "../lib/orca.ts";
import { CARD_RESET } from "../lib/pr-finish.ts";
import {
  KIND_TABLE,
  STATE_LABEL,
  branchHead,
  buildSenders,
  isUnsettled,
  readItems,
  selectBundle,
  type OutboxItem,
  type OutboxState,
} from "../lib/outbox.ts";
import {
  checkSendEntry,
  realClock,
  sendItems,
  type Clock,
  type SendOutcome,
} from "../lib/send-guard.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";
import type { FlowConfig } from "../config.ts";

const USAGE =
  "使い方：orca-flow send 〈ID〉 --expect 〈束の指紋〉 --head 〈先頭〉（値は orca-flow outbox show の出力から）";

export interface SendDeps {
  /** 書き込みの間の待ちに使う時計。テストでは偽物を渡す */
  clock?: Clock;
}

/**
 * `orca-flow send`：人が見た束の指紋と先頭を引数に入れたときだけ、積んだ案を送る。
 * 送りの案を GitHub に書くのはここだけ（送る関数は send-guard の sendItems を通ったときにだけ呼ばれる）。
 * マージ（merge）・保留中のレビュー（respond draft）・印のある枝の push（push --branch）は別の道（7章7番）
 */
export function createSend(deps: SendDeps = {}): Command {
  const clock = deps.clock ?? realClock;
  return async (ctx) => {
    const args = parseArgs(ctx.argv, ["expect", "head"]);
    const [id, ...rest] = args.positionals;
    const expect = args.values.get("expect");
    const head = args.values.get("head");
    if (!id || rest.length > 0 || !expect || !head)
      throw new FlowError(1, USAGE);
    requireIdShape(id);

    // 統括役の場所の確認（メインのチェックアウトの外では終了コード2）
    const config = await requireFlowConfig(
      ctx.runner,
      await requireRoot(ctx.runner, ctx.cwd),
    );
    const root = await requireIntegratorPlace(ctx.runner, ctx.cwd, config);
    const task = await requireActiveTask(ctx.runner, root, config, id);
    const common = await gitCommonDir(ctx.runner, root);

    // GitHub を呼ぶ前の確かめ。照らしは置き場から読み直した案と、ブランチの今の先頭で行う
    const currentHead = await branchHead(ctx.runner, root, task.branch);
    const items = await readItems(common, id);
    const selected = checkSendEntry({
      config,
      items,
      expect,
      head,
      currentHead,
      expectedTarget: {
        remote: REMOTE,
        branch: task.branch,
        base: config.baseBranch,
      },
    });

    const g: GhContext = { runner: ctx.runner, cwd: root, env: ctx.env };
    await requireGh(g);

    // 送る関数は種類の表（outbox.ts の KIND_TABLE）にある
    const created: { pr: { number: number; url: string } | null } = {
      pr: null,
    };
    const senders = buildSenders({ g, task, config, root, created });

    const outcome = await sendItems(
      {
        common,
        outbound: config.outbound,
        env: ctx.env,
        senders,
        clock,
      },
      selected,
    );

    // 送ったあと：記録・PR とカードの結び付け（後の案が落ちても、送った分は記録する）
    const after = await afterSend(ctx, {
      root,
      common,
      config,
      task,
      g,
      selected,
      outcome,
      createdPr: created.pr,
    });

    const label = (itemId: string) => {
      const item = selected.find((i) => i.id === itemId);
      return item ? `${itemId}（${KIND_TABLE[item.kind].label}）` : itemId;
    };
    if (!ctx.json) {
      for (const done of outcome.sent) ctx.stdout(`送りました：${label(done)}`);
    }
    if (outcome.failed) {
      const f = outcome.failed;
      const left =
        outcome.remaining.length > 0
          ? `残り（${outcome.remaining.join("、")}）は送っていません。`
          : "";
      const hint =
        f.state === "uncertain"
          ? "送れたか分からないので、GitHub を確かめてください。自動では送り直しません。"
          : "";
      ctx.stderr(
        redactSecrets(
          `${f.reason}（${STATE_LABEL[f.state]}）。${left}${hint}`,
          envSecrets(ctx.env),
        ),
      );
      return { code: 1, data: { id, ...outcome, pr: after.pr } };
    }
    if (!ctx.json && items.some(isUnsettled))
      ctx.stdout(
        "送ったか確かでない案（確かでない・送っている）があります。自動では送りません。GitHub を確かめてから orca-flow outbox withdraw で取り下げてください（積み直しても前の案は残ります）",
      );
    // 範囲（perBatch 件）の外で、積んだままの案。うまく終わったときに伝える
    const leftover = selectBundle(
      items,
      config.outbound.interval.perBatch,
    ).rest.map((i) => i.id);
    if (!ctx.json && leftover.length > 0)
      ctx.stdout(
        `範囲の外で積んだままの案（今回は送っていません。もう一度 orca-flow outbox show から）：${leftover.join("、")}`,
      );
    const closing = await closeLeadTerminal(ctx, {
      root,
      common,
      config,
      task,
    });
    return {
      code: 0,
      data: {
        id,
        ...outcome,
        rest: leftover,
        pr: after.pr,
        closed: closing.closed,
      },
    };
  };
}

interface TaskRef {
  id: string;
  branch: string;
  path: string;
}

interface AfterSend {
  /** 結んだ PR（なければ null） */
  pr: { number: number; url: string } | null;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * 送り終えたあとの処理（落ちたときも、送った分について行う）。
 * push を送れば記録に先頭を、PR を作れば番号を書く。PR があればカードと結び、カードを CI 待ちにする（そのあとは見張りが動かす）。
 * Orca・記録の失敗は警告だけで、send の結果は変えない
 */
async function afterSend(
  ctx: CommandContext,
  input: {
    root: string;
    common: string;
    config: FlowConfig;
    task: TaskRef;
    g: GhContext;
    selected: readonly OutboxItem[];
    outcome: SendOutcome;
    /** pr-create を送る関数が作った PR（作らなかったら null） */
    createdPr: { number: number; url: string } | null;
  },
): Promise<AfterSend> {
  const { root, config, task, g, selected, outcome } = input;
  const result: AfterSend = { pr: null };
  const done = selected.filter((i) => outcome.sent.includes(i.id));
  if (done.length === 0) return result;
  const warn = (what: string, error: unknown) =>
    ctx.stderr(
      `警告：${what}（${redactSecrets(message(error), envSecrets(ctx.env))}）`,
    );
  const sent = (kind: OutboxItem["kind"]) =>
    selected.find((i) => i.kind === kind && outcome.sent.includes(i.id));

  // 記録：push を送ったら送った先頭を（承認した SHA は案の先頭）
  let record = await readPushRecord(ctx.runner, root, task.id).catch(
    () => null,
  );
  try {
    const pushed = sent("push");
    if (pushed) {
      record = await writePushRecord(ctx.runner, root, task.id, {
        id: task.id,
        branch: task.branch,
        base: config.baseBranch,
        pushedHead: pushed.head,
        pushedAt: ctx.now().toISOString(),
      });
    }
  } catch (error) {
    warn("push の記録を書けませんでした", error);
  }

  // PR：作ったなら、送る関数が作った番号を使う（探し直さない）。作らなかったら記録の番号、それもなければ開いている PR を探す
  const createdItem = sent("pr-create");
  const created = createdItem !== undefined;
  let pr = created ? input.createdPr : (record?.pr ?? null);
  if (pr !== null && created && !record) {
    // 記録がまだなければ、読める形（先頭つき）で書く。先頭は PR の作成の案の先頭（承認した SHA）
    try {
      record = await writePushRecord(ctx.runner, root, task.id, {
        id: task.id,
        branch: task.branch,
        base: config.baseBranch,
        pushedHead: createdItem.head,
        pushedAt: ctx.now().toISOString(),
      });
    } catch (error) {
      warn("push の記録を書けませんでした", error);
    }
  }
  if (pr === null) {
    try {
      const found = await findPr(g, task.branch);
      if (found && found.state === "open") {
        pr = { number: found.number, url: found.url };
        if (!record)
          record = await writePushRecord(ctx.runner, root, task.id, {
            id: task.id,
            branch: task.branch,
            base: config.baseBranch,
            pushedHead: found.headSha ?? selected[0]!.head,
            pushedAt: ctx.now().toISOString(),
          });
      } else if (created) {
        warn(
          "PR を作りましたが、番号を記録からも GitHub の一覧からも見つけられませんでした",
          "PR なし",
        );
      }
    } catch (error) {
      warn("PR を探せませんでした", error);
    }
  }
  if (pr === null) return result;
  result.pr = pr;
  try {
    await writePushRecord(ctx.runner, root, task.id, { id: task.id, pr });
  } catch (error) {
    warn("PR の番号を記録に書けませんでした", error);
  }

  // Orca：PR とカードを結び、カードを CI 待ちにする
  const orca = createOrca(ctx.runner, root);
  try {
    await orca.linkPr(task.path, pr.number);
  } catch (error) {
    warn(`${task.id} のカードを PR #${pr.number} と結べませんでした`, error);
  }
  try {
    await orca.setCard(task.path, cardForPushWatch("ci-wait", pr.number));
    // 見張りにカードの書き直しを頼む印（見張りが次の回に「CI 待ち」から書き直す）
    await writePushRecord(ctx.runner, root, task.id, {
      id: task.id,
      watch: {
        status: "ci-wait",
        detail: null,
        reason: CARD_RESET,
        ci: null,
        draft: null,
        updatedAt: ctx.now().toISOString(),
      },
    });
  } catch (error) {
    warn(`${task.id} のカードを更新できませんでした`, error);
  }

  return result;
}

/** 積んだまま、人の手が要る案（承認済み・CI 待ち・送った・取り下げた は数えない） */
const HANDS_ON: readonly OutboxState[] = [
  "queued",
  "sending",
  "uncertain",
  "skipped",
];

/**
 * send が落ちずに終えたあと、手が空いていればタスク長のターミナルだけを閉じる。
 * 閉じる条件：積んだまま・送っている・確かでない・送らなかった の案がなく、タスク長のターミナルが1つに決まり、入力欄が空。
 * 満たさなければ閉じず、理由と案内を出す（worktree とカードは残す）
 */
async function closeLeadTerminal(
  ctx: CommandContext,
  input: {
    root: string;
    common: string;
    config: FlowConfig;
    task: TaskRef;
  },
): Promise<{ closed: string | null; reason: string | null }> {
  const { config, task } = input;
  const say = (text: string) => {
    if (!ctx.json) ctx.stdout(text);
  };
  const keep = (reason: string, guide: string) => {
    say(`${task.id} のタスク長の会話は閉じませんでした：${reason}。${guide}`);
    return { closed: null, reason };
  };
  const left = (await readItems(input.common, task.id)).filter((i) =>
    HANDS_ON.includes(i.state),
  );
  if (left.length > 0)
    return keep(
      `人の手が要る案が残っています（${left.map((i) => `${i.id}：${STATE_LABEL[i.state]}`).join("、")}）`,
      "片づいたあと、会話を閉じるなら Orca で閉じてください",
    );
  const orca = createOrca(ctx.runner, input.root);
  let found;
  try {
    found = await orca.findSendTarget(task.path, config.lead.agent);
  } catch (error) {
    return keep(
      `ターミナルを確かめられませんでした（${redactSecrets(message(error), envSecrets(ctx.env))}）`,
      "会話を閉じるなら Orca で閉じてください",
    );
  }
  if (found.kind !== "found")
    return keep(
      describeSendBlock(found, config.lead.agent),
      found.kind === "none"
        ? "閉じる会話はありません"
        : "手が空いたら、会話を閉じるなら Orca で閉じてください",
    );
  try {
    await orca.closeTerminal(found.terminal.handle);
  } catch (error) {
    const text = redactSecrets(message(error), envSecrets(ctx.env));
    ctx.stderr(
      `警告：${task.id} のタスク長のターミナルを閉じられませんでした（${text}）。Orca で閉じてください`,
    );
    return { closed: null, reason: text };
  }
  say(
    `${task.id} のタスク長の会話（${found.terminal.handle}）を閉じました。worktree とカードは残してあります。戻るときは、その worktree のターミナルで claude --resume を打ってください（起動のときの権限の形は引き継がれません）`,
  );
  return { closed: found.terminal.handle, reason: null };
}

export const run: Command = createSend();
