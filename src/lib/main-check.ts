import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { FlowConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import { idFromMergeSubject } from "./merge-subject.ts";
import { launchBackground, ORCA_FLOW_MAIN } from "./background.ts";
import {
  acquireLock,
  releaseOrWarn,
  currentBootAt,
  holderAlive,
  type LockResult,
} from "./lock.ts";
import { shellCommand, type Runner } from "./exec.ts";
import { activeTasks, gitCommonDir, runGit } from "./git.ts";
import {
  createOrca,
  describeSendBlock,
  notSentWarning,
  remedyAfter,
  tellAfter,
} from "./orca.ts";
import { matchingPathVerify } from "./overlap.ts";
import {
  TAIL_LINES,
  VERIFY_TIMEOUT_MS,
  commandsFor,
  testRelevantFiles,
} from "./verified.ts";

/** 今の main の先頭の確かめの様子（先頭から first-parent をたどった最初の結果） */
export type MainCheckStatus =
  | { kind: "passed"; commit: string }
  | {
      kind: "failed";
      /** 結果を見つけたコミット（先頭か、その first-parent の祖先） */
      commit: string;
      /** 落ちた原因のコミット。探している間・分からないときは null */
      culprit: string | null;
      /** 原因のタスクの ID。マージでなければコミットの件名。culprit が null なら null */
      culpritLabel: string | null;
      /** 落ちたコマンド。分からなければ null */
      failedCommand: string | null;
      /**
       * known：原因が分かっている／searching：二分探索で探している／
       * stalled：探すプロセスがもういない／unknown：確かめられないコミットがあり原因が分からない
       */
      cause: "known" | "searching" | "stalled" | "unknown";
      /** 落ちた結果より上（新しい側）で確かめ中・待ち・確かめられなかったコミット。なければ付かない */
      above?: { kind: "running" | "pending" | "unchecked"; commit: string };
    }
  | {
      /** 確かめられなかった。止めない */
      kind: "unchecked";
      commit: string;
      logPath: string | null;
      failedCommand: string | null;
      /** prep：準備（checkout・setup.sh）の失敗／environment：原因の1つ前も今の環境で落ちた */
      reason: UncheckedReason;
    }
  | { kind: "running"; commit: string }
  | { kind: "pending"; commit: string }
  | { kind: "none" };

/** 確かめられなかった理由 */
export type UncheckedReason = "prep" | "environment";

/** 確かめられなかったときの文（括弧の中）。integrate・main-check run・一覧で同じ */
export const uncheckedDetail = (
  reason: UncheckedReason | null,
  failedCommand: string | null,
  logPath: string | null,
) =>
  reason === "environment"
    ? `原因の1つ前も今の環境で落ちました。環境の不調かもしれません：${failedCommand ?? "不明"}。ログ：${logPath ?? "不明"}`
    : `準備の失敗：${failedCommand ?? "不明"}。ログ：${logPath ?? "不明"}`;

/** integrate がマージのコミットに書く記録 */
export interface MergeRecordInput {
  /** マージのコミット */
  commit: string;
  /** マージしたタスクの ID */
  id: string;
  /** true なら木がタスクの記録と同じなので「通った」、false なら「待ち」 */
  sameTree: boolean;
  /** sameTree のときに通ったコマンド */
  commands: string[];
  /** 時刻（ISO 8601） */
  at: string;
}

/** 記録の状態：待ち・確かめ中・通った・落ちた・飛ばした・確かめられなかった */
export type CheckStatus =
  "pending" | "running" | "passed" | "failed" | "skipped" | "unchecked";

/** main のコミットごとの確かめの記録（`〈コミット〉.json`） */
export interface MainCheckRecord {
  commit: string;
  /** マージしたタスクの ID。マージでなければ null */
  id: string | null;
  subject: string;
  status: CheckStatus;
  commands: string[];
  failedCommand: string | null;
  /** 出力の最後の80行 */
  tail: string;
  logPath: string | null;
  at: string;
  /** タスクの記録と同じ木で通った印 */
  sameTree: boolean;
  /** running（と、原因を探している落ちた）のときのプロセスの番号 */
  pid: number | null;
  /** pid を書いたときのマシンの起動の時刻（秒）。古い記録は null */
  bootAt: number | null;
  /** true：落ちて、pid のプロセスが原因を二分探索で探している */
  searching: boolean;
  /** unchecked の理由 */
  uncheckedReason: UncheckedReason | null;
  /** true：二分探索の途中に確かめられないコミットがあり、原因が分からない */
  causeUnknown: boolean;
  /** 落ちたときの原因のコミット */
  culprit: string | null;
  culpritLabel: string | null;
  note: string | null;
}

/** 一覧や状態で見るときの上限（first-parent をたどる数） */
export const WALK_LIMIT = 200;

export const STATUS_LABEL: Record<CheckStatus, string> = {
  pending: "待ち",
  running: "確かめ中",
  passed: "通った",
  failed: "落ちた",
  skipped: "飛ばした",
  unchecked: "確かめられなかった",
};

/** 落ちた main の文などの短いコミットの桁（コマンドの間でそろえる） */
export const SHORT_COMMIT = 8;
export const shortCommit = (commit: string) => commit.slice(0, SHORT_COMMIT);

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const tailOf = (text: string, lines: number) =>
  text.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");

/** 置き場所：〈git の共通ディレクトリ〉/orca-flow/main-check（作業ツリーの外） */
export async function mainCheckDir(
  runner: Runner,
  cwd: string,
): Promise<string> {
  return path.join(await gitCommonDir(runner, cwd), "orca-flow", "main-check");
}

const recordFile = (dir: string, commit: string) =>
  path.join(dir, `${commit}.json`);

const isRecord = (value: unknown): value is MainCheckRecord => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.commit === "string" &&
    typeof v.status === "string" &&
    v.status in STATUS_LABEL
  );
};

/** 記録を読む。なければ・壊れていれば null */
export async function readCheckRecord(
  dir: string,
  commit: string,
): Promise<MainCheckRecord | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(recordFile(dir, commit), "utf8"),
    );
    if (!isRecord(parsed)) return null;
    return { ...blankRecord(parsed.commit, "", ""), ...parsed };
  } catch {
    return null;
  }
}

async function writeCheckRecord(
  dir: string,
  record: MainCheckRecord,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = recordFile(dir, record.commit);
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
}

/** プロセスのいない「確かめ中」は「待ち」と同じに扱う */
export const effectiveStatus = (record: MainCheckRecord): CheckStatus =>
  record.status === "running" && !holderAlive(record.pid, record.bootAt)
    ? "pending"
    : record.status;

const blankRecord = (
  commit: string,
  subject: string,
  at: string,
): MainCheckRecord => ({
  commit,
  id: null,
  subject,
  status: "pending",
  commands: [],
  failedCommand: null,
  tail: "",
  logPath: null,
  at,
  sameTree: false,
  pid: null,
  bootAt: null,
  searching: false,
  uncheckedReason: null,
  causeUnknown: false,
  culprit: null,
  culpritLabel: null,
  note: null,
});

const subjectOf = async (runner: Runner, cwd: string, commit: string) =>
  (
    await runGit(runner, cwd, ["log", "-1", "--format=%s", commit], "git log")
  ).trim();

/** baseBranch の先頭から first-parent の新しい順にコミットを並べる */
async function firstParents(
  runner: Runner,
  cwd: string,
  ref: string,
  limit = WALK_LIMIT,
): Promise<string[] | null> {
  const result = await runner(
    "git",
    ["rev-list", "--first-parent", "-n", String(limit), ref],
    { cwd },
  );
  if (result.code !== 0) return null;
  return result.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** 今の baseBranch の先頭の確かめの様子 */
export async function mainCheckState(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
): Promise<MainCheckStatus> {
  const commits = await firstParents(runner, cwd, config.baseBranch);
  if (!commits) return { kind: "none" };
  const dir = await mainCheckDir(runner, cwd);
  // 一番上の確かめ中・待ち・確かめられなかった（止めない側。下に落ちた結果があれば、落ちた扱いに添える）
  let top: Extract<
    MainCheckStatus,
    { kind: "running" | "pending" | "unchecked" }
  > | null = null;
  for (const commit of commits) {
    const record = await readCheckRecord(dir, commit);
    if (!record) continue;
    const status = effectiveStatus(record);
    if (status === "running" || status === "pending") {
      top ??= { kind: status, commit };
      continue;
    }
    if (status === "unchecked") {
      top ??= {
        kind: "unchecked",
        commit,
        logPath: record.logPath,
        failedCommand: record.failedCommand,
        reason: record.uncheckedReason ?? "prep",
      };
      continue;
    }
    // 下が通っていれば、一番上のものが今の様子（止めない）
    if (status === "passed" || status === "skipped")
      return top ?? { kind: "passed", commit };
    // 落ちた結果は、上で確かめが流れていても確かめられていなくても落ちた扱い
    const above = top ? { above: { kind: top.kind, commit: top.commit } } : {};
    const base = {
      kind: "failed" as const,
      commit,
      failedCommand: record.failedCommand,
    };
    if (record.culprit === null && record.searching)
      return {
        ...base,
        culprit: null,
        culpritLabel: null,
        cause: holderAlive(record.pid, record.bootAt) ? "searching" : "stalled",
        ...above,
      };
    if (record.culprit === null && record.causeUnknown)
      return {
        ...base,
        culprit: null,
        culpritLabel: null,
        cause: "unknown",
        ...above,
      };
    const culprit = record.culprit ?? record.commit;
    const culpritRecord =
      culprit === record.commit ? record : await readCheckRecord(dir, culprit);
    const label =
      record.culpritLabel ??
      culpritRecord?.id ??
      (culpritRecord?.subject ||
        (await subjectOf(runner, cwd, culprit).catch(() => culprit)));
    return {
      ...base,
      culprit,
      culpritLabel: label,
      cause: "known",
      ...above,
    };
  }
  return top ?? { kind: "none" };
}

/** 落ちた main の次にすること（approve・verify の警告の括弧の中） */
export const failedMainNext = (
  status: Extract<MainCheckStatus, { kind: "failed" }>,
) => {
  switch (status.cause) {
    case "known":
      return "戻すか、直すタスクを --fixes-main で入れてください";
    case "searching":
      return "原因が分かるまで、orca-flow main-check で様子を見てください";
    case "stalled":
      return "orca-flow main-check run で確かめ直してください";
    case "unknown":
      return "ログを見て、直すタスクを --fixes-main で入れるか、直ってから orca-flow main-check run で確かめ直してください";
  }
};

/** 落ちた main の最初の文（標準エラーに orca-flow verify の文字を入れない）。integrate・approve・verify で同じ */
export const failedMainLine = (
  status: Extract<MainCheckStatus, { kind: "failed" }>,
) => {
  const command = status.failedCommand ?? "落ちたコマンドは不明";
  switch (status.cause) {
    case "known":
      return `main の確かめが ${status.culpritLabel} の時点（${shortCommit(status.culprit ?? status.commit)}）で落ちています（${command}）`;
    case "searching":
      return `main の確かめが落ちています（${command}）。原因のコミットを探している途中です`;
    case "stalled":
      return `main の確かめが落ちています（${command}）。原因を探していたプロセスがもういません`;
    case "unknown":
      return `main の確かめが落ちています（${command}）。確かめられないコミットがあって、原因が分かりません`;
  }
};

/** マージのコミットに「待ち」か「通った（同じ木）」の記録を書く */
export async function recordMerge(
  runner: Runner,
  cwd: string,
  _config: FlowConfig,
  input: MergeRecordInput,
): Promise<void> {
  const dir = await mainCheckDir(runner, cwd);
  const record = blankRecord(
    input.commit,
    await subjectOf(runner, cwd, input.commit),
    input.at,
  );
  record.id = input.id;
  if (input.sameTree) {
    record.status = "passed";
    record.sameTree = true;
    record.commands = input.commands;
    record.note = "タスクの記録と同じ木";
  }
  await writeCheckRecord(dir, record);
}

export { ORCA_FLOW_MAIN };

/** 背景の確かめ（orca-flow main-check run）を Runner を通して起動し、終わりを待たずに戻る */
export async function launchMainCheck(
  runner: Runner,
  cwd: string,
): Promise<void> {
  const dir = await mainCheckDir(runner, cwd);
  await mkdir(dir, { recursive: true });
  const log = path.join(dir, "run.log");
  await launchBackground(runner, {
    cwd,
    log,
    args: ["main-check", "run"],
    failure: (reason) =>
      `main の確かめを起動できませんでした：${reason}。orca-flow main-check run で手で流してください`,
  });
}

// ---- 知らせの状態 ----

interface UnsentEntry {
  reason: string;
  remedy: string;
}

interface NoticeState {
  /** 前に知らせたところ（そのコミットまでに入ったタスクは知らせ済み） */
  notifiedUpTo: string | null;
  /** 送れなかったタスク（ID → 理由とすること） */
  unsent: Record<string, UnsentEntry>;
}

const noticeFile = (dir: string) => path.join(dir, "notice.state");

async function readNotice(dir: string): Promise<NoticeState> {
  try {
    const parsed = JSON.parse(
      await readFile(noticeFile(dir), "utf8"),
    ) as Partial<NoticeState>;
    return {
      notifiedUpTo:
        typeof parsed.notifiedUpTo === "string" ? parsed.notifiedUpTo : null,
      unsent:
        typeof parsed.unsent === "object" && parsed.unsent !== null
          ? parsed.unsent
          : {},
    };
  } catch {
    return { notifiedUpTo: null, unsent: {} };
  }
}

async function writeNotice(dir: string, state: NoticeState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(noticeFile(dir), `${JSON.stringify(state, null, 2)}\n`);
}

const warningText = (id: string, entry: UnsentEntry) =>
  notSentWarning(id, NOTICE_WHAT, entry.reason, entry.remedy);

/** 確かめのあとの「main が進んだ知らせ」を送れなかったタスクの警告（「送れませんでした」を含む）。なければ空 */
export async function unsentNoticeWarnings(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
): Promise<string[]> {
  const dir = await mainCheckDir(runner, cwd);
  const state = await readNotice(dir);
  const ids = Object.keys(state.unsent);
  if (ids.length === 0) return [];
  const active = new Set(
    (await activeTasks(runner, cwd, config)).map((t) => t.id),
  );
  return ids
    .filter((id) => active.has(id))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((id) => warningText(id, state.unsent[id]!));
}

/** 確かめのあとの知らせの警告：作業中なら区切りで rebase、統合待ちなら何もしなくてよい */
const NOTICE_WHAT = "main が進んだ知らせ";
const noticeNote = "。統合待ちのタスクなら、何もしなくてかまいません";
const noticeTellWhat = (config: FlowConfig) =>
  `作業中なら区切りで git rebase ${config.baseBranch} をする`;

/** 「main が進んだ知らせ」（確かめが通ったあと） */
export const mainCheckedNotice = (config: FlowConfig, ids: readonly string[]) =>
  `（${config.integratorName}より）${ids.length > 0 ? `main に ${ids.join("・")} が入り、` : "main が進み、"}main の確かめが通りました。作業中なら区切りで git rebase ${config.baseBranch} をしてください。統合待ちなら何もしなくてかまいません。`;

// ---- main-check run ----

export interface RunDeps {
  runner: Runner;
  cwd: string;
  config: FlowConfig;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
}

export interface CheckOutcome {
  commit: string;
  id: string | null;
  subject: string;
  status: CheckStatus;
  failedCommand: string | null;
  tail: string;
  logPath: string | null;
  /** unchecked のときの理由 */
  uncheckedReason: UncheckedReason | null;
  culprit: string | null;
  culpritLabel: string | null;
}

export type RunResult =
  | { kind: "locked"; lockPath: string; pid: number | null }
  | { kind: "done"; outcomes: CheckOutcome[]; notified: string[] | null };

const short = shortCommit;

/** run.lock を取る。待たずに数回で諦め、生きている持ち主がいれば held（中身が空の新しいロックも持ち主ありとみなす） */
async function acquireRunLock(dir: string): Promise<LockResult> {
  await mkdir(dir, { recursive: true });
  return acquireLock(path.join(dir, "run.lock"), {
    waitMs: 0,
    maxAttempts: 3,
    failed: (file, detail) =>
      `main の確かめのロックを読み書きできません（${file}：${detail}）。ロックのパスを確かめてください`,
    releaseFailed: (file, detail) =>
      `main の確かめのロックを外せませんでした（${file}：${detail}）。ロックが残っていれば、${file} を消してください`,
  });
}

/** 確かめ用の作業ツリーと git ディレクトリの名前（main-check/ の下） */
export const TREE_NAME = "tree";
export const GITDIR_NAME = "gitdir";

class Checker {
  readonly deps: RunDeps;
  readonly dir: string;
  readonly root: string;

  constructor(deps: RunDeps, dir: string, root: string) {
    this.deps = deps;
    this.dir = dir;
    this.root = root;
  }

  private git(args: string[], cwd = this.root, what = "git") {
    return runGit(this.deps.runner, cwd, args, what);
  }

  private async filesBetween(
    from: string,
    to: string,
  ): Promise<string[] | null> {
    const result = await this.deps.runner(
      "git",
      ["diff", "--name-only", "--no-renames", from, to],
      { cwd: this.root },
    );
    if (result.code !== 0) return null;
    return result.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  }

  /** 前からある確かめ用の worktree（linked worktree）を片付ける。node_modules は持ち越さない */
  private async removeLegacyWorktree(): Promise<void> {
    const old = path.join(this.dir, "worktree");
    if (!(await exists(old))) return;
    const removed = await this.deps.runner(
      "git",
      ["worktree", "remove", "--force", old],
      { cwd: this.root },
    );
    if (removed.code !== 0) {
      await rm(old, { recursive: true, force: true });
      await this.deps.runner("git", ["worktree", "prune"], { cwd: this.root });
    }
  }

  /**
   * 確かめ用の作業ツリー（手作り。`git worktree list` に載らない）を用意して commit に切り替える。
   * 自分で作る git ディレクトリ（main-check/gitdir）に commondir（main の共通ディレクトリ）と HEAD を置き、
   * 作業ツリー（main-check/tree）の .git ファイルからそこを指す。`git rev-parse --git-common-dir` が
   * main の共通ディレクトリを返すので、init の setup.sh も linked worktree と同じに流れる。
   * fresh なら作り直す。作業ツリーは使い回す（node_modules も残る）
   */
  private async checkout(commit: string, fresh = false): Promise<string> {
    const wt = path.join(this.dir, TREE_NAME);
    const gitdir = path.join(this.dir, GITDIR_NAME);
    await this.removeLegacyWorktree();
    // この版より前のクローンが残っていれば消す
    await rm(path.join(this.dir, "clone"), { recursive: true, force: true });
    const usable =
      !fresh &&
      (await this.deps.runner("git", ["rev-parse", "--git-dir"], { cwd: wt }))
        .code === 0 &&
      (await exists(path.join(wt, ".git")));
    if (!usable) {
      await rm(wt, { recursive: true, force: true });
      await rm(gitdir, { recursive: true, force: true });
      await mkdir(gitdir, { recursive: true });
      await mkdir(wt, { recursive: true });
      const common = path.resolve(
        this.root,
        await gitCommonDir(this.deps.runner, this.root),
      );
      await writeFile(path.join(gitdir, "commondir"), `${common}\n`);
      await writeFile(path.join(gitdir, "HEAD"), `${commit}\n`);
      await writeFile(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
    }
    await this.git(
      ["checkout", "--detach", "--force", "--quiet", commit],
      wt,
      "git checkout",
    );
    return wt;
  }

  /** 1つのコミットを確かめ、記録を書く。base は最後に通ったコミット（なければ null） */
  async check(
    commit: string,
    base: string | null,
    pathVerifyFrom: string | null,
    /** true：落ちたら、このプロセスが原因を二分探索で探す */
    willSearch = false,
  ): Promise<MainCheckRecord> {
    const { runner, config, now } = this.deps;
    const existing = await readCheckRecord(this.dir, commit);
    const record =
      existing ??
      blankRecord(commit, await subjectOf(runner, this.root, commit), "");
    record.culprit = null;
    record.culpritLabel = null;
    record.failedCommand = null;
    record.tail = "";
    record.sameTree = false;
    record.note = null;
    record.searching = false;
    record.uncheckedReason = null;
    record.causeUnknown = false;
    record.logPath = path.join(this.dir, "logs", `${commit}.log`);

    // 差分でコマンドを決める
    const from = base ?? pathVerifyFrom;
    const files = from ? await this.filesBetween(from, commit) : null;
    if (
      base !== null &&
      files !== null &&
      testRelevantFiles(files, config).length === 0
    ) {
      record.status = "skipped";
      record.commands = [];
      record.pid = null;
      record.bootAt = null;
      record.at = now().toISOString();
      record.note = "最後に通ったコミットからの差がテストに関係しない場所だけ";
      await writeCheckRecord(this.dir, record);
      this.deps.stdout(
        `飛ばしました：${short(commit)}（テストに関係する変更がありません）`,
      );
      return record;
    }
    const commands =
      base !== null
        ? commandsFor(config, files ?? [])
        : [
            ...config.verify,
            ...matchingPathVerify(files ?? [], config.pathVerify),
          ];
    record.commands = commands;
    record.status = "running";
    record.pid = process.pid;
    record.bootAt = currentBootAt();
    record.at = now().toISOString();
    await writeCheckRecord(this.dir, record);

    await mkdir(path.dirname(record.logPath), { recursive: true });
    await writeFile(record.logPath, "");
    const log = (text: string) => appendFile(record.logPath!, text);

    const finish = async (
      status: "passed" | "failed" | "unchecked",
      failedCommand: string | null,
      tail: string,
    ) => {
      record.status = status;
      record.failedCommand = failedCommand;
      record.tail = tail;
      // 落ちて原因を探すあいだは、探すプロセスの番号を残す（原因は書かない）
      const searching = status === "failed" && willSearch;
      record.searching = searching;
      record.uncheckedReason = status === "unchecked" ? "prep" : null;
      record.pid = searching ? process.pid : null;
      record.bootAt = searching ? currentBootAt() : null;
      record.at = now().toISOString();
      await writeCheckRecord(this.dir, record);
      return record;
    };

    this.deps.stdout(
      `確かめています：${short(commit)}（${record.id ?? record.subject}）`,
    );
    // 準備の失敗は「落ちた」ではない：checkout は作業ツリーを作り直して1回だけやり直す
    let wt: string;
    try {
      wt = await this.checkout(commit);
    } catch (first) {
      await log(
        `${message(first)}\n（確かめ用の作業ツリーを作り直してやり直します）\n`,
      );
      try {
        wt = await this.checkout(commit, true);
      } catch (error) {
        await log(`${message(error)}\n`);
        return finish(
          "unchecked",
          "git checkout",
          tailOf(message(error), TAIL_LINES),
        );
      }
    }
    const steps: string[] = [];
    if (await exists(path.join(wt, ".orca-flow", "setup.sh")))
      steps.push("bash .orca-flow/setup.sh");
    steps.push(...commands);
    for (const step of steps) {
      const [cmd, args] =
        step === "bash .orca-flow/setup.sh"
          ? ["bash", [".orca-flow/setup.sh"]]
          : shellCommand(step);
      this.deps.stdout(`流しています：${step}`);
      const result = await runner(cmd, args, {
        cwd: wt,
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      await log(`$ ${step}\n${output}\n`);
      if (result.code !== 0 || result.timedOut) {
        const tail = tailOf(
          result.timedOut
            ? `${output}\n（時間内に終わりませんでした）`
            : output,
          TAIL_LINES,
        );
        // setup.sh の失敗は、コミットのせいとは限らないので「確かめられなかった」
        return finish(
          step === "bash .orca-flow/setup.sh" ? "unchecked" : "failed",
          step,
          tail,
        );
      }
    }
    return finish("passed", null, "");
  }

  /** 先頭が落ちたあと、base から head までで最初に落ちたコミットを二分探索で探す */
  async bisect(head: MainCheckRecord, base: string): Promise<void> {
    const { runner } = this.deps;
    const out = await runner(
      "git",
      ["rev-list", "--first-parent", "--reverse", `${base}..${head.commit}`],
      { cwd: this.root },
    );
    const range = out.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
    let hi = range.length - 1;
    // 前に落ちたと分かっているコミットがあれば、そこまでを探す
    for (let i = 0; i < hi; i++) {
      const known = await readCheckRecord(this.dir, range[i]!);
      // 原因の書いてある（確かな）落ちだけを近道に使う。途中で見た落ちは環境の不調かもしれない
      if (known && effectiveStatus(known) === "failed" && known.culprit) {
        hi = i;
        break;
      }
    }
    let lo = -1;
    /** この二分探索で確かめたコミット（環境の不調だったときに、まとめて「確かめられなかった」にする） */
    const checked = new Set<string>();
    if (range.length >= 2) {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const commit = range[mid]!;
        let record = await readCheckRecord(this.dir, commit);
        let status = record ? effectiveStatus(record) : null;
        if (
          status !== "passed" &&
          status !== "skipped" &&
          status !== "failed"
        ) {
          record = await this.check(commit, base, null);
          status = record.status;
          checked.add(commit);
        }
        if (status === "unchecked") {
          // 途中のコミットを確かめられなかったので、原因を決めずに終える
          head.culprit = null;
          head.culpritLabel = null;
          head.searching = false;
          head.causeUnknown = true;
          head.pid = null;
          head.bootAt = null;
          await writeCheckRecord(this.dir, head);
          return;
        }
        if (status === "failed") hi = mid;
        else lo = mid;
      }
    }
    const culprit = range[hi] ?? head.commit;
    // 環境の不調（壊れた node_modules など）はコマンドの失敗に見える。
    // 原因の1つ前を今の環境で流し直し、それも落ちれば原因を決めない
    const before = await parentOf(runner, this.root, culprit);
    if (before) {
      const prior = await readCheckRecord(this.dir, before);
      const again = await this.check(before, null, null);
      if (again.status !== "passed") {
        // 前に通っていた記録（最後に通ったコミットなど）は、動く環境で通った事実なので元に戻す
        if (prior && (prior.status === "passed" || prior.status === "skipped"))
          await writeCheckRecord(this.dir, prior);
        else checked.add(before);
        for (const c of checked) {
          const r = await readCheckRecord(this.dir, c);
          if (r && r.status === "failed") {
            r.status = "unchecked";
            r.uncheckedReason = "environment";
            r.note = "環境の不調かもしれないので、確かめられなかったことにした";
            r.pid = null;
            r.bootAt = null;
            r.searching = false;
            r.culprit = null;
            r.culpritLabel = null;
            await writeCheckRecord(this.dir, r);
          }
        }
        head.status = "unchecked";
        head.uncheckedReason = "environment";
        head.culprit = null;
        head.culpritLabel = null;
        head.searching = false;
        head.causeUnknown = false;
        head.pid = null;
        head.bootAt = null;
        head.note =
          "原因の1つ前も今の環境では落ちたので、確かめられなかったことにした";
        await writeCheckRecord(this.dir, head);
        return;
      }
    }
    const culpritRecord =
      culprit === head.commit ? head : await readCheckRecord(this.dir, culprit);
    head.culprit = culprit;
    head.searching = false;
    head.pid = null;
    head.bootAt = null;
    head.culpritLabel =
      culpritRecord?.id ??
      (culpritRecord?.subject || (await subjectOf(runner, this.root, culprit)));
    if (culpritRecord?.failedCommand) {
      head.failedCommand = culpritRecord.failedCommand;
    }
    // 原因と確かめた落ちは、次の二分探索の近道に使える印（原因を書く）をつける
    if (culpritRecord && culprit !== head.commit) {
      culpritRecord.culprit = culprit;
      culpritRecord.culpritLabel = head.culpritLabel;
      await writeCheckRecord(this.dir, culpritRecord);
    }
    await writeCheckRecord(this.dir, head);
  }

  /** 先頭が通ったとき、間の「待ち」を後の確かめに含まれたものとして飛ばしにする */
  async cover(head: string, base: string | null): Promise<void> {
    if (!base) return;
    const out = await this.deps.runner(
      "git",
      ["rev-list", "--first-parent", `${base}..${head}`],
      { cwd: this.root },
    );
    for (const commit of out.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")) {
      if (commit === head) continue;
      const record = await readCheckRecord(this.dir, commit);
      if (record && effectiveStatus(record) === "pending") {
        record.status = "skipped";
        record.pid = null;
        record.bootAt = null;
        record.note = "あとの先頭の確かめに含まれる";
        await writeCheckRecord(this.dir, record);
      }
    }
  }
}

const exists = async (file: string) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

/** 最後に通ったコミット：head の次から first-parent をたどって最初の「通った」「飛ばした」 */
async function lastPassed(
  runner: Runner,
  root: string,
  dir: string,
  head: string,
): Promise<string | null> {
  // 確かめた head からたどる（確かめの最中に入ったマージを含めない）
  const commits = (await firstParents(runner, root, head)) ?? [];
  for (const commit of commits) {
    if (commit === head) continue;
    const record = await readCheckRecord(dir, commit);
    if (!record) continue;
    const status = effectiveStatus(record);
    if (status === "passed" || status === "skipped") return commit;
  }
  return null;
}

const revParse = async (runner: Runner, root: string, ref: string) =>
  (await runGit(runner, root, ["rev-parse", ref], "git rev-parse")).trim();

/** 先頭のマージの差（親があれば）の起点 */
async function parentOf(
  runner: Runner,
  root: string,
  commit: string,
): Promise<string | null> {
  const result = await runner("git", ["rev-parse", `${commit}^1`], {
    cwd: root,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** main-check run：先頭を確かめる。終わったとき main が進んでいれば、もう一度確かめる */
export async function runMainCheck(
  deps: RunDeps,
  root: string,
): Promise<RunResult> {
  const { runner, config } = deps;
  const dir = await mainCheckDir(runner, root);
  const outcomes: CheckOutcome[] = [];
  let notified: string[] | null = null;
  for (let outer = 0; outer < 5; outer++) {
    const lock = await acquireRunLock(dir);
    if (lock.kind === "held") {
      if (outer === 0)
        return { kind: "locked", lockPath: lock.lockPath, pid: lock.pid };
      break;
    }
    const release = lock.release;
    try {
      const checker = new Checker(deps, dir, root);
      let first = true;
      for (let round = 0; round < 20; round++) {
        const head = await revParse(runner, root, config.baseBranch);
        const existing = await readCheckRecord(dir, head);
        const status = existing ? effectiveStatus(existing) : null;
        if (status === "passed" || status === "skipped") {
          deps.stdout(
            `すでに確かめ済みです：${short(head)}（${STATUS_LABEL[status]}）`,
          );
          if (first)
            outcomes.push({
              commit: head,
              id: existing!.id,
              subject: existing!.subject,
              status,
              failedCommand: null,
              tail: "",
              logPath: existing!.logPath,
              uncheckedReason: null,
              culprit: null,
              culpritLabel: null,
            });
          // コマンドも worktree の準備も流さず、まだ知らせていない ID の知らせだけを送る
          if (config.integrateVerify === "after-merge") {
            const base = await lastPassed(runner, root, dir, head);
            const ids = await sendNotice(deps, root, dir, head, base);
            if (ids) notified = [...(notified ?? []), ...ids];
          }
          // 知らせている間に main が進んでいれば続ける
          if ((await revParse(runner, root, config.baseBranch)) === head) break;
          continue;
        }
        first = false;
        const base = await lastPassed(runner, root, dir, head);
        const record = await checker.check(
          head,
          base,
          base ? null : await parentOf(runner, root, head),
          base !== null,
        );
        if (record.status === "failed" && base !== null) {
          await checker.bisect(record, base);
        } else if (record.status === "failed") {
          record.culprit = head;
          record.culpritLabel = record.id ?? record.subject;
          await writeCheckRecord(dir, record);
        }
        const passedNow =
          record.status === "passed" || record.status === "skipped";
        if (passedNow) await checker.cover(head, base);
        outcomes.push({
          commit: head,
          id: record.id,
          subject: record.subject,
          status: record.status,
          failedCommand: record.failedCommand,
          tail: record.tail,
          logPath: record.logPath,
          uncheckedReason: record.uncheckedReason,
          culprit: record.culprit,
          culpritLabel: record.culpritLabel,
        });
        if (passedNow && config.integrateVerify === "after-merge") {
          const ids = await sendNotice(deps, root, dir, head, base);
          if (ids) notified = [...(notified ?? []), ...ids];
        }
        const after = await revParse(runner, root, config.baseBranch);
        if (after === head) break;
      }
    } finally {
      await releaseOrWarn(release);
    }
    // ロックを離す前後に入ったマージは、起動してもロックで断られているので、ここで拾う
    const latest = await revParse(runner, root, config.baseBranch);
    const record = await readCheckRecord(dir, latest);
    const status = record ? effectiveStatus(record) : null;
    if (
      status === "passed" ||
      status === "skipped" ||
      status === "failed" ||
      status === "unchecked"
    )
      break;
  }
  return { kind: "done", outcomes, notified };
}

async function firstParentsWithSubject(
  runner: Runner,
  cwd: string,
  ref: string,
): Promise<{ commit: string; subject: string }[]> {
  const result = await runner(
    "git",
    [
      "log",
      "--first-parent",
      "-n",
      String(WALK_LIMIT),
      "--format=%H%x1f%s",
      ref,
    ],
    { cwd },
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((l) => l !== "")
    .map((line) => {
      const [commit = "", subject = ""] = line.split("\x1f");
      return { commit, subject };
    });
}

/** 先頭で通ったとき、前に知らせたあとに入ったタスクの ID をまとめて作業中のタスクに送る。知らせた ID を返す */
async function sendNotice(
  deps: RunDeps,
  root: string,
  dir: string,
  head: string,
  base: string | null,
): Promise<string[] | null> {
  const { runner, config } = deps;
  const state = await readNotice(dir);
  if (state.notifiedUpTo === head) return null;
  const stop = state.notifiedUpTo ?? base;
  const commits = await firstParentsWithSubject(runner, root, head);
  // 記録をまだ書いていない統括役のマージは、件名から ID を取る。
  // 前に知らせた位置も最後に通ったコミットもないときは、古いマージを並べないよう件名から取らない
  const fromSubject = stop !== null;
  const ids: string[] = [];
  // 知らせの状態がないときは、最後に通ったコミット自身も（まだ知らせていないので）含める
  const inclusive = state.notifiedUpTo === null;
  for (const { commit, subject } of commits) {
    if (commit === stop && !inclusive) break;
    const record = await readCheckRecord(dir, commit);
    const id =
      record?.id ??
      (fromSubject ? idFromMergeSubject(config.integratorName, subject) : null);
    if (id && !ids.includes(id)) ids.unshift(id);
    if (commit === stop) break;
  }
  // 新しく入った ID がなければ送らず、知らせ済みの位置だけ進める
  if (ids.length === 0) {
    await writeNotice(dir, { notifiedUpTo: head, unsent: state.unsent });
    return [];
  }
  const orca = createOrca(runner, root);
  const tasks = await activeTasks(runner, root, config);
  const text = mainCheckedNotice(config, ids);
  const unsent: Record<string, UnsentEntry> = {};
  const tellWhat = noticeTellWhat(config);
  for (const task of tasks) {
    try {
      const found = await orca.findSendTarget(task.path, config.lead.agent);
      if (found.kind !== "found") {
        unsent[task.id] = {
          reason: describeSendBlock(found, config.lead.agent),
          remedy: remedyAfter(
            found,
            task.id,
            config.lead.agent,
            tellWhat,
            noticeNote,
          ),
        };
        continue;
      }
      await orca.sendText(found.terminal.handle, text);
    } catch (error) {
      unsent[task.id] = {
        reason: `Orca の送信が失敗しました（${message(error)}）`,
        remedy: tellAfter("原因を直して", task.id, tellWhat, noticeNote),
      };
    }
  }
  for (const [id, entry] of Object.entries(unsent))
    deps.stderr(warningText(id, entry));
  await writeNotice(dir, { notifiedUpTo: head, unsent });
  return ids;
}

// ---- main-check（一覧） ----

export interface ListRow {
  commit: string;
  short: string;
  id: string | null;
  subject: string;
  /** none は記録なし */
  status: CheckStatus | "none";
  statusLabel: string;
  failedCommand: string | null;
  culprit: string | null;
  culpritLabel: string | null;
  /** 落ちて、原因を探している途中（探すプロセスが生きている） */
  searching: boolean;
  /** 落ちて、原因を探していたプロセスがもういない */
  stalled: boolean;
  /** unchecked の理由 */
  uncheckedReason: UncheckedReason | null;
  /** 落ちて、原因が分からない */
  causeUnknown: boolean;
  logPath: string | null;
  sameTree: boolean;
  at: string | null;
}

/** first-parent の新しい順に、コミットごとの確かめの結果 */
export async function listMainCheck(
  runner: Runner,
  cwd: string,
  config: FlowConfig,
  limit = 30,
): Promise<ListRow[]> {
  const out = await runner(
    "git",
    [
      "log",
      "--first-parent",
      "-n",
      String(limit),
      "--format=%H%x1f%s",
      config.baseBranch,
    ],
    { cwd },
  );
  if (out.code !== 0) return [];
  const dir = await mainCheckDir(runner, cwd);
  const rows: ListRow[] = [];
  for (const line of out.stdout.split(/\r?\n/).filter((l) => l !== "")) {
    const [commit = "", subject = ""] = line.split("\x1f");
    const record = await readCheckRecord(dir, commit);
    const status = record ? effectiveStatus(record) : "none";
    rows.push({
      commit,
      short: short(commit),
      id: record?.id ?? null,
      subject,
      status,
      statusLabel:
        status === "none"
          ? "記録なし"
          : `${STATUS_LABEL[status]}${record?.sameTree ? "（タスクの記録と同じ木）" : ""}`,
      failedCommand: record?.failedCommand ?? null,
      culprit: record?.culprit ?? null,
      culpritLabel: record?.culpritLabel ?? null,
      searching:
        status === "failed" &&
        !record?.culprit &&
        !!record?.searching &&
        holderAlive(record.pid, record.bootAt),
      stalled:
        status === "failed" &&
        !record?.culprit &&
        !!record?.searching &&
        !holderAlive(record.pid, record.bootAt),
      uncheckedReason:
        status === "unchecked" ? (record?.uncheckedReason ?? "prep") : null,
      causeUnknown: status === "failed" && (record?.causeUnknown ?? false),
      logPath: record?.logPath ?? null,
      sameTree: record?.sameTree ?? false,
      at: record?.at || null,
    });
  }
  return rows;
}
