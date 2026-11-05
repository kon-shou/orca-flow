import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireIdShape } from "../lib/auto.ts";
import { REMOTE, type GhContext } from "../lib/github.ts";
import { loadPendingDrafts } from "../lib/pending-review.ts";
import { gitCommonDir, requireActiveTask, requireRoot } from "../lib/git.ts";
import { readPushRecord } from "../lib/finish.ts";
import { createOrca, cardForPushWatch } from "../lib/orca.ts";
import {
  bodyProblemsOf,
  branchHead,
  buildShowSet,
  decideExpectedRemoteHead,
  describeItem,
  isOutboundKind,
  outboxTaskIds,
  readItems,
  redactBody,
  renderShow,
  stackItem,
  withdrawItem,
  type OutboxItem,
} from "../lib/outbox.ts";
import { OUTBOUND_KINDS } from "../config.ts";
import { readTaskRecord, taskDocPath } from "../lib/tasks.ts";
import { taskTitleOf } from "./push.ts";
import {
  FlowError,
  type Command,
  type CommandContext,
  type CommandResult,
} from "../types.ts";

const USAGE = `使い方：
  orca-flow outbox add <ID> <${OUTBOUND_KINDS.join("|")}> [--body-file <パス>] [--title <題>] [--pr <番号>] [--after-ci]
  orca-flow outbox add <ID> reply --pr <番号>
  orca-flow outbox add <ID> rerequest --pr <番号> --reviewers <ログイン名>,…
  orca-flow outbox list [<ID>]
  orca-flow outbox show <ID>
  orca-flow outbox withdraw <ID> <案の ID>`;

async function add(
  ctx: CommandContext,
  lockWaitMs?: number,
): Promise<CommandResult> {
  const args = parseArgs(
    ctx.argv.slice(1),
    ["body-file", "pr", "title", "reviewers"],
    ["after-ci"],
  );
  const [id, kind, ...rest] = args.positionals;
  if (!id || !kind || rest.length > 0) throw new FlowError(1, USAGE);
  requireIdShape(id);
  if (!isOutboundKind(kind))
    throw new FlowError(
      1,
      `知らない種類です：${kind}（${OUTBOUND_KINDS.join("・")} の中から選んでください）`,
    );
  const prText = args.values.get("pr");
  let pr: number | null = null;
  if (prText !== undefined) {
    if (!/^[1-9][0-9]*$/.test(prText))
      throw new FlowError(
        1,
        `--pr は PR の番号（正の整数）にしてください：${prText}`,
      );
    pr = Number(prText);
  }

  const reviewersText = args.values.get("reviewers");
  if (reviewersText !== undefined && kind !== "rerequest")
    throw new FlowError(1, "--reviewers は rerequest だけにつけられます");
  const reviewers =
    reviewersText === undefined
      ? null
      : reviewersText
          .split(",")
          .map((r) => r.trim())
          .filter((r) => r !== "");

  const bodyFile = args.values.get("body-file");
  const body =
    bodyFile === undefined
      ? ""
      : await readFile(path.resolve(ctx.cwd, bodyFile), "utf8").catch(() => {
          throw new FlowError(1, `本文のファイルを読めません：${bodyFile}`);
        });

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  const common = await gitCommonDir(ctx.runner, root);
  const head = await branchHead(ctx.runner, root, task.branch);

  // 種類ごとの入力の確かめは表が持つ（本文の手元のパス・秘密の確かめも pr-create の表が行う）
  const { item, withdrawn } = await stackItem(
    common,
    kind,
    {
      body,
      pr,
      afterCi: args.flags.has("after-ci"),
      title: args.values.get("title") ?? null,
      reviewers,
    },
    {
      taskId: id,
      branch: task.branch,
      // 題は設計書から（tasksDir を無視する設定でも読める readTaskRecord）。なければブランチの名前
      defaultTitle: async () => {
        const record = await readTaskRecord(
          ctx.runner,
          root,
          task,
          taskDocPath(config, id),
        );
        const name =
          (record.text === null ? null : taskTitleOf(record.text, id)) ??
          task.branch.replace(/^.*?\//, "");
        return `${id}: ${name}`;
      },
      // reply：保留中のレビューを読む（GitHub に書かない）
      readPending: async (number) => {
        const g: GhContext = { runner: ctx.runner, cwd: root, env: ctx.env };
        return loadPendingDrafts(g, { common, taskId: id }, number);
      },
      bodyProblems: (text) =>
        bodyProblemsOf(text, { env: ctx.env, config, root, task }),
      // push の期待値は、push と同じ関数で積むときに決める
      // add は GitHub を読まないので、記録の先頭だけから決める（記録がなく PR の先頭に頼る道は push が持つ）
      expectedRemoteHead: async () =>
        decideExpectedRemoteHead(
          ctx.runner,
          root,
          (await readPushRecord(ctx.runner, root, id))?.pushedHead,
          head,
        ),
    },
    {
      head,
      target: { remote: REMOTE, branch: task.branch, base: config.baseBranch },
    },
    ctx.env,
    ctx.now(),
    { lockWaitMs },
  );
  // 積んだら、カードを「送る前の確認待ち：〈案の種類と版〉」（未読）にする。Orca が落ちても積んだ案は残る
  try {
    await createOrca(ctx.runner, root).setCard(
      task.path,
      cardForPushWatch("send-wait", null, {
        // 返信は下書きの件数も一言に出す（他人の文章は入れない）
        detail:
          item.kind === "reply"
            ? `${item.id}、下書き ${item.target.pending?.comments.length ?? 0} 件`
            : item.id,
      }),
    );
  } catch (error) {
    ctx.stderr(
      `警告：${id} のカードを更新できませんでした（${redactBody(error instanceof Error ? error.message : String(error), ctx.env)}）`,
    );
  }
  if (!ctx.json) {
    ctx.stdout(`案を積みました：${describeItem(item)}\n`);
    for (const old of withdrawn)
      ctx.stdout(`前の案を取り下げました：${old.id}\n`);
    ctx.stdout(
      "GitHub にはまだ書いていません。orca-flow outbox show で見せてから send で送ります\n",
    );
  }
  return { code: 0, data: { item, withdrawn: withdrawn.map((w) => w.id) } };
}

async function list(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), []);
  const [id, ...rest] = args.positionals;
  if (rest.length > 0) throw new FlowError(1, USAGE);
  if (id) requireIdShape(id);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);
  const ids = id ? [id] : await outboxTaskIds(common);
  const all: OutboxItem[] = [];
  for (const taskId of ids) all.push(...(await readItems(common, taskId)));
  if (!ctx.json) {
    if (all.length === 0) ctx.stdout("送りの案はありません\n");
    for (const item of all)
      ctx.stdout(`${item.taskId}  ${describeItem(item)}\n`);
  }
  return { code: 0, data: { items: all } };
}

async function show(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), []);
  const [id, ...rest] = args.positionals;
  if (!id || rest.length > 0) throw new FlowError(1, USAGE);
  requireIdShape(id);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  const common = await gitCommonDir(ctx.runner, root);
  const head = await branchHead(ctx.runner, root, task.branch);
  const items = await readItems(common, id);
  const set = buildShowSet(items, config.outbound.interval.perBatch, head);
  if (!ctx.json)
    for (const chunk of renderShow(id, set, config)) ctx.stdout(chunk);
  return {
    code: 0,
    data: {
      id,
      items: set.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        version: i.version,
        fingerprint: i.fingerprint,
        head: i.head,
        target: i.target,
        body: i.body,
      })),
      rest: set.rest.map((i) => i.id),
      uncertain: set.uncertain.map((i) => i.id),
      bundleFingerprint: set.bundleFingerprint,
      head,
    },
  };
}

async function withdraw(
  ctx: CommandContext,
  lockWaitMs?: number,
): Promise<CommandResult> {
  const args = parseArgs(ctx.argv.slice(1), []);
  const [id, itemId, ...rest] = args.positionals;
  if (!id || !itemId || rest.length > 0) throw new FlowError(1, USAGE);
  requireIdShape(id);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const common = await gitCommonDir(ctx.runner, root);
  const item = await withdrawItem(common, id, itemId, ctx.now(), {
    lockWaitMs,
  });
  if (!ctx.json) ctx.stdout(`取り下げました：${item.id}\n`);
  return { code: 0, data: { item } };
}

export interface OutboxDeps {
  /** 置き場のロックを待つ長さ（ミリ秒）。なければ OUTBOX_LOCK_WAIT_MS。テストで短くする */
  lockWaitMs?: number;
}

export function createOutbox(deps: OutboxDeps = {}): Command {
  return async (ctx) => {
    const sub = ctx.argv[0];
    switch (sub) {
      case "add":
        return add(ctx, deps.lockWaitMs);
      case "list":
        return list(ctx);
      case "show":
        return show(ctx);
      case "withdraw":
        return withdraw(ctx, deps.lockWaitMs);
      default:
        throw new FlowError(1, USAGE);
    }
  };
}

export const run: Command = createOutbox();
