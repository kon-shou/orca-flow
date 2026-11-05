import { FROM_WORKSPACE_ENV } from "./new.ts";
import path from "node:path";
import { resolveCrossDependsArgs } from "../lib/cross-depends.ts";
import { ORCA_FLOW_MAIN } from "../lib/background.ts";
import { requireIntegratorPlace } from "../lib/git.ts";
import {
  loadWorkspace,
  type Workspace,
  type WorkspaceRepo,
} from "../lib/workspace.ts";
import {
  FlowError,
  type Command,
  type CommandContext,
  type CommandResult,
  type ExitCode,
} from "../types.ts";

/** 親が子へ流してよいサブコマンド（これ以外は子の CLI を流さずに終了コード1） */
export const ALLOWED_SUBCOMMANDS = [
  "config",
  "active",
  "merged",
  "new",
] as const;

/** 一覧の `--json` の、子1つ分 */
export interface WorkspaceRepoStatus {
  name: string;
  /** 実の絶対パス */
  path: string;
  role: "common" | "app";
  keywords: string[];
  /** 共通だけ。アプリは null */
  scope: string | null;
  package: string | null;
  bumpCommand: string | null;
  /** 共通で設定にあるときだけ（なければキーごとない）。枝の取り込み方のコマンド */
  branchCommand?: string;
  /** 子の `config --json` が0なら true、2（init がまだ）なら false、1（設定の誤り）なら null */
  initialized: boolean | null;
  /** 子の `config --json` の baseBranch。取れなければ null */
  baseBranch: string | null;
  /** 統括役の場所の確認。ok は通れば true、通らなければ false、確かめなかったら null */
  place: { ok: boolean | null; message: string | null };
  /** 子の設定の誤りや init がまだのときの、子のメッセージ。なければ null */
  message: string | null;
}

export interface WorkspaceListing {
  /** ワークスペースのフォルダの実のパス */
  dir: string;
  /** 設定のファイルの中身の sha256 */
  hash: string;
  repos: WorkspaceRepoStatus[];
}

export const run: Command = async (ctx) => {
  const [first] = ctx.argv;
  if (first === undefined) return list(ctx);
  return forward(ctx);
};

const toExit = (code: number): ExitCode =>
  code === 0 || code === 1 || code === 2 || code === 3 ? code : 1;

/** 子の CLI を、子のフォルダを作業の場所にして流す */
function runChild(
  ctx: CommandContext,
  repo: WorkspaceRepo,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return ctx.runner(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", ORCA_FLOW_MAIN, ...args],
    {
      cwd: repo.path,
      env: { ...ctx.env, ...extraEnv },
    },
  );
}

async function list(ctx: CommandContext): Promise<CommandResult> {
  const workspace = await loadWorkspace(ctx.runner, ctx.cwd);
  const repos: WorkspaceRepoStatus[] = [];
  for (const repo of workspace.repos) repos.push(await inspect(ctx, repo));

  const hasConfigError = repos.some((r) => r.initialized === null);
  const hasOther = repos.some(
    (r) => r.initialized !== true || r.place.ok !== true,
  );
  const code: ExitCode = hasConfigError ? 1 : hasOther ? 2 : 0;
  const data: WorkspaceListing = {
    dir: workspace.dir,
    hash: workspace.sha256,
    repos,
  };
  if (!ctx.json) {
    ctx.stdout(
      `ワークスペース：${workspace.dir}（設定の sha256：${workspace.sha256}）`,
    );
    for (const r of repos) ctx.stdout(describe(r));
  }
  return { code, data };
}

function describe(r: WorkspaceRepoStatus): string {
  const head = `${r.name}（${r.role === "common" ? "共通" : "アプリ"}）${r.path}`;
  if (r.initialized === null)
    return `${head}\n  設定の誤り：${r.message ?? "子の設定を読めません"}`;
  if (r.initialized === false)
    return `${head}\n  init がまだ：${r.message ?? "子の統括役のタブで /orca-flow:init を流してください"}`;
  if (r.place.ok === true)
    return `${head}\n  統括役の場所：よし（${r.baseBranch}）`;
  return `${head}\n  統括役の場所に問題：${r.place.message ?? ""}`;
}

/** 子の1つを調べる。子の CLI の config --json の答えから baseBranch を取り、git で場所を確かめる */
async function inspect(
  ctx: CommandContext,
  repo: WorkspaceRepo,
): Promise<WorkspaceRepoStatus> {
  const status: WorkspaceRepoStatus = {
    name: repo.name,
    path: repo.path,
    role: repo.role,
    keywords: repo.keywords,
    scope: repo.scope ?? null,
    package: repo.package ?? null,
    bumpCommand: repo.bumpCommand ?? null,
    ...(repo.branchCommand !== undefined
      ? { branchCommand: repo.branchCommand }
      : {}),
    initialized: null,
    baseBranch: null,
    place: { ok: null, message: null },
    message: null,
  };
  const result = await runChild(ctx, repo, ["config", "--json"]);
  const detail = (result.stderr || result.stdout).trim();
  if (result.code === 2) {
    status.initialized = false;
    status.message = detail || null;
    return status;
  }
  if (result.code !== 0) {
    status.message = detail || `子の config が終了コード ${result.code} でした`;
    return status;
  }
  let baseBranch: unknown;
  try {
    baseBranch = (JSON.parse(result.stdout) as { baseBranch?: unknown })
      .baseBranch;
  } catch {
    baseBranch = undefined;
  }
  if (typeof baseBranch !== "string" || baseBranch === "") {
    status.message = "子の config --json の答えから baseBranch を読めません";
    return status;
  }
  status.initialized = true;
  status.baseBranch = baseBranch;
  try {
    await requireIntegratorPlace(ctx.runner, repo.path, { baseBranch });
    status.place = { ok: true, message: null };
  } catch (error) {
    if (!(error instanceof FlowError)) throw error;
    status.place = {
      ok: false,
      message: `子 ${repo.name} の統括役のタブで直してください：${error.message}`,
    };
  }
  return status;
}

async function forward(ctx: CommandContext): Promise<CommandResult> {
  const [name, sub, ...rest] = ctx.argv;
  if (name === undefined || name.startsWith("--"))
    throw new FlowError(1, `知らない引数です：${ctx.argv.join(" ")}`);
  if (sub === undefined)
    throw new FlowError(
      1,
      `サブコマンドを書いてください（${ALLOWED_SUBCOMMANDS.join("・")}）。使い方：orca-flow workspace <名前> <サブコマンド> [引数]`,
    );
  if (!(ALLOWED_SUBCOMMANDS as readonly string[]).includes(sub))
    throw new FlowError(
      1,
      `親から子へ流せるのは ${ALLOWED_SUBCOMMANDS.join("・")} だけです：${sub}`,
    );
  if (
    sub === "new" &&
    rest.some((a) => a === "--auto" || a.startsWith("--auto="))
  )
    throw new FlowError(
      1,
      "親から子へ new --auto は流せません（子のタスクを承認と統合の確認なしにしてしまうため）。おまかせにしたいときは、子の統括役のタブで orca-flow auto on 〈ID〉 を打ってください",
    );
  if (
    sub === "new" &&
    rest.some(
      (a) =>
        a === "--cross-depends-json" || a.startsWith("--cross-depends-json="),
    )
  )
    throw new FlowError(
      1,
      "親から子へ --cross-depends-json は渡せません。--cross-depends・--bumps・--branches を使ってください",
    );
  const workspace: Workspace = await loadWorkspace(ctx.runner, ctx.cwd);
  const repo = workspace.repos.find((r) => r.name === name);
  if (!repo)
    throw new FlowError(
      1,
      `設定にないリポジトリです：${name}（あるのは ${workspace.repos.map((r) => r.name).join("・")}）`,
    );

  if (
    sub === "new" &&
    repo.role !== "common" &&
    rest.some(
      (a) =>
        a === "--allow-branch-push" || a.startsWith("--allow-branch-push="),
    )
  )
    throw new FlowError(
      1,
      `親から ${repo.name}（アプリ）の new へ --allow-branch-push は流せません（承認なしの push は共通のタスクの枝だけ）`,
    );

  if (
    sub === "new" &&
    repo.role === "common" &&
    repo.branchCommand === undefined &&
    rest.some(
      (a) =>
        a === "--allow-branch-push" || a.startsWith("--allow-branch-push="),
    )
  )
    throw new FlowError(
      1,
      `親から ${repo.name} の new へ --allow-branch-push は流せません（${repo.name} に branchCommand がなく、枝で先に始められないため）`,
    );

  let args = absolutizeRequestFile(rest, ctx.cwd);
  if (sub === "new") {
    const taken = takeCrossOptions(args);
    const json = resolveCrossDependsArgs(
      workspace.repos,
      name,
      taken.crossDepends,
      taken.bumps,
      taken.branches,
    );
    args =
      json === null
        ? taken.rest
        : [...taken.rest, "--cross-depends-json", json];
  }
  const result = await runChild(
    ctx,
    repo,
    [sub, ...args, ...(ctx.json ? ["--json"] : [])],
    sub === "new" ? { [FROM_WORKSPACE_ENV]: "1" } : {},
  );
  if (result.stderr.trim() !== "") ctx.stderr(result.stderr.replace(/\n$/, ""));
  const code = toExit(result.code);
  if (!ctx.json) {
    if (result.stdout !== "") ctx.stdout(result.stdout.replace(/\n$/, ""));
    return { code };
  }
  // cli が JSON で出すので、子の JSON を data に載せ直す（読めなければ文字列のまま）
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    data = result.stdout.trim();
  }
  return { code, data };
}

/** `--request-file` の値が相対パスなら、親の今の場所で絶対パスに直す。ほかの引数は変えない */
function absolutizeRequestFile(args: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--request-file" && i + 1 < args.length) {
      out.push(arg, path.resolve(cwd, args[++i]!));
    } else if (arg.startsWith("--request-file=")) {
      out.push(`--request-file=${path.resolve(cwd, arg.slice(15))}`);
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** `--cross-depends`・`--bumps`・`--branches` の値を引数から取り出す（`--x 値` と `--x=値`）。残りの引数の並びは変えない */
function takeCrossOptions(args: readonly string[]): {
  crossDepends: string | undefined;
  bumps: string | undefined;
  branches: string | undefined;
  rest: string[];
} {
  const found: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const key = ["--cross-depends", "--bumps", "--branches"].find(
      (k) => arg === k || arg.startsWith(`${k}=`),
    );
    if (key === undefined) {
      rest.push(arg);
      continue;
    }
    let value: string;
    if (arg === key) {
      if (i + 1 >= args.length)
        throw new FlowError(1, `${key} に値を書いてください`);
      value = args[++i]!;
    } else {
      value = arg.slice(key.length + 1);
    }
    found[key] = found[key] === undefined ? value : `${found[key]},${value}`;
  }
  return {
    crossDepends: found["--cross-depends"],
    bumps: found["--bumps"],
    branches: found["--branches"],
    rest,
  };
}
