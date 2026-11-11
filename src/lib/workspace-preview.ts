import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createOrca } from "./orca.ts";
import { launchBackground } from "./background.ts";
import { companionBaseApps, readCompanion } from "./companion.ts";
import { resolveBaseAppSources } from "./companion-source.ts";
import { samePath } from "./paths.ts";
import {
  noStopTargetMessage,
  readPreviewRecord,
  urlAnswers,
} from "./preview.ts";
import { stateHome } from "./preview-base.ts";
import { commonRecordPath, escapeId } from "./task-id.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { gitCommonDir, listBranches } from "./git.ts";
import {
  chooseGroup,
  parseGroupTarget,
  type ChildBranches,
  type GroupTarget,
  type Membership,
} from "./group-branch.ts";
import { outsideGroupReason } from "./workspace-group.ts";
import type { Workspace, WorkspaceRepo } from "./workspace.ts";
import { FlowError, type CommandContext } from "../types.ts";

/** 子の1つ分の結果 */
export interface PreviewRepoResult {
  name: string;
  url: string | null;
  result: "opened" | "started" | "reused" | "stopped" | "skipped" | "failed";
  /** 飛ばした・落ちた理由。開いたときは null */
  reason: string | null;
  /** タブを開いた先。ワークスペースのフォルダ、または各アプリの worktree。開かなかったら null */
  openedIn: string | null;
  /** 土台のアプリの行だけ。どの E2E の子の baseApps で、出どころは何か */
  baseApp?: BaseAppRow;
}

/** 土台のアプリの行の出どころ */
export interface BaseAppRow {
  /** 伴う記録を持つ E2E の子の名前 */
  e2e: string;
  /** task＝依存元のタスクのプレビュー、baseBranch＝土台のアプリ、undecided＝決めきれない（止めるときは null） */
  source: "task" | "baseBranch" | "undecided" | null;
  /** 依存元のタスクの ID（task のときだけ） */
  task?: string;
}

export interface PreviewRunData {
  id: string;
  repos: PreviewRepoResult[];
}

type RunChild = (
  repo: WorkspaceRepo,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 背景のログのパス。環境変数で場所を決める */
export function previewLogPath(
  env: NodeJS.ProcessEnv,
  id: string,
  base = false,
): string {
  return commonRecordPath(
    stateHome(env),
    base ? "workspace-preview-base" : "workspace-preview",
    id,
    ".log",
  );
}

const USAGE =
  "使い方：orca-flow workspace --preview 〈ブランチ名〉 [--stop] [--background] [--base]（組のブランチ名 〈branchPrefix〉〈ID〉-〈短い名前〉 で打ちます。ID では打てません）";

/** 引数の1つめを ID かブランチ名に分ける（ID は resolvePreviewGroup で候補を出して止める）。外れれば FlowError(1) */
export function requireTarget(positionals: readonly string[]): GroupTarget {
  const text = positionals[0];
  if (text === undefined || positionals.length !== 1)
    throw new FlowError(1, USAGE);
  try {
    return parseGroupTarget(text);
  } catch (error) {
    if (error instanceof FlowError)
      throw new FlowError(1, `${error.message}\n${USAGE}`);
    throw error;
  }
}

/** 組の ID と、アプリの子ごとのブランチ名での見分け */
export interface PreviewGroup {
  id: string;
  /** 打たれた組のブランチ名 */
  branch: string;
  members: ReadonlyMap<string, Membership>;
}

/**
 * アプリの子の設定と手元のブランチから、組を決める。設定・ブランチを読めない子は見分けに使わない
 * （その子は起動のときに設定なしなどで飛ばす）。
 * ID で打った・ブランチ名が外れる・どの子にもなければ FlowError(1)
 * （allowMissing なら、どの子にもないブランチ名でも止めない。--stop の片づけ用）
 */
export async function resolvePreviewGroup(
  ctx: CommandContext,
  workspace: Workspace,
  target: GroupTarget,
  runChild: RunChild,
  retype: (branch: string) => string,
  options: { allowMissing?: boolean } = {},
): Promise<PreviewGroup> {
  const children: ChildBranches[] = [];
  for (const repo of workspace.repos) {
    if (repo.role !== "app") continue;
    const config = await runChild(repo, ["config", "--json"]);
    if (config.code !== 0) continue;
    const raw = parseJson(config.stdout) as Record<string, unknown> | null;
    const text = (key: "branchPrefix" | "idPrefix") => {
      const value = raw?.[key];
      return typeof value === "string" && value !== ""
        ? value
        : DEFAULT_CONFIG[key];
    };
    let branches: string[];
    try {
      branches = await listBranches(ctx.runner, repo.path);
    } catch {
      continue;
    }
    children.push({
      name: repo.name,
      branchPrefix: text("branchPrefix"),
      idPrefix: text("idPrefix"),
      branches,
    });
  }
  const choice = chooseGroup(target, children, retype, options);
  return { id: choice.id, branch: choice.branch, members: choice.members };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * 子の stderr から理由の1行を選ぶ。stdout と2行目以降は端末の出力や秘密が混ざりうるので使わない。
 * 先に出た「警告：」で本当の理由を隠さないよう、`orca-flow:` の最後の行を優先する。
 */
const errorLine = (stderr: string, _stdout: string, code: number): string => {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const own = lines.filter((l) => l.startsWith("orca-flow:")).at(-1);
  const plain = lines.find((l) => !l.startsWith("警告："));
  return own ?? plain ?? lines[0] ?? `終了コード ${code}`;
};

/** 背景の子を起こしてすぐ戻る */
export async function previewBackground(
  ctx: CommandContext,
  workspace: Workspace,
  /** 打たれたブランチ名。背景の子にそのまま渡す */
  arg: string,
  id: string,
  base = false,
): Promise<void> {
  const log = previewLogPath(ctx.env, id, base);
  await mkdir(path.dirname(log), { recursive: true });
  await launchBackground(ctx.runner, {
    cwd: workspace.dir,
    log,
    args: ["workspace", "--preview", arg, ...(base ? ["--base"] : [])],
    failure: (reason) =>
      `組のアプリ${base ? "の前の画面" : ""}の背景の起動に失敗しました：${reason}。もう一度 orca-flow workspace --preview ${arg}${base ? " --base" : ""} --background を打ってください`,
  });
  if (!ctx.json)
    ctx.stdout(
      `組のアプリ${base ? "の前の画面" : ""}を背景で立てています。ログ：${log}`,
    );
}

/** 組のアプリを設定の順に1つずつ立て、答えた URL をタブに開く */
export async function previewStart(
  ctx: CommandContext,
  workspace: Workspace,
  group: PreviewGroup,
  runChild: RunChild,
  base = false,
): Promise<PreviewRunData> {
  const { id } = group;
  const orca = createOrca(ctx.runner, workspace.dir);
  const results: PreviewRepoResult[] = [];
  const say = (line: string) => {
    if (!ctx.json) ctx.stdout(line);
  };
  for (const repo of workspace.repos) {
    const skip = (reason: string) => {
      say(`${repo.name}：飛ばしました（${reason}）`);
      results.push({
        name: repo.name,
        url: null,
        result: "skipped",
        reason,
        openedIn: null,
      });
    };
    const fail = (reason: string, url: string | null = null) => {
      ctx.stderr(`${repo.name}：失敗しました（${reason}）`);
      results.push({
        name: repo.name,
        url,
        result: "failed",
        reason,
        openedIn: null,
      });
    };
    if (repo.role === "common") {
      skip("共通");
      continue;
    }
    const state = await previewState(runChild, repo, id);
    if (state.kind === "skip") {
      skip(state.reason);
      continue;
    }
    try {
      const outside = await outsideGroupReason(
        ctx.runner,
        workspace,
        repo,
        id,
        group.members.get(repo.name),
        group.branch,
      );
      if (outside !== null) {
        skip(outside);
        continue;
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      continue;
    }
    // 前の画面は子の中で setup.sh を流すので、タスクの setup を待たない
    const started = await runChild(
      repo,
      base
        ? ["preview", id, "--base", "--no-open", "--json"]
        : ["preview", id, "--after-setup", "--no-open", "--json"],
    );
    if (started.code !== 0) {
      fail(errorLine(started.stderr, started.stdout, started.code));
      continue;
    }
    const url = (parseJson(started.stdout) as { url?: unknown } | null)?.url;
    if (typeof url !== "string" || url === "") {
      fail("子の preview の答えに url がありません");
      continue;
    }
    if (base) {
      say(`${repo.name}：前の画面 ${url} を立てました`);
      results.push({
        name: repo.name,
        url,
        result: "started",
        reason: null,
        openedIn: null,
      });
      continue;
    }
    let openedIn: string | null = null;
    try {
      await orca.openUrlTab(workspace.dir, url);
      openedIn = workspace.dir;
    } catch (error) {
      ctx.stderr(
        `警告：ワークスペースのフォルダにタブを開けませんでした（${error instanceof Error ? error.message : String(error)}）。${repo.name} の worktree に開きます`,
      );
      try {
        await orca.openUrlTab(state.worktree, url);
        openedIn = state.worktree;
      } catch (error2) {
        fail(
          `タブを開けませんでした：${error2 instanceof Error ? error2.message : String(error2)}`,
          url,
        );
        continue;
      }
    }
    say(`${repo.name}：${url} を開きました`);
    results.push({
      name: repo.name,
      url,
      result: "opened",
      reason: null,
      openedIn,
    });
  }
  // 前の画面（--base）は後の画面と同じ URL を使うので、土台のアプリは後の画面のときだけ立てる
  if (!base)
    results.push(...(await startBaseApps(ctx, workspace, group, runChild)));
  return { id, repos: results };
}

/** 組の E2E の子と、その伴う記録の baseApps。組の外・記録なし・baseApps が空の子は入れない */
async function groupBaseApps(
  ctx: CommandContext,
  workspace: Workspace,
  group: PreviewGroup,
  inGroup: (repo: WorkspaceRepo) => Promise<boolean>,
): Promise<
  {
    e2e: WorkspaceRepo;
    apps: { name: string; path: string }[];
    error: string | null;
  }[]
> {
  const out = [];
  for (const e2e of workspace.repos) {
    if (e2e.role === "common" || !e2e.companion) continue;
    try {
      if (!(await inGroup(e2e))) continue;
      const companion = await readCompanion(ctx.runner, e2e.path, group.id);
      if (companion === null) continue;
      if (
        companion.taskBranch !== undefined &&
        companion.taskBranch !== group.branch
      )
        continue;
      const apps = companionBaseApps(companion);
      if (apps.length > 0) out.push({ e2e, apps, error: null });
    } catch (error) {
      out.push({ e2e, apps: [], error: messageOf(error) });
    }
  }
  return out;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * 組の E2E の子の伴う記録の baseApps ごとに、出どころを決めて立てる。
 * 依存元のタスクなら、そのプレビューが答えれば使い回し、答えなければアプリの子にその ID の preview を流す（止めも立て直しもしない）。
 * baseBranch なら土台のアプリを立てる。決めきれなければ失敗の行に理由を出す
 */
async function startBaseApps(
  ctx: CommandContext,
  workspace: Workspace,
  group: PreviewGroup,
  runChild: RunChild,
): Promise<PreviewRepoResult[]> {
  const { id } = group;
  const results: PreviewRepoResult[] = [];
  const say = (line: string) => {
    if (!ctx.json) ctx.stdout(line);
  };
  const owners = await groupBaseApps(ctx, workspace, group, async (repo) => {
    const outside = await outsideGroupReason(
      ctx.runner,
      workspace,
      repo,
      id,
      group.members.get(repo.name),
      group.branch,
    );
    return outside === null;
  });
  for (const { e2e, apps, error } of owners) {
    if (error !== null) {
      ctx.stderr(`${e2e.name} の土台のアプリ：失敗しました（${error}）`);
      results.push({
        name: e2e.name,
        url: null,
        result: "failed",
        reason: `伴う記録を読めません（${error}）`,
        openedIn: null,
        baseApp: { e2e: e2e.name, source: null },
      });
      continue;
    }
    const sources = await resolveBaseAppSources(ctx.runner, e2e.path, id, apps);
    for (const { app, source } of sources) {
      const row = (
        result: PreviewRepoResult["result"],
        url: string | null,
        reason: string | null,
      ): PreviewRepoResult => ({
        name: app.name,
        url,
        result,
        reason,
        openedIn: null,
        baseApp: {
          e2e: e2e.name,
          source: source.kind,
          ...(source.kind === "task" ? { task: source.id } : {}),
        },
      });
      const fail = (reason: string) => {
        ctx.stderr(
          `${app.name}（${e2e.name} の土台）：失敗しました（${reason}）`,
        );
        results.push(row("failed", null, reason));
      };
      if (source.kind === "undecided") {
        fail(source.reason);
        continue;
      }
      const repo = workspace.repos.find(
        (r) => r.role === "app" && samePath(r.path, app.path),
      );
      if (repo === undefined) {
        fail(`${app.path} はワークスペースの設定のアプリにありません`);
        continue;
      }
      if (source.kind === "task") {
        const answering = await answeringTaskPreview(ctx, app.path, source.id);
        if (answering !== null) {
          say(
            `${app.name}：${e2e.name} の土台に依存元のタスク ${source.id} のプレビュー ${answering} を使います`,
          );
          results.push(row("reused", answering, null));
          continue;
        }
      }
      const started = await runChild(
        repo,
        source.kind === "task"
          ? ["preview", source.id, "--after-setup", "--no-open", "--json"]
          : [
              "preview",
              id,
              "--companion-base",
              "--owner",
              e2e.path,
              "--no-open",
              "--json",
            ],
      );
      if (started.code !== 0) {
        fail(errorLine(started.stderr, started.stdout, started.code));
        continue;
      }
      const url = (parseJson(started.stdout) as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || url === "") {
        fail("子の preview の答えに url がありません");
        continue;
      }
      say(
        source.kind === "task"
          ? `${app.name}：${e2e.name} の土台に依存元のタスク ${source.id} のプレビュー ${url} を立てました`
          : `${app.name}：${e2e.name} の土台のアプリ（${source.branch} の先頭）${url} を立てました`,
      );
      results.push(row("started", url, null));
    }
  }
  return results;
}

/** 依存元のタスクのプレビューの記録の URL が答えれば、その URL。読めない・答えなければ null */
async function answeringTaskPreview(
  ctx: CommandContext,
  appPath: string,
  taskId: string,
): Promise<string | null> {
  try {
    const record = await readPreviewRecord(
      await gitCommonDir(ctx.runner, appPath),
      taskId,
    );
    if (record?.url === undefined) return null;
    return (await urlAnswers(record.url)) ? record.url : null;
  } catch {
    return null;
  }
}

/** 組の E2E の子の baseApps ごとに、自分が立てた土台のアプリだけを止める（依存元のタスクのプレビューは止めない） */
async function stopBaseApps(
  ctx: CommandContext,
  workspace: Workspace,
  group: PreviewGroup,
  runChild: RunChild,
  plans: ReadonlyMap<string, StopPlan>,
): Promise<PreviewRepoResult[]> {
  const { id } = group;
  const results: PreviewRepoResult[] = [];
  const owners = await groupBaseApps(
    ctx,
    workspace,
    group,
    async (repo) => plans.get(repo.name)?.kind === "stop",
  );
  for (const { e2e, apps, error } of [...owners].reverse()) {
    const baseApp: BaseAppRow = { e2e: e2e.name, source: null };
    if (error !== null) {
      const reason = `伴う記録を読めません（${error}）`;
      ctx.stderr(
        `${e2e.name} の土台のアプリ：止められませんでした（${reason}）`,
      );
      results.push({
        name: e2e.name,
        url: null,
        result: "failed",
        reason,
        openedIn: null,
        baseApp,
      });
      continue;
    }
    for (const app of [...apps].reverse()) {
      const row = { name: app.name, url: null, openedIn: null, baseApp };
      const label = `${app.name}（${e2e.name} の土台）`;
      const repo = workspace.repos.find(
        (r) => r.role === "app" && samePath(r.path, app.path),
      );
      if (repo === undefined) {
        const reason = `${app.path} はワークスペースの設定のアプリにありません`;
        ctx.stderr(`${label}：止められませんでした（${reason}）`);
        results.push({ ...row, result: "failed", reason });
        continue;
      }
      const stopped = await runChild(repo, [
        "preview",
        id,
        "--companion-base",
        "--stop",
        "--owner",
        e2e.path,
        "--json",
      ]);
      if (stopped.code !== 0) {
        const reason = errorLine(stopped.stderr, stopped.stdout, stopped.code);
        ctx.stderr(`${label}：止められませんでした（${reason}）`);
        results.push({ ...row, result: "failed", reason });
        continue;
      }
      if (!hadBaseToStop(stopped.stdout)) {
        if (!ctx.json)
          ctx.stdout(`${label}：飛ばしました（${NO_COMPANION_BASE_REASON}）`);
        results.push({
          ...row,
          result: "skipped",
          reason: NO_COMPANION_BASE_REASON,
        });
        continue;
      }
      if (!ctx.json) ctx.stdout(`${label}：止めました`);
      results.push({ ...row, result: "stopped", reason: null });
    }
  }
  return results;
}

const NO_COMPANION_BASE_REASON = "土台のアプリがありません";

type StopPlan =
  | { kind: "stop" }
  | { kind: "skip"; reason: string }
  | { kind: "fail"; reason: string };

/** 組のアプリを設定の逆の順に止める */
export async function previewStop(
  ctx: CommandContext,
  workspace: Workspace,
  group: PreviewGroup,
  runChild: RunChild,
  base = false,
): Promise<PreviewRunData> {
  const { id } = group;
  const results: PreviewRepoResult[] = [];
  const plans = new Map<string, StopPlan>();
  for (const repo of workspace.repos) {
    if (repo.role === "common") continue;
    try {
      const outside = await outsideGroupReason(
        ctx.runner,
        workspace,
        repo,
        id,
        group.members.get(repo.name),
        group.branch,
      );
      plans.set(
        repo.name,
        outside === null ? { kind: "stop" } : { kind: "skip", reason: outside },
      );
    } catch (error) {
      plans.set(repo.name, {
        kind: "fail",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (![...group.members.values()].some((m) => m.kind === "branch")) {
    const shown = escapeId(group.branch);
    if (![...plans.values()].some((p) => p.kind !== "skip"))
      throw new FlowError(
        1,
        `ブランチ ${shown} がどのアプリの子にもなく、${id} の記録で組に当たるアプリもないので、止めるものがありません`,
      );
    if (!ctx.json)
      ctx.stdout(
        `ブランチ ${shown} はどのアプリの子にもないので、${id} の記録で組に当たるアプリだけを止めます`,
      );
  }
  // 立てたのと逆の順なので、あとに立てた土台のアプリを先に止める
  if (!base)
    results.push(
      ...(await stopBaseApps(ctx, workspace, group, runChild, plans)),
    );
  for (const repo of [...workspace.repos].reverse()) {
    const row = { name: repo.name, url: null, openedIn: null };
    if (repo.role === "common") {
      if (!ctx.json) ctx.stdout(`${repo.name}：飛ばしました（共通）`);
      results.push({ ...row, result: "skipped", reason: "共通" });
      continue;
    }
    const plan = plans.get(repo.name)!;
    if (plan.kind === "skip") {
      if (!ctx.json) ctx.stdout(`${repo.name}：飛ばしました（${plan.reason}）`);
      results.push({ ...row, result: "skipped", reason: plan.reason });
      continue;
    }
    if (plan.kind === "fail") {
      ctx.stderr(`${repo.name}：止められませんでした（${plan.reason}）`);
      results.push({ ...row, result: "failed", reason: plan.reason });
      continue;
    }
    // 設定が外れていても、作業中でなくても、子の --stop は記録が残っていれば止めて消す
    const stopped = await runChild(
      repo,
      base
        ? ["preview", id, "--base", "--stop", "--json"]
        : ["preview", id, "--stop"],
    );
    const nothing = nothingToStop(stopped.code, stopped.stderr, id);
    if (nothing !== null) {
      if (!ctx.json) ctx.stdout(`${repo.name}：飛ばしました（${nothing}）`);
      results.push({ ...row, result: "skipped", reason: nothing });
      continue;
    }
    if (stopped.code !== 0) {
      const reason = errorLine(stopped.stderr, stopped.stdout, stopped.code);
      ctx.stderr(`${repo.name}：止められませんでした（${reason}）`);
      results.push({ ...row, result: "failed", reason });
      continue;
    }
    if (base && !hadBaseToStop(stopped.stdout)) {
      if (!ctx.json)
        ctx.stdout(`${repo.name}：飛ばしました（${NO_BASE_REASON}）`);
      results.push({ ...row, result: "skipped", reason: NO_BASE_REASON });
      continue;
    }
    if (!ctx.json) ctx.stdout(`${repo.name}：止めました`);
    results.push({ ...row, result: "stopped", reason: null });
  }
  return { id, repos: results };
}

const NO_BASE_REASON = "前の画面がありません";

/** 子の --base（--companion-base）--stop --json の答えに、片づけたものがあったか。読めなければあったことにする */
function hadBaseToStop(stdout: string): boolean {
  const data = parseJson(stdout) as Record<string, unknown> | null;
  if (data === null || typeof data !== "object") return true;
  return (
    data.hadRecord === true ||
    data.hadLeftover === true ||
    data.removedWorktree === true ||
    !("hadRecord" in data)
  );
}

/** 子の --stop が「止めるものがない」だけで終わったときの理由。違えば null */
function nothingToStop(
  code: number,
  stderr: string,
  id: string,
): string | null {
  if (code === 2) return "preview の設定も起動の記録もありません";
  if (code === 1 && stderr.includes(noStopTargetMessage(id)))
    return "作業中ではなく、起動の記録もありません";
  return null;
}

type State =
  { kind: "skip"; reason: string } | { kind: "ok"; worktree: string };

/** その子で ID が作業中か、preview の設定があるかを見る */
async function previewState(
  runChild: RunChild,
  repo: WorkspaceRepo,
  id: string,
): Promise<State> {
  const config = await runChild(repo, ["config", "--json"]);
  if (config.code !== 0)
    return { kind: "skip", reason: "子の設定を読めません" };
  const preview = (parseJson(config.stdout) as { preview?: unknown } | null)
    ?.preview;
  if (preview === null || preview === undefined)
    return { kind: "skip", reason: "preview の設定がありません" };
  const active = await runChild(repo, ["active", "--json"]);
  const rows = parseJson(active.stdout);
  const row = Array.isArray(rows)
    ? (rows as { id?: unknown; path?: unknown }[]).find((r) => r.id === id)
    : undefined;
  if (active.code !== 0 || row === undefined || typeof row.path !== "string")
    return { kind: "skip", reason: `${id} は作業中ではありません` };
  return { kind: "ok", worktree: row.path };
}
