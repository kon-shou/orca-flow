import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  requireConfig,
  type FlowConfig,
  type OutboundKind,
} from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  pushTaskBranchWithMark,
  readBranchPushMarkAt,
} from "../lib/branch-push.ts";
import { requireIdShape } from "../lib/auto.ts";
import { checkDecisionsAppendOnly } from "../lib/decisions.ts";
import {
  checkTaskBeforeIntegration,
  copyIgnoredRecords,
  describeMainBusy,
  findPushTask,
  readPushRecord,
  tellLead,
} from "../lib/finish.ts";
import {
  REMOTE,
  envSecrets,
  findPr,
  redactSecrets,
  requireGh,
  type GhContext,
  type PrInfo,
} from "../lib/github.ts";
import {
  gitCommonDir,
  requireIntegratorPlace,
  requireRoot,
  mainWorktreePath,
  runGit,
} from "../lib/git.ts";
import { cardForPushWatch, createOrca } from "../lib/orca.ts";
import {
  KIND_TABLE,
  bodyProblemsOf,
  buildShowSet,
  decideExpectedRemoteHead,
  readItems,
  renderShow,
  stackItem,
  type AddContext,
  type AddRequest,
  type OutboxItem,
} from "../lib/outbox.ts";
import {
  cleanupHolderLabel,
  cleanupMergedPr,
  showPushWatch,
} from "../lib/pr-finish.ts";
import {
  findWatchAutomation,
  type WatchAutomationLookup,
} from "../lib/watch-automation.ts";
import {
  allInSkipPaths,
  commandsFor,
  readRecord,
  recordMismatch,
} from "../lib/verified.ts";
import {
  FlowError,
  type Command,
  type CommandContext,
  type CommandResult,
} from "../types.ts";

/**
 * 見張り（src/lib/pr-finish.ts と automation）を呼ぶ口。
 * 既定は本物の関数。テストでは偽物を渡す
 */
export interface PushWatchDeps {
  /** `--show`：今の様子を出す */
  show: (ctx: CommandContext, id: string) => Promise<CommandResult>;
  /** 見張りの automation を探す（ある・ない・分からない） */
  findAutomation: (
    runner: CommandContext["runner"],
    root: string,
  ) => Promise<WatchAutomationLookup>;
}

const defaultDeps: PushWatchDeps = {
  show: showPushWatch,
  findAutomation: findWatchAutomation,
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const USAGE =
  "使い方：orca-flow push 〈ID〉 [--body-file 〈パス〉] [--show] | orca-flow push 〈ID〉 --branch";
const TELL_REBASE_VERIFY =
  "rebase して orca-flow verify をやり直し、integrate-wait に戻す";

/** 設計書の見出し「# タスク 〈ID〉：〈タスク名〉」からタスク名を読む。なければ null */
export function taskTitleOf(docText: string, id: string): string | null {
  const heading = /^#\s+タスク\s+(\S+?)\s*[：:]\s*(.+?)\s*$/m.exec(docText);
  if (!heading || heading[1] !== id) return null;
  return heading[2] ?? null;
}

export function createPush(overrides: Partial<PushWatchDeps> = {}): Command {
  const deps: PushWatchDeps = { ...defaultDeps, ...overrides };
  return async (ctx) => {
    const args = parseArgs(
      ctx.argv,
      ["body-file"],
      ["show", "watch", "branch"],
    );
    const [id, ...rest] = args.positionals;
    if (!id || rest.length > 0) throw new FlowError(1, USAGE);
    requireIdShape(id);

    // 背景の待ち受けは見張りに置き換わった
    if (args.flags.has("watch"))
      throw new FlowError(
        1,
        "push --watch は見張りに置き換わりました。見張りは Orca の automation が定時に動かします。automation がなければ orca-flow pr-watch install で作ってください",
      );
    if (args.flags.has("show")) return deps.show(ctx, id);

    // 共通のタスクの枝だけを承認なしで push する道（印があるときだけ。PR・案・返信は作らない）。
    // タスクの worktree と統括役の場所のどちらからも流せる
    if (args.flags.has("branch")) {
      if (args.values.has("body-file"))
        throw new FlowError(1, "--branch には --body-file を付けられません");
      const root = await requireRoot(ctx.runner, ctx.cwd);
      const config = await requireConfig(root);
      // 手元の push の記録があれば PR の道に入っている。この道では送らない（承認なしで動かさない）
      if ((await readPushRecord(ctx.runner, root, id)) !== null)
        throw new FlowError(
          2,
          `${id} は PR の道（push の記録があります）に入っているので、--branch では送りません。PR の道（/orca-flow:push）で送ってください`,
        );
      const out = await pushTaskBranchWithMark(ctx, config, root, id);
      if (!ctx.json)
        ctx.stdout(
          `${id} の枝 ${out.branch} を ${REMOTE} へ push しました（先頭 ${out.head.slice(0, 12)}${out.leased ? "、前の先頭を期待値にしました" : ""}）。PR と案は作っていません`,
        );
      return { code: 0, data: { ...out, pushed: true, pr: null } };
    }

    // ① 統括役の場所の確認
    const root = await requireRoot(ctx.runner, ctx.cwd);
    const config = await requireConfig(root);
    await requireIntegratorPlace(ctx.runner, root, config);
    const pushed = await readPushRecord(ctx.runner, root, id);
    // 後始末の取り込みで baseBranch に入ったあとのタスクも、worktree が残っていれば探せる
    const task = await findPushTask(ctx.runner, root, config, id, pushed);
    const g: GhContext = { runner: ctx.runner, cwd: root, env: ctx.env };

    // PR の今を読む。マージ済みなら、確かめも push もせず後始末をやり直す
    // （手元の main が進んでいても、タスクのブランチが先頭を含まなくても届くように、確かめより前に置く）
    await requireGh(g);
    const pr = await findPr(g, task.branch);
    if (pr && pr.state === "merged")
      return finishAgain(ctx, config, root, task, pr);

    const rev = async (ref: string) =>
      (
        await runGit(ctx.runner, root, ["rev-parse", ref], "git rev-parse")
      ).trim();
    const head = await rev(task.branch);
    const open = pr && pr.state === "open" ? pr : null;

    // PR が開いていて、先頭が push した先頭とも GitHub の先頭とも同じ：待ち受けを起こすだけ
    if (
      open &&
      pushed?.pushedHead === head &&
      open.headSha === head &&
      pushed.pr?.number === open.number
    )
      return alreadyPushed(ctx, deps, root, id, task.branch, open, head);

    // ②③ integrate と同じ確かめ
    const result = await checkTaskBeforeIntegration(
      ctx,
      config,
      root,
      id,
      task,
      { skipDecision: false, skipOrder: false, verb: "push" },
    );
    if (result.kind === "outside")
      return { code: 1, data: { id, outside: result.outside } };
    const { files } = result.checked;
    const base = await rev(config.baseBranch);

    // タスクのブランチが baseBranch の先頭を含むこと
    const included = await ctx.runner(
      "git",
      ["merge-base", "--is-ancestor", base, head],
      { cwd: root },
    );
    if (included.code !== 0) {
      const sent = await tellLead(
        ctx,
        config,
        createOrca(ctx.runner, root),
        id,
        task.path,
        "rebase と verify のやり直しの知らせ",
        TELL_REBASE_VERIFY,
        `タスクのブランチが ${config.baseBranch} の先頭を含んでいません。git rebase ${config.baseBranch} をして orca-flow verify をやり直し、status integrate-wait に戻してください。`,
      );
      throw new FlowError(
        2,
        `${id} のブランチが ${config.baseBranch} の先頭を含んでいないので、push しませんでした。${sent ? `タスク長に「rebase して verify をやり直し、integrate-wait に戻して」と送りました。` : "タスク長には送れていません（上の警告）。"}`,
      );
    }

    // 決定の記録が追記だけか（先頭を含むことを確かめたあと。integrate と同じ確かめ）
    await checkDecisionsAppendOnly(ctx.runner, config, root, {
      id,
      against: task.branch,
      caller: "push",
    });

    // テストの記録（差分が verifySkipPaths だけのときは要らない）
    if (!allInSkipPaths(files, config.verifySkipPaths)) {
      const commands = commandsFor(config, files);
      const reason = recordMismatch(await readRecord(ctx.runner, root, id), {
        head,
        base,
        commands,
      });
      if (reason !== null) {
        await tellLead(
          ctx,
          config,
          createOrca(ctx.runner, root),
          id,
          task.path,
          "verify のやり直しの知らせ",
          TELL_REBASE_VERIFY,
          `${reason}。orca-flow verify をやり直して、status integrate-wait に戻してください。`,
        );
        throw new FlowError(
          2,
          `${id} の verify の記録が使えないので、push しませんでした（${reason}）。タスクのコンソールで orca-flow verify を流し直してもらってください`,
        );
      }
    }

    // PR がまだなければ本文が要る。読むだけで、パスと秘密の確かめは pr-create の案を積む所（outbox.ts）が行う
    const bodyFile = args.values.get("body-file");
    let body: string | null = null;
    if (!open) {
      if (!bodyFile)
        throw new FlowError(
          1,
          `${id} はまだ PR がないので、本文が要ります。--body-file 〈パス〉 で本文のファイルを渡してください`,
        );
      try {
        body = await readFile(path.resolve(ctx.cwd, bodyFile), "utf8");
      } catch (error) {
        throw new FlowError(
          1,
          `--body-file ${bodyFile} を読めませんでした（${message(error)}）`,
        );
      }
    }

    const common = await gitCommonDir(ctx.runner, root);
    // --branch で送った先頭（印は手元だけ。記録も開いた PR もないときの期待値の候補）
    const branchMark = await readBranchPushMarkAt(common, id);
    const addContext: AddContext = {
      taskId: id,
      branch: task.branch,
      defaultTitle: async () =>
        `${id}: ${taskTitleOf(result.checked.docText, id) ?? task.branch.replace(/^.*?\//, "")}`,
      bodyProblems: (text) =>
        bodyProblemsOf(text, { env: ctx.env, config, root, task }),
      // rebase のあと（記録の先頭が今の先頭の祖先でない）は、記録の先頭を期待値として案に入れる。
      // 記録がなければ開いている PR の先頭
      expectedRemoteHead: () =>
        decideExpectedRemoteHead(
          ctx.runner,
          root,
          pushed?.pushedHead ?? open?.headSha ?? branchMark?.pushedHead,
          head,
        ),
    };
    const where = {
      head,
      target: { remote: REMOTE, branch: task.branch, base: config.baseBranch },
    };

    // 本文の確かめに落ちたら、何も写さず何も積まない（先に PR の作成の入力を確かめる）
    if (body !== null)
      await KIND_TABLE["pr-create"].prepareAdd(
        { body, pr: null, afterCi: false, title: null },
        addContext,
      );

    // 無視された設計書と報告を、積む前にメインの作業ツリーへ写す
    const copied = await copyIgnoredRecords(
      root,
      result.checked,
      "案は積んでいません",
    );

    // 案を積む（GitHub にも origin にも書かない）。送るのは人が承認した send だけ
    const stacked: OutboxItem[] = [];
    const withdrawn: OutboxItem[] = [];
    const stack = async (kind: OutboundKind, req: AddRequest) => {
      const added = await stackItem(
        common,
        kind,
        req,
        addContext,
        where,
        ctx.env,
        ctx.now(),
      );
      stacked.push(added.item);
      withdrawn.push(...added.withdrawn);
    };
    const none = {
      body: "",
      pr: open?.number ?? null,
      afterCi: false,
      title: null,
    };
    await stack("push", none);
    if (body !== null)
      await stack("pr-create", { body, pr: null, afterCi: false, title: null });
    if (config.prReady === "after-ci" && (!open || open.isDraft))
      await stack("pr-ready", { ...none, afterCi: true });

    const set = buildShowSet(
      await readItems(common, id),
      config.outbound.interval.perBatch,
      head,
    );
    // カードを「送る前の確認待ち：〈案の種類と版〉」（未読）にする。Orca が落ちても積んだ案は残る
    try {
      await createOrca(ctx.runner, root).setCard(
        task.path,
        cardForPushWatch("send-wait", null, {
          detail: stacked.map((i) => i.id).join("、"),
        }),
      );
    } catch (error) {
      ctx.stderr(
        `警告：${id} のカードを更新できませんでした（${redactSecrets(message(error), envSecrets(ctx.env))}）`,
      );
    }

    const automation = await automationState(ctx, deps, root);
    const expectedRemoteHead =
      stacked.find((i) => i.kind === "push")?.target.expectedRemoteHead ?? null;
    if (!ctx.json) {
      ctx.stdout(
        `${id} の案を積みました。GitHub にも origin にもまだ書いていません。下の本文と先頭を確かめて、よければ /orca-flow:send で送ってください（送るのは send だけです）\n`,
      );
      for (const old of withdrawn)
        ctx.stdout(`前の案を取り下げました：${old.id}\n`);
      for (const chunk of renderShow(id, set, config)) ctx.stdout(chunk);
      const note = automationNote(automation);
      if (note) ctx.stdout(`${note}\n`);
    }
    return {
      code: 0,
      data: {
        id,
        branch: task.branch,
        pushed: false,
        stacked: stacked.map((i) => i.id),
        withdrawn: withdrawn.map((i) => i.id),
        items: set.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          version: i.version,
          fingerprint: i.fingerprint,
          head: i.head,
          target: i.target,
          body: i.body,
        })),
        bundleFingerprint: set.bundleFingerprint,
        head,
        expectedRemoteHead,
        recordsCopied: copied,
        automation,
      },
    };
  };
}

/** 見張りの automation がないとき出す案内 */
const NO_AUTOMATION =
  "見張りの automation がありません。PR の動き（CI・レビュー・マージ）は見張られません。orca-flow pr-watch install で作ってください";

/** automation の有無を調べられなかったとき出す案内 */
const UNKNOWN_AUTOMATION =
  "見張りの automation があるか確かめられません。Orca を起動してから orca-flow pr-watch install を打ってください（あれば今の中身に直すだけです）";

/** automation の有無に応じた案内。あれば null */
function automationNote(state: WatchAutomationLookup["state"]): string | null {
  if (state === "missing") return NO_AUTOMATION;
  if (state === "unknown") return UNKNOWN_AUTOMATION;
  return null;
}

/** automation の有無を調べる。調べられなければ unknown */
async function automationState(
  ctx: CommandContext,
  deps: PushWatchDeps,
  root: string,
): Promise<WatchAutomationLookup["state"]> {
  try {
    // install・uninstall と同じ場所で探す（Windows の C:/… と C:\… で別の名前にならないように）
    const main = await mainWorktreePath(ctx.runner, root);
    return (await deps.findAutomation(ctx.runner, main)).state;
  } catch {
    return "unknown";
  }
}

/** 先頭が変わっていない 2 回目の push：確かめも push もせず、見張りの automation の有無だけ案内する */
async function alreadyPushed(
  ctx: CommandContext,
  deps: PushWatchDeps,
  root: string,
  id: string,
  branch: string,
  pr: PrInfo,
  head: string,
): Promise<CommandResult> {
  const automation = await automationState(ctx, deps, root);
  if (!ctx.json) {
    ctx.stdout(
      `${id} は push 済みで、先頭は変わっていません（PR #${pr.number} ${pr.url}）`,
    );
    const note = automationNote(automation);
    if (note) ctx.stdout(note);
  }
  return {
    code: 0,
    data: {
      id,
      branch,
      pr: { number: pr.number, url: pr.url },
      created: false,
      forced: false,
      pushedHead: head,
      automation,
    },
  };
}

/** マージ済みの PR があるときの 2 回目の push：後始末をやり直す（待ち受けと同じ関数を通る） */
async function finishAgain(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  task: { id: string; branch: string; path: string },
  pr: PrInfo,
): Promise<CommandResult> {
  const out = await cleanupMergedPr(ctx, root, config, task, pr, {
    holdingWatchLock: false,
    lockKind: "push",
  });
  if (out.kind === "watching") {
    if (!ctx.json)
      ctx.stdout(
        `${task.id} の PR #${pr.number} はマージ済みで、${cleanupHolderLabel(out.holderKind)}（プロセス ${out.pid ?? "不明"}）。終わるまで待ってください。様子は orca-flow push ${task.id} --show で見られます`,
      );
    return {
      code: 0,
      data: { id: task.id, pr: pr.number, cleanup: "running", pid: out.pid },
    };
  }
  if (out.kind === "busy")
    throw new FlowError(
      2,
      `${task.id} の PR #${pr.number} はマージ済みです。${await describeMainBusy(ctx, root)}`,
    );
  return out.result;
}

export const run: Command = createPush();
