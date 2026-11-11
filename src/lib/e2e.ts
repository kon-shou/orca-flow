import { readFile } from "node:fs/promises";
import type { Runner } from "./exec.ts";
import { gitCommonDir, mainWorktreePath } from "./git.ts";
import {
  commandMarkNames,
  companionBaseApps,
  type Companion,
} from "./companion.ts";
import { companionBaseStatus } from "./companion-base.ts";
import {
  resolveBaseAppSources,
  type BaseAppSource,
} from "./companion-source.ts";
import { readPreviewRecord, urlAnswers } from "./preview.ts";
import { isSafeBranchName } from "./qa/context.ts";
import { readStages } from "./stage-log.ts";
import { commonRecordPath } from "./task-id.ts";
import { PREVIEW_URL_MARK, type CompanionCommand } from "./workspace.ts";

// e2e：伴う記録のアプリごとに、プレビューの URL・答えるか・実装済みかを見る部品。
// プレビューのターミナルは読まない。URL は毎回アプリの preview の記録から読む（立て直しでポートが変わるため）

/** 印を埋める URL の出どころ。branch＝E2E のタスクと同じブランチのプレビュー */
export type E2eSource = { kind: "branch" } | BaseAppSource;

/** 伴うアプリ1つ分の状態 */
export interface E2eApp {
  name: string;
  url: string | null;
  answered: boolean;
  /** アプリの段の記録に integrate-wait の行がある（土台のアプリは依存元のタスクの段の記録） */
  implemented: boolean;
  /** baseApps のある記録だけに付ける（ない記録の --json の形を変えないため） */
  source?: E2eSource;
  /** 土台のアプリの、そろわない理由（そろえば null）。土台のアプリの行だけに付ける */
  reason?: string | null;
}

/**
 * 親のタブの `workspace --preview` に打つ組のブランチ名。組の入口はブランチ名だけを受けるので、
 * そのまま打てる形でなければ〈ブランチ名〉の字のまま出す（人がシェルに写すため）
 */
export function previewTarget(branch: string | null): string {
  return branch !== null && isSafeBranchName(branch)
    ? branch
    : "〈ブランチ名〉";
}

/** 状態を見て、流せないアプリごとの理由と次の手を返す。branch は E2E のタスクの手元のブランチ */
export function appReasons(
  apps: readonly E2eApp[],
  id: string,
  branch: string | null,
): string[] {
  const target = previewTarget(branch);
  const reasons: string[] = [];
  for (const app of apps) {
    if (app.source !== undefined && app.source.kind !== "branch") {
      reasons.push(...baseAppReasons(app, app.source, target));
      continue;
    }
    if (app.url === null)
      reasons.push(
        `${app.name}：preview の記録に URL がありません（親のタブで orca-flow workspace --preview ${target} を流してください）`,
      );
    else if (!app.answered)
      reasons.push(
        `${app.name}：プレビューの URL が答えません（親のタブで orca-flow workspace --preview ${target} を流し直してください）`,
      );
    if (!app.implemented)
      reasons.push(
        `${app.name}：実装がまだです（段の記録に integrate-wait の行がありません）。orca-flow e2e ${id} --wait で待てます`,
      );
  }
  return reasons;
}

function baseAppReasons(
  app: E2eApp,
  source: BaseAppSource,
  target: string,
): string[] {
  const rerun = `親のタブで orca-flow workspace --preview ${target} を流してください`;
  if (source.kind === "undecided")
    return [
      `${app.name}：ブランチにないアプリをどこに向けるか決められません（${source.reason}）。前を待つ印を確かめ、依存元のタスクが作業中か baseBranch に入ってから流してください`,
    ];
  if (source.kind === "baseBranch")
    return app.answered
      ? []
      : [
          `${app.name}：${source.branch} の先頭で立てる土台のアプリがそろっていません（${app.reason ?? "答えません"}）。${rerun}`,
        ];
  const reasons: string[] = [];
  if (app.url === null)
    reasons.push(
      `${app.name}：依存元のタスク ${source.id} の preview の記録に URL がありません（${rerun}）`,
    );
  else if (!app.answered)
    reasons.push(
      `${app.name}：依存元のタスク ${source.id} のプレビューの URL が答えません（${rerun}）`,
    );
  if (!app.implemented)
    reasons.push(
      `${app.name}：依存元のタスク ${source.id} の実装がまだです（段の記録に integrate-wait の行がありません）。待ってから流してください`,
    );
  return reasons;
}

const markReason = (name: string) =>
  `コマンドの印 {previewUrl:${name}} の名前が伴う記録にありません（親から new --companion を付け直してください）`;

/**
 * 伴う記録が壊れていると読めなかったとき、印の名前が apps にも baseApps（並びのときだけ）にもないものの理由を返す。
 * JSON として読めない・command が文字列でも値が全部文字列のオブジェクトでもない・apps が並びでないときは空
 * （呼び出し元は元の誤りを投げ直す）。
 * ほかの壊れ方（at・id・path など）は見ないので、印のずれと重なれば理由を返す
 */
export async function markMismatchReasons(
  runner: Runner,
  root: string,
  id: string,
): Promise<string[]> {
  try {
    const common = await gitCommonDir(runner, root);
    const raw = JSON.parse(
      await readFile(
        commonRecordPath(common, "companion", id, ".json"),
        "utf8",
      ),
    ) as { command?: unknown; apps?: unknown; baseApps?: unknown };
    if (!isCommandLike(raw.command) || !Array.isArray(raw.apps)) return [];
    // 印は土台のアプリも指せるので、baseApps の名前もずれではない
    const names = new Set(
      [...raw.apps, ...(Array.isArray(raw.baseApps) ? raw.baseApps : [])].map(
        (a: { name?: unknown }) => a?.name,
      ),
    );
    return commandMarkNames(raw.command)
      .filter((name) => !names.has(name))
      .map(markReason);
  } catch {
    return [];
  }
}

const isCommandLike = (value: unknown): value is CompanionCommand =>
  typeof value === "string" ||
  (typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string"));

/** 伴う記録の各アプリを、そのアプリのリポジトリの記録から見る */
export async function inspectApps(
  runner: Runner,
  record: Companion,
): Promise<E2eApp[]> {
  const out: E2eApp[] = [];
  for (const app of record.apps) {
    const common = await gitCommonDir(runner, app.path);
    const preview = await readPreviewRecord(common, record.id);
    const url = preview?.url ?? null;
    const stages = await readStages(common, record.id);
    out.push({
      name: app.name,
      url,
      answered: url !== null && (await urlAnswers(url)),
      implemented:
        stages?.entries.some((e) => e.state === "integrate-wait") ?? false,
    });
  }
  return out;
}

/**
 * 伴う記録の土台のアプリ（baseApps）を、出どころを決めて見る。root は E2E のタスクの作業ツリー。
 * 依存元のタスクならそのプレビューの記録と段の記録、baseBranch なら土台のアプリの記録を読む
 */
export async function inspectBaseApps(
  runner: Runner,
  record: Companion,
  root: string,
): Promise<E2eApp[]> {
  const baseApps = companionBaseApps(record);
  if (baseApps.length === 0) return [];
  const owner = {
    repo: await mainWorktreePath(runner, root),
    ...(record.taskBranch !== undefined
      ? { taskBranch: record.taskBranch }
      : {}),
  };
  const out: E2eApp[] = [];
  for (const { app, source } of await resolveBaseAppSources(
    runner,
    root,
    record.id,
    baseApps,
  )) {
    if (source.kind === "undecided") {
      out.push({
        name: app.name,
        url: null,
        answered: false,
        implemented: false,
        source,
        reason: source.reason,
      });
      continue;
    }
    if (source.kind === "baseBranch") {
      const status = await companionBaseStatus(
        runner,
        app.path,
        record.id,
        owner,
      );
      out.push({
        name: app.name,
        url: status.answers ? status.url : (status.record?.url ?? null),
        answered: status.answers,
        implemented: true,
        source,
        reason: status.answers ? null : status.reason,
      });
      continue;
    }
    const common = await gitCommonDir(runner, app.path);
    const preview = await readPreviewRecord(common, source.id);
    const url = preview?.url ?? null;
    const stages = await readStages(common, source.id);
    const answered = url !== null && (await urlAnswers(url));
    const implemented =
      stages?.entries.some((e) => e.state === "integrate-wait") ?? false;
    out.push({
      name: app.name,
      url,
      answered,
      implemented,
      source,
      reason:
        url === null
          ? "preview の記録に URL がありません"
          : !answered
            ? "プレビューの URL が答えません"
            : !implemented
              ? "実装がまだです"
              : null,
    });
  }
  return out;
}

/** ブランチのアプリと土台のアプリを合わせて見る。baseApps のある記録だけ、行に出どころを付ける */
export async function inspectAllApps(
  runner: Runner,
  record: Companion,
  root: string,
): Promise<E2eApp[]> {
  const apps = await inspectApps(runner, record);
  const bases = await inspectBaseApps(runner, record, root);
  if (bases.length === 0) return apps;
  return [
    ...apps.map((a) => ({ ...a, source: { kind: "branch" as const } })),
    ...bases,
  ];
}

/** 土台のアプリの行か（前の画面も後と同じ URL で埋める） */
export const isBaseAppRow = (app: E2eApp): boolean =>
  app.source !== undefined && app.source.kind !== "branch";

/** シェルの1語に引用する */
export const shellQuote = (text: string): string =>
  `'${text.replace(/'/g, `'\\''`)}'`;

/** 印を引用した URL に置き換え、テストの指定を1つずつ引用して末尾に足す */
export function buildCommand(
  command: string,
  apps: readonly E2eApp[],
  tests: readonly string[],
): string {
  const urls = new Map(apps.map((a) => [a.name, a.url ?? ""]));
  const filled = command.replace(PREVIEW_URL_MARK, (_all, name: string) =>
    shellQuote(urls.get(name) ?? ""),
  );
  return [filled, ...tests.map(shellQuote)].join(" ");
}
