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
  order: () => import("./commands/order.ts"),
  "rebase-review": () => import("./commands/rebase-review.ts"),
  auto: () => import("./commands/auto.ts"),
  push: () => import("./commands/push.ts"),
  lessons: () => import("./commands/lessons.ts"),
  choices: () => import("./commands/choices.ts"),
  timing: () => import("./commands/timing.ts"),
  merged: () => import("./commands/merged.ts"),
  outbox: () => import("./commands/outbox.ts"),
  send: () => import("./commands/send.ts"),
  pstack: () => import("./commands/pstack.ts"),
  "pr-watch": () => import("./commands/pr-watch.ts"),
  merge: () => import("./commands/merge.ts"),
  respond: () => import("./commands/respond.ts"),
  workspace: () => import("./commands/workspace.ts"),
  intake: () => import("./commands/intake.ts"),
  vote: () => import("./commands/vote.ts"),
} satisfies Record<string, () => Promise<{ run: Command }>>;

export type CommandName = keyof typeof COMMANDS;

const USAGE = `使い方：orca-flow <サブコマンド> [引数] [--json]

統括役（メインのチェックアウト）
  init [--yes]                       このリポジトリに orca-flow を入れる
  new --title <名前> --slug <短い名前> [--id <ID>] [--depends <ID>,<ID>]
      [--request-file <パス>] [--allow-branch-push] [--auto]
  approve <ID> [--prechanges-done]   設計を承認して実行を始める
  integrate <ID> [--keep-worktree] [--verify-here] [--fixes-main] [--skip-order]
      [--skip-decision] [--skip-cross-depends]
                                     範囲の確認・テスト・マージ
  push <ID> [--body-file <パス>] [--show]
                                     確かめのあと push と PR の作成の案を積んで見せる（送るのは send）
  push <ID> --branch                 承認なしの印のある共通のタスクの枝だけを push する
  order [<ID>,<ID>,...] [--remove <ID>] [--clear]
                                     マージの順を決める・見る・消す
  auto [show <ID>|on <ID>|off <ID>|log <ID> <文>|wait]
                                     おまかせのタスクを見る・切り替える・記録する・待つ
  vote auto [on|off <種類>]          合議で自動で決める道の状態を見る・入れる・切る
  tell <ID> <文>                     タスク長に伝える
  intake <URL>                       新しいタブで intake の本体を始める（ワークスペースのフォルダでも）

親の統括役（ワークスペースのフォルダ）
  workspace [--json]                 子ごとの統括役の場所と init 済みかを出す（読むだけ）
  workspace <名前> <config|active|merged|new> [引数]
                                     その子のフォルダで子の CLI を流す
  workspace --setup [<設定のファイル>] [--marketplace <入手元>] [--yes]
                                     ワークスペースを用意する（ない子の clone・プラグインの導入）

タスク長（タスクの worktree）
  status <designing|spec-review|working|question|responding|integrate-wait|integrated> [--note <一言>]
  overlap <ID>                       設計書の書き込む場所の重なりを確かめる
  verify                             main を取り込み、テストを流して記録する
  rebase-review <取り込みの前のコミット> | --done
                                     main の取り込みで変わったタスクの差分を出す・見直し済みを記録する
  review-local [ID] [範囲] [first|redo] --stage <数> --cycle <数>
                                     ローカルのモデルで1周分のレビューと検証をする
  review-ledger <show|record-fix|record-finding|record-opus|check-revert> --stage <数> [--input <JSON>]
                                     レビューの背景（台帳）を読む・記録する
  send <ID> --expect <束の指紋> --head <先頭>
                                     人が見た送りの案を GitHub に送る
  merge <ID> [--show | --head <先頭> | --drop-depend <ID|名前:ID>,...]
                                     確かめのあと PR をマージして後始末をする（人が打つ）
  respond <input|draft|drafts|ci-fix|open> <ID>
                                     PR の指摘と CI の赤を読み、保留中のレビューに返信を下書きする
  vote cast <ID> --target <ID> --kind <種類> --first <キー>
                                     指摘の答え方に2票目をとって記録する
  vote answer <ID> --target <ID> --human <キー>
                                     人の答えを記録に残す

だれでも
  active [--json]                    作業中のタスク
  config [--json]                    既定値を埋めた設定
  context                            自分の役（SessionStart のフックが呼ぶ）
  local-check [--base-url <URL>] [--model <名前>]
                                     ローカルのモデルの入口の疎通を確かめる
  main-check [run]                   マージのあとの main の確かめの結果（run で確かめ直す）
  lessons [--path] | lessons add <ファイル> | lessons remove <番号>
                                     教訓を出す・足す・消す
  choices [--path] | choices add <ファイル> | choices remove <番号> --heading <見出し>
                                     人の選択を出す・足す・消す
  timing [<ID> | --since <日付>]     段ごとの時間を出す
  merged <ID>... [--ref <ref>]       タスクが入ったかを出す（件名の行か push の記録）
  outbox <add|list|show|withdraw> <ID>
                                     GitHub に送る案を積む・見る・取り下げる
  pstack <pstack の中の相対パス> [--json]
                                     入手元を確かめて pstack のファイルの場所を出す
  pr-watch [usage|install|uninstall]
                                     GitHub の見張り（使った回数・automation を作る・消す）
  vote stats [--json]                合議の記録を種類ごとに数え、一致の割合を出す

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
