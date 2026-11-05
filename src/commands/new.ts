import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import {
  activeTasks,
  currentBranch,
  listBranches,
  listWorktrees,
  requireIntegratorPlace,
  requireRoot,
  runGit,
} from "../lib/git.ts";
import { acquireMainLock } from "../lib/finish.ts";
import { newRecord, readAuto, withOff, writeAuto } from "../lib/auto.ts";
import { shellQuote } from "../lib/detect.ts";
import {
  parseCrossDependsJson,
  writeCrossDependsAt,
  type CrossDependsRepo,
} from "../lib/cross-depends.ts";
import {
  removeBranchPushMarkAt,
  writeBranchPushMarkAt,
} from "../lib/branch-push.ts";
import { writeDependsAt } from "../lib/depends.ts";
import { cardForState, createOrca, displayName } from "../lib/orca.ts";
import { recordStage } from "../lib/stage-log.ts";
import { addRow, progressIds } from "../lib/progress.ts";
import {
  commonRecordPath,
  idProblem,
  isTaskIdShape,
  nextTaskId,
  type IdSources,
} from "../lib/task-id.ts";
import {
  applyProgress,
  planProgress,
  readProgressText,
  taskDocPath,
} from "../lib/tasks.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";
import { SLUG_PATTERN } from "../lib/slug.ts";

/** 作成のあと、worktree とブランチが残っているかを確かめる時間（ミリ秒）。Orca の実測では作成の約5秒後に削除が始まり約8秒後に消えた */
export const VERIFY_WINDOW_MS = 15_000;
/** 確かめる間隔（ミリ秒） */
export const VERIFY_INTERVAL_MS = 500;
/** 親から子の new を流したときだけ付く環境変数。子はこれがないと --allow-branch-push を断り、外のコマンドへは渡さない */
export const FROM_WORKSPACE_ENV = "ORCA_FLOW_FROM_WORKSPACE";
/** テストで待ち時間を短くする環境変数 */
export const VERIFY_WINDOW_ENV = "ORCA_FLOW_NEW_VERIFY_MS";
export const VERIFY_INTERVAL_ENV = "ORCA_FLOW_NEW_VERIFY_INTERVAL_MS";

const ORCA_LOG_DIR = "~/Library/Application Support/Orca/logs/";

function envMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 消せなかった元の理由（失敗のコード（EACCES など）、なければ失敗の文） */
function failureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

interface Presence {
  folder: boolean;
  line: boolean;
  branch: boolean;
}

/** worktree のフォルダ・git worktree list の行・ブランチが残っているかを調べる */
async function inspect(
  ctx: CommandContext,
  root: string,
  wtPath: string,
  branch: string | null,
): Promise<Presence> {
  const folder = await exists(wtPath);
  const target = await real(wtPath);
  const listed = await listWorktrees(ctx.runner, root);
  let line = false;
  for (const entry of listed)
    if (entry.path === wtPath || (await real(entry.path)) === target)
      line = true;
  const hasBranch =
    branch !== null && (await listBranches(ctx.runner, root)).includes(branch);
  return { folder, line, branch: hasBranch };
}

function missingOf(p: Presence, branch: string | null): string[] {
  const missing: string[] = [];
  if (!p.folder) missing.push("worktree のフォルダ");
  if (!p.line) missing.push("git worktree list の行");
  if (branch !== null && !p.branch) missing.push(`ブランチ ${branch}`);
  return missing;
}

/**
 * 残ったものの一覧と、片付けの案内。
 * branch が null のときは、ブランチを残りにも欠けにも入れない
 */
function leftoverText(
  presence: Presence,
  wtPath: string,
  branch: string | null,
  stopLeadFirst = false,
): { remaining: string; tidy: string } {
  const left: string[] = [];
  if (presence.line) left.push("git worktree list の行");
  if (branch !== null && presence.branch) left.push(`ブランチ ${branch}`);
  if (presence.folder) left.push("worktree のフォルダ");
  // ブランチは worktree を片付けたあとでないと消せないので、この順に出す
  const cleanup: string[] = [];
  let folderOnly = false;
  if (presence.folder && presence.line)
    cleanup.push(`git worktree remove --force ${shellQuote(wtPath)}`);
  else if (presence.folder) folderOnly = true;
  else if (presence.line) cleanup.push("git worktree prune");
  if (branch !== null && presence.branch)
    cleanup.push(`git branch -D ${shellQuote(branch)}`);
  const remaining =
    left.length > 0 ? `\n  残っているもの：${left.join("、")}` : "";
  let tidy = "";
  if (folderOnly)
    tidy += `\nフォルダ ${shellQuote(wtPath)} は git の管理から外れて残っています。中を確かめてから、フォルダを消してください`;
  if (cleanup.length > 0) {
    const lead = stopLeadFirst
      ? `先に Orca でタスク長を止めてから、${folderOnly ? "" : "中を確かめて、"}`
      : `残ったものは、${folderOnly ? "" : "中を確かめてから、"}`;
    tidy += `\n${lead}メインのチェックアウトで次を流して片付けてください：\n${cleanup.map((c) => `  ${c}`).join("\n")}`;
  }
  if (branch === null)
    tidy +=
      "\nOrca がつけたブランチが残っているかもしれません。git branch で確かめ、あれば消してください";
  tidy += tidy
    ? "\n片付けたら、もう一度 /orca-flow:new を流してください"
    : "\nもう一度 /orca-flow:new を流してください";
  return { remaining, tidy };
}

function vanishedError(
  presence: Presence,
  wtPath: string,
  branch: string | null,
): FlowError {
  const missing = missingOf(presence, branch);
  const { remaining, tidy } = leftoverText(presence, wtPath, branch);
  return new FlowError(
    1,
    `作った worktree が消えました。欠けたもの：${missing.join("、")}${remaining}\n  worktree：${wtPath}\n  Orca のログ：${ORCA_LOG_DIR}\n進捗表は書いていません。${tidy}`,
  );
}

/** git worktree list のその worktree の行のブランチ（行がない・読めない・切り離しなら null） */
async function branchFromList(
  ctx: CommandContext,
  root: string,
  wtPath: string,
): Promise<string | null> {
  try {
    const target = await real(wtPath);
    for (const entry of await listWorktrees(ctx.runner, root))
      if (entry.path === wtPath || (await real(entry.path)) === target)
        return entry.branch;
  } catch {
    // 読めなくても止めない
  }
  return null;
}

/**
 * ⑤の失敗のとき、フォルダか worktree list の行が欠けていれば消えたものとして扱う。
 * 消えていなければ、元のエラーに残っていること・片付けを添えて投げる。
 * branch は Orca がつけた元のブランチ（分からなければ null）
 */
async function failAfterRenameError(
  ctx: CommandContext,
  root: string,
  wtPath: string,
  branch: string | null,
  error: unknown,
): Promise<never> {
  let presence: Presence;
  try {
    presence = await inspect(ctx, root, wtPath, branch);
  } catch {
    throw error;
  }
  if (!presence.folder || !presence.line)
    throw vanishedError(presence, wtPath, branch);
  const { remaining, tidy } = leftoverText(presence, wtPath, branch, true);
  const original = error instanceof Error ? error.message : String(error);
  throw new FlowError(
    1,
    `${original}\n作った worktree は消えずに残っています。${remaining}\n  worktree：${wtPath}\n進捗表は書いていません。\nOrca ではタスク長がもう動いています。${tidy}`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 統括役がタスクを始める（8章 new） */
export const run: Command = async (rawCtx) => {
  // 親の印は子の new だけが読み、Orca や git などの外のコマンドへは渡さない
  const fromWorkspace = (rawCtx.env[FROM_WORKSPACE_ENV] ?? "") !== "";
  const ctx: CommandContext = {
    ...rawCtx,
    runner: (cmd, cmdArgs, opts) => {
      const env = { ...(opts?.env ?? rawCtx.env) };
      delete env[FROM_WORKSPACE_ENV];
      return rawCtx.runner(cmd, cmdArgs, { ...opts, env });
    },
  };
  const args = parseArgs(
    ctx.argv,
    ["title", "slug", "id", "depends", "request-file", "cross-depends-json"],
    ["auto", "allow-branch-push"],
  );
  const auto = args.flags.has("auto");
  const allowBranchPush = args.flags.has("allow-branch-push");
  if (allowBranchPush && !fromWorkspace)
    throw new FlowError(
      1,
      "--allow-branch-push は子のリポジトリで直には付けられません。親のワークスペースで orca-flow workspace 〈名前〉 new --allow-branch-push を流してください",
    );
  if (args.positionals.length > 0)
    throw new FlowError(1, `知らない引数です：${args.positionals.join(" ")}`);
  const title = args.values.get("title")?.trim();
  const slug = args.values.get("slug")?.trim();
  if (!title || !slug)
    throw new FlowError(
      1,
      "使い方：orca-flow new --title 〈タスク名〉 --slug 〈短い名前〉 [--id 〈ID〉] [--depends 〈ID〉,〈ID〉] [--request-file 〈パス〉] [--cross-depends-json 〈JSON〉] [--allow-branch-push] [--auto]",
    );
  if (!SLUG_PATTERN.test(slug))
    throw new FlowError(
      1,
      `--slug は英小文字・数字・「-」にしてください：${slug}`,
    );
  const depends = (args.values.get("depends") ?? "")
    .split(/[,、\s]+/)
    .filter((d) => d !== "");
  // またぐ依存は、ロック・Orca より前に形を確かめる（外れたら何も作らない）
  const crossRepos: CrossDependsRepo[] = args.values.has("cross-depends-json")
    ? parseCrossDependsJson(args.values.get("cross-depends-json")!)
    : [];
  let requestText: string | null = null;
  const requestFile = args.values.get("request-file")?.trim();
  if (args.values.has("request-file")) {
    if (!requestFile)
      throw new FlowError(1, "--request-file にパスを指定してください");
    const requestAbs = path.resolve(ctx.cwd, requestFile);
    let isFile = false;
    try {
      isFile = (await stat(requestAbs)).isFile();
    } catch {
      throw new FlowError(
        1,
        `--request-file のファイルを読めません：${requestFile}`,
      );
    }
    if (!isFile)
      throw new FlowError(
        1,
        `--request-file は通常のファイルにしてください：${requestFile}`,
      );
    try {
      requestText = await readFile(requestAbs, "utf8");
    } catch {
      throw new FlowError(
        1,
        `--request-file のファイルを読めません：${requestFile}`,
      );
    }
    if (requestText.trim() === "")
      throw new FlowError(
        1,
        `--request-file のファイルが空です：${requestFile}`,
      );
  }

  // ① 統括役の場所の確認
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  // 依存の ID の形は、ロック・Orca・依頼のファイルより前に確かめる
  const badDepends = depends.filter((d) => !isTaskIdShape(d, config.idPrefix));
  if (badDepends.length > 0)
    throw new FlowError(
      1,
      `--depends の ID の形が違います：${badDepends.join("、")}（${config.idPrefix} と数字の形で書いてください）`,
    );
  await requireIntegratorPlace(ctx.runner, root, config);

  // 統括役の場所の確認の直後から進捗表のコミットまで、main を書き換える他の処理と同じロックを取る
  const releaseMain = await acquireMainLock(ctx, root, "new");
  let id: string;
  let branch: string;
  let common: string;
  let requestPath: string | null = null;
  let created: Awaited<
    ReturnType<ReturnType<typeof createOrca>["createWorktree"]>
  >;
  let label: string;
  let committed: boolean;
  let designingAt: Date;
  try {
    // ② 作業中のタスクの上限
    const active = await activeTasks(ctx.runner, root, config);
    if (active.length >= config.maxActiveTasks)
      throw new FlowError(
        2,
        `作業中のタスクが上限（${config.maxActiveTasks}）に達しています：${active.map((t) => t.id).join("、")}。どれかを統合してから始めてください`,
      );

    // ③ ID を決める
    let taskFiles: string[] = [];
    try {
      taskFiles = await readdir(path.join(root, config.tasksDir));
    } catch {
      taskFiles = [];
    }
    const progressText = await readProgressText(root, config);
    const sources: IdSources = {
      idPrefix: config.idPrefix,
      branchPrefix: config.branchPrefix,
      taskFiles,
      progressIds:
        progressText && config.progress
          ? progressIds(progressText, config.progress)
          : [],
      branches: await listBranches(ctx.runner, root),
    };
    const requested = args.values.get("id")?.trim();
    if (requested) {
      const problem = idProblem(requested, sources);
      if (problem) throw new FlowError(1, problem);
    }
    id = requested || nextTaskId(sources);
    branch = `${config.branchPrefix}${id}-${slug}`;
    if (sources.branches.includes(branch))
      throw new FlowError(1, `ブランチ ${branch} はすでにあります`);

    // 進捗表の行は先に組み立てておく
    const progress = config.progress;
    const plan = await planProgress(ctx, root, config, (text) =>
      progress
        ? addRow(text, progress, {
            id,
            title,
            depends: depends.length > 0 ? depends.join("、") : "—",
            state: progress.stateLabels.designing,
            branch,
          })
        : text,
    );

    common = (
      await runGit(
        ctx.runner,
        root,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "git rev-parse --git-common-dir",
      )
    ).trim();
    // 同じ ID の古い画面の記録（GIF）を、依頼のファイルを扱う前に消す。
    // ID が空なら記録の場所の全体を消してしまうので、消さない
    if (id !== "") {
      const captureDir = commonRecordPath(common, "captures", id, "");
      let found = false;
      try {
        const info = await lstat(captureDir);
        found = true;
        // シンボリックリンクはリンクだけを消し、先は消さない
        if (info.isSymbolicLink()) await unlink(captureDir);
        else await rm(captureDir, { recursive: true });
      } catch (error) {
        if (!(found === false && isMissing(error)))
          throw new FlowError(
            1,
            `古い画面の記録を消せません：${captureDir}（理由：${failureReason(error)}）。消してからもう一度流してください`,
          );
      }
      if (found)
        ctx.stderr(`同じ ID の古い画面の記録を消しました：${captureDir}`);
    }
    // 依頼の全文を git の共通ディレクトリに置く（タスク長が最初に読む）。
    // 依頼がないときは、同じ ID の古い依頼のファイルを消す（別のタスクに読まれないように）
    const requestFilePath = commonRecordPath(common, "requests", id, ".md");
    if (requestText !== null) {
      requestPath = requestFilePath;
      await mkdir(path.dirname(requestPath), { recursive: true });
      await writeFile(requestPath, requestText);
    } else {
      try {
        await rm(requestFilePath, { force: true });
      } catch (error) {
        throw new FlowError(
          1,
          `古い依頼のファイルを消せません：${requestFilePath}（理由：${failureReason(error)}）。消してからもう一度流してください`,
        );
      }
    }

    // 依存の記録は作業ツリーの外に置く（merge の確かめが読む）。
    // 依存がないときは、同じ ID の古い記録を消す（別のタスクに読まれないように）
    try {
      await writeDependsAt(common, id, depends, ctx.now());
    } catch (error) {
      throw new FlowError(
        1,
        `依存の記録を書けません（理由：${failureReason(error)}）。直してからもう一度流してください`,
      );
    }

    // またぐ依存の記録も同じ。なければ同じ ID の古い記録を消す
    try {
      await writeCrossDependsAt(common, id, crossRepos, ctx.now());
    } catch (error) {
      throw new FlowError(
        1,
        `またぐ依存の記録を書けません（理由：${failureReason(error)}）。直してからもう一度流してください`,
      );
    }

    // 承認なしの push の印も作業ツリーの外に置く。なければ同じ ID の古い印を消す（別のタスクに効かないように）
    try {
      if (allowBranchPush)
        await writeBranchPushMarkAt(common, id, branch, ctx.now());
      else await removeBranchPushMarkAt(common, id);
    } catch (error) {
      throw new FlowError(
        1,
        `枝の push の印を書けません（理由：${failureReason(error)}）。直してからもう一度流してください`,
      );
    }

    // ④ Orca の worktree を作る
    const orca = createOrca(ctx.runner, root);
    created = await orca.createWorktree({
      repoPath: root,
      name: `${id}-${slug}`,
      baseBranch: config.baseBranch,
      lead: config.lead,
      prompt: `/orca-flow:spec ${id} ${title}`,
    });

    // ⑤ ブランチ名を直す（worktree が消えていて失敗したときは、消えたことを知らせる）。
    // 名前直しの前は、ブランチを Orca がつけた元の名前で調べる
    let original: string | null = created.branch;
    try {
      original ??= await currentBranch(ctx.runner, created.path);
      original ??= await branchFromList(ctx, root, created.path);
      if (original !== branch) {
        if (original)
          await runGit(
            ctx.runner,
            created.path,
            ["branch", "-m", branch],
            "git branch -m",
          );
        else
          await runGit(
            ctx.runner,
            created.path,
            ["switch", "-c", branch],
            "git switch -c",
          );
      }
    } catch (error) {
      await failAfterRenameError(ctx, root, created.path, original, error);
    }

    // ⑥ 表示名をつけ、カードを designing に（1回の worktree set で）
    designingAt = ctx.now();
    label = displayName(id, title);
    try {
      await orca.setCard(created.path, {
        displayName: label,
        ...cardForState("designing"),
      });
    } catch (error) {
      ctx.stderr(
        `警告：表示名「${label}」とカード「設計中」を入れられませんでした（${error instanceof Error ? error.message : String(error)}）`,
      );
    }

    // 作成から一定時間、worktree とブランチが残っているかを確かめる
    const startedAt = Date.now();
    const windowMs = envMs(ctx.env[VERIFY_WINDOW_ENV], VERIFY_WINDOW_MS);
    const intervalMs = Math.max(
      1,
      envMs(ctx.env[VERIFY_INTERVAL_ENV], VERIFY_INTERVAL_MS),
    );
    for (;;) {
      const presence = await inspect(ctx, root, created.path, branch);
      const missing = missingOf(presence, branch);
      if (missing.length > 0)
        throw vanishedError(presence, created.path, branch);
      const left = startedAt + windowMs - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(intervalMs, left));
    }

    // ⑦ 進捗表
    committed = await applyProgress(
      ctx.runner,
      root,
      plan,
      `${config.integratorName}: ${id} を始める`,
    );
  } finally {
    await releaseMain();
  }

  // ⑧ 結果。段の記録は、作れたと分かった今書く（時刻はカードを designing にした時）
  await recordStage(
    { ...ctx, now: () => designingAt },
    root,
    id,
    "designing",
    null,
    "new",
  );
  let autoSet = false;
  try {
    if (auto) {
      await writeAuto(common, newRecord(id, ctx.now()));
      autoSet = true;
    } else {
      // 捨てたタスクの ID を使い直したとき、古いおまかせを引き継がない
      const old = await readAuto(common, id);
      if (old?.auto)
        await writeAuto(
          common,
          withOff(old, "新しいタスクが同じ ID を使った", ctx.now()),
        );
    }
  } catch (error) {
    ctx.stderr(
      auto
        ? `警告：おまかせにできませんでした（${error instanceof Error ? error.message : String(error)}）。orca-flow auto on ${id} で入れ直せます`
        : `警告：同じ ID の古いおまかせを外せませんでした（${error instanceof Error ? error.message : String(error)}）。orca-flow auto off ${id} で外してください`,
    );
  }
  const data = {
    ...(autoSet ? { auto: true } : {}),
    id,
    branch,
    worktree: created.path,
    displayName: label,
    taskDoc: taskDocPath(config, id),
    progressCommitted: committed,
    requestFile: requestPath,
    ...(allowBranchPush ? { allowBranchPush: true } : {}),
  };
  if (!ctx.json)
    ctx.stdout(
      `${id} を始めました\n  ブランチ：${branch}\n  worktree：${created.path}\n  表示名：${label}\n  設計書：${data.taskDoc}${requestPath ? `\n  依頼：${requestPath}` : ""}${autoSet ? "\n  おまかせ：承認と統合を統括役が進めます（外すには orca-flow auto off）" : ""}`,
    );
  return { code: 0, data };
};
