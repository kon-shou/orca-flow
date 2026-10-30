import { requireConfig, type FlowConfig } from "../config.ts";
import { requireRoot } from "../lib/git.ts";
import {
  failedMainLine,
  failedMainNext,
  listMainCheck,
  mainCheckState,
  runMainCheck,
  shortCommit,
  uncheckedDetail,
  unsentNoticeWarnings,
} from "../lib/main-check.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

/** approve と verify：after-merge で main の確かめが落ちているとき、警告だけを出す（止めない） */
export async function warnIfMainFailed(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
): Promise<void> {
  if (config.integrateVerify !== "after-merge") return;
  try {
    const status = await mainCheckState(ctx.runner, root, config);
    if (status.kind === "failed")
      ctx.stderr(
        `警告：${failedMainLine(status)}。直すタスク以外の統合は止まります（${failedMainNext(status)}）`,
      );
  } catch (error) {
    ctx.stderr(
      `警告：main の確かめの様子を調べられませんでした（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

const USAGE = "使い方：orca-flow main-check [run]";

/** マージのあとの main の確かめの結果を並べる。run で今の先頭を確かめ直す（8章 main-check） */
export const run: Command = async (ctx) => {
  const [sub, ...rest] = ctx.argv;
  if (rest.length > 0 || (sub !== undefined && sub !== "run"))
    throw new FlowError(1, USAGE);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireConfig(root);

  if (sub === "run") {
    const result = await runMainCheck(
      {
        runner: ctx.runner,
        cwd: ctx.cwd,
        config,
        stdout: (t) => {
          if (!ctx.json) ctx.stdout(t);
        },
        stderr: ctx.stderr,
        now: ctx.now,
      },
      root,
    );
    if (result.kind === "locked")
      throw new FlowError(
        2,
        `main の確かめが別のプロセスで走っています（ロック：${result.lockPath}、プロセスの番号：${result.pid ?? "不明"}）。終わるまで待ってください（orca-flow main-check で様子を見られます）。そのプロセスがいなければ、ロックを消して流し直してください`,
      );
    // 落ちたと確かめられなかったの両方があれば、両方出す
    let code: 0 | 1 = 0;
    for (const o of result.outcomes) {
      if (o.status === "unchecked") {
        code = 1;
        ctx.stderr(
          `main の確かめができませんでした（${shortCommit(o.commit)}、${uncheckedDetail(o.uncheckedReason, o.failedCommand, o.logPath)}）。落ちたのではないので、止めずに進めます。出力の終わり：\n${o.tail}\n直ったら orca-flow main-check run で確かめ直してください`,
        );
      } else if (o.status === "failed") {
        code = 1;
        ctx.stderr(
          o.culprit === null
            ? `main の確かめが落ちました（${shortCommit(o.commit)}、${o.failedCommand ?? "不明"}）。原因のコミットは分かりません（確かめられないコミットがありました）。出力の終わり：\n${o.tail}`
            : `main の確かめが ${o.culpritLabel ?? o.id ?? o.subject} の時点（${shortCommit(o.culprit)}）で落ちました（${o.failedCommand ?? "不明"}）。出力の終わり：\n${o.tail}`,
        );
      }
    }
    if (code !== 0) return { code, data: result };
    if (!ctx.json) {
      const last = result.outcomes.at(-1);
      ctx.stdout(
        last
          ? `main の確かめが通りました（${shortCommit(last.commit)}）`
          : "確かめるものがありません",
      );
    }
    return { code: 0, data: result };
  }

  const rows = await listMainCheck(ctx.runner, root, config);
  const warnings = await unsentNoticeWarnings(ctx.runner, root, config);
  if (!ctx.json) {
    if (rows.length === 0) ctx.stdout("main にコミットがありません");
    for (const row of rows) {
      const cause =
        row.status === "failed" && row.culprit
          ? `  原因：${row.culpritLabel ?? shortCommit(row.culprit)}（${shortCommit(row.culprit)}）${row.failedCommand ? `  落ちたコマンド：${row.failedCommand}` : ""}`
          : row.status === "failed" && row.searching
            ? "  原因：探しています"
            : row.status === "failed" && row.stalled
              ? "  原因：探していたプロセスがいません（orca-flow main-check run）"
              : row.status === "failed" && row.causeUnknown
                ? `  原因：分かりません${row.failedCommand ? `  落ちたコマンド：${row.failedCommand}` : ""}`
                : row.status === "unchecked"
                  ? `  ${uncheckedDetail(row.uncheckedReason, row.failedCommand, row.logPath)}`
                  : "";
      ctx.stdout(
        `${row.short}  ${row.id ?? row.subject}  ${row.statusLabel}${cause}${row.at ? `  ${row.at}` : ""}`,
      );
    }
    for (const warning of warnings) ctx.stderr(warning);
  }
  return { code: 0, data: { commits: rows, warnings } };
};
