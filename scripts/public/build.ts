import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowError } from "../../src/types.ts";
import { verifyHook } from "./hook.ts";
import { loadCheckInputs, reportCheck } from "./check.ts";
import {
  git,
  gitOrThrow,
  PUBLIC_REF,
  MAIN_REF,
  say,
  topLevel,
  type Ctx,
  type Identity,
} from "./common.ts";

export const DEFAULT_MESSAGE = "公開用の更新";

/**
 * main の木から抜くパスを除いた木を、一時の index で作る。作業ツリーと index は変えない。
 * パスは文字にせず git の中だけで扱う（外のコマンドの出力は 64KB ごとに区切られ、日本語が壊れうる）
 */
async function buildTree(
  ctx: Ctx,
  exclude: readonly string[],
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "orca-flow-public-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    await gitOrThrow(ctx, ["read-tree", MAIN_REF], "一時の index の組み立て", {
      env,
    });
    if (exclude.length > 0)
      await gitOrThrow(
        ctx,
        [
          "rm",
          "--cached",
          "-f",
          "-r",
          "-q",
          "--ignore-unmatch",
          "--",
          ...exclude.map((entry) => `:(literal)${entry}`),
        ],
        "抜くパスの除外",
        { env },
      );
    return (await gitOrThrow(ctx, ["write-tree"], "木の作成", { env })).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseMessage(args: readonly string[]): string {
  let message = DEFAULT_MESSAGE;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--message" && args[i + 1] !== undefined) {
      message = args[i + 1] as string;
      i++;
    } else throw new FlowError(2, "使い方：build [--message 〈文〉]");
  }
  if (!message.trim()) throw new FlowError(2, "メッセージが空です");
  return message;
}

function commitEnv(identity: Identity, date: Date): NodeJS.ProcessEnv {
  const when = `${Math.floor(date.getTime() / 1000)} +0000`;
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: when,
  };
}

export async function build(
  base: Ctx,
  args: readonly string[],
): Promise<number> {
  const message = parseMessage(args);
  const ctx = { ...base, cwd: await topLevel(base) };
  await verifyHook(ctx);
  const inputs = await loadCheckInputs(ctx);

  const main = await git(ctx, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${MAIN_REF}^{commit}`,
  ]);
  if (main.code !== 0) throw new FlowError(2, "main ブランチがありません");

  const tree = await buildTree(ctx, inputs.exclude);

  const prev = await git(ctx, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${PUBLIC_REF}^{commit}`,
  ]);
  const parent = prev.code === 0 ? prev.stdout.trim() : "";
  if (parent) {
    const prevTree = (
      await gitOrThrow(ctx, ["rev-parse", `${parent}^{tree}`], "木の取得")
    ).trim();
    if (prevTree === tree) {
      say(ctx, "public と木が同じなので、コミットは作りません");
      return 0;
    }
  }

  const commitArgs = ["commit-tree", tree, ...(parent ? ["-p", parent] : [])];
  commitArgs.push("-m", message);
  const commit = (
    await gitOrThrow(ctx, commitArgs, "コミットの作成", {
      env: commitEnv(inputs.identity, ctx.now()),
    })
  ).trim();

  if (await reportCheck(ctx, [commit], inputs)) {
    say(ctx, "public は変えていません");
    return 1;
  }
  await gitOrThrow(
    ctx,
    ["update-ref", PUBLIC_REF, commit, parent],
    "public の更新",
  );
  say(ctx, `public を ${commit.slice(0, 10)} に進めました`);
  return 0;
}
