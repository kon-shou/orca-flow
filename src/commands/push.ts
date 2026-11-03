import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireConfig, type FlowConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireIdShape } from "../lib/auto.ts";
import {
  checkDecisionsAppendOnly,
  checkTaskBeforeIntegration,
  copyIgnoredRecords,
  describeMainBusy,
  findPushTask,
  readPushRecord,
  tellLead,
  writePushRecord,
} from "../lib/finish.ts";
import {
  createDraftPr,
  envSecrets,
  findPr,
  pushTaskBranch,
  redactSecrets,
  requireGh,
  type GhContext,
  type PrInfo,
} from "../lib/github.ts";
import { requireIntegratorPlace, requireRoot, runGit } from "../lib/git.ts";
import { createOrca } from "../lib/orca.ts";
import {
  cleanupMergedPr,
  launchPushWatch,
  runPushWatch,
  showPushWatch,
  watcherRunning,
} from "../lib/push-watch.ts";
import { reportPath, taskDocPath } from "../lib/tasks.ts";
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
 * 背景の待ち受け（src/lib/push-watch.ts）を呼ぶ口。
 * 既定は push-watch.ts の関数。テストでは偽物を渡す
 */
export interface PushWatchDeps {
  /** push のあと、背景で `orca-flow push 〈ID〉 --watch` を起こす（終わりを待たない） */
  launch: (ctx: CommandContext, id: string) => Promise<void>;
  /** `--watch`：背景の入口。PR のマージか閉じるまで見続ける */
  run: (ctx: CommandContext, id: string) => Promise<CommandResult>;
  /** `--show`：今の様子を出す */
  show: (ctx: CommandContext, id: string) => Promise<CommandResult>;
}

const defaultDeps: PushWatchDeps = {
  launch: launchPushWatch,
  run: (ctx, id) => runPushWatch(ctx, id),
  show: showPushWatch,
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const USAGE = "使い方：orca-flow push 〈ID〉 [--body-file 〈パス〉] [--show]";
const TELL_REBASE_VERIFY =
  "rebase して orca-flow verify をやり直し、integrate-wait に戻す";

/** 設計書の見出し「# タスク 〈ID〉：〈タスク名〉」からタスク名を読む。なければ null */
export function taskTitleOf(docText: string, id: string): string | null {
  const heading = /^#\s+タスク\s+(\S+?)\s*[：:]\s*(.+?)\s*$/m.exec(docText);
  if (!heading || heading[1] !== id) return null;
  return heading[2] ?? null;
}

/**
 * PR の本文に書いてはいけないものを探す（パス・秘密）。当たった種類だけを返す（値は出さない）
 */
function bodyProblems(
  body: string,
  ctx: CommandContext,
  config: FlowConfig,
  root: string,
  task: { id: string; path: string },
): string[] {
  const kinds: string[] = [];
  const has = (needle: string | undefined) =>
    needle !== undefined && needle.length > 1 && body.includes(needle);
  if (has(root)) kinds.push("リポジトリのパス");
  if (
    [ctx.env.HOME, ctx.env.USERPROFILE, os.homedir()].some(
      (home) => has(home) && home !== path.parse(root).root,
    )
  )
    kinds.push("ホームのディレクトリのパス");
  if (has(task.path)) kinds.push("タスクの worktree のパス");
  if (has(taskDocPath(config, task.id))) kinds.push("設計書のパス");
  if (has(reportPath(config, task.id))) kinds.push("報告のパス");
  if (redactSecrets(body, envSecrets(ctx.env)) !== body)
    kinds.push("秘密らしい値");
  return kinds;
}

export function createPush(overrides: Partial<PushWatchDeps> = {}): Command {
  const deps: PushWatchDeps = { ...defaultDeps, ...overrides };
  return async (ctx) => {
    const args = parseArgs(ctx.argv, ["body-file"], ["show", "watch"]);
    const [id, ...rest] = args.positionals;
    if (!id || rest.length > 0) throw new FlowError(1, USAGE);
    requireIdShape(id);

    // 背景の入口と様子の表示
    if (args.flags.has("watch")) return deps.run(ctx, id);
    if (args.flags.has("show")) return deps.show(ctx, id);

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
      return wakeWatcher(ctx, deps, root, id, task.branch, open, head);

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
    await checkDecisionsAppendOnly(ctx, config, root, id, task, "push");

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

    // PR がまだなければ本文が要る。パスと秘密が入っていないことを、gh に渡す前に確かめる
    const bodyFile = args.values.get("body-file");
    let bodyPath: string | null = null;
    if (!open) {
      if (!bodyFile)
        throw new FlowError(
          1,
          `${id} はまだ PR がないので、本文が要ります。--body-file 〈パス〉 で本文のファイルを渡してください`,
        );
      bodyPath = path.resolve(ctx.cwd, bodyFile);
      let body: string;
      try {
        body = await readFile(bodyPath, "utf8");
      } catch (error) {
        throw new FlowError(
          1,
          `--body-file ${bodyFile} を読めませんでした（${message(error)}）`,
        );
      }
      const problems = bodyProblems(body, ctx, config, root, task);
      if (problems.length > 0)
        throw new FlowError(
          1,
          `PR の本文に、${problems.join("、")}が含まれています。消してから、もう一度 push してください（push も PR もしていません）`,
        );
    }

    // 無視された設計書と報告を、push の前にメインの作業ツリーへ写す
    const copied = await copyIgnoredRecords(
      root,
      result.checked,
      "push も PR もしていません",
    );

    // push（タスクのブランチだけ）。早送りにならないときは前の先頭を期待値にした --force-with-lease
    const expected = pushed?.pushedHead ?? open?.headSha ?? null;
    let forced = false;
    if (expected && expected !== head) {
      const fastForward = await ctx.runner(
        "git",
        ["merge-base", "--is-ancestor", expected, head],
        { cwd: root },
      );
      forced = fastForward.code !== 0;
    }
    await pushTaskBranch(g, task.branch, config.baseBranch, {
      expectedRemoteHead: forced && expected ? expected : undefined,
    });
    // push の直後に先頭を記録する（PR を出せなくても、打ち直しで lease の期待値が分かるように）
    await writePushRecord(ctx.runner, root, id, {
      id,
      branch: task.branch,
      base: config.baseBranch,
      pushedHead: head,
      pushedAt: ctx.now().toISOString(),
    });

    // 下書きの PR を出す（なければ）
    let prInfo: { number: number; url: string };
    let created = false;
    if (open) prInfo = { number: open.number, url: open.url };
    else {
      const title = taskTitleOf(result.checked.docText, id);
      prInfo = await createDraftPr(g, {
        base: config.baseBranch,
        head: task.branch,
        title: `${id}: ${title ?? task.branch.replace(/^.*?\//, "")}`,
        bodyFile: bodyPath!,
      });
      created = true;
    }
    await writePushRecord(ctx.runner, root, id, { id, pr: prInfo });

    // 背景の待ち受けを起こす（起こせなくても push と PR は済んでいる）
    const launched = await launchQuietly(ctx, deps, id);

    if (!ctx.json)
      ctx.stdout(
        `${id} を push しました。${created ? "下書きの PR を出しました" : "PR は出ています"}（#${prInfo.number} ${prInfo.url}）${forced ? "。早送りにならないので --force-with-lease で push し直しました" : ""}。${launched ? "背景で CI とマージを見ます。マージは GitHub で人が行ってください" : "背景の待ち受けは起きていません"}`,
      );
    return {
      code: 0,
      data: {
        id,
        branch: task.branch,
        pr: prInfo,
        created,
        forced,
        pushedHead: head,
        recordsCopied: copied,
        watching: launched,
      },
    };
  };
}

/** 待ち受けを起こす。起こせなければ警告だけ出して false */
async function launchQuietly(
  ctx: CommandContext,
  deps: PushWatchDeps,
  id: string,
): Promise<boolean> {
  try {
    await deps.launch(ctx, id);
    return true;
  } catch (error) {
    ctx.stderr(
      `警告：背景の待ち受けを起こせませんでした（${redactSecrets(message(error), envSecrets(ctx.env))}）。orca-flow push ${id} をもう一度打つと起こし直します`,
    );
    return false;
  }
}

/** 先頭が変わっていない 2 回目の push：確かめも push もせず、待ち受けが止まっていれば起こし直す */
async function wakeWatcher(
  ctx: CommandContext,
  deps: PushWatchDeps,
  root: string,
  id: string,
  branch: string,
  pr: PrInfo,
  head: string,
): Promise<CommandResult> {
  const running = await watcherRunning(ctx, root, id);
  const launched = running.running ? true : await launchQuietly(ctx, deps, id);
  if (!ctx.json)
    ctx.stdout(
      `${id} は push 済みで、先頭は変わっていません（PR #${pr.number} ${pr.url}）。${running.running ? "背景の待ち受けは動いています" : launched ? "背景の待ち受けを起こし直しました" : "背景の待ち受けは起きていません"}`,
    );
  return {
    code: 0,
    data: {
      id,
      branch,
      pr: { number: pr.number, url: pr.url },
      created: false,
      forced: false,
      pushedHead: head,
      woke: !running.running,
      watching: launched,
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
  });
  if (out.kind === "watching") {
    if (!ctx.json)
      ctx.stdout(
        `${task.id} の PR #${pr.number} はマージ済みで、待ち受けが後始末をしています（プロセス ${out.pid ?? "不明"}）。終わるまで待ってください。様子は orca-flow push ${task.id} --show で見られます`,
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
