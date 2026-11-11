import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { FlowConfig, PreviewConfig } from "../config.ts";
import { FlowError, type CommandContext } from "../types.ts";
import { shellCommand } from "./exec.ts";
import type { ActiveTask } from "./git.ts";
import { mainWorktreePath, runGit } from "./git.ts";
import { acquireLock, releaseOrWarn } from "./lock.ts";
import type { Orca } from "./orca.ts";
import {
  previewDeps,
  readPreviewRecord,
  terminalAlive,
  urlAnswers,
  waitForPreview,
} from "./preview.ts";
import { commonRecordPath, hasIdShape } from "./task-id.ts";

// ブランチの分かれ目のアプリ（前の画面）を、リポジトリの外の作業ツリーに立てる部品（preview --base）。
// ターミナルと setup.sh の出力は秘密が出うるので、どこにも写さない。

/** 前の画面の記録（〈git の共通ディレクトリ〉/orca-flow/preview-base/〈ID〉.json） */
export interface PreviewBaseRecord {
  id: string;
  /** 前の作業ツリーの実のパス */
  worktree: string;
  /** タスクの worktree のパス（ターミナルを作った場所） */
  taskWorktree: string;
  /** 起動のコマンドを送ったターミナルのハンドル */
  terminal: string;
  /** 分かれ目のコミット */
  commit: string;
  /** 分かった URL（まだなら省く） */
  url?: string;
  /** 書いた時刻（ISO） */
  at: string;
}

/** 記録のファイルはあるが読めない・形が違う */
export interface BrokenPreviewBase {
  broken: true;
  reason: string;
}

export const isBrokenPreviewBase = (
  value: PreviewBaseRecord | BrokenPreviewBase | null,
): value is BrokenPreviewBase =>
  value !== null && "broken" in value && value.broken === true;

/** 前の画面が答えるかの判定。答えないときは理由（記録がない・壊れている・URL がまだ・答えない）が入る */
export type PreviewBaseStatus =
  | { answers: true; url: string; record: PreviewBaseRecord }
  | { answers: false; reason: string; record: PreviewBaseRecord | null };

/** 前の画面のターミナルの名前（タスクのプレビューの「preview」と見分ける） */
export const BASE_TERMINAL_TITLE = "preview-base";

/**
 * リポジトリの外の作業ツリーに立てるアプリの種類。前の画面（preview --base）と土台のアプリ（preview --companion-base）が
 * 置き場・setup.sh・待ち方・down の部品を共にし、記録と置き場のフォルダと文の呼び名だけを変える
 */
export interface OutsideKind {
  /** 記録（〈共通ディレクトリ〉/orca-flow/〈dir〉）と置き場（〈状態の置き場〉/orca-flow/〈dir〉）のフォルダ名 */
  dir: string;
  /** 文の中のアプリの呼び名 */
  label: string;
  /** 文の中の作業ツリーの呼び名 */
  tree: string;
  /** preview のフラグ（--stop の案内に使う） */
  flag: string;
}

export const PREVIEW_BASE: OutsideKind = {
  dir: "preview-base",
  label: "前の画面",
  tree: "前の作業ツリー",
  flag: "--base",
};

/** 種類ごとの止めるコマンドの案内 */
export const outsideStopCommand = (kind: OutsideKind, id: string) =>
  `orca-flow preview ${id} ${kind.flag} --stop`;

/** setup.sh を流す上限（ミリ秒） */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
/** down を流す上限（ミリ秒） */
const DOWN_TIMEOUT_MS = 120_000;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const previewBaseRecordPath = (common: string, id: string) =>
  commonRecordPath(common, PREVIEW_BASE.dir, id, ".json");

/** 録画の置き場：〈git の共通ディレクトリ〉/orca-flow/e2e-captures/〈ID〉。ID の形が外れたら FlowError(1) */
export const e2eCapturesDir = (common: string, id: string) =>
  commonRecordPath(common, "e2e-captures", id, "");

/** 〈XDG_STATE_HOME か ~/.local/state〉。決められなければ FlowError(1) */
export function stateHome(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_STATE_HOME;
  if (xdg && path.isAbsolute(xdg)) return xdg;
  const home = env.HOME || env.USERPROFILE;
  if (!home)
    throw new FlowError(
      1,
      "状態の置き場を決められません（XDG_STATE_HOME か HOME を設定してください）",
    );
  return path.join(home, ".local", "state");
}

const repoHash = (common: string) =>
  createHash("sha256").update(path.resolve(common)).digest("hex").slice(0, 16);

/**
 * dir の実のパスが、このリポジトリと ID の置き場（…/orca-flow/〈種類〉/〈16桁〉/〈ID〉）の形か。
 * 記録のパスは書き換えられうるので、消す前と down を流す前に確かめる。XDG_STATE_HOME は流す人で違うので形で見る
 */
async function isOwnOutsideDir(
  kind: OutsideKind,
  common: string,
  id: string,
  dir: string,
): Promise<boolean> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return false;
  }
  const stateRoot = path.dirname(
    path.dirname(path.dirname(path.dirname(real))),
  );
  return (
    real ===
    commonRecordPath(stateRoot, `${kind.dir}/${repoHash(common)}`, id, "")
  );
}

const outsideWarning = (kind: OutsideKind, id: string, dir: string) =>
  `警告：${id} の${kind.label}の記録の作業ツリー（${dir}）が置き場の外を指しているので、止めるコマンドも削除もしていません。記録は消します。必要なら手で確かめてください`;

/** 作業ツリーの置き場。種類・リポジトリ（共通ディレクトリ）・ID ごとに分ける */
export function outsideWorktreeDir(
  kind: OutsideKind,
  env: NodeJS.ProcessEnv,
  common: string,
  id: string,
): string {
  if (!hasIdShape(id)) throw new FlowError(1, "ID の形が正しくありません");
  return commonRecordPath(
    stateHome(env),
    `${kind.dir}/${repoHash(common)}`,
    id,
    "",
  );
}

/** 前の作業ツリーの置き場 */
export const previewBaseWorktreeDir = (
  env: NodeJS.ProcessEnv,
  common: string,
  id: string,
): string => outsideWorktreeDir(PREVIEW_BASE, env, common, id);

/** 記録を読む。なければ null、読めない・形が違えば { broken: true, reason } */
export async function readPreviewBaseRecord(
  common: string,
  id: string,
): Promise<PreviewBaseRecord | BrokenPreviewBase | null> {
  let text: string;
  try {
    text = await readFile(previewBaseRecordPath(common, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { broken: true, reason: `記録を読めません（${message(error)}）` };
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof raw.id !== "string" ||
      typeof raw.worktree !== "string" ||
      typeof raw.taskWorktree !== "string" ||
      typeof raw.terminal !== "string" ||
      typeof raw.commit !== "string" ||
      typeof raw.at !== "string"
    )
      throw new Error("形が違います");
    return {
      id: raw.id,
      worktree: raw.worktree,
      taskWorktree: raw.taskWorktree,
      terminal: raw.terminal,
      commit: raw.commit,
      ...(typeof raw.url === "string" ? { url: raw.url } : {}),
      at: raw.at,
    };
  } catch {
    return { broken: true, reason: "記録が壊れています" };
  }
}

export async function writePreviewBaseRecord(
  common: string,
  record: PreviewBaseRecord,
): Promise<void> {
  const file = previewBaseRecordPath(common, record.id);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temp, file);
}

export async function removePreviewBaseRecord(
  common: string,
  id: string,
): Promise<void> {
  await rm(previewBaseRecordPath(common, id), { force: true });
}

/**
 * 前の画面が答えるか。記録があり、壊れておらず、URL が分かっていて、その URL が答えるときだけ answers: true。
 * 答えないときは理由を返す（e2e が「流さず終了コード2」の理由に使う）
 */
export async function previewBaseStatus(
  common: string,
  id: string,
): Promise<PreviewBaseStatus> {
  const record = await readPreviewBaseRecord(common, id);
  if (record === null)
    return { answers: false, reason: "前の画面の記録がありません", record };
  if (isBrokenPreviewBase(record))
    return {
      answers: false,
      reason: `前の画面の記録が壊れています（${record.reason}）`,
      record: null,
    };
  if (record.url === undefined)
    return {
      answers: false,
      reason: "前の画面の URL がまだ分かりません",
      record,
    };
  if (!(await urlAnswers(record.url)))
    return {
      answers: false,
      reason: `前の画面が答えません（${record.url}）`,
      record,
    };
  return { answers: true, url: record.url, record };
}

/** 記録の読み書きを、種類と ID ごとのロックの中で行う */
export async function withOutsideLock<T>(
  kind: OutsideKind,
  common: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = commonRecordPath(common, kind.dir, id, ".lock");
  await mkdir(path.dirname(lock), { recursive: true });
  const got = await acquireLock(lock, {
    waitMs: previewDeps.lockWaitMs,
    kind: "preview",
    failed: (file, detail) =>
      `${kind.label}のロックを扱えませんでした（${file}）：${detail}`,
  });
  if (got.kind === "held")
    throw new FlowError(
      1,
      `${id} の${kind.label}を別のプロセスが操作中です（${got.lockPath}）。終わってからやり直してください`,
    );
  try {
    return await fn();
  } finally {
    await releaseOrWarn(got.release);
  }
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const shQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** 作業ツリーを消す。git で外せなければフォルダごと消して prune する。消せなかったら false */
async function removeOutsideWorktree(
  kind: OutsideKind,
  ctx: CommandContext,
  common: string,
  id: string,
  cwd: string,
  dir: string,
): Promise<boolean> {
  // git の外でフォルダだけ消えると登録が残り、次の worktree add が落ちる。prune は消えたものの登録しか外さない
  if (!(await exists(dir))) {
    await ctx.runner("git", ["worktree", "prune"], { cwd });
    return true;
  }
  // git は末尾の名前だけでも worktree を受け付けるので、置き場の形でないものは渡さない
  if (!path.isAbsolute(dir) || !(await isOwnOutsideDir(kind, common, id, dir)))
    return false;
  const result = await ctx.runner(
    "git",
    ["worktree", "remove", "--force", dir],
    { cwd },
  );
  if (result.code !== 0) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      return false;
    }
    await ctx.runner("git", ["worktree", "prune"], { cwd });
  }
  return !(await exists(dir));
}

/** 動いていない記録の作業ツリーを片づける。置き場の外を指していれば警告だけ。記録を消すのは呼ぶ側 */
export async function discardOutsideWorktree(
  kind: OutsideKind,
  ctx: CommandContext,
  common: string,
  id: string,
  root: string,
  worktree: string,
): Promise<void> {
  if (!(await exists(worktree)))
    await ctx.runner("git", ["worktree", "prune"], { cwd: root });
  else if (await isOwnOutsideDir(kind, common, id, worktree))
    await removeOutsideWorktree(kind, ctx, common, id, root, worktree);
  else ctx.stderr(outsideWarning(kind, id, worktree));
  await rm(outsideWorktreeDir(kind, ctx.env, common, id), {
    recursive: true,
    force: true,
  });
}

export interface LaunchOutsideInput<R> {
  /** 作業ツリーを足すリポジトリの作業の場所 */
  root: string;
  common: string;
  id: string;
  /** 作業ツリーを切り離しで置くコミット */
  commit: string;
  /** ターミナルを作る作業ツリー */
  terminalHome: string;
  terminalTitle: string;
  up: string;
  /** 作業ツリーの実のパスとターミナルのハンドルから記録を組む */
  record: (worktree: string, terminal: string) => R;
  write: (record: R) => Promise<void>;
  remove: () => Promise<void>;
}

/**
 * 置き場に切り離しの作業ツリーを作り、setup.sh を流し、ターミナルを作って記録を書き、そこへ移って up を送る。
 * setup.sh が落ちたら作業ツリーを消して FlowError(1)。送れなければ片づけて投げ直す。ロックは呼ぶ側が持つ
 */
export async function launchOutside<R>(
  kind: OutsideKind,
  ctx: CommandContext,
  orca: Orca,
  input: LaunchOutsideInput<R>,
): Promise<R> {
  const { root, common, id } = input;
  const dir = outsideWorktreeDir(kind, ctx.env, common, id);
  // 前に残った置き場があれば作り直す
  await removeOutsideWorktree(kind, ctx, common, id, root, dir);
  await mkdir(path.dirname(dir), { recursive: true });
  await runGit(
    ctx.runner,
    root,
    ["worktree", "add", "--detach", "--quiet", dir, input.commit],
    "git worktree add",
  );
  const worktree = await realpath(dir);

  const setup = path.join(
    await mainWorktreePath(ctx.runner, root),
    ".orca-flow",
    "setup.sh",
  );
  if (await exists(setup)) {
    const result = await ctx.runner("bash", [setup], {
      cwd: worktree,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.timedOut) {
      await removeOutsideWorktree(kind, ctx, common, id, root, worktree);
      throw new FlowError(
        1,
        `${id} の${kind.tree}の setup.sh が${result.timedOut ? "時間内に終わりませんでした" : `失敗しました（終了コード ${result.code}）`}。作業ツリーは消しました`,
      );
    }
  }

  const handle = await orca.createTerminal(
    input.terminalHome,
    input.terminalTitle,
  );
  const record = input.record(worktree, handle);
  await input.write(record);
  try {
    await orca.sendText(handle, `cd ${shQuote(worktree)}`);
    await orca.sendText(handle, input.up);
  } catch (error) {
    try {
      await orca.closeTerminal(handle);
    } catch {
      // 閉じられなくても、元の失敗を伝える
    }
    await input.remove();
    await removeOutsideWorktree(kind, ctx, common, id, root, worktree);
    throw error;
  }
  return record;
}

export interface StartBaseInput {
  root: string;
  common: string;
  config: FlowConfig;
  preview: PreviewConfig;
  task: ActiveTask;
  id: string;
  noOpen: boolean;
}

export interface StartBaseResult {
  url: string;
  /** 今回立てたか（false なら動いていた記録をそのまま使った） */
  started: boolean;
  worktree: string;
  commit: string;
}

/** 固定の url の設定では、リポジトリの外に立てない（後の画面とポートがぶつかる） */
export function refuseFixedUrl(kind: OutsideKind, preview: PreviewConfig) {
  if (preview.url !== undefined)
    throw new FlowError(
      2,
      `preview の設定の url が固定なので、${kind.label}は立てません（後の画面とポートがぶつかります）。固定の url をやめて、起動の出力の ORCA_FLOW_URL= で URL を知らせる形にするのは統括役の仕事です`,
    );
}

/** 前の画面を立てて答えるまで待つ。失敗は FlowError（固定の url は 2、ほかは 1） */
export async function startPreviewBase(
  ctx: CommandContext,
  orca: Orca,
  input: StartBaseInput,
): Promise<StartBaseResult> {
  const { root, common, config, preview, task, id } = input;
  refuseFixedUrl(PREVIEW_BASE, preview);

  const started = await withOutsideLock(PREVIEW_BASE, common, id, async () => {
    const existing = await readPreviewBaseRecord(common, id);
    if (isBrokenPreviewBase(existing))
      throw new FlowError(
        1,
        `${id} の前の画面の記録が壊れています（${existing.reason}）。orca-flow preview ${id} --base --stop で片づけてからやり直してください`,
      );
    if (existing !== null) {
      if (await terminalAlive(orca, existing.taskWorktree, existing.terminal))
        return { record: existing, fresh: false };
      await discardOutsideWorktree(
        PREVIEW_BASE,
        ctx,
        common,
        id,
        root,
        existing.worktree,
      );
      await removePreviewBaseRecord(common, id);
    }

    const commit = (
      await runGit(
        ctx.runner,
        root,
        ["merge-base", config.baseBranch, task.branch],
        "git merge-base",
      )
    ).trim();
    const record = await launchOutside(PREVIEW_BASE, ctx, orca, {
      root,
      common,
      id,
      commit,
      terminalHome: task.path,
      terminalTitle: BASE_TERMINAL_TITLE,
      up: preview.up,
      record: (worktree, terminal): PreviewBaseRecord => ({
        id,
        worktree,
        taskWorktree: task.path,
        terminal,
        commit,
        at: ctx.now().toISOString(),
      }),
      write: (r) => writePreviewBaseRecord(common, r),
      remove: () => removePreviewBaseRecord(common, id),
    });
    return { record, fresh: true };
  });
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
      `${id} の前の画面が ${preview.timeoutSeconds} 秒たっても答えませんでした（開く URL が出ないか、URL が答えません）。起動のターミナルと記録は残してあります。Orca の ${record.taskWorktree} のターミナル「${BASE_TERMINAL_TITLE}」で出力を確かめてください。片づけるには orca-flow preview ${id} --base --stop`,
    );
  const url = waited.url;

  let taskUrl: string | undefined;
  try {
    taskUrl = (await readPreviewRecord(common, id))?.url;
  } catch {
    taskUrl = undefined;
  }
  if (taskUrl !== undefined && taskUrl === url) {
    try {
      await stopPreviewBase(ctx, orca, {
        cwd: root,
        common,
        id,
        down: preview.down,
        force: true,
      });
    } catch {
      // 止められなくても、URL がぶつかったことを伝える
    }
    throw new FlowError(
      1,
      `${id} の前の画面の URL（${url}）がタスクのプレビューと同じです。後の画面とぶつかるので止めました。起動のスクリプトが空いているポートを選ぶようにしてください`,
    );
  }

  const current = await withOutsideLock(PREVIEW_BASE, common, id, async () => {
    const latest = await readPreviewBaseRecord(common, id);
    if (
      latest === null ||
      isBrokenPreviewBase(latest) ||
      latest.terminal !== record.terminal
    )
      return null;
    if (latest.url !== url)
      await writePreviewBaseRecord(common, { ...latest, url });
    return latest;
  });
  if (current === null)
    throw new FlowError(
      1,
      `${id} の前の画面は待っている間に止められたか置き換わりました。もう一度 orca-flow preview ${id} --base を打ってください`,
    );
  if (!input.noOpen) await orca.openUrlTab(task.path, url);
  return {
    url,
    started: started.fresh,
    worktree: record.worktree,
    commit: record.commit,
  };
}

export interface StopBaseOutcome {
  /** 記録があったか */
  hadRecord: boolean;
  /** 置き場だけが残っていたか（記録がなく、作業ツリーのフォルダがあった） */
  hadLeftover: boolean;
  ranDown: boolean;
  closedTerminal: boolean;
  removedWorktree: boolean;
}

export interface StopBaseInput {
  /** git の作業の場所（リポジトリのどの worktree でもよい） */
  cwd: string;
  common: string;
  id: string;
  down: string | undefined;
  /** true なら down の失敗を警告にして最後まで進める（統合の仕上げ用） */
  force: boolean;
}

/** 止めるのに要る記録の中身 */
export interface OutsideStopRecord {
  worktree: string;
  terminal: string;
  /** ターミナルを作った作業ツリー */
  terminalHome: string;
}

export interface OutsideRecordIO {
  /** ロックの中で呼ぶ。止めてはいけない記録なら FlowError を投げてよい */
  read: () => Promise<
    OutsideStopRecord | { broken: true; reason: string } | null
  >;
  remove: () => Promise<void>;
  recordPath: string;
}

/**
 * 止める：down・ターミナル・作業ツリー・記録の順に片づける。
 * 記録も置き場もなければ何もしない。壊れた記録は警告して消し、決まった置き場だけ片づける
 */
export async function stopOutside(
  kind: OutsideKind,
  ctx: CommandContext,
  orca: Orca,
  input: StopBaseInput,
  io: OutsideRecordIO,
): Promise<StopBaseOutcome> {
  const { cwd, common, id } = input;
  return withOutsideLock(kind, common, id, async () => {
    const found = await io.read();
    const record = found === null || "broken" in found ? null : found;
    // 置き場を決められない環境（HOME もない）では、記録の作業ツリーだけを片づける
    let defaultDir: string | null = null;
    try {
      defaultDir = outsideWorktreeDir(kind, ctx.env, common, id);
    } catch {
      defaultDir = null;
    }
    const dir = record?.worktree ?? defaultDir;
    const dirExists = dir !== null && (await exists(dir));
    const dirTrusted =
      dir !== null &&
      dirExists &&
      (await isOwnOutsideDir(kind, common, id, dir));
    const outcome: StopBaseOutcome = {
      hadRecord: found !== null,
      hadLeftover: found === null && dirExists,
      ranDown: false,
      closedTerminal: false,
      removedWorktree: false,
    };
    if (found === null && !dirExists) return outcome;
    if (found !== null && "broken" in found)
      ctx.stderr(
        `警告：${id} の${kind.label}の記録が壊れていたので消します（${found.reason}）。ターミナルが残っていれば Orca で閉じてください`,
      );

    if (dir !== null && dirExists && !dirTrusted)
      ctx.stderr(outsideWarning(kind, id, dir));
    if (!dirExists) await ctx.runner("git", ["worktree", "prune"], { cwd });

    if (record !== null && input.down !== undefined && dirTrusted) {
      const [cmd, args] = shellCommand(input.down);
      const result = await ctx.runner(cmd, args, {
        cwd: dir,
        timeoutMs: DOWN_TIMEOUT_MS,
      });
      outcome.ranDown = true;
      if (result.code !== 0 || result.timedOut) {
        const what = result.timedOut
          ? "時間内に終わりませんでした"
          : `失敗しました（終了コード ${result.code}）`;
        const text = `${id} の${kind.label}の止めるコマンドが${what}。コンテナなどが残っていないか確かめてください`;
        if (!input.force)
          throw new FlowError(
            1,
            `${text}。記録（${io.recordPath}）とターミナルは残してあります。原因を直したら ${outsideStopCommand(kind, id)} をやり直してください`,
          );
        ctx.stderr(`警告：${text}`);
      }
    }
    if (record !== null) {
      try {
        if (await terminalAlive(orca, record.terminalHome, record.terminal)) {
          await orca.closeTerminal(record.terminal);
          outcome.closedTerminal = true;
        }
      } catch (error) {
        ctx.stderr(
          `警告：${id} の${kind.label}のターミナルを閉じられませんでした（${message(error)}）。Orca で閉じてください`,
        );
      }
    }
    if (dir !== null && dirTrusted) {
      outcome.removedWorktree = await removeOutsideWorktree(
        kind,
        ctx,
        common,
        id,
        cwd,
        dir,
      );
      if (!outcome.removedWorktree)
        ctx.stderr(
          `警告：${id} の${kind.tree}（${dir}）を消せませんでした。手で消してください`,
        );
    }
    if (
      defaultDir !== null &&
      dir !== defaultDir &&
      (await exists(defaultDir)) &&
      (await isOwnOutsideDir(kind, common, id, defaultDir))
    )
      await removeOutsideWorktree(kind, ctx, common, id, cwd, defaultDir);
    await io.remove();
    return outcome;
  });
}

/**
 * 前の画面を止める：down・ターミナル・作業ツリー・記録の順に片づける。
 * 記録も置き場もなければ何もしない。壊れた記録は警告して消し、決まった置き場だけ片づける
 */
export async function stopPreviewBase(
  ctx: CommandContext,
  orca: Orca,
  input: StopBaseInput,
): Promise<StopBaseOutcome> {
  const { common, id } = input;
  return stopOutside(PREVIEW_BASE, ctx, orca, input, {
    read: async () => {
      const found = await readPreviewBaseRecord(common, id);
      if (found === null || isBrokenPreviewBase(found)) return found;
      return {
        worktree: found.worktree,
        terminal: found.terminal,
        terminalHome: found.taskWorktree,
      };
    },
    remove: () => removePreviewBaseRecord(common, id),
    recordPath: previewBaseRecordPath(common, id),
  });
}

/**
 * 統合の仕上げ用：前の画面があれば worktree を消す前に止める。止められなくても警告だけ。
 * 設定は readConfig で読む（読めなければ、記録があるときだけ警告し、止めるコマンドは流さない）
 */
export async function stopPreviewBaseForFinish(
  ctx: CommandContext,
  orca: Orca,
  readConfig: () => Promise<FlowConfig>,
  common: string,
  id: string,
  worktree: string,
): Promise<void> {
  let config: FlowConfig | null = null;
  let configError: string | null = null;
  try {
    config = await readConfig();
  } catch (error) {
    configError = message(error);
  }
  try {
    const outcome = await stopPreviewBase(ctx, orca, {
      cwd: worktree,
      common,
      id,
      down: config?.preview?.down,
      force: true,
    });
    if (configError !== null && outcome.hadRecord)
      ctx.stderr(
        `警告：${id} の設定を読めなかったので、前の画面の止めるコマンドを流していません（${configError}）。コンテナなどが残っていないか確かめてください`,
      );
  } catch (error) {
    ctx.stderr(
      `警告：${id} の前の画面を止められませんでした（${message(error)}）。記録は ${previewBaseRecordPath(common, id)} です。orca-flow preview ${id} --base --stop か Orca のターミナルで止めてください`,
    );
  }
}

/** 録画の置き場を消す。ID が空・形が外れていれば何も消さない。消せなければ警告だけ */
export async function clearE2eCaptures(
  ctx: CommandContext,
  common: string,
  id: string,
): Promise<boolean> {
  if (id === "" || !hasIdShape(id)) return false;
  const dir = e2eCapturesDir(common, id);
  if (!(await exists(dir))) return false;
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    ctx.stderr(
      `警告：${id} の録画の置き場（${dir}）を消せませんでした（${message(error)}）。手で消してください`,
    );
    return false;
  }
}
