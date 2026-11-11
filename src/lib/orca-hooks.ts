import type { Runner } from "./exec.ts";

/** 画面のワークツリーフック（セットアップスクリプト）に入れる1行。$ORCA_ROOT_PATH はメインのチェックアウト */
export const HOOK_SETUP_LINE = 'bash "$ORCA_ROOT_PATH/.orca-flow/setup.sh"';

const SETUP_MARK = ".orca-flow/setup.sh";
const WAIT_POLICY = "wait-for-setup";
const TIMEOUT_MS = 15_000;

export type HooksProblem = "setup" | "policy";

export interface HooksCheck {
  /** true：そろった。false：足りない。null：Orca に聞けなかった */
  ok: boolean | null;
  /** 足りないもの（ok が false のとき） */
  problems: HooksProblem[];
  /** 画面のセットアップスクリプトが空か */
  setupEmpty: boolean;
  /** 聞けなかった理由（ok が null のとき） */
  message?: string;
}

/** Orca の画面の設定を読み、setup が .orca-flow/setup.sh を含み「待ってから開始」かを確かめる */
export async function checkOrcaHooks(
  runner: Runner,
  root: string,
): Promise<HooksCheck> {
  const unknown = (message: string): HooksCheck => ({
    ok: null,
    problems: [],
    setupEmpty: false,
    message,
  });
  const result = await runner(
    "orca",
    ["repo", "show", "--repo", `path:${root}`, "--json"],
    { cwd: root, timeoutMs: TIMEOUT_MS },
  );
  if (result.code !== 0 || result.timedOut)
    return unknown("Orca の画面の設定を読めませんでした");
  let hook: unknown;
  try {
    const parsed = JSON.parse(result.stdout) as {
      result?: { repo?: { hookSettings?: unknown } };
    };
    hook = parsed.result?.repo?.hookSettings;
  } catch {
    return unknown("Orca の返事を読めませんでした");
  }
  if (typeof hook !== "object" || hook === null)
    return unknown("Orca の返事に画面の設定がありませんでした");
  const settings = hook as {
    scripts?: { setup?: unknown };
    setupAgentStartupPolicy?: unknown;
  };
  const setup =
    typeof settings.scripts?.setup === "string" ? settings.scripts.setup : "";
  const problems: HooksProblem[] = [];
  if (!setup.includes(SETUP_MARK)) problems.push("setup");
  if (settings.setupAgentStartupPolicy !== WAIT_POLICY) problems.push("policy");
  return {
    ok: problems.length === 0,
    problems,
    setupEmpty: setup.trim() === "",
  };
}

/** 直し方の文（行ごと）。そろっていれば空 */
export function hooksFixLines(check: HooksCheck): string[] {
  const lines: string[] = [];
  if (check.problems.includes("setup"))
    lines.push(
      check.setupEmpty
        ? `Orca の画面：リポジトリの設定の「ワークツリーフック」のセットアップスクリプトに、次の1行を入れてください：${HOOK_SETUP_LINE}`
        : `Orca の画面：セットアップスクリプトの後ろの行に、次の1行を足してください：${HOOK_SETUP_LINE}`,
    );
  if (check.problems.includes("policy"))
    lines.push(
      "Orca の画面：セットアップの設定を「待ってから開始」（wait-for-setup）にしてください",
    );
  return lines;
}
