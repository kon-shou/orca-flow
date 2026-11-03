import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import { FlowError, type CommandContext } from "../types.ts";
import {
  activeTasks,
  currentBranch,
  diffNames,
  gitCommonDir,
  isIgnored,
  isMainWorktree,
  listWorktrees,
  mergeNoFf,
  runGit,
  uncommittedChanges,
} from "./git.ts";
import { idFromBranch } from "./task-id.ts";
import { launchMainCheck, recordMerge } from "./main-check.ts";
import {
  chainOf,
  orderBefore,
  readMergeOrder,
  recordIntegrated,
} from "./merge-order.ts";
import {
  addedLinesOf,
  idLikeLines,
  readDecisionDraft,
  startsWithBase,
} from "./decisions.ts";
import { acquireLock, releaseOrWarn, type LockResult } from "./lock.ts";
import {
  blockedWarning,
  cardForState,
  createOrca,
  sendFailedWarning,
} from "./orca.ts";
import { filesOutsideRange } from "./overlap.ts";
import {
  readReviewed,
  ownChange,
  type ReviewedRecord,
} from "./rebase-review.ts";
import { parseTaskDoc } from "./task-doc.ts";
import {
  applyProgress,
  mainAdvancedNotice,
  planProgress,
  readTaskRecord,
  reportPath,
  taskDocPath,
  type ProgressPlan,
  type TaskRecord,
} from "./tasks.ts";
import { setCell } from "./progress.ts";

// integrate と push が共通で使う確かめと後始末。

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export type OrcaClient = ReturnType<typeof createOrca>;

/** マージの順で止めるときの、タスク長への知らせごとの「伝えること」 */
const TELL_TAKE_PREVIOUS =
  "前のタスクを取り込み、見直して integrate-wait に戻す";
const TELL_REVIEW = "rebase の見直しをして integrate-wait に戻す";

/** タスク長に知らせを送る。送れたかを返す。送れなければ『送れない理由の文』の警告にする */
export async function tellLead(
  ctx: CommandContext,
  config: FlowConfig,
  orca: OrcaClient,
  id: string,
  worktree: string,
  what: string,
  tellWhat: string,
  text: string,
): Promise<boolean> {
  try {
    const found = await orca.findSendTarget(worktree, config.lead.agent);
    if (found.kind !== "found") {
      ctx.stderr(blockedWarning(id, what, tellWhat, found, config.lead.agent));
      return false;
    }
    await orca.sendText(
      found.terminal.handle,
      `（${config.integratorName}より）${text}`,
    );
    return true;
  } catch (error) {
    ctx.stderr(sendFailedWarning(id, what, tellWhat, error));
    return false;
  }
}

/**
 * マージの順を守らせる（8章 integrate「マージの順」）。順に入っているタスクだけが対象。
 * 止めるときは FlowError(2)。標準エラーの文に orca-flow verify の文字は入れない
 */
export async function checkMergeOrder(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  id: string,
  task: { branch: string; path: string },
  exclude: readonly string[],
  verb = "integrate",
): Promise<void> {
  const previous = orderBefore(await readMergeOrder(ctx.runner, root), id);
  if (previous.length === 0) return;
  // push には --skip-order がないので、順から外す道だけを案内する
  const skip =
    verb === "integrate"
      ? `順を飛ばすときは --skip-order をつけて、順から外すときは orca-flow order --remove ${id} を流して、もう一度 integrate してください`
      : `順から外すときは orca-flow order --remove ${id} を流して、もう一度 ${verb} してください`;

  // ① 前のタスクが未統合：先に入れる。タスク長には送らない
  const waiting = previous.filter((p) => !p.integrated).map((p) => p.id);
  if (waiting.length > 0)
    throw new FlowError(
      2,
      `マージの順：${id} の前に、まだ統合されていないタスクがあります。先に ${waiting.join("、")} を統合してください。${skip}`,
    );

  const orca = createOrca(ctx.runner, root);

  // ② 統合済みの前のタスクのマージのコミットを、先頭が含むか
  const missing: string[] = [];
  for (const p of previous) {
    if (p.mergeCommit === null) continue;
    const included = await ctx.runner(
      "git",
      ["merge-base", "--is-ancestor", p.mergeCommit, task.branch],
      { cwd: root },
    );
    if (included.code !== 0) missing.push(p.id);
  }
  if (missing.length > 0) {
    const names = missing.join("、");
    const sentToLead = await tellLead(
      ctx,
      config,
      orca,
      id,
      task.path,
      "前のタスクを取り込む知らせ",
      TELL_TAKE_PREVIOUS,
      `${names} を取り込み、見直して verify をやり直し integrate-wait に戻してください。`,
    );
    throw new FlowError(
      2,
      `マージの順：${id} の先頭が、統合済みの前のタスク（${names}）のマージを含んでいません。止めました。${sentToLead ? `タスク長に「${names} を取り込み、見直して verify をやり直し integrate-wait に戻して」と送りました。` : "タスク長には送れていません（上の警告）。"}${skip}`,
    );
  }

  // ③ 見直しの記録があり、指紋が今のタスク自身の変更と同じか
  const record: ReviewedRecord | null = await readReviewed(
    ctx.runner,
    root,
    id,
  );
  const now = await ownChange(
    ctx.runner,
    task.path,
    config.baseBranch,
    task.branch,
    exclude,
  );
  if (record === null || record.fingerprint !== now.fingerprint) {
    const why =
      record === null
        ? "rebase の見直しの記録がありません"
        : "見直したあとにタスク自身の変更が変わっています";
    const asked = await tellLead(
      ctx,
      config,
      orca,
      id,
      task.path,
      "rebase の見直しの依頼",
      TELL_REVIEW,
      `${why}。rebase の前のコミットを指定して orca-flow rebase-review を流し、変わった所を見直してから orca-flow rebase-review --done で記録し、integrate-wait に戻してください。`,
    );
    throw new FlowError(
      2,
      `マージの順：${id} は${why}。止めました。${asked ? "タスク長に見直しを頼みました。" : "タスク長には送れていません（上の警告）。"}${skip}`,
    );
  }
}

/** 順に入っていれば統合済みの印をつける。つけられなくても統合は済んでいるので警告だけ */
export async function markIntegrated(
  ctx: CommandContext,
  root: string,
  id: string,
  mergeCommit: string | null,
): Promise<void> {
  try {
    if (!chainOf(await readMergeOrder(ctx.runner, root), id)) return;
    await recordIntegrated(ctx.runner, root, id, mergeCommit);
  } catch (error) {
    ctx.stderr(
      `警告：${id} に「統合済み」の印をつけられませんでした（${message(error)}）。orca-flow order で確かめてください`,
    );
  }
}

export async function setIntegratedCard(
  ctx: CommandContext,
  orca: OrcaClient,
  worktree: string,
): Promise<void> {
  try {
    await orca.setCard(worktree, cardForState("integrated"));
  } catch (error) {
    ctx.stderr(
      `警告：カードを「統合済み」にできませんでした（${message(error)}）`,
    );
  }
}

/** worktree を消す。ブランチは消さない。消せなければ警告だけ */
export async function removeTaskWorktree(
  ctx: CommandContext,
  orca: OrcaClient,
  id: string,
  worktree: string,
): Promise<boolean> {
  try {
    // orca worktree rm は今のブランチを消そうとするので、HEAD を切り離してから消す
    await runGit(
      ctx.runner,
      worktree,
      ["switch", "--detach", "--quiet"],
      "git switch --detach",
    );
    await orca.removeWorktree(worktree);
    return true;
  } catch (error) {
    ctx.stderr(
      `警告：${id} の worktree を消せませんでした（${message(error)}）。Orca で消してください`,
    );
    return false;
  }
}

// ---- 統合前の確かめ（integrate と push で共通） ----

export interface CheckedTask {
  docFile: string;
  reportFile: string;
  docText: string;
  docRecord: TaskRecord;
  reportRecord: TaskRecord;
  /** baseBranch との差分のファイル */
  files: string[];
}

export type CheckResult =
  | { kind: "ok"; checked: CheckedTask }
  /** 範囲の外のファイルがある（標準エラーに出し済み。呼び出し側は終了コード1で返す） */
  | { kind: "outside"; outside: string[] };

/**
 * 統合の前の確かめ：未コミットの変更・報告・設計書・範囲・決定の記録・マージの順・追跡された記録。
 * 止めるときは FlowError、範囲の外があるときは kind: "outside"。
 * 統括役の場所の確認とタスクの特定は、呼び出し側が先に行う
 */
export async function checkTaskBeforeIntegration(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  id: string,
  task: { branch: string; path: string },
  flags: { skipDecision: boolean; skipOrder: boolean; verb: string },
): Promise<CheckResult> {
  // 未コミットの変更がなく、報告がある
  const changes = await uncommittedChanges(ctx.runner, task.path, true);
  if (changes.length > 0)
    throw new FlowError(
      1,
      `${id} の worktree に未コミットの変更があります。タスク長にコミットしてもらってください：\n${changes.join("\n")}`,
    );
  const docFile = taskDocPath(config, id);
  const reportFile = reportPath(config, id);
  const reportRecord = await readTaskRecord(ctx.runner, root, task, reportFile);
  if (reportRecord.text === null)
    throw new FlowError(
      1,
      reportRecord.ignored
        ? `報告 ${reportRecord.absolute} がありません`
        : `${task.branch} に報告 ${reportFile} がコミットされていません`,
    );
  const docRecord = await readTaskRecord(ctx.runner, root, task, docFile);
  const docText = docRecord.text;
  if (docText === null)
    throw new FlowError(
      1,
      docRecord.ignored
        ? `設計書 ${docRecord.absolute} がありません`
        : `${task.branch} に設計書 ${docFile} がありません`,
    );
  const doc = parseTaskDoc(docText);
  for (const warning of doc.warnings) ctx.stderr(`警告：${warning}`);

  // 範囲の確認
  const files = await diffNames(
    ctx.runner,
    root,
    config.baseBranch,
    task.branch,
  );
  const outside = filesOutsideRange({
    files,
    allowed: doc.allowed,
    docs: [docFile, reportFile],
    appendOnlyFiles: config.appendOnlyFiles,
  });
  if (outside.length > 0) {
    ctx.stderr(
      `${id} の差分に「書き込んでよい場所」の外のファイルがあります：\n${outside.map((f) => `- ${f}`).join("\n")}`,
    );
    return { kind: "outside", outside };
  }

  // 決定の記録（decisionsFile があるときだけ）
  if (config.decisionsFile !== null) {
    const file = config.decisionsFile;
    const draft = readDecisionDraft(docText);
    if (draft === "missing")
      ctx.stderr(
        `警告：設計書に「決定の記録の文案」の節がないので、${file} に項があるかは確かめませんでした`,
      );
    else if (draft === "present" && !files.includes(file)) {
      const note = `設計書に決定の記録の文案がありますが、差分に ${file} がありません`;
      if (!flags.skipDecision)
        throw new FlowError(
          1,
          flags.verb === "integrate"
            ? `${id}：${note}。タスクのブランチで、文案から項を ${file} に足してコミットしてから、もう一度 integrate してください（足さずに通すときは --skip-decision）。マージしていません`
            : `${id}：${note}。タスクのブランチで、文案から項を ${file} に足してコミットしてから、もう一度 ${flags.verb} してください。push も PR もしていません`,
        );
      ctx.stderr(`警告：${note}。--skip-decision で通しました`);
    }
    if (files.includes(file)) {
      const diff = await runGit(
        ctx.runner,
        root,
        [
          "diff",
          "--no-renames",
          `${config.baseBranch}...${task.branch}`,
          "--",
          file,
        ],
        "git diff",
      );
      const hits = idLikeLines(addedLinesOf(diff), config.idPrefix);
      if (hits.length > 0)
        ctx.stderr(
          `警告：${file} の足した行に ID の形（${config.idPrefix} と数字）があります。記録は公開に出るので、ID を書かずに「日付 見出し」で指してください（${hits.length} 行）`,
        );
    }
  }

  // マージの順
  if (!flags.skipOrder)
    await checkMergeOrder(
      ctx,
      config,
      root,
      id,
      task,
      [docFile, reportFile],
      flags.verb,
    );

  // タスクのブランチで追跡されている記録が、メインでは無視される行に当たるなら止める
  const trackedRecords: string[] = [];
  for (const file of [
    docFile,
    reportFile,
    ...(config.progress ? [config.progress.file] : []),
  ])
    if (
      files.includes(file) &&
      (await isIgnored(ctx.runner, root, file, { noIndex: true }))
    )
      trackedRecords.push(file);
  if (trackedRecords.length > 0)
    throw new FlowError(
      1,
      `${trackedRecords.map((f) => `「${f}」`).join("")}はタスクのブランチで追跡されていますが、メインの作業ツリーでは .gitignore に当たります。このまま入れると main でも追跡されて push で出ます。タスクのブランチで、先に git rebase ${config.baseBranch} をして、そのあと ${trackedRecords.map((f) => `git rm --cached ${f}`).join(" と ")} をしてコミットしてから、もう一度 ${flags.verb} してください（先に rebase しないと、追跡をやめた記録が未追跡のファイルになり、次の ${flags.verb} が未コミットの変更で止まります）`,
    );

  return {
    kind: "ok",
    checked: { docFile, reportFile, docText, docRecord, reportRecord, files },
  };
}

/**
 * 決定の記録が追記だけか：baseBranch の中身が、タスクのブランチの中身の先頭とそのまま同じ
 * （merge=union の rebase で行が消える・すでにある項を書き換えるのを止める）。
 * decisionsFile がないとき、baseBranch にその記録がないときは何もしない。違えば FlowError(1)
 */
export async function checkDecisionsAppendOnly(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  id: string,
  task: { branch: string },
  verb: string,
): Promise<void> {
  if (config.decisionsFile === null) return;
  const file = config.decisionsFile;
  const show = (ref: string) =>
    ctx.runner("git", ["show", `${ref}:${file}`], { cwd: root });
  const baseShow = await show(config.baseBranch);
  if (baseShow.code !== 0) return;
  const branchShow = await show(task.branch);
  const branchText = branchShow.code === 0 ? branchShow.stdout : null;
  if (branchText !== null && startsWithBase(baseShow.stdout, branchText))
    return;
  throw new FlowError(
    1,
    `${id}：${config.baseBranch} の ${file} が、タスクのブランチの ${file} の先頭と同じではありません（rebase で記録の行が消えたか、すでにある項を書き換えています）。タスクのブランチで ${config.baseBranch} の ${file} の行を戻し、自分の項を末尾に足し直してコミットし、orca-flow verify をやり直してから、もう一度 ${verb} してください。${verb === "integrate" ? "マージしていません" : "push も PR もしていません"}`,
  );
}

/** 無視された記録を、メインの作業ツリーの同じパスへ写す（写せなければ FlowError(1)）。写したファイルを返す */
export async function copyIgnoredRecords(
  root: string,
  checked: Pick<
    CheckedTask,
    "docFile" | "reportFile" | "docRecord" | "reportRecord"
  >,
  after: string,
): Promise<string[]> {
  const copied: string[] = [];
  for (const [file, record] of [
    [checked.docFile, checked.docRecord],
    [checked.reportFile, checked.reportRecord],
  ] as const) {
    if (!record.ignored || record.text === null) continue;
    const target = path.join(root, file);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(record.absolute, target);
      copied.push(file);
    } catch (error) {
      throw new FlowError(
        1,
        `${file} をメインの作業ツリーに写せませんでした（${message(error)}）。${after}`,
      );
    }
  }
  return copied;
}

// ---- マージのあとの後始末（integrate と push で共通） ----

export interface CompleteOptions {
  orca: OrcaClient;
  /** main の確かめが「通った」ことにできるか（記録と同じ木か、ここで流したとき） */
  sameTree: boolean;
  /** sameTree のときに記録するコマンド */
  commands: readonly string[];
  /** 組み立て済みの進捗表の書き換え。undefined なら今組み立てる */
  plan?: ProgressPlan | null;
  keepWorktree: boolean;
}

export interface CompleteResult {
  progressCommitted: boolean;
  mainCheck: "same-tree" | "launched" | null;
  notified: string[];
  worktreeRemoved: boolean;
}

const TELL_MAIN_ADVANCED = "main を取り込む";

/**
 * baseBranch に入ったあとの後始末：マージの順の統合済みの印・main の確かめの記録（after-merge）・進捗表・
 * 背景の確かめの起動・カード・ほかのタスクへの知らせ（after-merge では確かめが通ってから別に送る）・worktree を消す
 */
export async function completeMerge(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  task: { id: string; branch: string; path: string },
  options: CompleteOptions,
): Promise<CompleteResult> {
  const { orca, sameTree } = options;
  const id = task.id;
  const afterMerge = config.integrateVerify === "after-merge";
  const head = async () =>
    (
      await runGit(
        ctx.runner,
        root,
        ["rev-parse", config.baseBranch],
        "git rev-parse",
      )
    ).trim();
  const plan =
    options.plan !== undefined
      ? options.plan
      : await planProgress(ctx, root, config, (text) =>
          config.progress
            ? setCell(
                text,
                config.progress,
                id,
                "state",
                config.progress.stateLabels.integrated,
              )
            : text,
        );

  await markIntegrated(ctx, root, id, await head());

  // main の確かめの記録（after-merge のとき）
  let mainCheck: CompleteResult["mainCheck"] = null;
  let recorded = false;
  if (afterMerge) {
    try {
      await recordMerge(ctx.runner, root, config, {
        commit: await head(),
        id,
        sameTree,
        commands: sameTree ? [...options.commands] : [],
        at: ctx.now().toISOString(),
      });
      recorded = true;
      if (sameTree) mainCheck = "same-tree";
    } catch (error) {
      ctx.stderr(
        `警告：main の確かめを始められませんでした（${message(error)}）。orca-flow main-check run で確かめてください`,
      );
    }
  }

  // 進捗表（失敗しても、確かめの起動はする）
  let committed = false;
  let progressError: unknown = null;
  try {
    committed = await applyProgress(
      ctx.runner,
      root,
      plan,
      `${config.integratorName}: ${id} の統合を進捗に記録する`,
    );
  } catch (error) {
    progressError = error;
  }

  // 背景の確かめを起動する（進捗表のコミットのあと）
  if (recorded) {
    try {
      await launchMainCheck(ctx.runner, root);
      if (!sameTree) mainCheck = "launched";
    } catch (error) {
      ctx.stderr(
        `警告：main の確かめを始められませんでした（${message(error)}）。orca-flow main-check run で確かめてください`,
      );
    }
  }
  if (progressError) throw progressError;

  await setIntegratedCard(ctx, orca, task.path);

  // 作業中のほかのタスクに知らせる
  const notified: string[] = [];
  const others = afterMerge
    ? []
    : (await activeTasks(ctx.runner, root, config)).filter((t) => t.id !== id);
  for (const other of others) {
    try {
      const found = await orca.findSendTarget(other.path, config.lead.agent);
      if (found.kind !== "found") {
        ctx.stderr(
          blockedWarning(
            other.id,
            "main が進んだ知らせ",
            TELL_MAIN_ADVANCED,
            found,
            config.lead.agent,
          ),
        );
        continue;
      }
      await orca.sendText(
        found.terminal.handle,
        mainAdvancedNotice(config, id),
      );
      notified.push(other.id);
    } catch (error) {
      ctx.stderr(
        sendFailedWarning(
          other.id,
          "main が進んだ知らせ",
          TELL_MAIN_ADVANCED,
          error,
        ),
      );
    }
  }

  const removed = options.keepWorktree
    ? false
    : await removeTaskWorktree(ctx, orca, id, task.path);
  return {
    progressCommitted: committed,
    mainCheck,
    notified,
    worktreeRemoved: removed,
  };
}

// ---- main を書き換える共通のロック ----

/** main を書き換える間（取り込み・マージ・進捗表・後始末）に取るロック：〈git の共通ディレクトリ〉/orca-flow/main.lock */
export async function tryMainLock(
  ctx: CommandContext,
  root: string,
): Promise<LockResult> {
  const dir = path.join(await gitCommonDir(ctx.runner, root), "orca-flow");
  await mkdir(dir, { recursive: true });
  return acquireLock(path.join(dir, "main.lock"), {
    waitMs: 0,
    maxAttempts: 3,
    failed: (file, detail) =>
      `main のロックを読み書きできません（${file}：${detail}）。ロックのパスを確かめてください`,
    releaseFailed: (file, detail) =>
      `main のロックを外せませんでした（${file}：${detail}）。ロックが残っていれば、${file} を消してください`,
  });
}

export const MAIN_BUSY =
  "背景の後始末が main を書き換えています。少し待ってもう一度流してください";

/** main のロックを取る。取れなければ FlowError(2)。戻り値で放す（finally で呼ぶ） */
export async function acquireMainLock(
  ctx: CommandContext,
  root: string,
): Promise<() => Promise<void>> {
  const lock = await tryMainLock(ctx, root);
  if (lock.kind === "held") throw new FlowError(2, MAIN_BUSY);
  return () => releaseOrWarn(lock.release);
}

// ---- PR の道の後始末 ----

export type SyncStop = "place" | "dirty" | "fetch" | "conflict";

export type SyncResult =
  | {
      kind: "synced";
      how: "fast-forward" | "merge" | "up-to-date";
      head: string;
    }
  | { kind: "stopped"; reason: SyncStop; detail: string };

/**
 * origin の baseBranch を取ってきて、手元の baseBranch に取り込む。
 * 早送りできれば早送り、できなければマージ。競合したら戻して止める。
 * 統括役の場所が満たされない（baseBranch でない・メインの作業ツリーでない・未コミットの変更がある）ときも何も変えずに止める。
 * 止めるときは投げずに kind: "stopped" で返す
 */
export async function syncBaseFromOrigin(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
): Promise<SyncResult> {
  const base = config.baseBranch;
  const stop = (reason: SyncStop, detail: string): SyncResult => ({
    kind: "stopped",
    reason,
    detail,
  });
  try {
    if (!(await isMainWorktree(ctx.runner, root)))
      return stop(
        "place",
        "統括役の場所（メインのチェックアウト）ではありません",
      );
    const branch = await currentBranch(ctx.runner, root);
    if (branch !== base)
      return stop(
        "place",
        `メインのチェックアウトが ${base} ではありません（今は ${branch ?? "切り離された HEAD"}）`,
      );
    const changes = await uncommittedChanges(ctx.runner, root, false);
    if (changes.length > 0)
      return stop(
        "dirty",
        `メインのチェックアウトに未コミットの変更があります：${changes.join("、")}`,
      );
  } catch (error) {
    return stop("place", message(error));
  }

  const fetched = await ctx.runner("git", ["fetch", "origin", base], {
    cwd: root,
    timeoutMs: 120_000,
  });
  if (fetched.code !== 0 || fetched.timedOut)
    return stop(
      "fetch",
      `git fetch origin ${base} に失敗しました：${(fetched.stderr || fetched.stdout).trim() || "時間切れ"}`,
    );
  const remote = `origin/${base}`;
  const rev = async (ref: string) =>
    (
      await runGit(ctx.runner, root, ["rev-parse", ref], "git rev-parse")
    ).trim();
  const isAncestor = async (a: string, b: string) =>
    (
      await ctx.runner("git", ["merge-base", "--is-ancestor", a, b], {
        cwd: root,
      })
    ).code === 0;

  if (await isAncestor(remote, "HEAD"))
    return { kind: "synced", how: "up-to-date", head: await rev("HEAD") };
  if (await isAncestor("HEAD", remote)) {
    const ff = await ctx.runner("git", ["merge", "--ff-only", remote], {
      cwd: root,
    });
    if (ff.code !== 0)
      return stop(
        "conflict",
        `git merge --ff-only ${remote} に失敗しました：${(ff.stderr || ff.stdout).trim()}`,
      );
    return { kind: "synced", how: "fast-forward", head: await rev("HEAD") };
  }
  try {
    await mergeNoFf(
      ctx.runner,
      root,
      remote,
      `${config.integratorName}: ${remote} を取り込む`,
    );
  } catch (error) {
    if (error instanceof FlowError && error.code === 3)
      return stop("conflict", error.message);
    throw error;
  }
  return { kind: "synced", how: "merge", head: await rev("HEAD") };
}

/** 後始末が止まる理由：取り込みの理由に加えて、main のロック・先頭の違い・worktree の未コミット・記録の写し */
export type FinishStop = SyncStop | "busy" | "head" | "worktree" | "copy";

export type FinishResult =
  | ({
      kind: "done";
      sync: Extract<SyncResult, { kind: "synced" }>;
    } & CompleteResult)
  | { kind: "stopped"; reason: FinishStop; detail: string };

/**
 * PR がマージされたあとの後始末の入口（push の道）。main のロックを取って、
 * タスクのブランチの先頭が PR の先頭と同じか・worktree に未コミットの変更がないかを確かめ、
 * origin の baseBranch を手元に取り込み（止まったら何も変えず kind: "stopped" と理由を返す）、
 * 無視された記録をメインの作業ツリーへ写してから completeMerge を通す。
 * ロックが取れないときは reason "busy"。Orca につながらないときは何も変えずに FlowError(1)。
 * root はメインの作業ツリー（統括役の場所）
 */
export async function finishMergedTask(
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  task: { id: string; branch: string; path: string },
  options: { keepWorktree?: boolean; prHead?: string | null } = {},
): Promise<FinishResult> {
  const orca = createOrca(ctx.runner, root);
  await orca.ping();
  const lock = await tryMainLock(ctx, root);
  if (lock.kind === "held")
    return { kind: "stopped", reason: "busy", detail: MAIN_BUSY };
  try {
    const stop = (reason: FinishStop, detail: string): FinishResult => ({
      kind: "stopped",
      reason,
      detail,
    });
    const hasWorktree = existsSync(task.path);

    // push のあとのローカルのコミット・未コミットの変更を、worktree ごと消さない
    if (options.prHead) {
      const local = await ctx.runner(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}`],
        { cwd: root },
      );
      if (local.code === 0 && local.stdout.trim() !== options.prHead)
        return stop(
          "head",
          `タスクのブランチ ${task.branch} の先頭が、マージされた PR の先頭と違います（push のあとにコミットがあります）。何も消していません`,
        );
    }
    if (hasWorktree) {
      const changes = await uncommittedChanges(ctx.runner, task.path, true);
      if (changes.length > 0)
        return stop(
          "worktree",
          `${task.id} の worktree に未コミットの変更があります：${changes.slice(0, 5).join("、")}。消さずに止めました`,
        );
    }

    const sync = await syncBaseFromOrigin(ctx, config, root);
    if (sync.kind === "stopped") return sync;

    // 無視された設計書と報告は、worktree を消す前にメインの作業ツリーへ写す
    if (hasWorktree) {
      const docFile = taskDocPath(config, task.id);
      const reportFile = reportPath(config, task.id);
      try {
        await copyIgnoredRecords(
          root,
          {
            docFile,
            reportFile,
            docRecord: await readTaskRecord(ctx.runner, root, task, docFile),
            reportRecord: await readTaskRecord(
              ctx.runner,
              root,
              task,
              reportFile,
            ),
          },
          "worktree は消していません",
        );
      } catch (error) {
        if (error instanceof FlowError) return stop("copy", error.message);
        throw error;
      }
    }

    const result = await completeMerge(ctx, config, root, task, {
      orca,
      sameTree: false,
      commands: [],
      keepWorktree: options.keepWorktree === true,
    });
    return { kind: "done", sync, ...result };
  } finally {
    await releaseOrWarn(lock.release);
  }
}

/**
 * push の道でタスクを探す。作業中のタスクにあればそれ。なければ（後始末の取り込みで手元の baseBranch に
 * 入ってマージ済みになったあと）、push の記録があるときだけ、worktree の一覧からブランチで探す
 */
export async function findPushTask(
  runner: CommandContext["runner"],
  root: string,
  config: FlowConfig,
  id: string,
  record: PushRecord | null,
): Promise<{ id: string; branch: string; path: string }> {
  const active = (await activeTasks(runner, root, config)).find(
    (t) => t.id === id,
  );
  if (active) return active;
  if (record) {
    const found = (await listWorktrees(runner, root)).find(
      (wt) =>
        wt.branch !== null &&
        (wt.branch === record.branch ||
          idFromBranch(wt.branch, config.branchPrefix, config.idPrefix) === id),
    );
    if (found?.branch) return { id, branch: found.branch, path: found.path };
  }
  throw new FlowError(
    1,
    `作業中のタスクに ${id} が見つかりません（${config.branchPrefix}${id}-… のブランチの worktree がないか、すでに後始末が済んでいます）`,
  );
}

// ---- 待ち受けの記録 ----

/**
 * 待ち受けの記録 〈git の共通ディレクトリ〉/orca-flow/push/〈ID〉.json。
 * push が書くのは id・branch・base・pushedHead・pr。担当Bの待ち受けは同じファイルに別のキーを足してよい
 * （writePushRecord は読んだ中身に重ねて書くので、知らないキーは消えない）
 */
export interface PushRecord {
  id: string;
  branch: string;
  base: string;
  /** 前に push したタスクのブランチの先頭 */
  pushedHead: string;
  pushedAt: string;
  pr: { number: number; url: string } | null;
  [key: string]: unknown;
}

export async function pushRecordFile(
  runner: CommandContext["runner"],
  cwd: string,
  id: string,
): Promise<string> {
  return path.join(
    await gitCommonDir(runner, cwd),
    "orca-flow",
    "push",
    `${id}.json`,
  );
}

export async function readPushRecord(
  runner: CommandContext["runner"],
  cwd: string,
  id: string,
): Promise<PushRecord | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(await pushRecordFile(runner, cwd, id), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PushRecord).pushedHead === "string"
    )
      return parsed as PushRecord;
    return null;
  } catch {
    return null;
  }
}

/** 読んだ中身に patch を重ねて書く（一時ファイルから rename） */
export async function writePushRecord(
  runner: CommandContext["runner"],
  cwd: string,
  id: string,
  patch: Partial<PushRecord> & Pick<PushRecord, "id">,
): Promise<PushRecord> {
  const file = await pushRecordFile(runner, cwd, id);
  const before = (await readPushRecord(runner, cwd, id)) ?? {};
  const next = { ...before, ...patch } as PushRecord;
  await mkdir(path.dirname(file), { recursive: true });
  const dir = await mkdtemp(path.join(path.dirname(file), `.${id}-`));
  const tmp = path.join(dir, "record.json");
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, file);
  await rm(dir, { recursive: true, force: true });
  return next;
}
