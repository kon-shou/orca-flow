import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig, PreviewConfig } from "../config.ts";
import { FlowError, type CommandContext } from "../types.ts";
import { companionBaseApps, readCompanion } from "./companion.ts";
import type { Runner } from "./exec.ts";
import { gitCommonDir, mainWorktreePath, runGit } from "./git.ts";
import type { Orca } from "./orca.ts";
import { samePath } from "./paths.ts";
import {
  discardOutsideWorktree,
  launchOutside,
  outsideStopCommand,
  refuseFixedUrl,
  stopOutside,
  withOutsideLock,
  type OutsideKind,
  type StopBaseOutcome,
} from "./preview-base.ts";
import { terminalAlive, urlAnswers, waitForPreview } from "./preview.ts";
import { commonRecordPath, hasIdShape } from "./task-id.ts";

// 土台のアプリ（E2E のタスクのために、アプリの baseBranch の先頭をリポジトリの外に立てたもの）の記録。
// 記録はアプリのリポジトリの〈git の共通ディレクトリ〉/orca-flow/companion-base/〈E2E のタスクの ID〉.json

/** 土台のアプリを立てさせた E2E のタスク */
export interface CompanionBaseOwner {
  /** E2E のリポジトリのメインの作業ツリーの実のパス */
  repo: string;
  /** 伴う記録の taskBranch。古い記録にはない */
  taskBranch?: string;
}

export interface CompanionBaseRecord {
  /** E2E のタスクの ID */
  id: string;
  /** 土台の作業ツリーの実のパス */
  worktree: string;
  /** ターミナルを作ったアプリのメインの作業ツリー */
  mainWorktree: string;
  terminal: string;
  baseBranch: string;
  /** 立てたときの baseBranch の先頭 */
  commit: string;
  owner: CompanionBaseOwner;
  /** 分かった URL（まだなら省く） */
  url?: string;
  at: string;
}

export interface BrokenCompanionBase {
  broken: true;
  reason: string;
}

export const isBrokenCompanionBase = (
  value: CompanionBaseRecord | BrokenCompanionBase | null,
): value is BrokenCompanionBase =>
  value !== null && "broken" in value && value.broken === true;

/** 土台のアプリが答えるか。答えないときは理由が入る（e2e が流さない理由に使う） */
export type CompanionBaseStatus =
  | { answers: true; url: string; record: CompanionBaseRecord }
  | { answers: false; reason: string; record: CompanionBaseRecord | null };

export const COMPANION_BASE_KIND = "companion-base";

export const COMPANION_BASE: OutsideKind = {
  dir: COMPANION_BASE_KIND,
  label: "土台のアプリ",
  tree: "土台の作業ツリー",
  flag: "--companion-base",
};

/** 土台のアプリのターミナルの名前（タスクのプレビュー・前の画面と見分ける） */
export const COMPANION_BASE_TERMINAL_TITLE = "companion-base";

export const companionBaseRecordPath = (common: string, id: string) =>
  commonRecordPath(common, COMPANION_BASE_KIND, id, ".json");

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v !== "";

/** 記録を読む。なければ null、読めない・形が違えば { broken: true, reason } */
export async function readCompanionBaseRecord(
  common: string,
  id: string,
): Promise<CompanionBaseRecord | BrokenCompanionBase | null> {
  let text: string;
  try {
    text = await readFile(companionBaseRecordPath(common, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { broken: true, reason: `記録を読めません（${message(error)}）` };
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const owner = raw?.owner as Record<string, unknown> | null | undefined;
    if (
      raw === null ||
      typeof raw !== "object" ||
      raw.id !== id ||
      !isNonEmptyString(raw.worktree) ||
      !isNonEmptyString(raw.mainWorktree) ||
      !isNonEmptyString(raw.terminal) ||
      !isNonEmptyString(raw.baseBranch) ||
      !isNonEmptyString(raw.commit) ||
      typeof raw.at !== "string" ||
      (raw.url !== undefined && !isNonEmptyString(raw.url)) ||
      owner === null ||
      typeof owner !== "object" ||
      Array.isArray(owner) ||
      !isNonEmptyString(owner.repo) ||
      (owner.taskBranch !== undefined && !isNonEmptyString(owner.taskBranch))
    )
      throw new Error("形が違います");
    return {
      id,
      worktree: raw.worktree,
      mainWorktree: raw.mainWorktree,
      terminal: raw.terminal,
      baseBranch: raw.baseBranch,
      commit: raw.commit,
      owner: {
        repo: owner.repo,
        ...(owner.taskBranch !== undefined
          ? { taskBranch: owner.taskBranch as string }
          : {}),
      },
      ...(raw.url !== undefined ? { url: raw.url as string } : {}),
      at: raw.at,
    };
  } catch {
    return { broken: true, reason: "記録が壊れています" };
  }
}

export async function writeCompanionBaseRecord(
  common: string,
  record: CompanionBaseRecord,
): Promise<void> {
  const file = companionBaseRecordPath(common, record.id);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temp, file);
}

export async function removeCompanionBaseRecord(
  common: string,
  id: string,
): Promise<void> {
  await rm(companionBaseRecordPath(common, id), { force: true });
}

/** 同じ持ち主か。taskBranch のない古い伴う記録どうしは、リポジトリだけで見る */
export function sameCompanionBaseOwner(
  a: CompanionBaseOwner,
  b: CompanionBaseOwner,
): boolean {
  return samePath(a.repo, b.repo) && a.taskBranch === b.taskBranch;
}

export const describeOwner = (owner: CompanionBaseOwner) =>
  `${owner.repo}${owner.taskBranch !== undefined ? ` の ${owner.taskBranch}` : ""}`;

/**
 * 共通ディレクトリを渡して、土台のアプリが答えるかを見る。
 * 記録がある・壊れていない・持ち主が同じ・URL が分かっていて答えるときだけ answers: true
 */
export async function companionBaseStatusAt(
  common: string,
  id: string,
  owner: CompanionBaseOwner,
): Promise<CompanionBaseStatus> {
  if (!hasIdShape(id))
    return {
      answers: false,
      reason: "ID の形が正しくありません",
      record: null,
    };
  const record = await readCompanionBaseRecord(common, id);
  if (record === null)
    return { answers: false, reason: "土台のアプリの記録がありません", record };
  if (isBrokenCompanionBase(record))
    return {
      answers: false,
      reason: `土台のアプリの記録が壊れています（${record.reason}）`,
      record: null,
    };
  if (!sameCompanionBaseOwner(record.owner, owner))
    return {
      answers: false,
      reason: `土台のアプリの記録は別の持ち主（${describeOwner(record.owner)}）のものです`,
      record,
    };
  if (record.url === undefined)
    return {
      answers: false,
      reason: "土台のアプリの URL がまだ分かりません",
      record,
    };
  if (!(await urlAnswers(record.url)))
    return {
      answers: false,
      reason: `土台のアプリが答えません（${record.url}）`,
      record,
    };
  return { answers: true, url: record.url, record };
}

/** アプリのリポジトリ（baseApps の path）を渡して、土台のアプリが答えるかを見る */
export async function companionBaseStatus(
  runner: Runner,
  appPath: string,
  id: string,
  owner: CompanionBaseOwner,
): Promise<CompanionBaseStatus> {
  let common: string;
  try {
    common = await gitCommonDir(runner, appPath);
  } catch (error) {
    return {
      answers: false,
      reason: `アプリのリポジトリを読めません（${message(error)}）`,
      record: null,
    };
  }
  return companionBaseStatusAt(common, id, owner);
}

const otherOwner = (id: string, found: CompanionBaseOwner) =>
  new FlowError(
    1,
    `${id} の土台のアプリの記録は別の持ち主（${describeOwner(found)}）のものです。そのタスクの土台のアプリなので触りません。違う E2E のタスクと ID がぶつかっていないか確かめてください`,
  );

export interface StartCompanionBaseInput {
  /** アプリのリポジトリの作業の場所 */
  root: string;
  common: string;
  config: FlowConfig;
  preview: PreviewConfig;
  /** E2E のタスクの ID */
  id: string;
  owner: CompanionBaseOwner;
  noOpen: boolean;
}

export interface StartCompanionBaseResult {
  url: string;
  /** 今回立てたか（false なら動いていた記録をそのまま使った） */
  started: boolean;
  /** baseBranch の先頭が進んでいたので立て直したか */
  restarted: boolean;
  worktree: string;
  commit: string;
}

type Decision =
  | { kind: "ready"; record: CompanionBaseRecord; fresh: boolean }
  | { kind: "restart" };

/**
 * 土台のアプリを baseBranch の先頭で立てて答えるまで待つ。動いていて先頭が同じなら使い回し、進んでいれば立て直す。
 * 失敗は FlowError（固定の url は 2、ほかは 1）
 */
export async function startCompanionBase(
  ctx: CommandContext,
  orca: Orca,
  input: StartCompanionBaseInput,
): Promise<StartCompanionBaseResult> {
  const { root, common, config, preview, id, owner } = input;
  refuseFixedUrl(COMPANION_BASE, preview);
  const head = (
    await runGit(
      ctx.runner,
      root,
      ["rev-parse", "--verify", "--quiet", `${config.baseBranch}^{commit}`],
      "git rev-parse",
    )
  ).trim();
  const mainWorktree = await mainWorktreePath(ctx.runner, root);

  const decide = () =>
    withOutsideLock(COMPANION_BASE, common, id, async (): Promise<Decision> => {
      const existing = await readCompanionBaseRecord(common, id);
      if (isBrokenCompanionBase(existing))
        throw new FlowError(
          1,
          `${id} の土台のアプリの記録が壊れています（${existing.reason}）。${outsideStopCommand(COMPANION_BASE, id)} で片づけてからやり直してください`,
        );
      if (existing !== null) {
        if (!sameCompanionBaseOwner(existing.owner, owner))
          throw otherOwner(id, existing.owner);
        if (
          await terminalAlive(orca, existing.mainWorktree, existing.terminal)
        ) {
          if (existing.commit === head)
            return { kind: "ready", record: existing, fresh: false };
          return { kind: "restart" };
        }
        await discardOutsideWorktree(
          COMPANION_BASE,
          ctx,
          common,
          id,
          root,
          existing.worktree,
        );
        await removeCompanionBaseRecord(common, id);
      }
      const record = await launchOutside(COMPANION_BASE, ctx, orca, {
        root,
        common,
        id,
        commit: head,
        terminalHome: mainWorktree,
        terminalTitle: COMPANION_BASE_TERMINAL_TITLE,
        up: preview.up,
        record: (worktree, terminal): CompanionBaseRecord => ({
          id,
          worktree,
          mainWorktree,
          terminal,
          baseBranch: config.baseBranch,
          commit: head,
          owner: {
            repo: owner.repo,
            ...(owner.taskBranch !== undefined
              ? { taskBranch: owner.taskBranch }
              : {}),
          },
          at: ctx.now().toISOString(),
        }),
        write: (r) => writeCompanionBaseRecord(common, r),
        remove: () => removeCompanionBaseRecord(common, id),
      });
      return { kind: "ready", record, fresh: true };
    });

  let decision = await decide();
  let restarted = false;
  if (decision.kind === "restart") {
    // 止めるのは自分の持ち主の土台のアプリだけ（stopCompanionBase が持ち主を確かめる）
    await stopCompanionBase(ctx, orca, {
      cwd: root,
      common,
      id,
      down: preview.down,
      force: false,
      owner,
    });
    restarted = true;
    decision = await decide();
  }
  if (decision.kind !== "ready")
    throw new FlowError(
      1,
      `${id} の土台のアプリを立て直している間に別の起動に置き換わりました。もう一度 orca-flow preview ${id} --companion-base を打ってください`,
    );
  const record = decision.record;

  const waited = await waitForPreview(
    orca,
    preview,
    record.terminal,
    record.url,
  );
  if (waited.kind === "timeout")
    throw new FlowError(
      1,
      `${id} の土台のアプリが ${preview.timeoutSeconds} 秒たっても答えませんでした（開く URL が出ないか、URL が答えません）。起動のターミナルと記録は残してあります。Orca の ${record.mainWorktree} のターミナル「${COMPANION_BASE_TERMINAL_TITLE}」で出力を確かめてください。片づけるには ${outsideStopCommand(COMPANION_BASE, id)}`,
    );
  const url = waited.url;

  const current = await withOutsideLock(
    COMPANION_BASE,
    common,
    id,
    async () => {
      const latest = await readCompanionBaseRecord(common, id);
      if (
        latest === null ||
        isBrokenCompanionBase(latest) ||
        latest.terminal !== record.terminal
      )
        return null;
      if (latest.url !== url)
        await writeCompanionBaseRecord(common, { ...latest, url });
      return latest;
    },
  );
  if (current === null)
    throw new FlowError(
      1,
      `${id} の土台のアプリは待っている間に止められたか置き換わりました。もう一度 orca-flow preview ${id} --companion-base を打ってください`,
    );
  if (!input.noOpen) await orca.openUrlTab(record.mainWorktree, url);
  return {
    url,
    started: decision.fresh,
    restarted,
    worktree: record.worktree,
    commit: record.commit,
  };
}

export interface StopCompanionBaseInput {
  /** git の作業の場所（アプリのリポジトリのどの worktree でもよい） */
  cwd: string;
  common: string;
  id: string;
  down: string | undefined;
  /** true なら down の失敗を警告にして最後まで進める（タスクの終わり用） */
  force: boolean;
  /** 渡せば、違う持ち主の記録は止めずに FlowError(1) */
  owner?: CompanionBaseOwner;
  /** true なら持ち主のリポジトリだけを比べる（伴う記録が消えて taskBranch を知れないとき） */
  ownerRepoOnly?: boolean;
}

/** 土台のアプリを止める：down・ターミナル・作業ツリー・記録の順に片づける。記録も置き場もなければ何もしない */
export async function stopCompanionBase(
  ctx: CommandContext,
  orca: Orca,
  input: StopCompanionBaseInput,
): Promise<StopBaseOutcome> {
  const { common, id, owner } = input;
  return stopOutside(COMPANION_BASE, ctx, orca, input, {
    read: async () => {
      const found = await readCompanionBaseRecord(common, id);
      if (found === null || isBrokenCompanionBase(found)) return found;
      if (
        owner !== undefined &&
        !(input.ownerRepoOnly
          ? samePath(found.owner.repo, owner.repo)
          : sameCompanionBaseOwner(found.owner, owner))
      )
        throw otherOwner(id, found.owner);
      return {
        worktree: found.worktree,
        terminal: found.terminal,
        terminalHome: found.mainWorktree,
      };
    },
    remove: () => removeCompanionBaseRecord(common, id),
    recordPath: companionBaseRecordPath(common, id),
  });
}

/**
 * E2E のタスクの終わり用：伴う記録の baseApps ごとに、自分が立てた土台のアプリを止める。止められなくても警告だけ。
 * root は E2E のリポジトリの作業の場所。readConfig はアプリのメインの作業ツリーから設定を読む
 */
export async function stopCompanionBasesForFinish(
  ctx: CommandContext,
  orca: Orca,
  readConfig: (appPath: string) => Promise<FlowConfig>,
  root: string,
  id: string,
): Promise<void> {
  let apps;
  let owner: CompanionBaseOwner;
  try {
    const companion = await readCompanion(ctx.runner, root, id);
    if (companion === null) return;
    apps = companionBaseApps(companion);
    if (apps.length === 0) return;
    owner = {
      repo: await mainWorktreePath(ctx.runner, root),
      ...(companion.taskBranch !== undefined
        ? { taskBranch: companion.taskBranch }
        : {}),
    };
  } catch (error) {
    ctx.stderr(
      `警告：${id} の伴う記録を読めなかったので、土台のアプリを止めていません（${message(error)}）。残っていれば orca-flow preview ${id} --companion-base --stop をアプリの子で打ってください`,
    );
    return;
  }
  for (const app of apps) {
    const hint = `${app.name} で ${outsideStopCommand(COMPANION_BASE, id)} --owner ${owner.repo}`;
    try {
      const common = await gitCommonDir(ctx.runner, app.path);
      let down: string | undefined;
      let configError: string | null = null;
      try {
        down = (await readConfig(app.path)).preview?.down;
      } catch (error) {
        configError = message(error);
      }
      const outcome = await stopCompanionBase(ctx, orca, {
        cwd: app.path,
        common,
        id,
        down,
        force: true,
        owner,
      });
      if (configError !== null && outcome.hadRecord)
        ctx.stderr(
          `警告：${app.name} の設定を読めなかったので、${id} の土台のアプリの止めるコマンドを流していません（${configError}）。コンテナなどが残っていないか確かめてください`,
        );
    } catch (error) {
      ctx.stderr(
        `警告：${app.name} の ${id} の土台のアプリを止められませんでした（${message(error)}）。${hint} か Orca のターミナルで止めてください`,
      );
    }
  }
}
