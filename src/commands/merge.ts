import { requireFlowConfig } from "../lib/flow-config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireIdShape } from "../lib/auto.ts";
import {
  dropCrossDepends,
  parseCrossDependsRef,
  readCrossDepends,
} from "../lib/cross-depends.ts";
import { dropDepends, readDepends } from "../lib/depends.ts";
import { describeMainBusy, readPushRecord } from "../lib/finish.ts";
import {
  gitCommonDir,
  requireActiveTask,
  requireIntegratorPlace,
  requireRoot,
} from "../lib/git.ts";
import { readRepoName, type ReadContext } from "../lib/github-read.ts";
import {
  chooseMergeMethod,
  envSecrets,
  mergePr,
  readAllowedMergeMethods,
  readPr,
  redactSecrets,
  requireGh,
  type MergeMethod,
} from "../lib/github.ts";
import {
  checkMerge,
  failureCode,
  type MergeCheckResult,
} from "../lib/merge-check.ts";
import { readItems } from "../lib/outbox.ts";
import { cleanupHolderLabel, cleanupMergedPr } from "../lib/pr-finish.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

const USAGE =
  "使い方：orca-flow merge 〈ID〉 --show（読むだけ）／ --head 〈先頭〉（マージ）／ --drop-depend 〈ID または 名前:ID〉,…（依存の記録から外す）";

const FETCH_TIMEOUT_MS = 120_000;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** 方式を選ぶ。許された方式が1つもなければ FlowError(1) */
async function pickMethod(g: ReadContext): Promise<MergeMethod> {
  const method = chooseMergeMethod(await readAllowedMergeMethods(g));
  if (!method)
    throw new FlowError(
      1,
      "GitHub の設定で、マージの方式（merge・squash・rebase）がどれも許されていません",
    );
  return method;
}

/** 確かめの結果を出す行 */
function describeChecks(
  id: string,
  ref: string,
  c: MergeCheckResult,
): string[] {
  const failed = (kind: string) => c.failures.filter((f) => f.kind === kind);
  const line = (label: string, kind: string, okText: string) => {
    const f = failed(kind);
    return f.length === 0
      ? [`  ${label}：OK（${okText}）`]
      : [
          `  ${label}：外れ`,
          ...f.map((x) => `    ${x.message}`),
          ...(kind === "all-ok" && c.allOk.note !== null
            ? [`    ${c.allOk.note}`]
            : []),
        ];
  };
  return [
    ...line("承認した push", "no-push", "あります"),
    ...line("依存と順の前のタスク", "depends", `${ref} に入っています`),
    ...line(
      "またぐ依存",
      "cross-depends",
      c.crossRecorded
        ? "依存先が PR でマージされていて、版上げがあります"
        : "記録なし",
    ),
    ...line("先頭", "head", "PR の今の先頭は承認した先頭と同じです"),
    ...line("PR の状態", "state", "開いていて、まだマージしていません"),
    ...line(
      "全員 OK",
      "all-ok",
      c.allOk.note === null
        ? "承認済み・マージできる状態"
        : `承認済み・マージできる状態。${c.allOk.note}`,
    ),
  ];
}

export const run: Command = async (ctx: CommandContext) => {
  const args = parseArgs(ctx.argv, ["head", "drop-depend"], ["show"]);
  const [id, ...rest] = args.positionals;
  const head = args.values.get("head");
  const drop = args.values.get("drop-depend");
  const show = args.flags.has("show");
  if (!id || rest.length > 0) throw new FlowError(1, USAGE);
  if (
    [show, head !== undefined, drop !== undefined].filter(Boolean).length !== 1
  )
    throw new FlowError(1, USAGE);
  requireIdShape(id);

  const config = await requireFlowConfig(
    ctx.runner,
    await requireRoot(ctx.runner, ctx.cwd),
  );

  // 依存の記録から外す：マージしない
  if (drop !== undefined) {
    const ids = drop
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (ids.length === 0) throw new FlowError(1, USAGE);
    // 〈名前〉:〈ID〉 は別のリポジトリの依存、ほかは今の依存の ID
    const crossRefs = ids.filter((d) => parseCrossDependsRef(d) !== null);
    const plain = ids.filter((d) => parseCrossDependsRef(d) === null);
    for (const d of plain) requireIdShape(d);
    const root = await requireIntegratorPlace(ctx.runner, ctx.cwd, config);
    const before = await readDepends(ctx.runner, root, id);
    const crossBefore = await readCrossDepends(ctx.runner, root, id);
    const crossIds = (c: typeof crossBefore) =>
      (c?.repos ?? []).flatMap((r) => r.ids.map((x) => `${r.name}:${x}`));
    const crossHas = (ref: string) => crossIds(crossBefore).includes(ref);
    const unknown = [
      ...plain.filter((d) => !before.includes(d)),
      ...crossRefs.filter((r) => !crossHas(r)),
    ];
    if (unknown.length === ids.length)
      throw new FlowError(
        1,
        `${id} の依存の記録に ${ids.join("、")} はありません（記録の依存：${[...before, ...crossIds(crossBefore)].join("、") || "なし"}）`,
      );
    const left =
      plain.length > 0
        ? await dropDepends(ctx.runner, root, id, plain, ctx.now())
        : before;
    const crossLeftRecord =
      crossRefs.length > 0
        ? await dropCrossDepends(ctx.runner, root, id, crossRefs, ctx.now())
        : crossBefore;
    const crossLeftIds = crossIds(crossLeftRecord);
    if (!ctx.json) {
      const dropped = [
        ...plain.filter((d) => before.includes(d)),
        ...crossRefs.filter(crossHas),
      ];
      const rest = [...left, ...crossLeftIds];
      ctx.stdout(
        `${id} の依存の記録から ${dropped.join("、")} を外しました（残り：${rest.length > 0 ? rest.join("、") : "なし"}）。マージはしていません`,
      );
    }
    return {
      code: 0,
      data: { id, dropped: ids, left, crossLeft: crossLeftIds },
    };
  }

  // --head は統括役の場所。--show は場所を確かめない
  const root = show
    ? await requireRoot(ctx.runner, ctx.cwd)
    : await requireIntegratorPlace(ctx.runner, ctx.cwd, config);
  const common = await gitCommonDir(ctx.runner, root);
  const record = await readPushRecord(ctx.runner, root, id);
  if (!record?.pr)
    throw new FlowError(
      2,
      `${id} の PR の番号が push の記録にありません。/orca-flow:push からやり直してください`,
    );
  const prNumber = record.pr.number;
  const items = await readItems(common, id);
  const g: ReadContext = { runner: ctx.runner, cwd: root, env: ctx.env };
  await requireGh(g);
  const repo = await readRepoName(ctx.runner, root);
  const ref = `origin/${config.baseBranch}`;

  if (show) {
    const checks = await checkMerge({
      runner: ctx.runner,
      root,
      config,
      id,
      g,
      repo,
      prNumber,
      head: null,
      items,
      fetched: false,
    });
    let method: MergeMethod | null = null;
    let methodError: string | null = null;
    try {
      method = await pickMethod(g);
    } catch (error) {
      methodError = redactSecrets(message(error), envSecrets(ctx.env));
    }
    if (!ctx.json) {
      ctx.stdout(`${id} の PR #${prNumber}（${checks.pr.url}）`);
      ctx.stdout("確かめ（origin は手元の最後の取得で見ています）：");
      for (const l of describeChecks(id, ref, checks)) ctx.stdout(l);
      ctx.stdout(`PR の今の先頭：${checks.pr.head ?? "不明"}`);
      ctx.stdout(`承認した先頭：${checks.approvedHead ?? "なし"}`);
      ctx.stdout(`マージの方式：${method ?? `決まりません（${methodError}）`}`);
      ctx.stdout(
        checks.ok && method
          ? `通りました。マージするなら orca-flow merge ${id} --head ${checks.pr.head}`
          : "外れた確かめがあります。マージはできません",
      );
    }
    return {
      code: 0,
      data: {
        id,
        pr: prNumber,
        ok: checks.ok && method !== null,
        failures: checks.failures,
        missing: checks.missing,
        prHead: checks.pr.head,
        approvedHead: checks.approvedHead,
        method,
      },
    };
  }

  // マージ
  if (!/^[0-9a-f]{7,64}$/.test(head!))
    throw new FlowError(1, `--head の形が正しくありません：${head}`);
  const task = await requireActiveTask(ctx.runner, root, config, id);
  const fetched = await ctx.runner(
    "git",
    ["fetch", "origin", config.baseBranch],
    {
      cwd: root,
      timeoutMs: FETCH_TIMEOUT_MS,
    },
  );
  if (fetched.code !== 0 || fetched.timedOut)
    throw new FlowError(
      1,
      redactSecrets(
        `git fetch origin ${config.baseBranch} に失敗しました：${(fetched.stderr || fetched.stdout).trim() || "時間切れ"}`,
        envSecrets(ctx.env),
      ),
    );
  const checks = await checkMerge({
    runner: ctx.runner,
    root,
    config,
    id,
    g,
    repo,
    prNumber,
    head: head!,
    items,
    fetched: true,
  });
  if (!checks.ok) {
    const code = failureCode(checks.failures);
    ctx.stderr(
      `マージしませんでした：\n${checks.failures.map((f) => f.message).join("\n")}`,
    );
    return {
      code,
      data: { id, pr: prNumber, merged: false, failures: checks.failures },
    };
  }

  const method = await pickMethod(g);
  await mergePr(g, prNumber, method, head!);
  if (!ctx.json)
    ctx.stdout(
      `${id} の PR #${prNumber} をマージしました（方式：${method}、先頭：${head}）`,
    );

  // マージのあと：GitHub の今の PR（マージのコミット）を読んで後始末をする。止まったら終了コード2（マージ済みの印つき）
  const stoppedAfterMerge = (reason: string) => {
    const text = redactSecrets(
      `${id} の PR #${prNumber} はマージしました。後始末が止まりました（${reason}）`,
      envSecrets(ctx.env),
    );
    return {
      text,
      data: { id, pr: prNumber, merged: true, method, stopped: true },
    };
  };
  try {
    let pr;
    try {
      pr = await readPr(g, prNumber);
    } catch (error) {
      throw new FlowError(
        2,
        `マージのあとの状態を読めませんでした（${message(error)}）。見張りか /orca-flow:push で後始末をやり直せます`,
      );
    }
    if (pr.state !== "merged")
      throw new FlowError(
        2,
        "GitHub ではまだマージ済みになっていません。見張りか /orca-flow:push で確かめてください",
      );
    const out = await cleanupMergedPr(ctx, root, config, task, pr, {
      holdingWatchLock: false,
      lockKind: "merge",
    });
    if (out.kind === "watching") {
      if (!ctx.json)
        ctx.stdout(
          `${cleanupHolderLabel(out.holderKind)}（プロセス ${out.pid ?? "不明"}）。後始末はそちらが行います`,
        );
      return {
        code: 0,
        data: { id, pr: prNumber, merged: true, method, cleanup: "running" },
      };
    }
    if (out.kind === "busy")
      throw new FlowError(
        2,
        `${await describeMainBusy(ctx, root)}。/orca-flow:push で後始末をやり直せます`,
      );
    if (out.result.code !== 0) {
      // cleanupMergedPr が理由を stderr に出している。終了コードを2にそろえる
      return {
        code: 2,
        data: {
          ...(typeof out.result.data === "object" && out.result.data !== null
            ? out.result.data
            : {}),
          merged: true,
          method,
        },
      };
    }
    return {
      code: 0,
      data: {
        ...(typeof out.result.data === "object" && out.result.data !== null
          ? out.result.data
          : {}),
        merged: true,
        method,
      },
    };
  } catch (error) {
    const stop = stoppedAfterMerge(
      error instanceof FlowError ? error.message : message(error),
    );
    ctx.stderr(stop.text);
    return { code: 2, data: stop.data };
  }
};
