import { requireFlowConfig } from "../lib/flow-config.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type FlowConfig, type OutboundKind } from "../config.ts";
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
  attachSupport,
  envSecrets,
  findPr,
  readPrBody,
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
  buildCapturesSection,
  capturesDigest,
  capturesDigestOf,
  collectTaskCaptures,
  replaceCapturesSection,
  textSha256,
  type CaptureRef,
} from "../lib/pr-captures.ts";
import {
  cleanupHolderLabel,
  cleanupMergedPr,
  showPushWatch,
} from "../lib/pr-finish.ts";
import {
  findWatchAutomation,
  watchStuckNote,
  type WatchAutomationLookup,
} from "../lib/watch-automation.ts";
import {
  findPrTemplate,
  missingHeadings,
  templatesOf,
} from "../lib/pr-template.ts";
import { requireStackLanded } from "../lib/stack-notice.ts";
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
  "使い方：orca-flow push 〈ID〉 [--body-file 〈パス〉] [--show] | orca-flow push 〈ID〉 --branch | orca-flow push 〈ID〉 --template";
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
      ["show", "watch", "branch", "template"],
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

    // baseBranch の PR のテンプレートを出す（読むだけ。確かめ・案・gh・カードは触らない）
    if (args.flags.has("template")) {
      if (args.values.has("body-file") || args.flags.has("branch"))
        throw new FlowError(
          1,
          "--template には --body-file と --branch を付けられません",
        );
      return showTemplate(ctx, id);
    }

    // 共通のタスクの枝だけを承認なしで push する道（印があるときだけ。PR・案・返信は作らない）。
    // タスクの worktree と統括役の場所のどちらからも流せる
    if (args.flags.has("branch")) {
      if (args.values.has("body-file"))
        throw new FlowError(1, "--branch には --body-file を付けられません");
      const root = await requireRoot(ctx.runner, ctx.cwd);
      const config = await requireFlowConfig(ctx.runner, root);
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
    const config = await requireFlowConfig(ctx.runner, root);
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
    // 乗せたタスクは乗せた先より先に PR にしない（マージ済みの後始末は止めないよう、その判定のあと）
    await requireStackLanded(ctx.runner, root, config, id, "push");

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
      return alreadyPushed(ctx, deps, config, root, g, id, task, open, head);

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

    // 録画：PR がまだなければ PR の作成の本文の末尾に節を足し、あれば本文の節を直す案を考える（GitHub には書かない）
    const found = await collectForPush(ctx, common, id);
    let captures: CaptureRef[] = [];
    let editReq: AddRequest | null = null;
    if (body !== null && found.length > 0 && (await canAttach(ctx, g))) {
      const next = replaceCapturesSection(body, buildCapturesSection(found));
      if (next === null)
        ctx.stderr(
          "警告：本文に録画の節の始まりの印はありますが、終わりの印がないので、録画を載せません。本文の印を直すか消してから push し直してください",
        );
      else {
        captures = found;
        body = next;
      }
    }
    if (open)
      editReq = await planPrEdit(ctx, config, g, open, found, {
        bodyProblems: addContext.bodyProblems,
      });
    const createReq: AddRequest | null =
      body === null
        ? null
        : {
            body,
            pr: null,
            afterCi: false,
            title: null,
            ...(captures.length > 0 ? { captures } : {}),
          };

    // 本文の確かめに落ちたら、何も写さず何も積まない（先に PR の作成の入力を確かめる）
    if (createReq !== null)
      await KIND_TABLE["pr-create"].prepareAdd(createReq, addContext);

    // PR のテンプレートの見出しが本文に欠けていれば警告する（止めない。積む案も変えない）
    if (body !== null) await warnMissingHeadings(ctx, root, config, body);

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
    if (createReq !== null) await stack("pr-create", createReq);
    // 開いた PR が下書きのときだけ、下書きを外す案を一緒に積む（CI は待たない）。
    // 積まないときは、前に積んだままの pr-ready を取り下げる（古い先頭で束に残り send を止めないため）
    if (open?.isDraft) await stack("pr-ready", none);
    else
      withdrawn.push(
        ...(await withdrawQueued(common, id, "pr-ready", ctx.now())),
      );
    // 積まないときは、前に積んだままの pr-edit を取り下げる（PR が開いていない・録画がない・載せられないときも。
    // 古い先頭で束に残ると、send が束全体を止め、push を打ち直しても片づかない）
    if (editReq !== null) await stack("pr-edit", editReq);
    else
      withdrawn.push(
        ...(await withdrawQueued(common, id, "pr-edit", ctx.now())),
      );

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

    const watch = await automationState(ctx, deps, config, root);
    const automation = watch.state;
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
      if (watch.stuck) ctx.stdout(`${watch.stuck}\n`);
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
        captures: captures.map((c) => c.name),
      },
    };
  };
}

/** 録画の置き場から載せる録画を拾い、載せない流れを警告する（手元のパスは出さない） */
async function collectForPush(
  ctx: CommandContext,
  common: string,
  id: string,
): Promise<CaptureRef[]> {
  const { captures, warnings } = await collectTaskCaptures(common, id);
  for (const w of warnings) ctx.stderr(`警告：${w}`);
  return captures;
}

/** gh の版とホストが録画の添付に合うか。合わなければ理由つきで警告する（終了コードは変えない） */
async function canAttach(ctx: CommandContext, g: GhContext): Promise<boolean> {
  let reason: string;
  try {
    const support = await attachSupport(g);
    if (support.ok) return true;
    reason = support.reason;
  } catch (error) {
    reason = redactSecrets(message(error), envSecrets(ctx.env));
  }
  ctx.stderr(
    `警告：録画を PR に載せません（${reason}）。案は録画なしで積みます`,
  );
  return false;
}

/**
 * 開いた PR の本文の録画の節を直す案の入力。積まないときは null（理由は警告か案内に出す）。
 * 録画がなければ何もしない（今の節は消さない）。null のとき、積んだままの前の案は呼ぶ側が取り下げる
 */
async function planPrEdit(
  ctx: CommandContext,
  config: FlowConfig,
  g: GhContext,
  pr: PrInfo,
  captures: CaptureRef[],
  check: { bodyProblems: (text: string) => string[] },
): Promise<AddRequest | null> {
  if (captures.length === 0) return null;
  const allowed = config.outbound.allow.includes("pr-edit");
  // 許していなくても本文は読む。今の録画がもう載っていれば、案内を出すと載っていないように読めるため
  const notAllowed = (state: string) => {
    if (!ctx.json)
      ctx.stdout(
        `録画がありますが、PR #${pr.number} の本文の録画の節が${state}。outbound.allow に pr-edit がないので、節を直す案は積みません。統括役が .orca-flow/config.json の outbound.allow に pr-edit を足すと、次の push で載ります\n`,
      );
    return null;
  };
  let prBody: string;
  try {
    prBody = await readPrBody(g, pr.number);
  } catch (error) {
    // 許していないときは、読めない警告より、人が次にできる手（設定に足す）を示す
    if (!allowed) return notAllowed("今の録画と同じか確かめられませんでした");
    ctx.stderr(
      `警告：PR #${pr.number} の本文を読めないので、録画の節を直す案は積みません（${redactSecrets(message(error), envSecrets(ctx.env))}）`,
    );
    return null;
  }
  // 本文はもう今の録画なので、直しは要らない
  if (capturesDigestOf(prBody) === capturesDigest(captures)) return null;
  if (!allowed)
    return notAllowed("今の録画と違います（古い録画か、節がありません）");
  if (!(await canAttach(ctx, g))) return null;
  const next = replaceCapturesSection(prBody, buildCapturesSection(captures));
  if (next === null) {
    ctx.stderr(
      `警告：PR #${pr.number} の本文に録画の節の始まりの印はありますが、終わりの印がないので、直す案は積みません。GitHub の画面で節を直すか消してから push し直してください`,
    );
    return null;
  }
  const problems = check.bodyProblems(next);
  if (problems.length > 0) {
    ctx.stderr(
      `警告：PR #${pr.number} の本文に、${problems.join("、")}が含まれているので、録画の節を直す案は積みません。GitHub の画面で消してから push し直してください`,
    );
    return null;
  }
  return {
    body: next,
    pr: pr.number,
    afterCi: false,
    title: null,
    prEdit: { prBodySha: textSha256(prBody), captures },
  };
}

/** `--template`：baseBranch の PR のテンプレートを出す。何も積まず、gh も呼ばない */
async function showTemplate(
  ctx: CommandContext,
  id: string,
): Promise<CommandResult> {
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  const lookup = await findPrTemplate(ctx.runner, root, config.baseBranch);
  const templates = templatesOf(lookup);
  if (!ctx.json) {
    if (lookup.kind === "none")
      ctx.stdout(
        `PR のテンプレートはありません（${config.baseBranch} の .github/・直下・docs/ を探しました）`,
      );
    else {
      if (lookup.kind === "many")
        ctx.stdout(
          `PR のテンプレートが複数あります（${templates.length} 件）。使うものを人に選んでもらってください`,
        );
      for (const t of templates)
        ctx.stdout(`PR のテンプレート：${t.path}\n${t.content}`);
    }
  }
  return {
    code: 0,
    data: {
      id,
      baseBranch: config.baseBranch,
      found: lookup.kind,
      templates,
    },
  };
}

/** 本文にテンプレートの見出しが欠けていれば、標準エラーに警告を出す */
async function warnMissingHeadings(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  body: string,
): Promise<void> {
  let lookup;
  try {
    lookup = await findPrTemplate(ctx.runner, root, config.baseBranch);
  } catch {
    return;
  }
  const found = missingHeadings(body, templatesOf(lookup));
  if (found)
    ctx.stderr(
      `警告：本文に PR のテンプレートの見出しがありません（${found.path}）：${found.missing.join("、")}。止めずに案を積みます`,
    );
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
  config: FlowConfig,
  root: string,
): Promise<{ state: WatchAutomationLookup["state"]; stuck: string | null }> {
  try {
    // install・uninstall と同じ場所で探す（Windows の C:/… と C:\… で別の名前にならないように）
    const main = await mainWorktreePath(ctx.runner, root);
    const lookup = await deps.findAutomation(ctx.runner, main);
    const stuck = await watchStuckNote(
      ctx.runner,
      main,
      lookup,
      config.prWatch.intervalMinutes,
    );
    return { state: lookup.state, stuck };
  } catch {
    return { state: "unknown", stuck: null };
  }
}

/**
 * 先頭が変わっていない 2 回目の push：確かめも push もせず、見張りの automation の有無だけ案内する。
 * PR が下書きなら下書きを外す案を、本文の録画が今と違えば本文の録画の節を直す案を積む
 */
async function alreadyPushed(
  ctx: CommandContext,
  deps: PushWatchDeps,
  config: FlowConfig,
  root: string,
  g: GhContext,
  id: string,
  task: { branch: string; path: string },
  pr: PrInfo,
  head: string,
): Promise<CommandResult> {
  const watch = await automationState(ctx, deps, config, root);
  const automation = watch.state;
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
    if (watch.stuck) ctx.stdout(watch.stuck);
  };
  const editReq = await planPrEdit(
    ctx,
    config,
    g,
    pr,
    await collectForPush(ctx, common, id),
    {
      bodyProblems: (text) =>
        bodyProblemsOf(text, {
          env: ctx.env,
          config,
          root,
          task: { id, path: task.path },
        }),
    },
  );
  // 下書きでなく、直す録画もなければ、積みっぱなしの pr-ready と pr-edit を取り下げて、何も積まない
  if (!pr.isDraft && editReq === null) {
    const old = [
      ...(await withdrawQueued(common, id, "pr-ready", ctx.now())),
      ...(await withdrawQueued(common, id, "pr-edit", ctx.now())),
    ];
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

  // push と PR の作成は積み直さず、下書きを外す案と本文の録画の節を直す案だけを積む
  const addContext: AddContext = {
    taskId: id,
    branch: task.branch,
    defaultTitle: async () => id,
    // 本文の確かめは planPrEdit が済ませてある
    bodyProblems: () => [],
    expectedRemoteHead: async () => null,
  };
  const stacked: OutboxItem[] = [];
  const withdrawn: OutboxItem[] = [];
  const stack = async (kind: OutboundKind, req: AddRequest) => {
    const added = await stackItem(
      common,
      kind,
      req,
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
    stacked.push(added.item);
    withdrawn.push(...added.withdrawn);
  };
  if (pr.isDraft)
    await stack("pr-ready", {
      body: "",
      pr: pr.number,
      afterCi: false,
      title: null,
    });
  else
    withdrawn.push(
      ...(await withdrawQueued(common, id, "pr-ready", ctx.now())),
    );
  if (editReq !== null) await stack("pr-edit", editReq);
  else
    withdrawn.push(...(await withdrawQueued(common, id, "pr-edit", ctx.now())));
  const set = buildShowSet(
    await readItems(common, id),
    config.outbound.interval.perBatch,
    head,
  );
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
  if (!ctx.json) {
    ctx.stdout(
      editReq === null
        ? `${id} は push 済みで、先頭は変わっていませんが、PR #${pr.number} は下書きのままです。下書きを外す案だけを積みました。GitHub にはまだ書いていません。よければ /orca-flow:send で送ってください\n`
        : `${id} は push 済みで、先頭は変わっていませんが、PR #${pr.number} の本文の録画が今の録画と違います。${pr.isDraft ? "下書きを外す案と、" : ""}本文の録画の節を直す案を積みました。GitHub にはまだ書いていません。下の録画を開いて確かめ、よければ /orca-flow:send で送ってください\n`,
    );
    for (const o of withdrawn) ctx.stdout(`前の案を取り下げました：${o.id}\n`);
    for (const chunk of renderShow(id, set, config)) ctx.stdout(chunk);
    printAutomation();
  }
  return {
    code: 0,
    data: {
      ...base,
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
    },
  };
}

/** 積んだままの案（束に残ると古い先頭や古い本文で send を止める）を種類ごとに取り下げる */
async function withdrawQueued(
  common: string,
  id: string,
  kind: OutboundKind,
  now: Date,
): Promise<OutboxItem[]> {
  const out: OutboxItem[] = [];
  for (const item of await readItems(common, id))
    if (item.kind === kind && item.state === "queued")
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
