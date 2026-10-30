import {
  access,
  chmod,
  constants,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../../src/types.ts";
import { loadCheckInputs, reportCheck } from "./check.ts";
import {
  commonDir,
  git,
  MAIN_REF,
  PUBLIC_REF,
  say,
  topLevel,
  ZERO_OID,
  type Ctx,
} from "./common.ts";

export const HOOK_MARKER = "# orca-flow public pre-push";

function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** フックの中身。setup した時の node と main.ts を使う。見つからなければ日本語で理由を出して止める */
export function hookScript(nodePath: string, mainFile: string): string {
  return `#!/bin/sh
${HOOK_MARKER}（orca-flow の setup が書いたもの）
node=${shQuote(nodePath)}
[ -x "$node" ] || node=$(command -v node)
if [ -z "$node" ]; then
  echo "pre-push：node が見つかりません。setup をもう一度実行してください" >&2
  exit 1
fi
main=${shQuote(mainFile)}
if [ ! -f "$main" ]; then
  echo "pre-push：main.ts が見つかりません。setup をもう一度実行してください" >&2
  exit 1
fi
exec "$node" "$main" pre-push "$@"
`;
}

const HOOK_HINT = "setup を流してください";

/** フックの `main='…'` の値（shQuote の逆）。なければ null */
function hookMainFile(script: string): string | null {
  const line = script.split("\n").find((l) => l.startsWith("main='"));
  if (!line) return null;
  const quoted = line.slice("main=".length);
  const parts = quoted.match(/'([^']*)'|\\'/g);
  if (!parts || parts.join("") !== quoted) return null;
  return parts.map((p) => (p === "\\'" ? "'" : p.slice(1, -1))).join("");
}

/** build の前に、pre-push のフックが効く形かを確かめる。欠けていれば終了コード2 */
export async function verifyHook(ctx: Ctx): Promise<void> {
  const stop = (reason: string): never => {
    throw new FlowError(2, `${reason}。${HOOK_HINT}`);
  };
  const hooksPath = await git(ctx, ["config", "--get", "core.hooksPath"]);
  if (hooksPath.code === 0)
    stop(
      "core.hooksPath が設定されていて、置いたフックが使われないので public を作りません",
    );
  const hookFile = path.join(await commonDir(ctx), "hooks", "pre-push");
  let script: string;
  try {
    script = await readFile(hookFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return stop("pre-push のフックがないので public を作りません");
  }
  if (!script.includes(HOOK_MARKER))
    stop(
      "pre-push のフックが setup の書いたものではないので public を作りません",
    );
  try {
    await access(hookFile, constants.X_OK);
  } catch {
    stop("pre-push のフックが実行できないので public を作りません");
  }
  const main = hookMainFile(script);
  const exists =
    main !== null &&
    (await stat(main).then(
      (s) => s.isFile(),
      () => false,
    ));
  if (!exists)
    stop("フックが指す main.ts が見つからないので public を作りません");
}

/** 標準入力の行を読み、public を main へ送るときだけ、送る範囲の全コミットに check をかける */
export async function prePush(base: Ctx): Promise<number> {
  const ctx = { ...base, cwd: await topLevel(base) };
  const input = await ctx.io.stdin();
  const lines = input.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return 0;
  const refs = lines.map((line) => line.trim().split(/\s+/));
  for (const [localRef, , remoteRef] of refs) {
    if (localRef !== PUBLIC_REF || remoteRef !== MAIN_REF) {
      say(
        ctx,
        `push を止めました：送れるのは public から main だけです（${localRef ?? ""} → ${remoteRef ?? ""}）`,
      );
      return 1;
    }
  }
  const inputs = await loadCheckInputs(ctx);
  const commits = new Set<string>();
  for (const [, localSha = "", , remoteSha = ""] of refs) {
    let list = null;
    if (remoteSha && !ZERO_OID.test(remoteSha)) {
      const out = await git(ctx, ["rev-list", localSha, `^${remoteSha}`]);
      if (out.code === 0) list = out.stdout;
    }
    if (list === null) {
      const out = await git(ctx, ["rev-list", localSha]);
      if (out.code !== 0)
        throw new FlowError(1, "送るコミットの一覧を取得できませんでした");
      list = out.stdout;
    }
    for (const sha of list.split("\n")) if (sha.trim()) commits.add(sha.trim());
  }
  if (await reportCheck(ctx, [...commits], inputs)) {
    say(ctx, "push を止めました");
    return 1;
  }
  return 0;
}

export interface SetupArgs {
  name: string;
  email: string;
  remote: string;
}

export function parseSetupArgs(args: readonly string[]): SetupArgs {
  const usage =
    "使い方：setup --name 〈名前〉 --email 〈メールアドレス〉 [--remote 〈名前〉]";
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      (key !== "--name" && key !== "--email" && key !== "--remote") ||
      value === undefined ||
      !value.trim()
    )
      throw new FlowError(2, usage);
    values[key] = value;
  }
  if (!values["--name"] || !values["--email"]) throw new FlowError(2, usage);
  return {
    name: values["--name"],
    email: values["--email"],
    remote: values["--remote"] ?? "origin",
  };
}

export async function setup(
  ctx: Ctx,
  args: readonly string[],
): Promise<number> {
  const parsed = parseSetupArgs(args);
  const common = await commonDir(ctx);

  // 何かを書き換える前に、衝突を全部確かめる
  const hooksPath = await git(ctx, ["config", "--get", "core.hooksPath"]);
  if (hooksPath.code === 0)
    throw new FlowError(
      2,
      "core.hooksPath が設定されているので、フックは置きません。設定を確かめてください",
    );
  const hookFile = path.join(common, "hooks", "pre-push");
  const script = hookScript(ctx.nodePath, ctx.mainFile);
  let existing: string | null = null;
  try {
    existing = await readFile(hookFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== null && !existing.includes(HOOK_MARKER))
    throw new FlowError(
      2,
      "違う pre-push のフックがすでにあるので、書き換えません。中身を確かめて、自分で統合してください",
    );

  for (const [key, value] of [
    ["orca-flow.publicName", parsed.name],
    ["orca-flow.publicEmail", parsed.email],
  ] as const) {
    const out = await git(ctx, ["config", key, value]);
    if (out.code !== 0)
      throw new FlowError(1, `git の設定（${key}）を書けませんでした`);
  }
  await mkdir(path.dirname(hookFile), { recursive: true });
  await writeFile(hookFile, script);
  await chmod(hookFile, 0o755);
  say(ctx, `pre-push のフックを置きました：${hookFile}`);

  const remotes = await git(ctx, ["remote"]);
  if (
    remotes.stdout
      .split("\n")
      .map((r) => r.trim())
      .includes(parsed.remote)
  ) {
    const out = await git(ctx, [
      "config",
      `remote.${parsed.remote}.push`,
      `${PUBLIC_REF}:${MAIN_REF}`,
    ]);
    if (out.code !== 0)
      throw new FlowError(1, "remote の push の設定を書けませんでした");
    say(
      ctx,
      `remote.${parsed.remote}.push を ${PUBLIC_REF}:${MAIN_REF} にしました`,
    );
  } else {
    say(
      ctx,
      `remote「${parsed.remote}」がありません。remote を足したあとに setup をもう一度実行してください`,
    );
  }
  return 0;
}
