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
  withdrawItem,
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
const TELL_MERGE_VERIFY =
  "main を取り込んで orca-flow verify をやり直し、integrate-wait に戻す";

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
      return alreadyPushed(ctx, deps, config, root, id, task, open, head);

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
        "取り込みと verify のやり直しの知らせ",
        TELL_MERGE_VERIFY,
        `タスクのブランチが ${config.baseBranch} の先頭を含んでいません。git merge ${config.baseBranch} をして orca-flow verify をやり直し、status integrate-wait に戻してください。`,
      );
      throw new FlowError(
        2,
        `${id} のブランチが ${config.baseBranch} の先頭を含んでいないので、push しませんでした。${sent ? `タスク長に「main を取り込んで verify をやり直し、integrate-wait に戻して」と送りました。` : "タスク長には送れていません（上の警告）。"}`,
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
          TELL_MERGE_VERIFY,
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
      // 履歴を書き換えたあと（手で rebase したときなど。記録の先頭が今の先頭の祖先でない）は、記録の先頭を期待値として案に入れる。
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
    // 開いた PR が下書きのときだけ、下書きを外す案を一緒に積む（CI は待たない）。
    // 積まないときは、前に積んだままの pr-ready を取り下げる（古い先頭で束に残り send を止めないため）
    if (open?.isDraft) await stack("pr-ready", none);
    else
      withdrawn.push(...(await withdrawQueuedPrReady(common, id, ctx.now())));

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
  config: FlowConfig,
  root: string,
  id: string,
  task: { branch: string; path: string },
  pr: PrInfo,
  head: string,
): Promise<CommandResult> {
  const automation = await automationState(ctx, deps, root);
  const common = await gitCommonDir(ctx.runner, root);
  const base = {
    id,
    branch: task.branch,
    pr: { number: pr.number, url: pr.url },
    created: false,
    forced: false,
    pushedHead: head,
    automation,
  };
  const printAutomation = () => {
    const note = automationNote(automation);
    if (note) ctx.stdout(note);
  };
  // 下書きでなければ、積みっぱなしの pr-ready だけ取り下げて、何も積まない
  if (!pr.isDraft) {
    const old = await withdrawQueuedPrReady(common, id, ctx.now());
    if (!ctx.json) {
      ctx.stdout(
        `${id} は push 済みで、先頭は変わっていません（PR #${pr.number} ${pr.url}）`,
      );
      for (const o of old) ctx.stdout(`前の案を取り下げました：${o.id}\n`);
      printAutomation();
    }
    return {
      code: 0,
      data: { ...base, withdrawn: old.map((i) => i.id) },
    };
  }

  // 下書きのままの PR：push と PR の作成は積み直さず、下書きを外す案だけを積む
  const addContext: AddContext = {
    taskId: id,
    branch: task.branch,
    defaultTitle: async () => id,
    bodyProblems: () => [],
    expectedRemoteHead: async () => null,
  };
  const added = await stackItem(
    common,
    "pr-ready",
    { body: "", pr: pr.number, afterCi: false, title: null },
    addContext,
    {
      head,
      target: {
        remote: REMOTE,
        branch: task.branch,
        base: config.baseBranch,
      },
    },
    ctx.env,
    ctx.now(),
  );
  const set = buildShowSet(
    await readItems(common, id),
    config.outbound.interval.perBatch,
    head,
  );
  try {
    await createOrca(ctx.runner, root).setCard(
      task.path,
      cardForPushWatch("send-wait", null, { detail: added.item.id }),
    );
  } catch (error) {
    ctx.stderr(
      `警告：${id} のカードを更新できませんでした（${redactSecrets(message(error), envSecrets(ctx.env))}）`,
    );
  }
  if (!ctx.json) {
    ctx.stdout(
      `${id} は push 済みで、先頭は変わっていませんが、PR #${pr.number} は下書きのままです。下書きを外す案だけを積みました。GitHub にはまだ書いていません。よければ /orca-flow:send で送ってください\n`,
    );
    for (const o of added.withdrawn)
      ctx.stdout(`前の案を取り下げました：${o.id}\n`);
    for (const chunk of renderShow(id, set, config)) ctx.stdout(chunk);
    printAutomation();
  }
  return {
    code: 0,
    data: {
      ...base,
      stacked: [added.item.id],
      withdrawn: added.withdrawn.map((i) => i.id),
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
    },
  };
}

/** 積んだままの pr-ready（束に残ると古い先頭で send を止める）を取り下げる */
async function withdrawQueuedPrReady(
  common: string,
  id: string,
  now: Date,
): Promise<OutboxItem[]> {
  const out: OutboxItem[] = [];
  for (const item of await readItems(common, id))
    if (item.kind === "pr-ready" && item.state === "queued")
      out.push(await withdrawItem(common, id, item.id, now));
  return out;
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
