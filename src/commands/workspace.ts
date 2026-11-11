import { FROM_WORKSPACE_ENV } from "./new.ts";
import path from "node:path";
import { resolveCompanionArg } from "../lib/companion.ts";
import { resolveCrossDependsArgs } from "../lib/cross-depends.ts";
import { resolveWorkspaceStartAfter } from "../lib/start-after.ts";
import { requireIntegratorPlace } from "../lib/git.ts";
import { parseArgs } from "../lib/args.ts";
import {
  previewBackground,
  previewStart,
  previewStop,
  requireTarget,
  resolvePreviewGroup,
} from "../lib/workspace-preview.ts";
import { draftWorkspace } from "../lib/workspace-draft.ts";
import { runSetup, type ChildCheck } from "../lib/workspace-setup.ts";
import {
  appUsersOf,
  loadWorkspace,
  nextIdOf,
  runChildCli,
  type Workspace,
  type WorkspaceCompanion,
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
  "preview",
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
  /** 設定で true の子だけ（なければキーごとない）。intake が毎回読む印 */
  alwaysRead?: true;
  /** アプリで設定にあるときだけ（なければキーごとない）。E2E を伴わせる設定 */
  companion?: WorkspaceCompanion;
  /** 共通だけ。共通のパッケージ名を使うアプリの名前の並び。アプリを読めないときは null（アプリにはキーがない） */
  users?: string[] | null;
  /** 子の `config --json` が0なら true、2（init がまだ）なら false、1（設定の誤り）なら null */
  initialized: boolean | null;
  /** 子の `config --json` の baseBranch。取れなければ null */
  baseBranch: string | null;
  /** その子で `new` が次に振る ID（tasksDir・進捗表・ブランチの最大の数＋1）。init がまだ・設定が読めない・数えられないときは null */
  nextId: string | null;
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
  /** 設定に readFirst があるときだけ（なければキーごとない）。先に読む文書の実の絶対パス */
  readFirst?: string[];
  repos: WorkspaceRepoStatus[];
}

export const run: Command = async (ctx) => {
  const [first] = ctx.argv;
  if (first === undefined) return list(ctx);
  if (first.startsWith("--") && ctx.argv.includes("--draft")) return draft(ctx);
  if (first.startsWith("--") && ctx.argv.includes("--setup")) return setup(ctx);
  if (first.startsWith("--") && ctx.argv.includes("--preview"))
    return previewParent(ctx);
  return forward(ctx);
};

async function previewParent(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(
    ctx.argv.filter((a) => a !== "--preview"),
    [],
    ["stop", "background", "base"],
  );
  const target = requireTarget(args.positionals);
  const base = args.flags.has("base");
  const stop = args.flags.has("stop");
  const background = args.flags.has("background");
  if (stop && background)
    throw new FlowError(1, "--stop と --background は一緒に使えません");
  const workspace = await loadWorkspace(ctx.runner, ctx.cwd);
  const child = (repo: WorkspaceRepo, childArgs: readonly string[]) =>
    runChild(ctx, repo, childArgs);
  const flags = [
    ...(stop ? ["--stop"] : []),
    ...(background ? ["--background"] : []),
    ...(base ? ["--base"] : []),
  ];
  // 背景に回す前に見分けて、ID・外れはこの場で終了コード1にする
  const group = await resolvePreviewGroup(
    ctx,
    workspace,
    target,
    child,
    (branch) => ["orca-flow workspace --preview", branch, ...flags].join(" "),
    // --stop は組のブランチを消したあとでも、記録で組に当たる子を片づける
    { allowMissing: stop },
  );
  const { id } = group;
  if (background) {
    await previewBackground(ctx, workspace, args.positionals[0]!, id, base);
    return { code: 0, data: { id, background: true } };
  }
  const data = stop
    ? await previewStop(ctx, workspace, group, child, base)
    : await previewStart(ctx, workspace, group, child, base);
  const failed = data.repos.some((r) => r.result === "failed");
  return { code: failed ? 1 : 0, data };
}

async function draft(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.argv.includes("--setup"))
    throw new FlowError(1, "--draft と --setup は一緒に使えません");
  const paths: string[] = [];
  for (const arg of ctx.argv) {
    if (arg === "--draft") continue;
    if (arg.startsWith("-")) throw new FlowError(1, `知らない引数です：${arg}`);
    paths.push(arg);
  }
  const data = await draftWorkspace(ctx.runner, ctx.cwd, paths);
  if (!ctx.json) {
    ctx.stdout(`ワークスペース：${data.dir}`);
    for (const r of data.repos) {
      ctx.stdout(
        `${r.name ?? "（名前は決める）"}（${r.role === "common" ? "共通の推し" : "アプリ"}）${r.path}`,
      );
      ctx.stdout(
        `  url：${r.url ?? "なし"}／package：${r.package ?? "なし"}／manager：${r.manager ?? "なし"}／e2e：${r.e2e ?? "なし"}／users：${r.users === null ? "読めません" : r.users.join("・") || "なし"}`,
      );
      for (const p of r.problems) ctx.stdout(`  問題：${p}`);
    }
  }
  return { code: 0, data };
}

async function setup(ctx: CommandContext): Promise<CommandResult> {
  const { code, data } = await runSetup(
    ctx.runner,
    ctx.cwd,
    ctx.argv,
    { stdout: ctx.stdout, stderr: ctx.stderr },
    ctx.json,
    async (workspace): Promise<ChildCheck[]> => {
      const out: ChildCheck[] = [];
      for (const repo of workspace.repos) {
        const s = await inspect(ctx, repo);
        out.push({
          name: s.name,
          path: s.path,
          initialized: s.initialized,
          placeOk: s.place.ok,
          line: describe(s),
        });
      }
      return out;
    },
  );
  return { code, data };
}

const toExit = (code: number): ExitCode =>
  code === 0 || code === 1 || code === 2 || code === 3 ? code : 1;

/** 子の CLI を、子のフォルダを作業の場所にして流す */
function runChild(
  ctx: CommandContext,
  repo: WorkspaceRepo,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return runChildCli(ctx.runner, { ...ctx.env, ...extraEnv }, repo, args);
}

async function list(ctx: CommandContext): Promise<CommandResult> {
  const workspace = await loadWorkspace(ctx.runner, ctx.cwd);
  const repos: WorkspaceRepoStatus[] = [];
  for (const repo of workspace.repos) repos.push(await inspect(ctx, repo));
  await fillUsers(ctx, repos);

  const hasConfigError = repos.some((r) => r.initialized === null);
  const hasOther = repos.some(
    (r) => r.initialized !== true || r.place.ok !== true,
  );
  const code: ExitCode = hasConfigError ? 1 : hasOther ? 2 : 0;
  const data: WorkspaceListing = {
    dir: workspace.dir,
    hash: workspace.sha256,
    ...(workspace.readFirst !== undefined
      ? { readFirst: workspace.readFirst }
      : {}),
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

/** 共通の要素に users（共通を使うアプリの名前の並び）を足す */
async function fillUsers(
  ctx: CommandContext,
  repos: WorkspaceRepoStatus[],
): Promise<void> {
  const apps = repos.filter((r) => r.role === "app");
  for (const repo of repos) {
    if (repo.role !== "common") continue;
    repo.users =
      repo.package === null
        ? null
        : await appUsersOf(ctx.runner, repo.package, apps);
  }
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
    ...(repo.alwaysRead ? { alwaysRead: true as const } : {}),
    ...(repo.companion !== undefined ? { companion: repo.companion } : {}),
    initialized: null,
    baseBranch: null,
    nextId: null,
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
  let rawConfig: unknown = null;
  try {
    rawConfig = JSON.parse(result.stdout);
    baseBranch = (rawConfig as { baseBranch?: unknown }).baseBranch;
  } catch {
    baseBranch = undefined;
  }
  if (typeof baseBranch !== "string" || baseBranch === "") {
    status.message = "子の config --json の答えから baseBranch を読めません";
    return status;
  }
  status.initialized = true;
  status.baseBranch = baseBranch;
  status.nextId = await nextIdOf(ctx.runner, repo.path, rawConfig);
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
  if (
    sub === "new" &&
    rest.some(
      (a) => a === "--read-first-json" || a.startsWith("--read-first-json="),
    )
  )
    throw new FlowError(
      1,
      "親から子へ --read-first-json は渡せません。先に読む文書は設定の readFirst から親が渡します",
    );
  if (
    sub === "new" &&
    rest.some(
      (a) => a === "--start-after-json" || a.startsWith("--start-after-json="),
    )
  )
    throw new FlowError(
      1,
      "親から子へ --start-after-json は渡せません。--start-after 〈名前〉:〈ID〉,… を使ってください（親が設定の実のパスに解いて渡します）",
    );
  const startAfterTaken = takeOption(rest, "--start-after");
  if (startAfterTaken.found && sub !== "new")
    throw new FlowError(1, "--start-after は new にだけ付けられます");
  const companionTaken = takeCompanion(startAfterTaken.rest);
  if (companionTaken.found && sub !== "new")
    throw new FlowError(1, "--companion は new にだけ付けられます");
  if (
    sub === "new" &&
    rest.some(
      (a) => a === "--companion-json" || a.startsWith("--companion-json="),
    )
  )
    throw new FlowError(
      1,
      "親から子へ --companion-json は渡せません。--companion を使ってください",
    );
  const workspace: Workspace = await loadWorkspace(ctx.runner, ctx.cwd);
  // 親が --read-first-json を足すので、流すと子が人の打っていない引数の名前で止まる
  if (
    sub === "new" &&
    workspace.readFirst !== undefined &&
    rest.some(
      (a) => a === "--read-first-from" || a.startsWith("--read-first-from="),
    )
  )
    throw new FlowError(
      1,
      "このワークスペースでは、親から子の new へ --read-first-from は渡せません。先に読む文書は設定の readFirst から親が渡します。親の記録を写したいときは、子のリポジトリで直に orca-flow new … --read-first-from 〈親の ID〉 を流してください",
    );
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

  let args = absolutizeRequestFile(companionTaken.rest, ctx.cwd);
  if (sub === "new") {
    const companionJson = resolveCompanionArg(
      workspace.repos,
      name,
      companionTaken.value,
    );

    const taken = takeCrossOptions(args);
    const json = resolveCrossDependsArgs(
      workspace.repos,
      name,
      taken.crossDepends,
      taken.bumps,
      taken.branches,
    );
    const startAfter = startAfterTaken.found
      ? resolveWorkspaceStartAfter(
          workspace.repos,
          name,
          startAfterTaken.value ?? "",
        )
      : null;
    args = [
      ...taken.rest,
      ...(json === null ? [] : ["--cross-depends-json", json]),
      ...(companionJson === null ? [] : ["--companion-json", companionJson]),
      ...(startAfter !== null && startAfter.same.length > 0
        ? ["--start-after", startAfter.same.join(",")]
        : []),
      ...(startAfter !== null && startAfter.json.length > 0
        ? ["--start-after-json", JSON.stringify(startAfter.json)]
        : []),
    ];
  }
  if (sub === "new" && workspace.readFirst !== undefined)
    args = [...args, "--read-first-json", JSON.stringify(workspace.readFirst)];
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

/** `--companion` の値を引数から取り出す（`--x 値` と `--x=値`。複数なら「,」でつなぐ） */
function takeCompanion(args: readonly string[]): {
  found: boolean;
  value: string | undefined;
  rest: string[];
} {
  return takeOption(args, "--companion");
}

/** 1つの引数の値を取り出す（`--x 値` と `--x=値`。複数なら「,」でつなぐ）。残りの引数の並びは変えない */
function takeOption(
  args: readonly string[],
  key: string,
): {
  found: boolean;
  value: string | undefined;
  rest: string[];
} {
  const values: string[] = [];
  const rest: string[] = [];
  let found = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === key) {
      found = true;
      if (i + 1 >= args.length)
        throw new FlowError(1, `${key} に値を書いてください`);
      values.push(args[++i]!);
    } else if (arg.startsWith(`${key}=`)) {
      found = true;
      values.push(arg.slice(key.length + 1));
    } else {
      rest.push(arg);
    }
  }
  return { found, value: found ? values.join(",") : undefined, rest };
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
