import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { requireConfig, type FlowConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  activeTasks,
  diffNames,
  isIgnored,
  mergeNoFf,
  rebaseOrAbort,
  requireActiveTask,
  requireIntegratorPlace,
  requireRoot,
  runGit,
  uncommittedChanges,
} from "../lib/git.ts";
import {
  failedMainLine,
  launchMainCheck,
  mainCheckState,
  recordMerge,
  shortCommit,
  uncheckedDetail,
  unsentNoticeWarnings,
  type MainCheckStatus,
} from "../lib/main-check.ts";
import {
  blockedWarning,
  cardForState,
  createOrca,
  sendFailedWarning,
} from "../lib/orca.ts";
import { filesOutsideRange } from "../lib/overlap.ts";
import { setCell } from "../lib/progress.ts";
import { parseTaskDoc } from "../lib/task-doc.ts";
import {
  applyProgress,
  mainAdvancedNotice,
  planProgress,
  readTaskRecord,
  reportPath,
  taskDocPath,
} from "../lib/tasks.ts";
import {
  allInSkipPaths,
  baseDrift,
  commandsFor,
  readRecord,
  recordMismatch,
  runVerifyCommands,
  type BaseDrift,
} from "../lib/verified.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** 知らせごとに、tell で伝えること */
const TELL_MAIN_ADVANCED = "main を取り込む";
const TELL_VERIFY_AGAIN = "orca-flow verify をやり直して integrate-wait に戻す";

/** 落ちた main で止めるときの本文（終了コード2。標準エラーに orca-flow verify の文字を入れない） */
function failedMainStop(
  id: string,
  status: Extract<MainCheckStatus, { kind: "failed" }>,
): string {
  const above = status.above
    ? `\n- 上のコミット ${shortCommit(status.above.commit)} は${status.above.kind === "running" ? "確かめが流れています" : status.above.kind === "pending" ? "確かめが待ちです" : "確かめられませんでした"}。その確かめが通るまで、落ちたままの扱いです`
    : "";
  const line = `${failedMainLine(status)}。${id} の統合を止めました。`;
  switch (status.cause) {
    case "known":
      return `${line}${above}\n- 戻す：統括役が main で git revert -m 1 ${status.culprit} をして、orca-flow main-check run で確かめ直す\n- 直す：直すタスクを作り、orca-flow integrate 〈直すタスクの ID〉 --fixes-main で入れる\n- 偶然落ちたと思うとき：orca-flow main-check run で確かめ直す`;
    case "searching":
      return `${line}${above}\n- 原因を探しています。orca-flow main-check で様子を見てください（戻すコマンドは、原因が分かってから出ます）`;
    case "stalled":
      return `${line}${above}\n- 原因を探していたプロセスがいません。orca-flow main-check run で確かめ直してください（戻すコマンドは、原因が分かってから出ます）`;
    case "unknown":
      return `${line}${above}\n- 原因が分からないので、戻すコマンドは出しません。ログを見て（orca-flow main-check）、直すタスクを orca-flow integrate 〈直すタスクの ID〉 --fixes-main で入れるか、直ってから orca-flow main-check run で確かめ直してください`;
  }
}

type OrcaClient = ReturnType<typeof createOrca>;

async function setIntegratedCard(
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
async function removeTaskWorktree(
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

/** 統括役が範囲の確認・テスト・マージを行う（8章 integrate） */
export const run: Command = async (ctx) => {
  const args = parseArgs(
    ctx.argv,
    [],
    ["keep-worktree", "verify-here", "fixes-main"],
  );
  const [id, ...rest] = args.positionals;
  if (!id || rest.length > 0)
    throw new FlowError(
      1,
      "使い方：orca-flow integrate 〈ID〉 [--keep-worktree] [--verify-here] [--fixes-main]",
    );

  // ① 統括役の場所の確認
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  await requireIntegratorPlace(ctx.runner, root, config);
  const task = await requireActiveTask(ctx.runner, root, config, id);

  // ② 未コミットの変更がなく、報告がある
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

  // ③ 範囲の確認
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
    return { code: 1, data: { id, outside } };
  }

  // タスクのブランチで追跡されている記録が、メインでは無視される行に当たるなら止める
  // （マージで main にまた追跡されて、push で出てしまうため）
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
      `${trackedRecords.map((f) => `「${f}」`).join("")}はタスクのブランチで追跡されていますが、メインの作業ツリーでは .gitignore に当たります。このまま入れると main でも追跡されて push で出ます。タスクのブランチで ${trackedRecords.map((f) => `git rm --cached ${f}`).join(" と ")} をしてコミットしてから、もう一度 integrate してください`,
    );

  // 無視された記録を、マージの前にメインの作業ツリーの同じパスへ写す（写せなければ止める）
  const copied: string[] = [];
  for (const [file, record] of [
    [docFile, docRecord],
    [reportFile, reportRecord],
  ] as const) {
    if (!record.ignored) continue;
    const target = path.join(root, file);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(record.absolute, target);
      copied.push(file);
    } catch (error) {
      throw new FlowError(
        1,
        `${file} をメインの作業ツリーに写せませんでした（${message(error)}）。マージも worktree の削除もしていません`,
      );
    }
  }

  // 差分がない（記録しか変えないタスクで、記録は無視されている）：
  // マージのコミットができないので、マージ・main の確かめの記録・知らせはせず、進捗表・カード・worktree の片づけだけ行う。
  // verify も流さない（コードが変わらないため）
  if (files.length === 0) {
    const orca = createOrca(ctx.runner, root);
    await orca.ping();
    const progress = config.progress;
    const plan = await planProgress(ctx, root, config, (text) =>
      progress
        ? setCell(text, progress, id, "state", progress.stateLabels.integrated)
        : text,
    );
    const committed = await applyProgress(
      ctx.runner,
      root,
      plan,
      `${config.integratorName}: ${id} の統合を進捗に記録する`,
    );
    await setIntegratedCard(ctx, orca, task.path);
    const removed = args.flags.has("keep-worktree")
      ? false
      : await removeTaskWorktree(ctx, orca, id, task.path);
    if (!ctx.json)
      ctx.stdout(
        `${id} は差分がないのでマージしませんでした（記録はメインの作業ツリーへ写しました）。push は人間が行ってください`,
      );
    return {
      code: 0,
      data: {
        id,
        branch: task.branch,
        files,
        recordsCopied: copied,
        merged: false,
        verified: [],
        progressCommitted: committed,
        notified: [],
        mainCheck: null,
        worktreeRemoved: removed,
      },
    };
  }

  // 落ちた main で止める（after-merge のとき。Orca やマージに触る前）
  const afterMerge = config.integrateVerify === "after-merge";
  if (afterMerge) {
    try {
      for (const warning of await unsentNoticeWarnings(
        ctx.runner,
        root,
        config,
      ))
        ctx.stderr(warning);
    } catch (error) {
      ctx.stderr(
        `警告：送れなかった知らせの記録を調べられませんでした（${message(error)}）`,
      );
    }
    const status = await mainCheckState(ctx.runner, root, config);
    if (status.kind === "failed" && !args.flags.has("fixes-main"))
      throw new FlowError(2, failedMainStop(id, status));
    if (status.kind === "unchecked")
      ctx.stderr(
        `警告：main の確かめができませんでした（${uncheckedDetail(status.reason, status.failedCommand, status.logPath)}）。止めずに進みます。orca-flow main-check run で確かめ直してください`,
      );
    if ((status.kind === "running" || status.kind === "pending") && !ctx.json)
      ctx.stdout(
        `main の確かめは${status.kind === "running" ? "いま流れています" : "待ちです"}（${shortCommit(status.commit)}）。止めずに進みます`,
      );
  }

  // 道を決める：ここで流す（--verify-here）・飛ばす（verifySkipPaths）・タスク側の記録を使う
  const commands = commandsFor(config, files);
  const orca = createOrca(ctx.runner, root);
  let route: "here" | "skipped" | "record";
  let mainChanged: string[] = [];
  let rebaseNeeded = false;
  let recordCommands: string[] = [];
  let relevantDrift = false;
  let notIncluded = false;
  const listFiles = (list: readonly string[], max = 5) =>
    list.length > max
      ? `${list.slice(0, max).join("、")} ほか${list.length - max}件`
      : list.join("、");
  // タスク長に verify のやり直しを送り、終了コード2のエラーを返す
  const askVerifyAgain = async (reason: string): Promise<FlowError> => {
    try {
      const found = await orca.findSendTarget(task.path, config.lead.agent);
      if (found.kind !== "found") {
        ctx.stderr(
          blockedWarning(
            id,
            "verify のやり直しの知らせ",
            TELL_VERIFY_AGAIN,
            found,
            config.lead.agent,
          ),
        );
      } else {
        await orca.sendText(
          found.terminal.handle,
          `（${config.integratorName}より）${reason}。orca-flow verify をやり直して、status integrate-wait に戻してください。`,
        );
      }
    } catch (error) {
      ctx.stderr(
        sendFailedWarning(
          id,
          "verify のやり直しの知らせ",
          TELL_VERIFY_AGAIN,
          error,
        ),
      );
    }
    return new FlowError(
      2,
      `${id} の verify の記録が使えないので、テストを流さず止めました（${reason}）。タスクのコンソールで orca-flow verify を流し直してもらってください`,
    );
  };
  if (args.flags.has("verify-here")) route = "here";
  else if (allInSkipPaths(files, config.verifySkipPaths)) route = "skipped";
  else {
    const rev = async (ref: string) =>
      (
        await runGit(ctx.runner, root, ["rev-parse", ref], "git rev-parse")
      ).trim();
    const record = await readRecord(ctx.runner, root, id);
    const head = await rev(task.branch);
    const base = await rev(config.baseBranch);
    // 記録のあとに main が動いていても、テストに関係しないファイルだけなら記録を使う
    let drift: BaseDrift = { kind: "same" };
    if (record && record.head === head)
      drift = await baseDrift(ctx.runner, root, config, record.base, base);
    // after-merge では、テストに関係するファイルが動いていても rebase して入れる
    const usable =
      drift.kind === "same" ||
      drift.kind === "irrelevant" ||
      (afterMerge && drift.kind === "relevant");
    let reason = recordMismatch(record, {
      head,
      base: usable && record ? record.base : base,
      commands,
    });
    if (reason !== null && record && record.base !== base) {
      if (drift.kind === "relevant" && !afterMerge)
        reason += `（テストに関係するファイル：${listFiles(drift.relevant)}）`;
      else if (drift.kind === "unknown") reason += `（${drift.why}）`;
    }
    if (reason !== null) throw await askVerifyAgain(reason);
    route = "record";
    if (drift.kind === "irrelevant" || drift.kind === "relevant") {
      mainChanged = drift.changed;
      rebaseNeeded = true;
      relevantDrift = drift.kind === "relevant";
    }
    // 記録の base が今の main と同じでも、タスクの先頭が main を含まないなら
    // （verify の最中に main が進んだ）、テストしていない合成の木になるので rebase する
    if (afterMerge && !rebaseNeeded) {
      const included = await ctx.runner(
        "git",
        ["merge-base", "--is-ancestor", base, head],
        { cwd: root },
      );
      if (included.code !== 0) {
        rebaseNeeded = true;
        notIncluded = true;
      }
    }
    recordCommands = record!.commands;
    if (!ctx.json)
      ctx.stdout(
        `${record!.at} に ${id} のコンソールで通った記録を使います${mainChanged.length > 0 ? `（記録のあと main で変わった${relevantDrift ? "ファイル。確かめはマージのあとの main の確かめに任せます" : "テストに関係しないファイル"}：${listFiles(mainChanged)}）` : ""}`,
      );
  }

  // Orca につながるかを先に確かめ、進捗表の書き換えを組み立てる
  await orca.ping();
  const progress = config.progress;
  const plan = await planProgress(ctx, root, config, (text) =>
    progress
      ? setCell(text, progress, id, "state", progress.stateLabels.integrated)
      : text,
  );

  // ④ rebase（記録が先頭と main に合っているときは要らない。
  //    main がテストに関係しないファイルだけ動いたときは、競合したら verify のやり直し）
  if (route !== "record")
    await rebaseOrAbort(ctx.runner, task.path, config.baseBranch, id);
  else if (rebaseNeeded) {
    try {
      await rebaseOrAbort(ctx.runner, task.path, config.baseBranch, id);
    } catch (error) {
      if (error instanceof FlowError && error.code === 3) {
        // 詳しい内容（競合したファイルなど）は標準エラーにだけ出す
        ctx.stderr(error.message);
        throw await askVerifyAgain(
          notIncluded
            ? "タスクの先頭が今の main を含んでいません（verify の最中に main が進みました）。rebase が競合しました"
            : relevantDrift
              ? "記録のあとに main が動きました。rebase が競合しました"
              : "記録のあとに main が動きました。テストに関係しない変更ですが、rebase が競合しました",
        );
      }
      throw error;
    }
  }

  // ⑤ verify と、当たる pathVerify（ここで流すときだけ）
  const verified = route === "here" ? commands : [];
  if (route === "here") {
    const failed = await runVerifyCommands(ctx, task.path, id, commands);
    if (failed !== null) return { code: 1, data: { id, failed } };
  }

  // ⑥ main にマージ
  await mergeNoFf(
    ctx.runner,
    root,
    task.branch,
    `${config.integratorName}: ${id} をマージする`,
  );

  // ⑥' マージのあとの main の確かめの記録（after-merge のとき）
  //    rebase が要らなかった（記録と同じ木）か、ここで流したなら「通った」。それ以外は「待ち」にして背景で確かめる
  //    起動は進捗表のコミットのあと（先に起動すると、進捗表のコミットで先頭が動いて知らせが2回送られる）
  let mainCheck: "same-tree" | "launched" | null = null;
  let recorded = false;
  const sameTree =
    afterMerge && (route === "here" || (route === "record" && !rebaseNeeded));
  if (afterMerge) {
    try {
      await recordMerge(ctx.runner, root, config, {
        commit: await runGit(
          ctx.runner,
          root,
          ["rev-parse", config.baseBranch],
          "git rev-parse",
        ).then((out) => out.trim()),
        id,
        sameTree,
        commands: sameTree
          ? route === "here"
            ? commands
            : recordCommands
          : [],
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

  // ⑦ 進捗表（失敗しても、確かめの起動はする）
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

  // 背景の確かめを起動する（同じ木でも起動する。先頭が同じ木なら run は流さず、知らせだけ送る）
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

  // ⑧ カード
  await setIntegratedCard(ctx, orca, task.path);

  // ⑨ 作業中のほかのタスクに知らせる（after-merge では確かめが通ってから別に送る）
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

  // ⑩ worktree を消す。ブランチは消さない
  const removed = args.flags.has("keep-worktree")
    ? false
    : await removeTaskWorktree(ctx, orca, id, task.path);

  const data = {
    id,
    branch: task.branch,
    files,
    recordsCopied: copied,
    verified,
    verifyRoute: route,
    mainChangedFiles: mainChanged,
    progressCommitted: committed,
    notified,
    mainCheck,
    worktreeRemoved: removed,
  };
  if (!ctx.json)
    ctx.stdout(
      afterMerge
        ? `${id} を ${config.baseBranch} にマージしました（${files.length} ファイル）。${mainCheck === "same-tree" ? "記録と同じ木なので、main の確かめは通ったことにしました" : mainCheck === "launched" ? "main の確かめを背景で始めました" : "main の確かめは始められていません"}。main が進んだ知らせは、確かめが通ってから送ります。push は人間が行ってください`
        : `${id} を ${config.baseBranch} にマージしました（${files.length} ファイル）。知らせを送ったタスク：${notified.join("、") || "なし"}。push は人間が行ってください`,
    );
  return { code: 0, data };
};
