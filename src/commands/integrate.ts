import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  acquireMainLock,
  checkDecisionsAppendOnly,
  checkTaskBeforeIntegration,
  completeMerge,
  copyIgnoredRecords,
  markIntegrated,
  removeTaskWorktree,
  setIntegratedCard,
  tellLead,
} from "../lib/finish.ts";
import {
  mergeNoFf,
  rebaseOrAbort,
  requireActiveTask,
  requireIntegratorPlace,
  requireRoot,
  runGit,
} from "../lib/git.ts";
import {
  failedMainLine,
  mainCheckState,
  shortCommit,
  uncheckedDetail,
  unsentNoticeWarnings,
  type MainCheckStatus,
} from "../lib/main-check.ts";
import { createOrca } from "../lib/orca.ts";
import { setCell } from "../lib/progress.ts";
import { applyProgress, planProgress } from "../lib/tasks.ts";
import {
  allInSkipPaths,
  baseDrift,
  commandsFor,
  readRecord,
  recordMismatch,
  runVerifyCommands,
  type BaseDrift,
} from "../lib/verified.ts";
import { FlowError, type Command } from "../types.ts";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** 知らせごとに、tell で伝えること */
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

/** 統括役が範囲の確認・テスト・マージを行う（8章 integrate） */
export const run: Command = async (ctx) => {
  const args = parseArgs(
    ctx.argv,
    [],
    [
      "keep-worktree",
      "verify-here",
      "fixes-main",
      "skip-order",
      "skip-decision",
    ],
  );
  const [id, ...rest] = args.positionals;
  if (!id || rest.length > 0)
    throw new FlowError(
      1,
      "使い方：orca-flow integrate 〈ID〉 [--keep-worktree] [--verify-here] [--fixes-main] [--skip-order] [--skip-decision]",
    );

  // ① 統括役の場所の確認
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  await requireIntegratorPlace(ctx.runner, root, config);
  const task = await requireActiveTask(ctx.runner, root, config, id);

  // ②③ 未コミットの変更・報告・範囲・決定の記録・マージの順・追跡された記録
  const result = await checkTaskBeforeIntegration(ctx, config, root, id, task, {
    skipDecision: args.flags.has("skip-decision"),
    skipOrder: args.flags.has("skip-order"),
    verb: "integrate",
  });
  if (result.kind === "outside")
    return { code: 1, data: { id, outside: result.outside } };
  const { docFile, reportFile, files } = result.checked;

  // 差分がないタスクは、マージ済みにならないので worktree を残せない（作業中のまま残るため）
  if (files.length === 0 && args.flags.has("keep-worktree"))
    throw new FlowError(
      1,
      `${id} は差分がないのでマージのコミットができず、ブランチがマージ済みになりません。--keep-worktree をつけると作業中のまま残るので、何もせず止まりました。--keep-worktree を外して、もう一度 integrate してください`,
    );

  // 無視された記録を、マージの前にメインの作業ツリーの同じパスへ写す（写せなければ止める）
  const copied = await copyIgnoredRecords(
    root,
    result.checked,
    "マージも worktree の削除もしていません",
  );

  // main を書き換える間（マージから後始末まで）は、背景の後始末と同じロックを取る
  const releaseMain = await acquireMainLock(ctx, root);
  try {
    // 差分がない（記録しか変えないタスクで、記録は無視されている）：
    // マージのコミットができないので、マージ・main の確かめの記録・知らせはせず、進捗表・カード・worktree の片づけだけ行う。
    // verify も流さない（コードが変わらないため）
    if (files.length === 0) {
      const orca = createOrca(ctx.runner, root);
      await orca.ping();
      const progress = config.progress;
      const plan = await planProgress(ctx, root, config, (text) =>
        progress
          ? setCell(
              text,
              progress,
              id,
              "state",
              progress.stateLabels.integrated,
            )
          : text,
      );
      const committed = await applyProgress(
        ctx.runner,
        root,
        plan,
        `${config.integratorName}: ${id} の統合を進捗に記録する`,
      );
      await markIntegrated(ctx, root, id, null);
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
      await tellLead(
        ctx,
        config,
        orca,
        id,
        task.path,
        "verify のやり直しの知らせ",
        TELL_VERIFY_AGAIN,
        `${reason}。orca-flow verify をやり直して、status integrate-wait に戻してください。`,
      );
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

    // ④' 決定の記録が追記だけか（merge=union の rebase で行が消えるのを止める。--skip-decision でも飛ばさない）
    await checkDecisionsAppendOnly(ctx, config, root, id, task, "integrate");

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

    // ⑥〜⑩ 後始末（統合済みの印・main の確かめ・進捗表・カード・知らせ・worktree）
    const sameTree =
      afterMerge && (route === "here" || (route === "record" && !rebaseNeeded));
    const done = await completeMerge(ctx, config, root, task, {
      orca,
      sameTree,
      commands: route === "here" ? commands : recordCommands,
      plan,
      keepWorktree: args.flags.has("keep-worktree"),
    });
    const { mainCheck, notified } = done;

    const data = {
      id,
      branch: task.branch,
      files,
      recordsCopied: copied,
      verified,
      verifyRoute: route,
      mainChangedFiles: mainChanged,
      progressCommitted: done.progressCommitted,
      notified,
      mainCheck,
      worktreeRemoved: done.worktreeRemoved,
    };
    if (!ctx.json)
      ctx.stdout(
        afterMerge
          ? `${id} を ${config.baseBranch} にマージしました（${files.length} ファイル）。${mainCheck === "same-tree" ? "記録と同じ木なので、main の確かめは通ったことにしました" : mainCheck === "launched" ? "main の確かめを背景で始めました" : "main の確かめは始められていません"}。main が進んだ知らせは、確かめが通ってから送ります。push は人間が行ってください`
          : `${id} を ${config.baseBranch} にマージしました（${files.length} ファイル）。知らせを送ったタスク：${notified.join("、") || "なし"}。push は人間が行ってください`,
      );
    return { code: 0, data };
  } finally {
    await releaseMain();
  }
};
