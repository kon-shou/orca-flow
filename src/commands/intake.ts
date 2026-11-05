import { access } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig, type LeadConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { isMainWorktree, requireRoot } from "../lib/git.ts";
import { createOrca } from "../lib/orca.ts";
import { loadWorkspace, WORKSPACE_FILE } from "../lib/workspace.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE = "使い方：orca-flow intake 〈https:// で始まる URL〉";

/** 1語の https:// の URL だけ（URL に使う ASCII の文字のみ）。会話の最初の入力に入るので、続く文やシェルの記号を混ぜさせない */
const URL_PATTERN = /^https:\/\/[A-Za-z0-9\-._~:/?#@!&=+,;%]+$/;

/** intake の本体を新しいタブで始める（8章 intake）。git も Notion も書かない */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, []);
  const [url, ...rest] = args.positionals;
  if (url === undefined || rest.length > 0) throw new FlowError(1, USAGE);
  if (!URL_PATTERN.test(url))
    throw new FlowError(
      1,
      `URL は https:// で始まる1語（英数字と URL に使う記号だけ）にしてください。${USAGE}`,
    );

  const prompt = `/orca-flow:intake --here ${url}`;

  let kind: "repo" | "workspace";
  let place: string;
  let lead: LeadConfig;
  if (await exists(path.join(ctx.cwd, WORKSPACE_FILE))) {
    const workspace = await loadWorkspace(ctx.runner, ctx.cwd);
    kind = "workspace";
    place = workspace.dir;
    lead = DEFAULT_CONFIG.lead;
  } else {
    const root = await requireRoot(ctx.runner, ctx.cwd);
    if (!(await isMainWorktree(ctx.runner, root)))
      throw new FlowError(
        2,
        "ここはタスクの worktree です。メインのチェックアウト（統括役のタブ）かワークスペースのフォルダで呼んでください",
      );
    const loaded = await loadConfig(root);
    if (!loaded.exists)
      throw new FlowError(
        2,
        "このリポジトリには orca-flow の設定がありません。メインのチェックアウトのタブで /orca-flow:init を流してください",
      );
    kind = "repo";
    place = root;
    lead =
      loaded.config.lead.agent === "claude"
        ? loaded.config.lead
        : DEFAULT_CONFIG.lead;
  }

  try {
    await createOrca(ctx.runner, place).launchAgent({
      worktreePath: place,
      lead,
      prompt,
    });
  } catch (error) {
    if (!(error instanceof FlowError)) throw error;
    throw new FlowError(
      1,
      `${error.message}\n新しいタブが立たなかったかもしれません。同じ場所に intake の新しいタブが立っていないかを先に確かめ、なければ同じタブで続けるには /orca-flow:intake --here ${url} を流してください`,
    );
  }

  if (!ctx.json)
    ctx.stdout(
      `${kind === "workspace" ? "ワークスペースのフォルダ" : "メインのチェックアウト"} ${place} に新しいタブを立てて、intake の本体を渡しました。続きはそのタブで進めます`,
    );
  return { code: 0, data: { kind, place, url } };
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
