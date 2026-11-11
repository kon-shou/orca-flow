import { loadFlowConfig } from "../lib/flow-config.ts";
import {
  access,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type LeadConfig } from "../config.ts";
import { parseArgs } from "../lib/args.ts";
import { isMainWorktree, requireRoot } from "../lib/git.ts";
import { createOrca } from "../lib/orca.ts";
import { loadWorkspace, WORKSPACE_FILE } from "../lib/workspace.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE =
  "使い方：orca-flow intake 〈https:// で始まる URL〉 または 〈手元のパス〉";

/** 受け渡しのファイルのパスが最初の入力に入るので、この文字だけに限る */
const SAFE_FILE_PATH = /^[A-Za-z0-9/\\:._-]+$/;

const HANDOFF_PREFIX = "orca-flow-intake-";

/** 1語の https:// の URL だけ（URL に使う ASCII の文字のみ）。会話の最初の入力に入るので、続く文やシェルの記号を混ぜさせない */
const URL_PATTERN = /^https:\/\/[A-Za-z0-9\-._~:/?#@!&=+,;%]+$/;

/** intake の本体を新しいタブで始める（8章 intake）。git も Notion も書かない */
export const run: Command = async (ctx) => {
  const args = parseArgs(ctx.argv, []);
  const [url, ...rest] = args.positionals;
  if (url === undefined || url.trim() === "" || rest.length > 0)
    throw new FlowError(1, USAGE);
  const isUrl = /^https?:\/\//.test(url);
  if (isUrl && !URL_PATTERN.test(url))
    throw new FlowError(
      1,
      `URL は https:// で始まる1語（英数字と URL に使う記号だけ）にしてください。${USAGE}`,
    );

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
    const loaded = await loadFlowConfig(ctx.runner, root);
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

  let prompt = `/orca-flow:intake --here ${url}`;
  let hereArg = url;
  let localPath: string | undefined;
  if (!isUrl) {
    const target = await resolveLocal(ctx, url);
    hereArg = target.path;
    localPath = target.path;
    const made = await mkdtemp(path.join(os.tmpdir(), HANDOFF_PREFIX));
    let dir = made;
    try {
      // node:fs/promises の realpath は OS の実のパスを返す。Windows の os.tmpdir() は ABCDEF~1 のような短い名前を返すことがあり、~ は許す文字にないため
      dir = await realpath(made);
      const file = path.join(dir, "source.json");
      if (!SAFE_FILE_PATH.test(file))
        throw new FlowError(
          1,
          `受け渡しのファイルのパスに使えない文字があります。同じタブで続けるには /orca-flow:intake --here ${hereArg} を流してください`,
        );
      await writeFile(
        file,
        JSON.stringify({ path: target.path, kind: target.kind }),
      );
    } catch (error) {
      await rm(made, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    prompt = `/orca-flow:intake --here --path-file ${path.join(dir, "source.json")}`;
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
      `${error.message}\n新しいタブが立たなかったかもしれません。同じ場所に intake の新しいタブが立っていないかを先に確かめ、なければ同じタブで続けるには /orca-flow:intake --here ${hereArg} を流してください`,
    );
  }

  if (!ctx.json)
    ctx.stdout(
      `${kind === "workspace" ? "ワークスペースのフォルダ" : "メインのチェックアウト"} ${place} に新しいタブを立てて、intake の本体を渡しました。続きはそのタブで進めます`,
    );
  return {
    code: 0,
    data:
      localPath === undefined
        ? { kind, place, url }
        : { kind, place, path: localPath },
  };
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** 手元のパスを実の絶対パスに直し、あるか・形を確かめる。フォルダの中は数えない */
async function resolveLocal(
  ctx: { cwd: string; env: NodeJS.ProcessEnv },
  input: string,
): Promise<{ path: string; kind: "file" | "dir" }> {
  const home = ctx.env.HOME || ctx.env.USERPROFILE || os.homedir();
  const expanded =
    input === "~" || input.startsWith("~/") || input.startsWith("~\\")
      ? path.join(home, input.slice(1))
      : input;
  let real: string;
  let info;
  try {
    real = await realpath(path.resolve(ctx.cwd, expanded));
    info = await stat(real);
  } catch {
    throw new FlowError(
      1,
      `手元のパスが見つかりません：${input}。URL を渡したつもりなら、引用符や <> で囲まず、小文字の https:// で始めて打ち直してください。${USAGE}`,
    );
  }
  if (info.isDirectory()) return { path: real, kind: "dir" };
  const ext = path.extname(real).toLowerCase();
  if (info.isFile() && (ext === ".md" || ext === ".html"))
    return { path: real, kind: "file" };
  throw new FlowError(
    1,
    ext === ".zip"
      ? `.zip は渡せません。展開したフォルダを渡してください：${input}`
      : `渡せるのは .md か .html のファイルかフォルダです：${input}`,
  );
}
