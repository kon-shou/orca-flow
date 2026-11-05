import type { FlowConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import { checkCrossDepends, readCrossDepends } from "./cross-depends.ts";
import { readDepends } from "./depends.ts";
import {
  fetchPrDetails,
  RateLimitedError,
  type PrDetail,
  type ReadContext,
} from "./github-read.ts";
import { envSecrets, redactSecrets } from "./github.ts";
import { orderBefore, readMergeOrder } from "./merge-order.ts";
import { readPushRecord } from "./finish.ts";
import { taskMergedInto } from "./merged.ts";
import { countUnresolvedThreads, judgeAllOk } from "./pr-watch/classify.ts";
import { sortItems, type OutboxItem } from "./outbox.ts";

// merge の確かめ。依存と順の前のタスク・全員 OK・先頭・PR の状態。どれかが外れたらマージしない（8章 merge）

/** 外れた確かめの種類 */
export type CheckKind =
  "no-push" | "depends" | "cross-depends" | "state" | "all-ok" | "head";

export interface CheckFailure {
  kind: CheckKind;
  /** 終了コード（依存・push なしは2、ほかは1） */
  code: 1 | 2;
  message: string;
}

/** origin/〈baseBranch〉 に入っていないタスク。via：依存の記録か、マージの順か */
export interface MissingTask {
  id: string;
  via: "depend" | "order";
  /** push の記録（PR）はあるが、マージのコミットがまだ記録にない（GitHub でマージ済みでも後始末が済んでいない場合がある） */
  pending?: boolean;
}

export interface MergeCheckResult {
  failures: CheckFailure[];
  missing: MissingTask[];
  pr: PrDetail;
  /** 承認した先頭（送った push の案の最後の先頭）。なければ null */
  approvedHead: string | null;
  /** 全員 OK の判定（理由つき） */
  allOk: { ok: boolean; reasons: string[] };
  /** またぐ依存の記録があるか（なければ門は何も確かめていない） */
  crossRecorded: boolean;
  /** 全部通ったか */
  ok: boolean;
}

/** 承認した先頭：送りの案のうち、送った push の案の最後の先頭。push の記録の先頭は使わない */
export function approvedHeadOf(items: readonly OutboxItem[]): string | null {
  const sent = sortItems(items).filter(
    (i) => i.kind === "push" && i.state === "sent",
  );
  return sent.length > 0 ? sent[sent.length - 1]!.head : null;
}

/** 依存の記録とマージの順の前のタスクのうち、ref に入っていないもの（重複は1つにまとめる） */
export async function findMissingTasks(
  runner: Runner,
  root: string,
  config: Pick<FlowConfig, "integratorName">,
  id: string,
  ref: string,
): Promise<MissingTask[]> {
  const depends = await readDepends(runner, root, id);
  const order = orderBefore(await readMergeOrder(runner, root), id).map(
    (i) => i.id,
  );
  const wanted: MissingTask[] = [
    ...depends.map((d): MissingTask => ({ id: d, via: "depend" })),
    ...order
      .filter((o) => !depends.includes(o))
      .map((o): MissingTask => ({ id: o, via: "order" })),
  ];
  const missing: MissingTask[] = [];
  for (const task of wanted) {
    const merged = await taskMergedInto(runner, root, config, task.id, ref);
    if (merged.merged) continue;
    const record = await readPushRecord(runner, root, task.id);
    missing.push(
      record?.pr && !record.mergeCommit ? { ...task, pending: true } : task,
    );
  }
  return missing;
}

function missingMessage(
  id: string,
  ref: string,
  missing: readonly MissingTask[],
  fetched: boolean,
): string {
  const refetch = fetched
    ? ""
    : `。origin を取ってきていないので、git fetch origin ${ref.replace(/^origin\//, "")} のあと --show を打ち直してください`;
  return missing
    .map((m) => {
      const pending = m.pending
        ? `。GitHub でマージ済みなら、${m.id} の後始末が済んでいません（/orca-flow:push ${m.id}）`
        : "";
      return m.via === "depend"
        ? `依存先 ${m.id} が ${ref} に入っていません。先に GitHub に入れるか、orca-flow merge ${id} --drop-depend ${m.id} で依存の記録から外してください${pending}${refetch}`
        : `マージの順で前の ${m.id} が ${ref} に入っていません。先に入れるか、orca-flow order --remove ${m.id} で順から外してください${pending}${refetch}`;
    })
    .join("\n");
}

export interface MergeCheckInput {
  runner: Runner;
  root: string;
  config: Pick<FlowConfig, "integratorName" | "baseBranch">;
  id: string;
  g: ReadContext;
  repo: string;
  prNumber: number;
  /** 人が見た先頭（--head）。--show のときは null で、承認した先頭と PR の今の先頭だけを照らす */
  head: string | null;
  items: readonly OutboxItem[];
  /** マージの前に origin を取ってきたか。--show は取ってこない（false） */
  fetched: boolean;
}

/** 確かめを全部流して、外れたものを集める。GitHub からその場で PR を読み直す */
export async function checkMerge(
  input: MergeCheckInput,
): Promise<MergeCheckResult> {
  const { runner, root, config, id, prNumber } = input;
  const ref = `origin/${config.baseBranch}`;
  const failures: CheckFailure[] = [];

  const approvedHead = approvedHeadOf(input.items);
  if (approvedHead === null)
    failures.push({
      kind: "no-push",
      code: 2,
      message: `${id} に、人が承認して送った push の案がありません。/orca-flow:push からやり直してください`,
    });

  const missing = await findMissingTasks(runner, root, config, id, ref);
  if (missing.length > 0)
    failures.push({
      kind: "depends",
      code: 2,
      message: missingMessage(id, ref, missing, input.fetched),
    });

  // 別のリポジトリのタスクへの依存と版上げ。版上げはマージされるコミットで探す
  // （--head、なければ承認した先頭、なければ push の記録の先頭。手元のブランチの今の先頭は見ない）
  const pushed = await readPushRecord(runner, root, id);
  const mergeCommit = input.head ?? approvedHead ?? pushed?.pushedHead ?? null;
  const crossRecord = await readCrossDepends(runner, root, id);
  if (crossRecord !== null) {
    const cross =
      mergeCommit === null
        ? [
            `版上げを探すコミットが分かりません（--head も承認した先頭も push の記録の先頭もありません）`,
          ]
        : await checkCrossDepends(runner, root, mergeCommit, id);
    if (cross.length > 0)
      failures.push({
        kind: "cross-depends",
        code: 2,
        message: `${cross.join("\n")}\n先に依存先を入れるか、版上げをタスクのブランチに足して push し直すか、要らなくなった依存は orca-flow merge ${id} --drop-depend 〈名前〉:〈ID〉 で記録から外してください`,
      });
  }

  let pr: PrDetail | undefined;
  try {
    pr = (await fetchPrDetails(input.g, input.repo, [prNumber])).details.get(
      prNumber,
    );
  } catch (error) {
    if (error instanceof FlowError) throw error;
    const text =
      error instanceof RateLimitedError
        ? "GitHub の読み取りの上限に達しています。しばらくしてからもう一度流してください"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new FlowError(
      1,
      redactSecrets(
        `PR #${prNumber} を読めませんでした：${text}`,
        envSecrets(input.g.env ?? {}),
      ),
    );
  }
  if (!pr)
    throw new FlowError(1, `PR #${prNumber} を GitHub から読めませんでした`);

  if (pr.state === "merged")
    failures.push({
      kind: "state",
      code: 1,
      message: `PR #${prNumber} はすでにマージ済みです。後始末は見張りか /orca-flow:push でやり直せます`,
    });
  else if (pr.state === "closed")
    failures.push({
      kind: "state",
      code: 1,
      message: `PR #${prNumber} は閉じています（マージされていません）`,
    });

  const threads = countUnresolvedThreads(pr);
  const allOk = judgeAllOk({
    reviewDecision: pr.reviewDecision,
    mergeStateStatus: pr.mergeStateStatus,
    isDraft: pr.isDraft,
    unresolvedThreads: threads.unresolved,
    threadsTruncated: threads.truncated,
    threadTotal: threads.total,
  });
  if (!allOk.ok && pr.state === "open")
    failures.push({
      kind: "all-ok",
      code: 1,
      message: `全員 OK ではありません：${allOk.reasons.join("、")}`,
    });

  const wrong: string[] = [];
  if (input.head !== null && pr.head !== input.head)
    wrong.push(`PR の今の先頭は ${pr.head ?? "不明"}`);
  if (
    approvedHead !== null &&
    input.head !== null &&
    approvedHead !== input.head
  )
    wrong.push(`承認した先頭は ${approvedHead}`);
  if (wrong.length > 0)
    failures.push({
      kind: "head",
      code: 1,
      message: `--head ${input.head} と先頭が違います（${wrong.join("、")}）。orca-flow merge ${id} --show で見直してください`,
    });
  else if (
    input.head === null &&
    approvedHead !== null &&
    pr.head !== approvedHead
  )
    failures.push({
      kind: "head",
      code: 1,
      message: `PR の今の先頭は ${pr.head ?? "不明"} で、承認した先頭 ${approvedHead} と違います。/orca-flow:push からやり直してください`,
    });

  return {
    failures,
    missing,
    pr,
    approvedHead,
    allOk,
    crossRecorded: crossRecord !== null,
    ok: failures.length === 0,
  };
}

/** 外れた確かめから終了コードを決める（依存・push なしの2が優先） */
export const failureCode = (failures: readonly CheckFailure[]): 1 | 2 =>
  failures.some((f) => f.code === 2) ? 2 : 1;
