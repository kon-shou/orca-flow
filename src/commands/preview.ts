import { mkdir } from "node:fs/promises";
import path from "node:path";
import { requireFlowConfig } from "../lib/flow-config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  activeTasks,
  gitCommonDir,
  mainWorktreePath,
  requireRoot,
} from "../lib/git.ts";
import { staleBranchWarnings } from "../lib/branch-push.ts";
import { readCrossDepends } from "../lib/cross-depends.ts";
import { launchBackground } from "../lib/background.ts";
import { createOrca, type Orca } from "../lib/orca.ts";
import { startPreviewBase, stopPreviewBase } from "../lib/preview-base.ts";
import {
  startCompanionBase,
  stopCompanionBase,
  type CompanionBaseOwner,
} from "../lib/companion-base.ts";
import { companionBaseApps, readCompanion } from "../lib/companion.ts";
import { samePath } from "../lib/paths.ts";
import {
  noStopTargetMessage,
  readPreviewRecord,
  removePreviewRecord,
  stopPreview,
  terminalAlive,
  previewDeps,
  TERMINAL_TITLE,
  waitForPreview,
  waitForSetup,
  withPreviewLock,
  writePreviewRecord,
  type PreviewRecord,
} from "../lib/preview.ts";
import { commonRecordPath, hasIdShape } from "../lib/task-id.ts";
import type { FlowConfig } from "../config.ts";
import {
  FlowError,
  type Command,
  type CommandContext,
  type CommandResult,
} from "../types.ts";

const USAGE =
  "使い方：orca-flow preview 〈ID〉 [--stop|--restart|--after-setup|--no-open] [--base|--companion-base --owner 〈E2E のリポジトリのパス〉]";

/**
 * タスクのアプリを起動して開く（--no-open で開かない）。--stop で止め、--restart で立て直す（8章 preview）。
 * --base はブランチの分かれ目のアプリ（前の画面）を別に立てる／止める。
 * --companion-base は、ID の E2E のタスクのために、このアプリの baseBranch の先頭（土台のアプリ）を立てる／止める
 */
export const run: Command = async (ctx) => {
  const args = parseArgs(
    ctx.argv,
    ["owner"],
    [
      "stop",
      "restart",
      "restart-now",
      "after-setup",
      "no-open",
      "base",
      "companion-base",
    ],
  );
  const id = args.positionals[0];
  if (id === undefined || args.positionals.length !== 1 || !hasIdShape(id))
    throw new FlowError(1, USAGE);
  const stop = args.flags.has("stop");
  const restart = args.flags.has("restart");
  // restart-now は --restart が起こす背景の子の内側の印（手では打たない）
  const restartNow = args.flags.has("restart-now");
  const afterSetup = args.flags.has("after-setup");
  const noOpen = args.flags.has("no-open") || restartNow;
  const base = args.flags.has("base");
  const companionBase = args.flags.has("companion-base");
  const owner = args.values.get("owner");
  if (
    [stop, restart, restartNow].filter(Boolean).length > 1 ||
    (stop && (afterSetup || noOpen)) ||
    ((base || companionBase) && (restart || restartNow || afterSetup)) ||
    (base && companionBase) ||
    (owner !== undefined && !companionBase)
  )
    throw new FlowError(1, USAGE);

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  const orca = createOrca(ctx.runner, root);
  const common = await gitCommonDir(ctx.runner, root);
  const preview = config.preview;

  if (base) return previewBase(ctx, { root, config, orca, common, id });
  if (companionBase)
    return previewCompanionBase(ctx, {
      root,
      config,
      orca,
      common,
      id,
      stop,
      noOpen,
      owner,
    });

  if (stop) {
    const record = await readPreviewRecord(common, id);
    const task = (await activeTasks(ctx.runner, root, config)).find(
      (t) => t.id === id,
    );
    if (preview === null && record === null) throw noPreviewConfig();
    const worktree = task?.path ?? record?.worktree;
    if (worktree === undefined) throw new FlowError(1, noStopTargetMessage(id));
    const outcome = await stopPreview(
      ctx,
      orca,
      common,
      id,
      worktree,
      preview?.down,
      { force: false },
    );
    if (!ctx.json)
      ctx.stdout(
        outcome.hadRecord || outcome.ranDown
          ? `${id} のアプリを止めました`
          : `${id} には止めるものがありません`,
      );
    return { code: 0, data: { id, ...outcome } };
  }

  if (restart) {
    const record =
      preview === null ? null : await readPreviewRecord(common, id);
    if (preview === null || record === null) {
      if (!ctx.json)
        ctx.stdout(
          `${id} には立て直すアプリがありません（${preview === null ? "preview の設定がありません" : "起動の記録がありません"}）`,
        );
      return { code: 0, data: { id, restarted: false } };
    }
    const logFile = commonRecordPath(common, "preview-restart", id, ".log");
    await mkdir(path.dirname(logFile), { recursive: true });
    await launchBackground(ctx.runner, {
      cwd: root,
      log: logFile,
      args: ["preview", id, "--restart-now"],
      failure: (reason) =>
        `${id} のアプリの立て直しを起動できませんでした：${reason}。orca-flow preview ${id} --stop のあと orca-flow preview ${id} --no-open で手でやり直してください`,
    });
    if (!ctx.json)
      ctx.stdout(
        `${id} のアプリの立て直しを背景で始めました。ログ：${logFile}`,
      );
    return { code: 0, data: { id, restarted: true, log: logFile } };
  }

  if (preview === null) throw noPreviewConfig();
  const task = (await activeTasks(ctx.runner, root, config)).find(
    (t) => t.id === id,
  );
  if (!task)
    throw new FlowError(
      1,
      `作業中のタスクに ${id} が見つかりません（${config.branchPrefix}${id}-… のブランチの worktree がないか、すでにマージ済みです）`,
    );

  if (restartNow) {
    await stopPreview(ctx, orca, common, id, task.path, preview.down, {
      force: false,
    });
  }
  if (afterSetup && (await waitForSetup(common, id)) === "timeout")
    throw new FlowError(
      1,
      `${id} の setup の終わり（最初の status）を ${Math.round(previewDeps.setupWaitMs / 60_000)} 分待ちましたが出ませんでした。アプリは立てていません。setup を確かめてから orca-flow preview ${id} を打ってください`,
    );

  // 動いている記録があれば、起動し直さない。なければ（ターミナルが消えていれば記録を捨てて）起動する
  const started = await withPreviewLock(
    common,
    id,
    async (): Promise<{ record: PreviewRecord; fresh: boolean }> => {
      const existing = await readPreviewRecord(common, id);
      if (existing !== null) {
        if (await terminalAlive(orca, existing.worktree, existing.terminal))
          return { record: existing, fresh: false };
        await removePreviewRecord(common, id);
      }
      await warnStaleBranches(ctx, root, task.path, id);
      const handle = await orca.createTerminal(task.path, TERMINAL_TITLE);
      const record: PreviewRecord = {
        id,
        worktree: task.path,
        terminal: handle,
        at: ctx.now().toISOString(),
      };
      await writePreviewRecord(common, record);
      try {
        await orca.sendText(handle, preview.up);
      } catch (error) {
        try {
          await orca.closeTerminal(handle);
        } catch {
          // 閉じられなくても、元の失敗を伝える
        }
        await removePreviewRecord(common, id);
        throw error;
      }
      return { record, fresh: true };
    },
  );
  const record = started.record;

  const waited = await waitForPreview(
    orca,
    preview,
    record.terminal,
    record.url,
  );
  if (waited.kind === "timeout")
    throw new FlowError(
      1,
      `${id} のアプリが ${preview.timeoutSeconds} 秒たっても答えませんでした（開く URL が出ないか、URL が答えません）。起動のターミナルと記録は残してあります。Orca の ${record.worktree} のターミナル「${TERMINAL_TITLE}」で出力を確かめてください。片づけるには orca-flow preview ${id} --stop`,
    );

  const url = waited.url;
  // 待つ間に別のタブの --stop や起動し直し、統合の仕上げが記録を消す・置き換えることがある。
  // ロックの中で読み直し、同じターミナルの記録のときだけ書く
  const current = await withPreviewLock(common, id, async () => {
    const latest = await readPreviewRecord(common, id);
    if (latest === null || latest.terminal !== record.terminal) return latest;
    if (latest.url !== url)
      await writePreviewRecord(common, { ...latest, url });
    return latest;
  });
  if (current === null || current.terminal !== record.terminal)
    throw new FlowError(
      1,
      current === null
        ? `${id} のアプリは待っている間に止められたので、ブラウザは開いていません。もう一度 orca-flow preview ${id} を打ってください`
        : `${id} の起動は待っている間に別の起動に置き換わったので、ブラウザは開いていません。もう一度 orca-flow preview ${id} を打ってください`,
    );
  if (!noOpen) await orca.openUrlTab(record.worktree, url);
  if (!ctx.json)
    ctx.stdout(
      `${id} のアプリを${noOpen ? "立てました" : "Orca のブラウザで開きました"}：${url}${started.fresh ? "" : "（起動済みだったので、起動し直していません）"}。止めるには orca-flow preview ${id} --stop`,
    );
  return { code: 0, data: { id, url, started: started.fresh } };
};

async function previewBase(
  ctx: CommandContext,
  input: {
    root: string;
    config: FlowConfig;
    orca: Orca;
    common: string;
    id: string;
  },
): Promise<CommandResult> {
  const { root, config, orca, common, id } = input;
  const stop = ctx.argv.includes("--stop");
  const preview = config.preview;
  if (stop) {
    const outcome = await stopPreviewBase(ctx, orca, {
      cwd: root,
      common,
      id,
      down: preview?.down,
      force: false,
    });
    const had =
      outcome.hadRecord || outcome.hadLeftover || outcome.removedWorktree;
    if (!ctx.json)
      ctx.stdout(
        had
          ? `${id} の前の画面を止めました`
          : `${id} には止める前の画面がありません`,
      );
    return { code: 0, data: { id, base: true, ...outcome } };
  }
  if (preview === null) throw noPreviewConfig();
  const task = (await activeTasks(ctx.runner, root, config)).find(
    (t) => t.id === id,
  );
  if (!task)
    throw new FlowError(
      1,
      `作業中のタスクに ${id} が見つかりません（${config.branchPrefix}${id}-… のブランチの worktree がないか、すでにマージ済みです）`,
    );
  const result = await startPreviewBase(ctx, orca, {
    root,
    common,
    config,
    preview,
    task,
    id,
    noOpen: ctx.argv.includes("--no-open"),
  });
  if (!ctx.json)
    ctx.stdout(
      `${id} の前の画面を${ctx.argv.includes("--no-open") ? "立てました" : "Orca のブラウザで開きました"}：${result.url}${result.started ? "" : "（起動済みだったので、起動し直していません）"}。止めるには orca-flow preview ${id} --base --stop`,
    );
  return {
    code: 0,
    data: {
      id,
      base: true,
      url: result.url,
      started: result.started,
      worktree: result.worktree,
      commit: result.commit,
    },
  };
}

async function previewCompanionBase(
  ctx: CommandContext,
  input: {
    root: string;
    config: FlowConfig;
    orca: Orca;
    common: string;
    id: string;
    stop: boolean;
    noOpen: boolean;
    owner: string | undefined;
  },
): Promise<CommandResult> {
  const { root, config, orca, common, id } = input;
  const preview = config.preview;
  if (input.stop) {
    const resolved =
      input.owner === undefined
        ? undefined
        : await resolveOwner(ctx, root, id, input.owner, { forStop: true });
    const outcome = await stopCompanionBase(ctx, orca, {
      cwd: root,
      common,
      id,
      down: preview?.down,
      force: false,
      ...(resolved !== undefined
        ? { owner: resolved.owner, ownerRepoOnly: resolved.repoOnly }
        : {}),
    });
    const had =
      outcome.hadRecord || outcome.hadLeftover || outcome.removedWorktree;
    if (!ctx.json)
      ctx.stdout(
        had
          ? `${id} の土台のアプリを止めました`
          : `${id} には止める土台のアプリがありません`,
      );
    return { code: 0, data: { id, companionBase: true, ...outcome } };
  }
  if (input.owner === undefined)
    throw new FlowError(
      1,
      `土台のアプリを立てるには、持ち主の E2E のリポジトリを --owner 〈パス〉 で渡してください（ふつうは orca-flow workspace --preview 〈ブランチ名〉 が渡します）\n${USAGE}`,
    );
  if (preview === null) throw noPreviewConfig();
  const { owner } = await resolveOwner(ctx, root, id, input.owner, {
    forStop: false,
  });
  const result = await startCompanionBase(ctx, orca, {
    root,
    common,
    config,
    preview,
    id,
    owner,
    noOpen: input.noOpen,
  });
  if (!ctx.json)
    ctx.stdout(
      `${id} の土台のアプリ（${config.baseBranch} の先頭）を${input.noOpen ? "立てました" : "Orca のブラウザで開きました"}：${result.url}${result.started ? (result.restarted ? `（${config.baseBranch} の先頭が進んでいたので立て直しました）` : "") : "（起動済みだったので、起動し直していません）"}。止めるには orca-flow preview ${id} --companion-base --stop`,
    );
  return {
    code: 0,
    data: {
      id,
      companionBase: true,
      url: result.url,
      started: result.started,
      restarted: result.restarted,
      worktree: result.worktree,
      commit: result.commit,
    },
  };
}

/**
 * --owner の E2E のリポジトリの伴う記録から、持ち主（リポジトリの実のパスと taskBranch）を決める。
 * 立てるときは、記録があり、このアプリが baseApps にあることを確かめる（外れれば FlowError(1)）。
 * 止めるときは、記録がなければリポジトリだけで比べる
 */
async function resolveOwner(
  ctx: CommandContext,
  root: string,
  id: string,
  ownerPath: string,
  options: { forStop: boolean },
): Promise<{ owner: CompanionBaseOwner; repoOnly: boolean }> {
  let repo: string;
  try {
    repo = await mainWorktreePath(ctx.runner, ownerPath);
  } catch {
    throw new FlowError(
      1,
      `--owner の ${ownerPath} は git のリポジトリではありません`,
    );
  }
  const companion = await readCompanion(ctx.runner, repo, id);
  if (companion === null) {
    if (options.forStop) return { owner: { repo }, repoOnly: true };
    throw new FlowError(
      1,
      `${repo} に ${id} の伴う記録がありません。土台のアプリは E2E のタスクのために立てます`,
    );
  }
  const owner: CompanionBaseOwner = {
    repo,
    ...(companion.taskBranch !== undefined
      ? { taskBranch: companion.taskBranch }
      : {}),
  };
  if (!options.forStop) {
    const self = await mainWorktreePath(ctx.runner, root);
    if (!companionBaseApps(companion).some((a) => samePath(a.path, self)))
      throw new FlowError(
        1,
        `${repo} の ${id} の伴う記録の baseApps に、このアプリ（${self}）がありません`,
      );
  }
  return { owner, repoOnly: false };
}

function noPreviewConfig(): FlowError {
  return new FlowError(
    2,
    ".orca-flow/config.json に preview が設定されていません。preview を足すのは統括役です（統括役に頼んでください）",
  );
}

/** 起動の前に、共通の枝の取り込みが古いかを確かめ、警告だけ出す（verify と同じ見分け） */
async function warnStaleBranches(
  ctx: CommandContext,
  root: string,
  worktree: string,
  id: string,
): Promise<void> {
  try {
    const record = await readCrossDepends(ctx.runner, root, id);
    for (const warning of await staleBranchWarnings(
      ctx.runner,
      worktree,
      record?.repos ?? [],
    ))
      ctx.stderr(`警告：${warning}`);
  } catch {
    // 記録が読めなくても起動は止めない
  }
}
