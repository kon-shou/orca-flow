import { requireFlowConfig } from "../lib/flow-config.ts";
import path from "node:path";
import { type QaConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { requireRoot } from "../lib/git.ts";
import { escapeId, requireIdShape } from "../lib/task-id.ts";
import { parseGroupTarget } from "../lib/group-branch.ts";
import { listBranches } from "../lib/git.ts";
import {
  choiceBranches,
  chooseGroupApps,
  isWorkspaceFolder,
  readGroupQa,
  resolveGroup,
  type GroupApp,
} from "../lib/qa/group.ts";
import {
  isSafeBranchName,
  repoKey,
  requireQa,
  resolveTask,
} from "../lib/qa/context.ts";
import {
  borrow,
  groupLeasesOf,
  pickEnv,
  readLeases,
  recordLease,
  release,
  type Borrower,
  type Lease,
  type LeaseApp,
} from "../lib/qa/leases.ts";
import {
  authHeader,
  buildFields,
  sendForm,
  type SendResult,
} from "../lib/qa/send.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

const USAGE =
  "使い方：orca-flow qa plan 〈ID〉／ qa deploy 〈ID〉 --env 〈番号〉 --head 〈先頭〉 [--branch 〈欄〉=〈ブランチ〉]… [--database]／ qa list [--json]／ qa release 〈ID〉 または qa release --env 〈番号〉（ワークスペースのフォルダでは 〈ID〉 の代わりに組のブランチ名 〈branchPrefix〉〈ID〉-〈短い名前〉 で打ち、ID では打てません。--head は 〈名前〉=〈先頭〉 を組のアプリごとに1つ）";

/** 繰り返せる値つきのフラグを、書いた順にすべて拾う（parseArgs は最後の1つしか持たない） */
function repeated(rest: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === `--${name}`) out.push(rest[++i] ?? "");
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  }
  return out;
}

/** 送りが通らなかったときの、貸し出しの記録の扱いと文。通ったときは何もしない */
async function failSend(
  ctx: CommandContext,
  qa: QaConfig,
  envNumber: number,
  borrower: Borrower,
  reused: boolean,
  result: Extract<SendResult, { ok: false }>,
): Promise<never> {
  if (!reused) await release(ctx.env, qa.url, { env: envNumber }, borrower);
  const delivery =
    result.delivered === "no"
      ? "要求は届いていません"
      : result.delivered === "unknown"
        ? "要求が届いたか分かりません。管理画面で状態を確かめてください"
        : "要求は送っています。管理画面で状態を確かめてください";
  const record = reused
    ? "前からの貸し出しの記録は残しました"
    : "この回で借りた分の記録は外しました";
  throw new FlowError(
    1,
    `QA 環境 ${envNumber} への deploy の要求が通りませんでした：${result.reason}。${delivery}。${record}`,
  );
}

/** 貸し出しの1行。組の貸し出しはアプリごとのブランチも出す */
function leaseLines(lease: Lease): string[] {
  if (!lease.apps)
    return [
      `${lease.id}（${path.basename(lease.repo)}、${lease.branch}、先頭 ${lease.head.slice(0, 12)}、${lease.at}）`,
    ];
  return [
    `${lease.id}（組 ${path.basename(lease.repo)}、${lease.at}）`,
    ...lease.apps.map(
      (a) => `    ${a.name}：${a.branch}（先頭 ${a.head.slice(0, 12)}）`,
    ),
  ];
}

const leaseApps = (apps: readonly GroupApp[]): LeaseApp[] =>
  apps.map((a) => ({
    name: a.name,
    path: a.path,
    branch: a.branch,
    head: a.head,
  }));

const appUrlOf = (qa: QaConfig, env: number) =>
  qa.appUrl?.replaceAll("{env}", String(env));

function parseEnvNumber(text: string): number {
  if (!/^[1-9]\d*$/.test(text))
    throw new FlowError(
      1,
      `--env は 1 以上の整数にしてください：${JSON.stringify(text)}`,
    );
  return Number(text);
}

/**
 * qa deploy は --json を受けない。cli が --json を位置に関係なく取り除くため、
 * ask の Bash(orca-flow qa deploy *) に当たらない形（qa --json deploy …）でも届く。許可の照合を外れるので断る
 */
function rejectJson(ctx: CommandContext): void {
  if (ctx.json)
    throw new FlowError(
      1,
      "qa deploy は --json を受けません（許可の画面の照合から外れるため）。--json を外してください",
    );
}

/** --branch 〈欄〉=〈ブランチ〉 を解く。lockedFields（送り手のアプリの欄）は上書きできない */
function parseBranchOverrides(
  qa: QaConfig,
  items: readonly string[],
  lockedFields: readonly string[],
  hint = "",
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    const field = eq < 0 ? "" : item.slice(0, eq);
    const branch = eq < 0 ? "" : item.slice(eq + 1);
    if (
      !Object.hasOwn(qa.branchFields, field) ||
      lockedFields.includes(field) ||
      !isSafeBranchName(branch)
    )
      throw new FlowError(
        1,
        `--branch は 〈欄〉=〈ブランチ〉 の形で、欄は ${
          Object.keys(qa.branchFields)
            .filter((k) => !lockedFields.includes(k))
            .join("・") || "（上書きできる欄なし）"
        } のどれか${hint}、ブランチは使える形にしてください`,
      );
    overrides[field] = branch;
  }
  return overrides;
}

/** --database と --env が設定に合うかを確かめる。--database が立っていれば true */
function checkDatabaseAndEnv(
  qa: QaConfig,
  args: { flags: ReadonlySet<string> },
  envNumber: number,
): boolean {
  const database = args.flags.has("database");
  if (database && !qa.databaseField)
    throw new FlowError(
      1,
      "設定に qa.databaseField がないので --database は使えません",
    );
  if (!qa.envs.includes(envNumber))
    throw new FlowError(
      1,
      `QA 環境 ${envNumber} は設定の envs にありません（${qa.envs.join("・")}）`,
    );
  return database;
}

const noFreeEnv = (qa: QaConfig) =>
  new FlowError(
    2,
    `空いている QA 環境がありません（${qa.envs.join("・")} はどれも借りられています）。qa list で見て、不要なものを qa release で返してください`,
  );

async function plan(ctx: CommandContext, rest: string[]) {
  const args = parseArgs(rest, []);
  const [id, ...extra] = args.positionals;
  if (!id || extra.length > 0) throw new FlowError(1, USAGE);
  const task = await resolveTask(ctx.runner, ctx.cwd, id);
  const leases = await readLeases(ctx.env, task.qa.url);
  const picked = pickEnv(leases, task.qa.envs, {
    repo: task.repo,
    id,
    branches: [task.branch],
  });
  if (!picked) throw noFreeEnv(task.qa);
  const fields = buildFields(task.qa, {
    env: picked.env,
    overrides: {},
    selfBranch: task.branch,
    database: false,
  });
  const lines = [
    `${id}：QA 環境 ${picked.env} に${picked.reused ? "（すでに借りています。使い直し）" : "（空いています）"}送ります`,
    `送り先：${task.qa.url}`,
    `ブランチ：${task.branch}（origin の先頭 ${task.head}）`,
    "送る欄：",
    ...fields.map(([k, v]) => `  ${k} = ${v}`),
    "",
    `次に打つ：orca-flow qa deploy ${id} --env ${picked.env} --head ${task.head}`,
  ];
  const heldByGroup = groupLeasesOf(leases, id, task.repo, task.branch);
  for (const h of heldByGroup)
    lines.splice(
      1,
      0,
      `同じ ${id} を組（${path.basename(h.lease.repo)}）が QA 環境 ${h.env} で借りています。組のモードで出すときは、ワークスペースのフォルダで qa plan を打ってください`,
    );
  if (!ctx.json) ctx.stdout(lines.join("\n"));
  return {
    code: 0 as const,
    data: {
      id,
      env: picked.env,
      reused: picked.reused,
      ...(heldByGroup.length > 0
        ? { groupEnvs: heldByGroup.map((h) => h.env) }
        : {}),
      branch: task.branch,
      head: task.head,
      fields: Object.fromEntries(fields),
    },
  };
}

async function deploy(ctx: CommandContext, rest: string[]) {
  rejectJson(ctx);
  const args = parseArgs(rest, ["env", "head", "branch"], ["database"]);
  const [id, ...extra] = args.positionals;
  const envText = args.values.get("env");
  const headArg = args.values.get("head");
  if (!id || extra.length > 0 || envText === undefined || headArg === undefined)
    throw new FlowError(1, USAGE);
  const envNumber = parseEnvNumber(envText);
  const branchArgs = repeated(rest, "branch");
  const task = await resolveTask(ctx.runner, ctx.cwd, id);
  const { qa } = task;

  const overrides = parseBranchOverrides(qa, branchArgs, [qa.selfField]);
  const database = checkDatabaseAndEnv(qa, args, envNumber);
  if (headArg !== task.head)
    throw new FlowError(
      1,
      `--head が origin の今の先頭と違います（渡された ${headArg}／今の先頭 ${task.head}）。qa plan をやり直してください`,
    );
  const authorization = authHeader(qa, ctx.env);

  const now = ctx.now().toISOString();
  const lease: Lease = {
    repo: task.repo,
    id,
    branch: task.branch,
    head: task.head,
    at: now,
  };
  const { reused } = await borrow(ctx.env, qa.url, envNumber, lease);
  const fields = buildFields(qa, {
    env: envNumber,
    overrides,
    selfBranch: task.branch,
    database,
  });
  const result = await sendForm(qa, fields, authorization);
  if (!result.ok)
    await failSend(ctx, qa, envNumber, { repo: task.repo, id }, reused, result);
  await recordLease(ctx.env, qa.url, envNumber, lease);
  const app = appUrlOf(qa, envNumber);
  if (!ctx.json)
    ctx.stdout(
      [
        `QA 環境 ${envNumber} に ${id}（${task.branch}）の deploy の要求を積みました（状態 ${result.status}）`,
        ...(app ? [`環境の画面：${app}`] : []),
        "積んだあと進まなければ、管理画面を開いてキューを進めてください",
      ].join("\n"),
    );
  return {
    code: 0 as const,
    data: {
      id,
      env: envNumber,
      branch: task.branch,
      head: task.head,
      status: result.status,
    },
  };
}

function formatEnv(e: {
  env: number;
  lease: Lease | null;
  appUrl: string | null;
}): string {
  const url = e.appUrl ? ` ${e.appUrl}` : "";
  if (!e.lease) return `環境 ${e.env}：空き${url}`;
  const [head, ...more] = leaseLines(e.lease);
  return [`環境 ${e.env}：${head}${url}`, ...more].join("\n");
}

async function list(ctx: CommandContext, rest: string[]) {
  if (rest.length > 0) throw new FlowError(1, USAGE);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const qa = requireQa(await requireFlowConfig(ctx.runner, root));
  return listEnvs(ctx, qa);
}

async function listEnvs(ctx: CommandContext, qa: QaConfig) {
  const leases = await readLeases(ctx.env, qa.url);
  const envs = qa.envs.map((env) => {
    const lease = leases.get(env);
    return {
      env,
      free: !lease,
      lease: lease ?? null,
      appUrl: appUrlOf(qa, env) ?? null,
    };
  });
  if (!ctx.json) ctx.stdout(envs.map((e) => formatEnv(e)).join("\n"));
  return { code: 0 as const, data: { url: qa.url, envs } };
}

async function releaseCmd(ctx: CommandContext, rest: string[]) {
  const args = parseArgs(rest, ["env"]);
  const [id, ...extra] = args.positionals;
  const envText = args.values.get("env");
  if (extra.length > 0 || (id === undefined) === (envText === undefined))
    throw new FlowError(1, USAGE);
  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  const qa = requireQa(config);
  let removed;
  if (envText !== undefined) {
    removed = await release(ctx.env, qa.url, { env: parseEnvNumber(envText) });
  } else {
    requireIdShape(id!);
    const repo = await repoKey(ctx.runner, ctx.cwd);
    removed = await release(ctx.env, qa.url, { who: { repo, id: id! } });
    if (removed.length === 0) {
      const start = `${config.branchPrefix}${id!}-`;
      const own = (await listBranches(ctx.runner, root, `${start}*`)).filter(
        (b) => b.length > start.length,
      );
      const held = groupLeasesOf(
        await readLeases(ctx.env, qa.url),
        id!,
        repo,
        own.length === 1 ? own[0] : undefined,
      );
      if (held.length > 0) {
        // ワークスペースのフォルダの組の release はブランチ名だけを受けるので、決まらなければ --env だけを案内する
        const again =
          own.length === 1 && isSafeBranchName(own[0]!) ? own[0]! : null;
        if (!ctx.json)
          ctx.stdout(
            held
              .map((h) =>
                again === null
                  ? `QA 環境 ${h.env} は組（${path.basename(h.lease.repo)}）が借りています。\`orca-flow qa release --env ${h.env}\` で返してください`
                  : `QA 環境 ${h.env} は組（${path.basename(h.lease.repo)}）が借りています。ワークスペースのフォルダで \`orca-flow qa release ${again}\` か、\`orca-flow qa release --env ${h.env}\` で返してください`,
              )
              .join("\n"),
          );
        return {
          code: 0 as const,
          data: { released: [], heldByGroup: held.map((h) => h.env) },
        };
      }
    }
  }
  return finishRelease(ctx, removed);
}

function finishRelease(
  ctx: CommandContext,
  removed: { env: number; lease: Lease }[],
) {
  if (!ctx.json)
    ctx.stdout(
      removed.length === 0
        ? "返すものはありませんでした（借りている環境はありません）"
        : removed
            .map((r) => `QA 環境 ${r.env}（${r.lease.id}）を空きに戻しました`)
            .join("\n"),
    );
  return {
    code: 0 as const,
    data: { released: removed.map((r) => ({ env: r.env, id: r.lease.id })) },
  };
}

/** ワークスペースのフォルダの qa plan／deploy が使う、組の貸し出しの借り手 */
const groupBorrower = (dir: string, id: string, apps: readonly GroupApp[]) => ({
  repo: dir,
  id,
  also: apps.map((a) => a.path),
  branches: apps.map((a) => a.branch),
});

/** ブランチ名で打ち直す1行に出すコマンド */
const retypeWith = (sub: "plan" | "release") => (branch: string) =>
  `orca-flow qa ${sub} ${branch}`;

async function groupPlan(ctx: CommandContext, rest: string[]) {
  const args = parseArgs(rest, []);
  const [arg, ...extra] = args.positionals;
  if (!arg || extra.length > 0) throw new FlowError(1, USAGE);
  const task = await resolveGroup(
    ctx.runner,
    ctx.env,
    ctx.cwd,
    parseGroupTarget(arg),
    retypeWith("plan"),
  );
  const { id } = task;
  const leases = await readLeases(ctx.env, task.qa.url);
  const picked = pickEnv(
    leases,
    task.qa.envs,
    groupBorrower(task.dir, id, task.apps),
  );
  if (!picked) throw noFreeEnv(task.qa);
  const fields = buildFields(task.qa, {
    env: picked.env,
    overrides: otherSelfFields(task.apps),
    selfBranch: task.apps[0]!.branch,
    database: false,
  });
  const heads = task.apps.map((a) => `--head ${a.name}=${a.head}`).join(" ");
  const lines = [
    `${id}：QA 環境 ${picked.env} に${picked.reused ? "（すでに借りています。使い直し）" : "（空いています）"}組で送ります`,
    `送り先：${task.qa.url}`,
    "組のアプリ：",
    ...task.apps.map(
      (a) => `  ${a.name}：${a.branch}（origin の先頭 ${a.head}）`,
    ),
    ...task.notes,
    "送る欄：",
    ...fields.map(([k, v]) => `  ${k} = ${v}`),
    "",
    `次に打つ：orca-flow qa deploy ${arg} --env ${picked.env} ${heads}`,
  ];
  if (!ctx.json) ctx.stdout(lines.join("\n"));
  return {
    code: 0 as const,
    data: {
      id,
      env: picked.env,
      reused: picked.reused,
      branch: task.apps.map((a) => a.branch).join(","),
      head: task.apps.map((a) => a.head).join(","),
      fields: Object.fromEntries(fields),
      apps: leaseApps(task.apps),
      notes: task.notes,
    },
  };
}

/** 組のアプリのうち最初の1つを除く、selfField → ブランチ（最初の1つは selfBranch で入る） */
function otherSelfFields(apps: readonly GroupApp[]): Record<string, string> {
  return Object.fromEntries(apps.slice(1).map((a) => [a.selfField, a.branch]));
}

async function groupDeploy(ctx: CommandContext, rest: string[]) {
  rejectJson(ctx);
  const args = parseArgs(rest, ["env", "head", "branch"], ["database"]);
  const [arg, ...extra] = args.positionals;
  const envText = args.values.get("env");
  const headArgs = repeated(rest, "head");
  if (
    !arg ||
    extra.length > 0 ||
    envText === undefined ||
    headArgs.length === 0
  )
    throw new FlowError(1, USAGE);
  const envNumber = parseEnvNumber(envText);
  const given = new Map<string, string>();
  for (const item of headArgs) {
    const eq = item.indexOf("=");
    const name = eq < 0 ? "" : item.slice(0, eq);
    const head = eq < 0 ? "" : item.slice(eq + 1);
    if (name === "" || head === "" || given.has(name))
      throw new FlowError(
        1,
        "--head は 〈名前〉=〈先頭〉 の形で、組のアプリごとに1つずつ書いてください",
      );
    given.set(name, head);
  }
  const task = await resolveGroup(
    ctx.runner,
    ctx.env,
    ctx.cwd,
    parseGroupTarget(arg),
    retypeWith("plan"),
  );
  const { qa, id } = task;

  const names = task.apps.map((a) => a.name);
  const missing = names.filter((n) => !given.has(n));
  const surplus = [...given.keys()].filter((n) => !names.includes(n));
  if (missing.length > 0 || surplus.length > 0)
    throw new FlowError(
      1,
      `--head は組のアプリ（${names.join("・")}）にちょうど1つずつ書いてください${missing.length > 0 ? `。足りない：${missing.join("・")}` : ""}${surplus.length > 0 ? `。余り：${surplus.join("・")}` : ""}`,
    );
  const stale = task.apps.filter((a) => given.get(a.name) !== a.head);
  if (stale.length > 0)
    throw new FlowError(
      1,
      `--head が origin の今の先頭と違います（${stale.map((a) => `${a.name}：渡された ${given.get(a.name)}／今の先頭 ${a.head}`).join("、")}）。qa plan をやり直してください`,
    );

  const appFields = task.apps.map((a) => a.selfField);
  const overrides = parseBranchOverrides(
    qa,
    repeated(rest, "branch"),
    appFields,
    "（組のアプリの欄は上書きできません）",
  );
  const database = checkDatabaseAndEnv(qa, args, envNumber);
  const authorization = authHeader(qa, ctx.env);

  const lease: Lease = {
    repo: task.dir,
    id,
    branch: task.apps.map((a) => a.branch).join(","),
    head: task.apps.map((a) => a.head).join(","),
    at: ctx.now().toISOString(),
    apps: leaseApps(task.apps),
  };
  const borrower = groupBorrower(task.dir, id, task.apps);
  const { reused } = await borrow(
    ctx.env,
    qa.url,
    envNumber,
    lease,
    borrower.also,
  );
  const fields = buildFields(qa, {
    env: envNumber,
    overrides: { ...overrides, ...otherSelfFields(task.apps) },
    selfBranch: task.apps[0]!.branch,
    database,
  });
  const result = await sendForm(qa, fields, authorization);
  if (!result.ok) await failSend(ctx, qa, envNumber, borrower, reused, result);
  await recordLease(ctx.env, qa.url, envNumber, lease);
  const app = appUrlOf(qa, envNumber);
  ctx.stdout(
    [
      `QA 環境 ${envNumber} に ${id}（${task.apps.map((a) => `${a.name}：${a.branch}`).join("、")}）の deploy の要求を積みました（状態 ${result.status}）`,
      ...task.notes,
      ...(app ? [`環境の画面：${app}`] : []),
      "積んだあと進まなければ、管理画面を開いてキューを進めてください",
    ].join("\n"),
  );
  return {
    code: 0 as const,
    data: {
      id,
      env: envNumber,
      branch: lease.branch,
      head: lease.head,
      apps: lease.apps,
      notes: task.notes,
      status: result.status,
    },
  };
}

async function groupList(ctx: CommandContext, rest: string[]) {
  if (rest.length > 0) throw new FlowError(1, USAGE);
  const { qa } = await readGroupQa(ctx.runner, ctx.env, ctx.cwd);
  return listEnvs(ctx, qa);
}

async function groupRelease(ctx: CommandContext, rest: string[]) {
  const args = parseArgs(rest, ["env"]);
  const [arg, ...extra] = args.positionals;
  const envText = args.values.get("env");
  if (extra.length > 0 || (arg === undefined) === (envText === undefined))
    throw new FlowError(1, USAGE);
  if (envText !== undefined) {
    const { qa } = await readGroupQa(ctx.runner, ctx.env, ctx.cwd);
    return finishRelease(
      ctx,
      await release(ctx.env, qa.url, { env: parseEnvNumber(envText) }),
    );
  }
  // ブランチを消したあとでも返せるよう、ブランチ名は手元になくても記録の apps の branch と照らす
  const { group, choice } = await chooseGroupApps(
    ctx.runner,
    ctx.env,
    ctx.cwd,
    parseGroupTarget(arg!),
    retypeWith("release"),
    { allowMissing: true },
  );
  const dir = group.workspace.dir;
  const branches = [choice.branch];
  const removed = await release(ctx.env, group.qa.url, {
    who: { repo: dir, id: choice.id, branches },
  });
  if (removed.length > 0) return finishRelease(ctx, removed);
  const held = [...(await readLeases(ctx.env, group.qa.url))]
    .filter(([, l]) => l.id === choice.id && l.repo === dir && l.apps)
    .sort(([a], [b]) => a - b);
  if (held.length > 0) {
    if (!ctx.json)
      ctx.stdout(
        [
          `返すものはありませんでした（ブランチ ${escapeId(choice.branch)} の組の貸し出しはありません）`,
          ...held.map(
            ([env, l]) =>
              `QA 環境 ${env} は同じ ${choice.id} の組（${l.apps!.map((a) => `${a.name}：${escapeId(a.branch)}`).join("、")}）が借りています。その貸し出しを返すときは \`orca-flow qa release --env ${env}\` を打ってください`,
          ),
        ].join("\n"),
      );
    return {
      code: 0 as const,
      data: { released: [], heldByGroup: held.map(([env]) => env) },
    };
  }
  if (choiceBranches(choice) === undefined)
    throw new FlowError(
      1,
      `ブランチ ${escapeId(choice.branch)} がどのアプリの子にもなく、そのブランチの組の貸し出しもありません`,
    );
  return finishRelease(ctx, removed);
}

export const run: Command = async (ctx) => {
  const [sub, ...rest] = ctx.argv;
  const group = await isWorkspaceFolder(ctx.cwd);
  switch (sub) {
    case "plan":
      return group ? groupPlan(ctx, rest) : plan(ctx, rest);
    case "deploy":
      return group ? groupDeploy(ctx, rest) : deploy(ctx, rest);
    case "list":
      return group ? groupList(ctx, rest) : list(ctx, rest);
    case "release":
      return group ? groupRelease(ctx, rest) : releaseCmd(ctx, rest);
    default:
      throw new FlowError(1, USAGE);
  }
};
