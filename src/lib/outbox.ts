import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  commonRecordPath,
  escapeId,
  hasIdShape,
  requireIdShape,
} from "./task-id.ts";
import {
  OUTBOUND_KINDS,
  type FlowConfig,
  type OutboundKind,
} from "../config.ts";
import { FlowError } from "../types.ts";
import { runOrThrow, type Runner } from "./exec.ts";
import {
  attachSupport,
  createPr,
  editPrBody,
  envSecrets,
  findPr,
  isReviewerLogin,
  markPrReady,
  pushApprovedSha,
  readPendingReviewOf,
  readPrBody,
  redactSecrets,
  requestReviewers,
  submitPendingReview,
  type AttachInput,
  type GhContext,
  type PendingComment,
} from "./github.ts";
import {
  captureKey,
  restoreCaptureRefs,
  sideLabel,
  stageCaptures,
  textSha256,
  type CaptureRef,
} from "./pr-captures.ts";
import { e2eCapturesDir } from "./preview-base.ts";
import {
  readDrafts,
  recordedFixedBy,
  recordedSummary,
  type PendingDrafts,
} from "./pending-review.ts";
import {
  buildReplyBody,
  fixRangeOf,
  ancestryOf,
  hasCommit,
  type FixRange,
} from "./reply-body.ts";
import { gitCommonDir } from "./git.ts";
import { acquireLock, releaseOrWarn } from "./lock.ts";
import { reportPath, taskDocPath } from "./tasks.ts";

// 送りの案の置き場（6章『送りの案と見張りの記録』）：
// 〈git の共通ディレクトリ〉/orca-flow/outbox/〈タスクの ID〉/〈案の ID〉.json。1件1ファイル。作業ツリーの外。

/**
 * 案の状態。
 * queued＝積んだ／sending＝送っている（送る前に書く）／sent＝送った／skipped＝送らなかった（送る関数が何も書かなかったと言った）／
 * uncertain＝確かでない（送ったか分からない。自動では送り直さない）／ci-wait＝承認済み・CI 待ち／withdrawn＝取り下げた
 */
export type OutboxState =
  | "queued"
  | "sending"
  | "sent"
  | "skipped"
  | "uncertain"
  | "ci-wait"
  | "withdrawn";

export const STATE_LABEL: Record<OutboxState, string> = {
  queued: "積んだ",
  sending: "送っている",
  sent: "送った",
  skipped: "送らなかった",
  uncertain: "確かでない",
  "ci-wait": "承認済み・CI 待ち",
  withdrawn: "取り下げた",
};

/**
 * 送り先。同じ本文を別の送り先へ送れないよう、指紋に入る。
 * 種類ごとの欄は、ここに任意の欄として足す（返信のスレッドなど）。どれを指紋に入れるかは種類の表で決める
 */
export interface OutboxTarget {
  remote: string;
  branch: string;
  base: string;
  /** PR の番号。PR を作る前は null */
  pr: number | null;
  /** pr-create：PR の題（積むときに決める。伏せ字にしてある） */
  title?: string | null;
  /**
   * push：履歴を書き換えたあと（手で rebase したときなど）の送り直しの期待値（強制の push で「リモートがこの先頭なら上書きする」と照らす値）。
   * 積むときに push の記録の先頭から決める。ないときは早送りだけ。指紋に入る
   */
  expectedRemoteHead?: string | null;
  /** reply：積むときに読んだ保留中のレビュー（本投稿の直前に読み直して照らす）。指紋に入る */
  pending?: PendingSnapshot;
  /** rerequest：再依頼する相手のログイン名（並べ替え済み）。指紋に入る */
  reviewers?: string[];
  /** pr-create・pr-edit：載せる録画（ファイル名・大きさ・sha256 が指紋に入る。手元のパスは show に出すだけ） */
  captures?: CaptureRef[];
  /** pr-edit：積むときに読んだ PR の本文の sha256（送る直前に読み直して照らす）。指紋に入る */
  prBodySha?: string;
}

/**
 * reply の案に残す、保留中のレビューの写し（自分の下書きだけ）。
 * 本文は残さず、正規化した本文の sha256 だけを残す（照らしに使う。人に見せる本文は案の body にある）
 */
export interface PendingSnapshot {
  reviewId: string;
  /** レビューの本文の sha256 */
  summarySha: string;
  comments: {
    id: string;
    bodySha: string;
    path: string | null;
    line: number | null;
    replyToId: string | null;
  }[];
}

export interface OutboxItem {
  /** 案の ID（〈種類〉-v〈版〉）。タスクの中で一意 */
  id: string;
  taskId: string;
  kind: OutboundKind;
  version: number;
  target: OutboxTarget;
  /** 秘密の形を伏せ字にした本文 */
  body: string;
  /** 積んだときのタスクのブランチの先頭 */
  head: string;
  state: OutboxState;
  /** 種類・送り先・正規化した本文（と先頭）の sha256 */
  fingerprint: string;
  /** 古い記録を読むためだけに残す（新しくは付かない。send は CI を待たずにほかの案と同じに送る） */
  afterCi: boolean;
  /** 古い ci-wait の記録を読むためだけに残す（新しくは付かない） */
  approvedHead: string | null;
  approvedFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
  /** 落ちた理由など */
  note: string | null;
}

// ---- 種類の表 ----

/** 送る関数が「何も書かずに落ちた」と言うときに投げる。案は「送らなかった」になる */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

/** 送る関数。本文は伏せ字にしたものが渡る。何も書かずに落ちたと言えるときは NotSentError を投げる */
export type Sender = (item: OutboxItem, body: string) => Promise<void>;

/** 送る関数の差し込み口（sendItems に渡す）。表の makeSender から buildSenders で作る */
export type Senders = Partial<Record<OutboundKind, Sender>>;

/** 送る関数を作るための材料 */
export interface SendContext {
  g: GhContext;
  /** path は手元のパスの確かめに使う（なければ worktree のパスは確かめない） */
  task: { id: string; branch: string; path?: string };
  config: FlowConfig;
  root: string;
  /** git の共通ディレクトリ（reply が respond の記録を読む。なければ root から求める） */
  common?: string;
  /** pr-create を送る関数が、作った PR をここに置く（send が送ったあとの記録に使う。探し直さない） */
  created?: { pr: { number: number; url: string } | null };
}

/** `outbox add` に渡る入力（コマンドが読んだもの） */
export interface AddRequest {
  /** 本文（--body-file の中身。なければ空） */
  body: string;
  /** --pr */
  pr: number | null;
  /** --after-ci */
  afterCi: boolean;
  /** --title */
  title: string | null;
  /** --reviewers（rerequest） */
  reviewers?: string[] | null;
  /** pr-create：本文の末尾に節を足した録画（push だけが渡す） */
  captures?: CaptureRef[] | null;
  /** pr-edit：push が読んだ PR の本文と録画（push だけが渡す。outbox add からは渡らない） */
  prEdit?: { prBodySha: string; captures: CaptureRef[] } | null;
}

/** add の入力を確かめるときに使えるもの */
export interface AddContext {
  taskId: string;
  branch: string;
  /** 既定の題を求める（設計書から）。種類が必要なときだけ呼ぶ */
  defaultTitle: () => Promise<string>;
  /** 本文に書いてはいけないもの（手元のパス・秘密）の種類を探す。当たった種類だけを返す（値は返さない） */
  bodyProblems: (body: string) => string[];
  /** push の期待値を求める（push の記録の先頭が今の先頭の祖先でなければ、その先頭。なければ null） */
  expectedRemoteHead: () => Promise<string | null>;
  /** reply：PR の保留中のレビューを読む（respond が書いたコメントとそれ以外に分ける） */
  readPending?: (pr: number) => Promise<PendingDrafts>;
  /** reply：直しのコミットをたどる git の場所（tip はタスクのブランチの先頭） */
  git?: { runner: Runner; cwd: string; tip: string };
}

/** 確かめたあとの、積む中身 */
export interface AddPlan {
  body: string;
  afterCi: boolean;
  /** 種類ごとに足す送り先の欄（remote・branch・base は呼び手が入れる） */
  target: Partial<OutboxTarget>;
}

export interface KindSpec {
  /** 送る順（小さいほど先） */
  order: number;
  label: string;
  /** 見せるときの送り先 */
  destination: (item: OutboxItem) => string;
  /** 指紋に入れる中身（本文は別に入る） */
  fingerprintParts: (item: OutboxItem) => unknown;
  /** 積み直しの単位の鍵。同じ種類で鍵が同じ案だけが、積み直しで前の案を取り下げにする */
  unitKey: (target: OutboxTarget) => string;
  /** add の入力の受け取りと確かめ。足りなければ FlowError(1) */
  prepareAdd: (req: AddRequest, ctx: AddContext) => Promise<AddPlan>;
  /** 送る関数を作る */
  makeSender: (ctx: SendContext) => Sender;
}

const branchRef = (t: OutboxTarget) => `${t.remote}/${t.branch}`;

const requireNo = (
  req: AddRequest,
  kind: string,
  what: "title" | "after-ci",
) => {
  if (what === "title" && req.title !== null)
    throw new FlowError(
      1,
      `--title は pr-create だけにつけられます（${kind}）`,
    );
  if (what === "after-ci" && req.afterCi)
    throw new FlowError(1, "--after-ci は pr-ready だけにつけられます");
};

/** 書き込みより前の読みが落ちたとき、何も書いていないと言える NotSentError にする（NotSentError はそのまま） */
function notSentFromRead(
  error: unknown,
  what: string,
  env: NodeJS.ProcessEnv | undefined,
): NotSentError {
  if (error instanceof NotSentError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new NotSentError(
    `${what}読めませんでした（何も書いていません）：${redactBody(detail, env ?? {})}`,
  );
}

/** push が git に断られた（リモートは変わっていない）ときの stderr の形 */
const REJECTED = /\[rejected\]|non-fast-forward/i;

/** 直しのコミットが、たどれるはずの先頭からたどれない */
class FixUnreachable extends Error {
  readonly commentId: string;
  readonly sha: string;
  constructor(commentId: string, sha: string) {
    super(`直しのコミット ${sha.slice(0, 8)} が先頭からたどれません`);
    this.name = "FixUnreachable";
    this.commentId = commentId;
    this.sha = sha;
  }
}

/**
 * 本投稿の本文（人の本文＋組み立てた本文）を作る。
 * 返信ごとの直しのコミットが tip からたどれなければ FixUnreachable。範囲は git で決める
 */
async function composeReplyBody(input: {
  summary: string;
  comments: readonly PendingComment[];
  viewer: string | null;
  prUrl: string | null;
  fixedBy: Record<string, string[]>;
  git?: { runner: Runner; cwd: string; tip: string };
}): Promise<string> {
  const ranges = new Map<string, FixRange>();
  for (const c of input.comments) {
    const shas = input.fixedBy[c.id];
    if (!shas || shas.length === 0) continue;
    const git = input.git;
    if (!git) throw new FlowError(1, "直しのコミットをたどる手段がありません");
    for (const sha of shas) {
      // 先頭は呼ぶ側が手元にあると確かめてある。解けない SHA はたどれないものとして扱う
      if ((await ancestryOf(git.runner, git.cwd, sha, git.tip)) !== "yes")
        throw new FixUnreachable(c.id, sha);
    }
    ranges.set(c.id, await fixRangeOf(git.runner, git.cwd, shas));
  }
  return buildReplyBody({
    summary: input.summary,
    comments: input.comments,
    viewer: input.viewer,
    prUrl: input.prUrl,
    ranges,
  });
}

/**
 * 送る直前の組み立て用：場所（path・line）は積んだときの写しのものを使う。
 * push で行の番号が動いても、人が見た本文と同じになるため。写しにない ID は今のまま（照らしで止まる）
 */
function placedAsPending(
  comments: readonly PendingComment[],
  pending: PendingSnapshot,
): PendingComment[] {
  const placed = new Map(pending.comments.map((c) => [c.id, c]));
  return comments.map((c) => {
    const was = placed.get(c.id);
    return was ? { ...c, path: was.path, line: was.line } : c;
  });
}

/** reply の写しの照らす用の鍵：レビューの ID・本文の指紋・保留中のコメントの ID と本文の指紋（ID の順） */
function pendingKey(p: PendingSnapshot | undefined): unknown {
  if (!p) return null;
  return {
    reviewId: p.reviewId,
    summary: p.summarySha,
    comments: [...p.comments]
      .map((c) => ({ id: c.id, body: c.bodySha }))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
  };
}

/** 読んだ保留中のレビューの写し（本文は指紋にして残す） */
function snapshotOf(
  reviewId: string,
  summary: string,
  comments: readonly PendingComment[],
): PendingSnapshot {
  return {
    reviewId,
    summarySha: sha256(normalizeBody(summary)),
    comments: comments.map((c) => ({
      id: c.id,
      bodySha: sha256(normalizeBody(c.body)),
      path: c.path,
      line: c.line,
      replyToId: c.replyToId,
    })),
  };
}

/** 人に見せる本文：レビューの本文と、返す先の場所つきの下書きの全文 */
function renderPending(
  summary: string,
  comments: readonly PendingComment[],
): string {
  const parts: string[] = [];
  if (summary.trim() !== "") parts.push(`レビューの本文：\n${summary}`);
  for (const c of comments)
    parts.push(
      `返信（${c.path ?? "場所不明"}${c.line === null ? "" : `:${c.line}`}）：\n${c.body}`,
    );
  return parts.join("\n\n");
}

/** 保留中のレビューの本文・コメントに、伏せ字にすべき秘密や手元のパスがあれば、その種類（値は返さない） */
function pendingProblems(
  summary: string,
  comments: readonly PendingComment[],
  check: (body: string) => string[],
): string[] {
  const kinds = new Set<string>();
  for (const text of [summary, ...comments.map((c) => c.body)])
    for (const kind of check(text)) kinds.add(kind);
  return [...kinds];
}

const hasCaptures = (t: OutboxTarget) =>
  t.captures !== undefined && t.captures.length > 0;

/**
 * 送る直前の録画の確かめ：gh の版とホストを確かめ、録画を一時ディレクトリ dir へ写して大きさと sha256 を照らす。
 * 外れたら NotSentError（何も書いていない）。録画がなければ添付なし
 */
async function prepareAttach(
  ctx: SendContext,
  captures: readonly CaptureRef[],
  dir: string,
): Promise<AttachInput | undefined> {
  if (captures.length === 0) return undefined;
  let repo: string;
  let problem: string | null;
  try {
    const support = await attachSupport(ctx.g);
    if (!support.ok)
      throw new NotSentError(
        `録画を添付できません（${support.reason}）。何も書いていません。gh を更新するか、orca-flow push で積み直してください（添付できないときは録画なしの案になります）`,
      );
    repo = support.repo;
    const common = ctx.common ?? (await gitCommonDir(ctx.g.runner, ctx.root));
    problem = await stageCaptures(
      e2eCapturesDir(common, ctx.task.id),
      captures,
      dir,
    );
  } catch (error) {
    throw notSentFromRead(error, "録画か gh の版を", ctx.g.env);
  }
  if (problem !== null)
    throw new NotSentError(
      `${problem}（何も書いていません）。録画を見直し、orca-flow push で積み直してください`,
    );
  return { dir, names: captures.map((c) => c.name), repo };
}

/** 送る順：push → PR の作成 → 下書きを外す → ほか */
export const KIND_TABLE: Record<OutboundKind, KindSpec> = {
  push: {
    order: 10,
    label: "push",
    destination: (item) =>
      `${branchRef(item.target)}${item.target.expectedRemoteHead ? `（--force-with-lease：リモートが ${item.target.expectedRemoteHead.slice(0, 8)} のときだけ上書き）` : ""}`,
    // push は先頭の SHA を送るので、先頭を指紋に入れる。期待値は人が見た値として指紋に入れる（ないときは入れない）
    fingerprintParts: (item) => ({
      remote: item.target.remote,
      branch: item.target.branch,
      head: item.head,
      ...(item.target.expectedRemoteHead
        ? { expectedRemoteHead: item.target.expectedRemoteHead }
        : {}),
    }),
    unitKey: () => "push",
    prepareAdd: async (req, ctx) => {
      requireNo(req, "push", "title");
      requireNo(req, "push", "after-ci");
      return {
        body: req.body,
        afterCi: false,
        target: {
          pr: req.pr,
          expectedRemoteHead: await ctx.expectedRemoteHead(),
        },
      };
    },
    makeSender: (ctx) => async (item) => {
      // 承認した SHA を明示して push する（ブランチの名前では送らない）
      try {
        await pushApprovedSha(
          ctx.g,
          ctx.task.branch,
          ctx.config.baseBranch,
          item.head,
          { expectedRemoteHead: item.target.expectedRemoteHead ?? null },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // git が断ったときは、リモートを変えていない（早送りでない・期待値が古い）
        if (REJECTED.test(message))
          throw new NotSentError(
            `git に断られました（リモートは変えていません）。早送りにならないか、--force-with-lease の期待値が古くなっています。GitHub と手元を確かめ、案を積み直してください：${message}`,
          );
        throw error;
      }
    },
  },
  "pr-create": {
    order: 20,
    label: "PR の作成",
    destination: (item) => `${branchRef(item.target)} → ${item.target.base}`,
    // 録画のない案は前と同じ指紋にする（積んだままの古い案を壊さないため）
    fingerprintParts: (item) => ({
      remote: item.target.remote,
      branch: item.target.branch,
      base: item.target.base,
      title: item.target.title ?? null,
      ...(hasCaptures(item.target)
        ? { captures: captureKey(item.target.captures) }
        : {}),
    }),
    unitKey: () => "pr-create",
    prepareAdd: async (req, ctx) => {
      requireNo(req, "pr-create", "after-ci");
      if (req.body.trim() === "")
        throw new FlowError(
          1,
          "pr-create には --body-file で本文を渡してください",
        );
      const title = req.title ?? (await ctx.defaultTitle());
      if (title.trim() === "")
        throw new FlowError(1, "--title は空にできません");
      const problems = ctx.bodyProblems(req.body);
      if (problems.length > 0)
        throw new FlowError(
          1,
          `PR の本文に、${problems.join("、")}が含まれています。消してから、もう一度やり直してください（案は積んでいません）`,
        );
      const captures = req.captures ?? [];
      return {
        body: req.body,
        afterCi: false,
        target: {
          pr: req.pr,
          title,
          ...(captures.length > 0 ? { captures } : {}),
        },
      };
    },
    makeSender: (ctx) => async (item, body) => {
      // 題は積むときに決めて指紋に入れた案の題をそのまま使う（秘密は伏せ字）
      const raw =
        item.target.title ??
        `${ctx.task.id}: ${ctx.task.branch.replace(/^.*?\//, "")}`;
      const title = redactSecrets(raw, envSecrets(ctx.g.env ?? {}));
      const dir = await mkdtemp(path.join(os.tmpdir(), "orca-flow-send-"));
      try {
        // 録画はファイル名だけで本文から参照するので、写した一時ディレクトリで gh を流す
        const attach = await prepareAttach(
          ctx,
          item.target.captures ?? [],
          dir,
        );
        const bodyFile = path.join(dir, "body.md");
        await writeFile(bodyFile, body);
        const created = await createPr(ctx.g, {
          base: item.target.base,
          head: item.target.branch,
          title,
          bodyFile,
          ...(attach ? { attach } : {}),
        });
        // 作った PR の番号を送ったあとの処理へ渡す（send が記録に書く。あとの案が落ちても番号が残る）
        if (ctx.created)
          ctx.created.pr = { number: created.number, url: created.url };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  "pr-ready": {
    order: 30,
    label: "下書きを外す",
    destination: (item) =>
      `${branchRef(item.target)} の PR${item.target.pr === null ? "" : ` #${item.target.pr}`}`,
    fingerprintParts: (item) => ({
      remote: item.target.remote,
      branch: item.target.branch,
      base: item.target.base,
      pr: item.target.pr,
      afterCi: item.afterCi,
    }),
    unitKey: () => "pr-ready",
    prepareAdd: async (req) => {
      requireNo(req, "pr-ready", "title");
      return { body: req.body, afterCi: false, target: { pr: req.pr } };
    },
    makeSender: (ctx) => async (item) => {
      const found = await findPr(ctx.g, item.target.branch);
      if (found === null)
        throw new NotSentError(
          "下書きを外す PR が見つかりません（何も書いていません）",
        );
      // 案の PR 番号が、タスクのブランチの PR と違えば、別の PR を外してしまうので送らない
      if (item.target.pr !== null && item.target.pr !== found.number)
        throw new NotSentError(
          `案の PR #${item.target.pr} はタスクのブランチの PR（#${found.number}）ではありません（何も書いていません）`,
        );
      // 下書きでなければ外すものがない（gh pr ready を呼ばず、送ったとして終える）
      if (!found.isDraft) return;
      await markPrReady(ctx.g, found.number);
    },
  },
  reply: {
    order: 40,
    label: "返信の本投稿",
    destination: (item) =>
      `PR${item.target.pr === null ? "" : ` #${item.target.pr}`} の保留中のレビュー（下書き ${item.target.pending?.comments.length ?? 0} 件）を本投稿（COMMENT）`,
    // 人が見た中身（レビューの ID・本文・保留中のコメントの ID と本文）を指紋に入れる
    fingerprintParts: (item) => ({
      remote: item.target.remote,
      branch: item.target.branch,
      pr: item.target.pr,
      pending: pendingKey(item.target.pending),
    }),
    unitKey: (t) => `reply:${t.pr}`,
    prepareAdd: async (req, ctx) => {
      requireNo(req, "reply", "title");
      requireNo(req, "reply", "after-ci");
      if (req.pr === null)
        throw new FlowError(1, "reply には --pr で PR の番号を渡してください");
      if (req.body.trim() !== "" || (req.reviewers ?? null) !== null)
        throw new FlowError(
          1,
          "reply の本文は保留中のレビューから読みます（--body-file と --reviewers は渡せません）",
        );
      if (!ctx.readPending)
        throw new FlowError(1, "保留中のレビューを読む手段がありません");
      const drafts = await ctx.readPending(req.pr);
      if (drafts.foreign.length > 0)
        throw new FlowError(
          2,
          `保留中のレビューに、respond の記録にないコメント（人が GitHub で書いたか、記録が欠けた）が ${drafts.foreign.length} 件あります。まとめて本投稿しないよう、案は積んでいません。GitHub の画面で確かめ、要らなければ消してください`,
        );
      if (
        drafts.reviewId === null ||
        (drafts.mine.length === 0 && drafts.body.trim() === "")
      )
        throw new FlowError(
          1,
          `PR #${req.pr} の保留中のレビューに下書きがありません（案は積んでいません）`,
        );
      // 人が GitHub で直したかもしれないので、本投稿する中身そのものに秘密と手元のパスの確かめをかける
      const problems = pendingProblems(
        drafts.body,
        drafts.mine,
        ctx.bodyProblems,
      );
      if (problems.length > 0)
        throw new FlowError(
          1,
          `保留中のレビューに、${problems.join("、")}が含まれています。GitHub の画面か respond draft で消してから、もう一度やり直してください（案は積んでいません）`,
        );
      // 組み立てた全文（人の本文・空行・組み立てた本文）を案の本文と写しに入れる
      let full: string;
      try {
        full = await composeReplyBody({
          summary: drafts.body,
          comments: drafts.mine,
          viewer: drafts.viewer,
          prUrl: drafts.prUrl,
          fixedBy: drafts.fixedBy,
          git: ctx.git,
        });
      } catch (error) {
        if (error instanceof FixUnreachable)
          throw new FlowError(
            1,
            `記録の直しのコミット ${error.sha.slice(0, 8)} が、タスクのブランチの先頭からたどれません（案は積んでいません）。orca-flow respond draft 〈ID〉 --edit ${error.commentId} --fixed-by 〈直しのコミット〉,…（外すなら none）で直してください`,
          );
        throw error;
      }
      return {
        body: renderPending(full, drafts.mine),
        afterCi: false,
        target: {
          pr: req.pr,
          pending: snapshotOf(drafts.reviewId, full, drafts.mine),
        },
      };
    },
    makeSender: (ctx) => async (item) => {
      const pr = item.target.pr;
      const pending = item.target.pending;
      if (pr === null || !pending)
        throw new NotSentError(
          "返信の案に PR か下書きがありません（何も書いていません）",
        );
      // 本投稿より前の読みが落ちたときは、何も書いていないと言える
      let found: Awaited<ReturnType<typeof findPr>>;
      let now: Awaited<ReturnType<typeof readPendingReviewOf>>;
      let summary = "";
      let fixedBy: Record<string, string[]> = {};
      try {
        found = await findPr(ctx.g, item.target.branch);
        if (found === null || found.number !== pr)
          throw new NotSentError(
            `案の PR #${pr} はタスクのブランチの PR ではありません（何も書いていません）`,
          );
        now = await readPendingReviewOf(ctx.g, pr);
        if (now.review) {
          // 本文は記録のものを優先し、なければ GitHub の本文（loadPendingDrafts と同じ決め方）
          const common =
            ctx.common ?? (await gitCommonDir(ctx.g.runner, ctx.root));
          const record = await readDrafts(common, ctx.task.id);
          const recorded = recordedSummary(record, pr, now.review.id);
          if (recorded !== undefined) summary = recorded;
          else summary = now.review.body;
          fixedBy = recordedFixedBy(record, pr, now.review.id);
        }
      } catch (error) {
        throw notSentFromRead(error, "PR か保留中のレビューを", ctx.g.env);
      }
      if (!now.review)
        throw new NotSentError(
          "保留中のレビューが、人が見たときから変わっています（何も本投稿していません）。respond で見直し、案を積み直してください",
        );
      // 直しのコミットは、PR の先頭からたどれなければ送らない（PR にないリンクを出さないため）
      const hasFix = now.review.comments.some(
        (c) => (fixedBy[c.id] ?? []).length > 0,
      );
      if (hasFix && !found.headSha)
        throw new NotSentError(
          "PR の先頭が分からないので、直しのコミットが PR にあるか確かめられません（何も本投稿していません）。push を先に送り、PR に届いてから案を積み直してください",
        );
      if (
        hasFix &&
        found.headSha &&
        !(await hasCommit(ctx.g.runner, ctx.root, found.headSha))
      )
        throw new NotSentError(
          `PR の先頭 ${found.headSha.slice(0, 8)} が手元にありません（何も本投稿していません）。git fetch で取り込んでから、案を積み直してください`,
        );
      let full: string;
      try {
        full = await composeReplyBody({
          summary,
          comments: placedAsPending(now.review.comments, pending),
          viewer: now.viewer,
          prUrl: now.prUrl,
          fixedBy,
          git: {
            runner: ctx.g.runner,
            cwd: ctx.root,
            tip: found.headSha ?? "",
          },
        });
      } catch (error) {
        if (error instanceof FixUnreachable)
          throw new NotSentError(
            `直しのコミット ${error.sha.slice(0, 8)} が PR の先頭からたどれません（何も本投稿していません）。push を先に送り、PR に届いてから案を積み直してください`,
          );
        throw notSentFromRead(error, "直しのコミットの範囲を", ctx.g.env);
      }
      if (
        JSON.stringify(pendingKey(pending)) !==
        JSON.stringify(
          pendingKey(snapshotOf(now.review.id, full, now.review.comments)),
        )
      )
        throw new NotSentError(
          "保留中のレビューが、人が見たときから変わっています（何も本投稿していません）。respond で見直し、案を積み直してください",
        );
      // 読み直した中身にも、積むときと同じ確かめをかける（承認した中身が、伏せ字にしていない生の中身と一致していても出さない）
      const problems = pendingProblems(summary, now.review.comments, (text) =>
        bodyProblemsOf(text, {
          env: ctx.g.env ?? {},
          config: ctx.config,
          root: ctx.root,
          task: { id: ctx.task.id, path: ctx.task.path ?? "" },
        }),
      );
      if (problems.length > 0)
        throw new NotSentError(
          `保留中のレビューに、${problems.join("、")}が含まれています（何も本投稿していません）。GitHub の画面か respond draft で消してから、案を積み直してください`,
        );
      await submitPendingReview(
        ctx.g,
        pending.reviewId,
        full.trim() === "" ? undefined : full,
      );
    },
  },
  rerequest: {
    order: 50,
    label: "レビューの再依頼",
    destination: (item) =>
      `PR${item.target.pr === null ? "" : ` #${item.target.pr}`} の ${(item.target.reviewers ?? []).join("、")}`,
    fingerprintParts: (item) => ({
      remote: item.target.remote,
      branch: item.target.branch,
      pr: item.target.pr,
      reviewers: item.target.reviewers ?? [],
    }),
    unitKey: (t) => `rerequest:${t.pr}`,
    prepareAdd: async (req) => {
      requireNo(req, "rerequest", "title");
      requireNo(req, "rerequest", "after-ci");
      if (req.pr === null)
        throw new FlowError(
          1,
          "rerequest には --pr で PR の番号を渡してください",
        );
      const reviewers = [...new Set(req.reviewers ?? [])].sort();
      if (reviewers.length === 0)
        throw new FlowError(
          1,
          "rerequest には --reviewers でログイン名を渡してください（a,b の形）",
        );
      const bad = reviewers.find((r) => !isReviewerLogin(r));
      if (bad !== undefined)
        throw new FlowError(
          1,
          `ログイン名の形が正しくありません：${escapeId(bad)}`,
        );
      return {
        body: req.body,
        afterCi: false,
        target: { pr: req.pr, reviewers },
      };
    },
    makeSender: (ctx) => async (item) => {
      const pr = item.target.pr;
      const reviewers = item.target.reviewers ?? [];
      if (pr === null || reviewers.length === 0)
        throw new NotSentError(
          "再依頼の案に PR か相手がありません（何も書いていません）",
        );
      try {
        const found = await findPr(ctx.g, item.target.branch);
        if (found === null || found.number !== pr)
          throw new NotSentError(
            `案の PR #${pr} はタスクのブランチの PR ではありません（何も書いていません）`,
          );
      } catch (error) {
        throw notSentFromRead(error, "PR を", ctx.g.env);
      }
      await requestReviewers(ctx.g, pr, reviewers);
    },
  },
  "pr-edit": {
    order: 35,
    label: "PR の本文の録画の直し",
    destination: (item) =>
      `PR${item.target.pr === null ? "" : ` #${item.target.pr}`} の本文の録画の節（録画 ${item.target.captures?.length ?? 0} 本）`,
    // 人が見た本文の元（積むときに読んだ PR の本文）と録画を指紋に入れる
    fingerprintParts: (item) => ({
      remote: item.target.remote,
      branch: item.target.branch,
      pr: item.target.pr,
      prBodySha: item.target.prBodySha ?? null,
      captures: captureKey(item.target.captures),
    }),
    unitKey: () => "pr-edit",
    prepareAdd: async (req, ctx) => {
      requireNo(req, "pr-edit", "title");
      requireNo(req, "pr-edit", "after-ci");
      const prEdit = req.prEdit ?? null;
      if (prEdit === null)
        throw new FlowError(
          1,
          "pr-edit の案は orca-flow push が積みます（PR の本文と録画を読んで積むため、outbox add では積めません）",
        );
      if (req.pr === null)
        throw new FlowError(1, "pr-edit には PR の番号が要ります");
      if (prEdit.captures.length === 0)
        throw new FlowError(1, "pr-edit に載せる録画がありません");
      const problems = ctx.bodyProblems(req.body);
      if (problems.length > 0)
        throw new FlowError(
          1,
          `PR の本文に、${problems.join("、")}が含まれています（案は積んでいません）`,
        );
      return {
        body: req.body,
        afterCi: false,
        target: {
          pr: req.pr,
          prBodySha: prEdit.prBodySha,
          captures: prEdit.captures,
        },
      };
    },
    makeSender: (ctx) => async (item, body) => {
      const pr = item.target.pr;
      const want = item.target.prBodySha;
      const captures = item.target.captures ?? [];
      if (pr === null || !want || captures.length === 0)
        throw new NotSentError(
          "本文の直しの案に PR か録画がありません（何も書いていません）",
        );
      try {
        const found = await findPr(ctx.g, item.target.branch);
        if (found === null || found.number !== pr || found.state !== "open")
          throw new NotSentError(
            `案の PR #${pr} はタスクのブランチの開いた PR ではありません（何も書いていません）`,
          );
        // 人が GitHub で本文を直していたら、その直しを消さないよう送らない
        if (textSha256(await readPrBody(ctx.g, pr)) !== want)
          throw new NotSentError(
            `PR #${pr} の本文が、積んだときから変わっています（何も書いていません）。orca-flow push で積み直してください`,
          );
      } catch (error) {
        throw notSentFromRead(error, "PR か PR の本文を", ctx.g.env);
      }
      const dir = await mkdtemp(path.join(os.tmpdir(), "orca-flow-send-"));
      try {
        const attach = await prepareAttach(ctx, captures, dir);
        const bodyFile = path.join(dir, "body.md");
        await writeFile(bodyFile, body);
        await editPrBody(ctx.g, pr, {
          bodyFile,
          ...(attach ? { attach } : {}),
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
};

/** 表のすべての種類の送る関数を作る。書き忘れは Record の型が見つける */
export function buildSenders(ctx: SendContext): Record<OutboundKind, Sender> {
  const senders = {} as Record<OutboundKind, Sender>;
  for (const kind of OUTBOUND_KINDS)
    senders[kind] = KIND_TABLE[kind].makeSender(ctx);
  return senders;
}

export const isOutboundKind = (value: string): value is OutboundKind =>
  (OUTBOUND_KINDS as readonly string[]).includes(value);

// ---- 指紋 ----

/** 本文の正規化：改行を LF にそろえ、行末の空白と前後の空行を落とす */
export function normalizeBody(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** 案の指紋を、今の中身から求める（ファイルに書いた指紋は信じない） */
export function computeFingerprint(item: OutboxItem): string {
  return sha256(
    JSON.stringify({
      kind: item.kind,
      parts: KIND_TABLE[item.kind].fingerprintParts(item),
      body: normalizeBody(item.body),
    }),
  );
}

/** 束の指紋：送る順に並べた（順・案の ID・版・各案の指紋）の sha256 */
export function bundleFingerprint(items: readonly OutboxItem[]): string {
  return sha256(
    items
      .map(
        (item, index) =>
          `${index}\t${item.id}\t${item.version}\t${computeFingerprint(item)}`,
      )
      .join("\n"),
  );
}

// ---- 置き場 ----

export const outboxRoot = (common: string) =>
  path.join(common, "orca-flow", "outbox");

export const taskOutboxDir = (common: string, taskId: string) =>
  commonRecordPath(common, "outbox", taskId, "");

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function requireSafe(name: string, what: string): void {
  if (!SAFE.test(name))
    throw new FlowError(1, `${what}の形が正しくありません：${escapeId(name)}`);
}

const STATES = Object.keys(STATE_LABEL);

function isItem(value: unknown): value is OutboxItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.taskId === "string" &&
    typeof v.kind === "string" &&
    isOutboundKind(v.kind) &&
    typeof v.version === "number" &&
    typeof v.body === "string" &&
    typeof v.head === "string" &&
    typeof v.state === "string" &&
    STATES.includes(v.state) &&
    typeof v.target === "object" &&
    v.target !== null
  );
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const itemFile = (common: string, taskId: string, id: string) =>
  path.join(taskOutboxDir(common, taskId), `${id}.json`);

/** 案を1件読む。なければ・壊れていれば null */
export async function readItem(
  common: string,
  taskId: string,
  id: string,
): Promise<OutboxItem | null> {
  requireIdShape(taskId);
  requireSafe(id, "案の ID");
  try {
    const parsed: unknown = JSON.parse(
      await readFile(itemFile(common, taskId, id), "utf8"),
    );
    if (!isItem(parsed)) return null;
    const captures = parsed.target.captures;
    return Array.isArray(captures)
      ? {
          ...parsed,
          target: {
            ...parsed.target,
            captures: restoreCaptureRefs(
              e2eCapturesDir(common, taskId),
              captures,
            ),
          },
        }
      : parsed;
  } catch {
    return null;
  }
}

/** タスクの案をすべて、送る順（種類の順・版の順）に読む。壊れたファイルは飛ばす */
export async function readItems(
  common: string,
  taskId: string,
): Promise<OutboxItem[]> {
  requireIdShape(taskId);
  let names: string[];
  try {
    names = await readdir(taskOutboxDir(common, taskId));
  } catch {
    return [];
  }
  const items: OutboxItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const item = await readItem(common, taskId, name.slice(0, -".json".length));
    if (item) items.push(item);
  }
  return sortItems(items);
}

/** 案を持つタスクの ID */
export async function outboxTaskIds(common: string): Promise<string[]> {
  try {
    const entries = await readdir(outboxRoot(common), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(hasIdShape)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch {
    return [];
  }
}

/** 送る順：種類の順、同じ種類は版の順 */
export function sortItems(items: readonly OutboxItem[]): OutboxItem[] {
  return [...items].sort(
    (a, b) =>
      KIND_TABLE[a.kind].order - KIND_TABLE[b.kind].order ||
      a.version - b.version,
  );
}

export async function writeItem(
  common: string,
  item: OutboxItem,
): Promise<void> {
  requireIdShape(item.taskId);
  requireSafe(item.id, "案の ID");
  const captures = item.target.captures;
  // 手元のパスは保存しない（読むときに置き場から組み立て直す）
  await writeJson(
    itemFile(common, item.taskId, item.id),
    captures === undefined
      ? item
      : {
          ...item,
          target: {
            ...item.target,
            captures: captures.map(({ path: _path, ...rest }) => rest),
          },
        },
  );
}

/** 状態を書き換えて保存する。書いた案を返す */
export async function updateState(
  common: string,
  item: OutboxItem,
  state: OutboxState,
  now: Date,
  fields: Partial<
    Pick<OutboxItem, "note" | "approvedHead" | "approvedFingerprint">
  > = {},
): Promise<OutboxItem> {
  const next: OutboxItem = {
    ...item,
    ...fields,
    state,
    updatedAt: now.toISOString(),
  };
  await writeItem(common, next);
  return next;
}

/** 秘密の形を伏せ字にする（今の redactSecrets・envSecrets） */
export const redactBody = (body: string, env: NodeJS.ProcessEnv): string =>
  redactSecrets(body, envSecrets(env));

/**
 * PR の本文に書いてはいけないものを探す（パス・秘密）。当たった種類だけを返す（値は出さない）
 */
export function bodyProblemsOf(
  body: string,
  input: {
    env: NodeJS.ProcessEnv;
    config: FlowConfig;
    root: string;
    task: { id: string; path: string };
  },
): string[] {
  const { env, config, root, task } = input;
  const kinds: string[] = [];
  const has = (needle: string | undefined) =>
    needle !== undefined && needle.length > 1 && body.includes(needle);
  if (has(root)) kinds.push("リポジトリのパス");
  if (
    [env.HOME, env.USERPROFILE, os.homedir()].some(
      (home) => has(home) && home !== path.parse(root).root,
    )
  )
    kinds.push("ホームのディレクトリのパス");
  if (has(task.path)) kinds.push("タスクの worktree のパス");
  if (has(taskDocPath(config, task.id))) kinds.push("設計書のパス");
  if (has(reportPath(config, task.id))) kinds.push("報告のパス");
  if (redactSecrets(body, envSecrets(env)) !== body) kinds.push("秘密らしい値");
  return kinds;
}

/**
 * push の期待値：push の記録の先頭が今の先頭の祖先でなければ（rebase などで書き換わった）その先頭、そうでなければ null。
 * 積むときに決めて案に入れる（send のときには決めない）。`push` と `outbox add push` が同じ関数を使う
 */
export async function decideExpectedRemoteHead(
  runner: Runner,
  cwd: string,
  pushedHead: string | null | undefined,
  head: string,
): Promise<string | null> {
  if (!pushedHead || pushedHead === head) return null;
  if (!/^[0-9a-f]{40,64}$/.test(pushedHead))
    throw new FlowError(
      1,
      `期待値にする先頭が40〜64桁の16進ではありません：${pushedHead}（案は積んでいません）`,
    );
  const ancestor = await runner(
    "git",
    ["merge-base", "--is-ancestor", pushedHead, head],
    { cwd },
  );
  return ancestor.code === 0 ? null : pushedHead;
}

/** 入力を確かめて案を積む（`outbox add` と `push` が共通で使う）。確かめに落ちたら何も積まない */
export async function stackItem(
  common: string,
  kind: OutboundKind,
  req: AddRequest,
  addContext: AddContext,
  where: {
    head: string;
    target: Pick<OutboxTarget, "remote" | "branch" | "base">;
  },
  env: NodeJS.ProcessEnv,
  now: Date,
  options: LockWaitOption = {},
): Promise<{ item: OutboxItem; withdrawn: OutboxItem[] }> {
  const plan = await KIND_TABLE[kind].prepareAdd(req, addContext);
  return addItem(
    common,
    {
      taskId: addContext.taskId,
      kind,
      body: plan.body,
      head: where.head,
      target: { ...where.target, pr: null, ...plan.target },
      afterCi: plan.afterCi,
    },
    env,
    now,
    options,
  );
}

export interface AddInput {
  taskId: string;
  kind: OutboundKind;
  body: string;
  head: string;
  target: OutboxTarget;
  afterCi?: boolean;
}

/**
 * 案を積む。本文の秘密の形は伏せ字にする。同じ種類の、まだ送っていない前の案（積んだ・CI 待ち・送らなかった）は取り下げになり、版が上がる
 */
export async function addItem(
  common: string,
  input: AddInput,
  env: NodeJS.ProcessEnv,
  now: Date,
  options: LockWaitOption = {},
): Promise<{ item: OutboxItem; withdrawn: OutboxItem[] }> {
  // 版を決めるところから書き終えるまで、置き場全体のロックの中で行う（同時に積んでも版がぶつからない）
  return withOutboxLock(common, () => addItemLocked(common, input, env, now), {
    kind: "add",
    waitMs: options.lockWaitMs ?? OUTBOX_LOCK_WAIT_MS,
  });
}

async function addItemLocked(
  common: string,
  input: AddInput,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<{ item: OutboxItem; withdrawn: OutboxItem[] }> {
  const sameKind = (await readItems(common, input.taskId)).filter(
    (i) => i.kind === input.kind,
  );
  // 積み直しの単位：同じ種類で、表の鍵が同じ案だけを取り下げにする（版は種類の中で一意）
  const spec = KIND_TABLE[input.kind];
  const unit = spec.unitKey(input.target);
  const existing = sameKind.filter((i) => spec.unitKey(i.target) === unit);
  const version = sameKind.reduce((max, i) => Math.max(max, i.version), 0) + 1;
  const target: OutboxTarget =
    typeof input.target.title === "string"
      ? { ...input.target, title: redactBody(input.target.title, env) }
      : input.target;
  const stamp = now.toISOString();
  const base: OutboxItem = {
    id: `${input.kind}-v${version}`,
    taskId: input.taskId,
    kind: input.kind,
    version,
    target,
    body: redactBody(input.body, env),
    head: input.head,
    state: "queued",
    fingerprint: "",
    afterCi: input.afterCi === true,
    approvedHead: null,
    approvedFingerprint: null,
    createdAt: stamp,
    updatedAt: stamp,
    note: null,
  };
  const item: OutboxItem = { ...base, fingerprint: computeFingerprint(base) };
  const withdrawn: OutboxItem[] = [];
  for (const old of existing)
    if (
      old.state === "queued" ||
      old.state === "ci-wait" ||
      old.state === "skipped"
    )
      withdrawn.push(
        await updateState(common, old, "withdrawn", now, {
          note: `${item.id} に積み直した`,
        }),
      );
  await writeItem(common, item);
  return { item, withdrawn };
}

/**
 * 取り下げられる状態：まだ送っていない案と、人が GitHub を確かめて片づける案（送っている・送らなかった・確かでない）。
 * 積み直しで自動に取り下げるのは、このうち 積んだ・CI 待ち・送らなかった だけ（送っている・確かでないは除く）
 */
const WITHDRAWABLE: readonly OutboxState[] = [
  "queued",
  "ci-wait",
  "sending",
  "skipped",
  "uncertain",
];

/**
 * 案を取り下げる。送った案と取り下げ済みの案は取り下げられない。
 * 送っている・送らなかった・確かでない案は、人が GitHub を確かめたあとに片づけるために取り下げられる（自動で送り直さない）。
 * 読むところから書き終えるまで置き場全体のロックの中で行う（最大 OUTBOX_LOCK_WAIT_MS 待つ）。
 * 人が見た状態を覚えておき、ロックを待つ間に状態が変わっていたら取り下げずに止める
 */
export async function withdrawItem(
  common: string,
  taskId: string,
  id: string,
  now: Date,
  options: LockWaitOption = {},
): Promise<OutboxItem> {
  const seen = await readItem(common, taskId, id);
  if (!seen) throw new FlowError(1, `案が見つかりません：${taskId} の ${id}`);
  if (!WITHDRAWABLE.includes(seen.state))
    throw new FlowError(
      1,
      `${id} は「${STATE_LABEL[seen.state]}」なので取り下げられません`,
    );
  return withOutboxLock(
    common,
    async () => {
      const item = await readItem(common, taskId, id);
      if (!item)
        throw new FlowError(1, `案が見つかりません：${taskId} の ${id}`);
      if (item.state !== seen.state)
        throw new FlowError(
          1,
          `${id} の状態が変わりました（${STATE_LABEL[seen.state]}→${STATE_LABEL[item.state]}）。outbox list で確かめてからやり直してください`,
        );
      const checked =
        item.state === "queued" || item.state === "ci-wait"
          ? "取り下げた"
          : "GitHub を確かめて取り下げた";
      return updateState(common, item, "withdrawn", now, { note: checked });
    },
    { kind: "withdraw", waitMs: options.lockWaitMs ?? OUTBOX_LOCK_WAIT_MS },
  );
}

// ---- show の集合 ----

export interface ShowSet {
  /** 今回送る案（送る順に最大 perBatch 件） */
  items: OutboxItem[];
  /** 範囲の外で、積んだままの案 */
  rest: OutboxItem[];
  /** 送ったか分からない案（自動では送らない） */
  uncertain: OutboxItem[];
  /** 送らない古い案（承認済み・CI 待ち）。束には入れない */
  stale: OutboxItem[];
  bundleFingerprint: string;
  /** 見せる先頭（タスクのブランチの今の先頭） */
  head: string;
}

/** 今回送る集合：積んだ案を送る順に並べて最大 perBatch 件。send も同じ関数で作り直す */
export function selectBundle(
  items: readonly OutboxItem[],
  perBatch: number,
): { selected: OutboxItem[]; rest: OutboxItem[] } {
  const queued = sortItems(items.filter((i) => i.state === "queued"));
  return { selected: queued.slice(0, perBatch), rest: queued.slice(perBatch) };
}

/** 送ったか確かでない案：確かでない・送っている（送る途中で落ちた）。自動では送らない */
export const isUnsettled = (item: OutboxItem) =>
  item.state === "uncertain" || item.state === "sending";

/** `outbox show` の中身。何も書かない */
export function buildShowSet(
  items: readonly OutboxItem[],
  perBatch: number,
  head: string,
): ShowSet {
  const { selected, rest } = selectBundle(items, perBatch);
  return {
    items: selected,
    rest,
    uncertain: items.filter(isUnsettled),
    stale: items.filter((i) => i.state === "ci-wait"),
    bundleFingerprint: bundleFingerprint(selected),
    head,
  };
}

const short = (sha: string) => sha.slice(0, 8);
const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/** 案の1行の説明 */
export function describeItem(item: OutboxItem): string {
  const spec = KIND_TABLE[item.kind];
  return `${item.id}  ${spec.label} → ${spec.destination(item)}  ${STATE_LABEL[item.state]}${item.state === "ci-wait" ? "（もう送られません）" : ""}`;
}

/**
 * `outbox show` と `push` が人に見せる文（本文・指紋・先頭・send の打ち方）。1つずつ標準出力に流す
 */
export function renderShow(
  id: string,
  set: ShowSet,
  config: Pick<FlowConfig, "outbound">,
): string[] {
  const out: string[] = [];
  const { perBatch } = config.outbound.interval;
  if (set.items.length === 0) {
    out.push(`${id}：送る案はありません\n`);
  } else {
    out.push(`${id}：今回送る案（送る順に最大 ${perBatch} 件）\n\n`);
    for (const item of set.items) {
      out.push(`■ ${describeItem(item)}\n`);
      if (typeof item.target.title === "string")
        out.push(`  題：${item.target.title}\n`);
      if (item.target.expectedRemoteHead)
        out.push(
          `  期待値（--force-with-lease）：${item.target.expectedRemoteHead}（リモートがこの先頭のときだけ上書きします）\n`,
        );
      out.push(`  指紋：${item.fingerprint}\n`);
      if (item.head !== set.head)
        out.push(
          `  注意：案の先頭 ${short(item.head)} が今の先頭 ${short(set.head)} と違います（積み直してください）\n`,
        );
      if (!config.outbound.allow.includes(item.kind))
        out.push(
          "  注意：許可リスト（outbound.allow）にない種類なので送られません\n",
        );
      const captures = item.target.captures ?? [];
      if (captures.length > 0) {
        // 録画に秘密が写りうるので、人が送る前に開いて見られるよう手元のパスを出す（GitHub には送らない）
        out.push(
          `  録画（送る前に開いて、秘密が写っていないか見てください）：\n`,
        );
        for (const c of captures)
          out.push(
            c.path === ""
              ? `    ${c.name}：${c.size} バイト（置き場の録画の名前の形が正しくないので、この案は送られません）\n`
              : `    ${c.flow} ${sideLabel(c.side)}：${c.size} バイト  ${c.path}\n`,
          );
      }
      out.push(
        `  本文：\n${indent(item.body === "" ? "（なし）" : item.body)}\n\n`,
      );
    }
    out.push(`束の指紋：${set.bundleFingerprint}\n先頭：${set.head}\n`);
    out.push(
      `送るとき：orca-flow send ${id} --expect ${set.bundleFingerprint} --head ${set.head}\n`,
    );
  }
  if (set.rest.length > 0)
    out.push(
      `範囲の外で積んだままの案（今回は送らない）：${set.rest.map((i) => i.id).join("、")}\n`,
    );
  if (set.uncertain.length > 0)
    out.push(
      `送ったか確かでない案（自動では送り直さない。GitHub で確かめたら orca-flow outbox withdraw 〈ID〉 〈案の ID〉 で取り下げてください。積み直しても前の案は残ります）：${set.uncertain.map((i) => i.id).join("、")}\n`,
    );
  if (set.stale.length > 0)
    out.push(
      `送らない古い案（承認済み・CI 待ち。もう送られません。orca-flow outbox withdraw ${id} 〈案の ID〉 で片づけ、外すなら orca-flow outbox add ${id} pr-ready で積み直してください）：${set.stale.map((i) => i.id).join("、")}\n`,
    );
  return out;
}

/** タスクのブランチの今の先頭（SHA） */
export async function branchHead(
  runner: Runner,
  cwd: string,
  branch: string,
): Promise<string> {
  const out = await runOrThrow(
    runner,
    "git",
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    "git rev-parse",
    { cwd },
  );
  return out.trim();
}

// ---- 書き込みの間 ----

const lastWriteFile = (common: string) =>
  path.join(outboxRoot(common), "last-write");

/** 前に GitHub へ書いた時刻（epoch ミリ秒）。なければ null */
export async function readLastWrite(common: string): Promise<number | null> {
  try {
    const n = Number((await readFile(lastWriteFile(common), "utf8")).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function writeLastWrite(
  common: string,
  epochMs: number,
): Promise<void> {
  await mkdir(outboxRoot(common), { recursive: true });
  await writeFile(lastWriteFile(common), `${epochMs}\n`);
}

// ---- 置き場全体のロック ----

/** 置き場のロックを取れないとき待つ長さ（ミリ秒）の既定。積む・取り下げるは一瞬で終わるので、待てば通ることが多い */
export const OUTBOX_LOCK_WAIT_MS = 5_000;

/** 積む・取り下げるがロックを待つ長さの差し替え（テストで短くする） */
export interface LockWaitOption {
  lockWaitMs?: number;
}

/** ロックを持つ側の種類（ロックのファイルに書く）。取れなかった側が名指す */
export type OutboxLockKind = "send" | "add" | "withdraw" | "watch";

const HOLDER_LABEL: Record<OutboxLockKind, string> = {
  send: "ほかの send が",
  add: "ほかの outbox add（案を積んでいる）が",
  withdraw: "ほかの outbox withdraw（案を取り下げている）が",
  watch: "見張りが",
};

/**
 * 置き場全体のロック（書き込みの間はタスクをまたいで共有するので、1つ）。
 * send は読み直しから送った印を書くまで、積む・取り下げるは読むところから書き終えるまで持つ。
 * 取れなければ waitMs（既定は待たない）まで待ち、それでも取れなければ持つ側を名指して FlowError(2)
 */
export async function withOutboxLock<T>(
  common: string,
  fn: () => Promise<T>,
  options: { kind?: OutboxLockKind; waitMs?: number } = {},
): Promise<T> {
  await mkdir(outboxRoot(common), { recursive: true });
  const lock = path.join(outboxRoot(common), "send.lock");
  const result = await acquireLock(lock, {
    waitMs: options.waitMs ?? 0,
    kind: options.kind ?? "send",
    failed: (file, detail) =>
      `送りのロックを扱えませんでした：${file}（${detail}）`,
  });
  if (result.kind === "held") {
    const who =
      result.holderKind !== undefined && result.holderKind in HOLDER_LABEL
        ? HOLDER_LABEL[result.holderKind as OutboxLockKind]
        : "ほかの書き込み（send・outbox add・outbox withdraw のどれか）が";
    throw new FlowError(
      2,
      `${who}動いています${result.pid === null ? "" : `（プロセス ${result.pid}）`}。終わってからやり直してください（${result.lockPath}）`,
    );
  }
  try {
    return await fn();
  } finally {
    await releaseOrWarn(result.release);
  }
}
