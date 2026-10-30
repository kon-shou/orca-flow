import { realRunner, type Runner } from "./lib/exec.ts";
import {
  FlowError,
  type Command,
  type CommandContext,
  type ExitCode,
} from "./types.ts";

/** サブコマンドの名前 → 実装のファイル。各ファイルは `export const run: Command` を持つ */
export const COMMANDS = {
  init: () => import("./commands/init.ts"),
  config: () => import("./commands/config.ts"),
  context: () => import("./commands/context.ts"),
  new: () => import("./commands/new.ts"),
  status: () => import("./commands/status.ts"),
  verify: () => import("./commands/verify.ts"),
  active: () => import("./commands/active.ts"),
  overlap: () => import("./commands/overlap.ts"),
  approve: () => import("./commands/approve.ts"),
  integrate: () => import("./commands/integrate.ts"),
  tell: () => import("./commands/tell.ts"),
  "review-local": () => import("./commands/review-local.ts"),
  "review-ledger": () => import("./commands/review-ledger.ts"),
  "local-check": () => import("./commands/local-check.ts"),
  "main-check": () => import("./commands/main-check.ts"),
} satisfies Record<string, () => Promise<{ run: Command }>>;

export type CommandName = keyof typeof COMMANDS;

const USAGE = `使い方：orca-flow <サブコマンド> [引数] [--json]

統括役（メインのチェックアウト）
  init [--yes]                       このリポジトリに orca-flow を入れる
  new --title <名前> --slug <短い名前> [--id <ID>] [--depends <ID>,<ID>]
      [--request-file <パス>]
  approve <ID> [--prechanges-done]   設計を承認して実行を始める
  integrate <ID> [--keep-worktree] [--verify-here] [--fixes-main]
                                     範囲の確認・テスト・マージ
  tell <ID> <文>                     タスク長に伝える

タスク長（タスクの worktree）
  status <designing|spec-review|working|question|integrate-wait|integrated> [--note <一言>]
  overlap <ID>                       設計書の書き込む場所の重なりを確かめる
  verify                             main を取り込み、テストを流して記録する
  review-local [ID] [範囲] [first|redo] --stage <数> --cycle <数>
                                     ローカルのモデルで1周分のレビューと検証をする
  review-ledger <show|record-fix|record-finding|record-opus|check-revert> --stage <数> [--input <JSON>]
                                     レビューの背景（台帳）を読む・記録する

だれでも
  active [--json]                    作業中のタスク
  config [--json]                    既定値を埋めた設定
  context                            自分の役（SessionStart のフックが呼ぶ）
  local-check [--base-url <URL>] [--model <名前>]
                                     ローカルのモデルの入口の疎通を確かめる
  main-check [run]                   マージのあとの main の確かめの結果（run で確かめ直す）

終了コード：0＝成功、1＝確認に落ちた・失敗、2＝人間か統括役の作業が先に要る、3＝git の競合`;

export interface MainDeps {
  runner?: Runner;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => Date;
  /** テストでサブコマンドを差し替える */
  commands?: Partial<Record<string, Command>>;
}

/** 引数を受けて終了コードを返す。process.exit は呼ばない */
export async function main(
  argv: readonly string[],
  deps: MainDeps = {},
): Promise<ExitCode> {
  const stdout =
    deps.stdout ??
    ((text: string) =>
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`));
  const stderr =
    deps.stderr ??
    ((text: string) =>
      process.stderr.write(text.endsWith("\n") ? text : `${text}\n`));

  const [name, ...rest] = argv;
  if (
    name === undefined ||
    name === "help" ||
    name === "--help" ||
    name === "-h"
  ) {
    stdout(USAGE);
    return 0;
  }

  let command = deps.commands?.[name];
  if (!command) {
    const load = (
      COMMANDS as Record<string, (() => Promise<{ run: Command }>) | undefined>
    )[name];
    if (!load) {
      stderr(`orca-flow: 知らないサブコマンドです：${name}\n\n${USAGE}`);
      return 1;
    }
    command = (await load()).run;
  }

  const json = rest.includes("--json");
  const ctx: CommandContext = {
    argv: rest.filter((arg) => arg !== "--json"),
    cwd: deps.cwd ?? process.cwd(),
    json,
    runner: deps.runner ?? realRunner,
    env: deps.env ?? process.env,
    stdout,
    stderr,
    now: deps.now ?? (() => new Date()),
  };

  try {
    const result = await command(ctx);
    if (json) stdout(JSON.stringify(result.data ?? null, null, 2));
    return result.code;
  } catch (error) {
    if (error instanceof FlowError) {
      stderr(`orca-flow: ${error.message}`);
      if (json)
        stdout(
          JSON.stringify({ error: error.message, code: error.code }, null, 2),
        );
      return error.code;
    }
    stderr(
      `orca-flow: 思わぬエラーで止まりました：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  }
}
