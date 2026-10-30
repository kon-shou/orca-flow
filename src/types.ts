import type { Runner } from "./lib/exec.ts";

/** 0＝成功、1＝確認に落ちた・失敗、2＝人間か統括役の作業が先に要る、3＝git の競合 */
export type ExitCode = 0 | 1 | 2 | 3;

/** 終了コードつきのエラー。message は日本語で、そのまま人間に見せる */
export class FlowError extends Error {
  readonly code: ExitCode;

  constructor(code: ExitCode, message: string) {
    super(message);
    this.code = code;
    this.name = "FlowError";
  }
}

export interface CommandContext {
  /** サブコマンドより後ろの引数。--json は取り除いてある */
  argv: string[];
  /** 呼ばれた場所。git のトップとは限らない */
  cwd: string;
  /** --json が付いていたか。付いていれば、cli が CommandResult.data を JSON で標準出力に出す */
  json: boolean;
  /** git と orca などの外のコマンドは、必ずこれを通して呼ぶ（テストで偽物に差し替える） */
  runner: Runner;
  env: NodeJS.ProcessEnv;
  /** 人間向けの出力。--json のときは使わない */
  stdout: (text: string) => void;
  /** 警告とエラー。日本語で書く */
  stderr: (text: string) => void;
  now: () => Date;
}

export interface CommandResult {
  code: ExitCode;
  /** --json のときに出す中身 */
  data?: unknown;
}

export type Command = (ctx: CommandContext) => Promise<CommandResult>;
