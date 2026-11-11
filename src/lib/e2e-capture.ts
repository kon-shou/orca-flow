import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { FlowError, type CommandContext } from "../types.ts";
import type { Companion } from "./companion.ts";
import {
  buildCommand,
  isBaseAppRow,
  previewTarget,
  type E2eApp,
} from "./e2e.ts";
import { shellCommand } from "./exec.ts";
import { gitCommonDir } from "./git.ts";
import { redactSecrets } from "./github.ts";
import { previewDeps } from "./preview.ts";
import { e2eCapturesDir, previewBaseStatus } from "./preview-base.ts";
import { TAIL_LINES, VERIFY_TIMEOUT_MS } from "./verified.ts";

// e2e --capture：E2E の道具の録画で、前の画面と後の画面の動きを1本ずつ録る部品。
// E2E の出力は標準出力・カード・記録に写さない（落ちたときの伏せた末尾だけ）

/** 置く録画1つの上限（バイト）。PR の本文に付けられる動画の上限に合わせる */
export const MAX_CAPTURE_BYTES = 10_000_000;

/** 流れの名前：頭は英小文字か数字、あとは英小文字・数字・「-」で40文字まで */
export const FLOW_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const EXTENSIONS = [".webm", ".mp4", ".gif"];

/** アプリ1つ分の前の画面の状態 */
export interface BaseState {
  name: string;
  url: string | null;
  answered: boolean;
  /** 答えないときの理由 */
  reason: string | null;
}

/** 伴う記録の各アプリの前の画面を、そのアプリのリポジトリの記録から見る */
export async function inspectBases(
  runner: CommandContext["runner"],
  record: Companion,
): Promise<BaseState[]> {
  const out: BaseState[] = [];
  for (const app of record.apps) {
    const common = await gitCommonDir(runner, app.path);
    const status = await previewBaseStatus(common, record.id);
    out.push(
      status.answers
        ? { name: app.name, url: status.url, answered: true, reason: null }
        : {
            name: app.name,
            url: status.record?.url ?? null,
            answered: false,
            reason: status.reason,
          },
    );
  }
  return out;
}

/** 前の画面が答えないアプリごとの理由と次の手。branch は E2E のタスクの手元のブランチ */
export function baseReasons(
  bases: readonly BaseState[],
  branch: string | null,
): string[] {
  const target = previewTarget(branch);
  return bases
    .filter((b) => !b.answered)
    .map(
      (b) =>
        `${b.name}：${b.reason}（親のタブで orca-flow workspace --preview ${target} --base を流してください）`,
    );
}

/** 時刻 since 以降に書かれた webm・mp4・gif を、root/output の下から探す（シンボリックリンクは辿らない） */
export async function findCaptures(
  root: string,
  output: string,
  since: number,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (
        entry.isFile() &&
        EXTENSIONS.includes(path.extname(entry.name).toLowerCase()) &&
        (await stat(full)).mtimeMs >= since
      )
        found.push(full);
    }
  };
  await walk(path.join(root, output));
  return found.sort();
}

interface Taken {
  extension: string;
  data: Buffer;
}

/** ちょうど1つの録画を読む。0・2つ以上・大きすぎるときは FlowError(1) */
async function takeOne(
  label: string,
  files: readonly string[],
  output: string,
): Promise<Taken> {
  if (files.length !== 1)
    throw new FlowError(
      1,
      `${label}の録画が${files.length}個見つかりました（${output} の下で、ちょうど1つにしてください）。テストの指定を1本に絞って流し直してください`,
    );
  const file = files[0]!;
  const size = (await stat(file)).size;
  if (size > MAX_CAPTURE_BYTES)
    throw new FlowError(
      1,
      `${label}の録画が大きすぎます（${size} バイト。上限は ${MAX_CAPTURE_BYTES} バイト）。短い流れに絞ってください`,
    );
  return {
    extension: path.extname(file).toLowerCase(),
    data: await readFile(file),
  };
}

export interface CaptureInput {
  id: string;
  flow: string;
  /** 録画を置くアプリの名前 */
  appName: string;
  record: Companion;
  /** 流す録画のコマンド（アプリごとのときは選んだアプリの分）と書き出し先 */
  capture: { command: string; output: string };
  /** 後の画面（今の e2e と同じ URL）で見たアプリ。土台のアプリの行を含む */
  apps: E2eApp[];
  bases: BaseState[];
  tests: string[];
  /** E2E のタスクの worktree */
  taskPath: string;
}

export interface CaptureResult {
  code: 0 | 1;
  /** 置いた録画のパス（前・後の順） */
  placed: string[];
}

const tail = (text: string) =>
  text.replace(/\s+$/, "").split(/\r?\n/).slice(-TAIL_LINES).join("\n");

async function runCommand(
  ctx: CommandContext,
  command: string,
  cwd: string,
): Promise<{ ok: boolean; timedOut: boolean; tailText: string }> {
  const [cmd, args] = shellCommand(command);
  const result = await ctx.runner(cmd, args, {
    cwd,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  return {
    ok: result.code === 0 && !result.timedOut,
    timedOut: Boolean(result.timedOut),
    tailText: redactSecrets(tail(`${result.stdout}\n${result.stderr}`)),
  };
}

/**
 * 前の画面、次に後の画面へ同じテストを流して録る。
 * 前は落ちても録画が1つあればよい。後が落ちたら、どちらも置かず 1。録画の数・大きさが外れても 1
 */
export async function runCapture(
  ctx: CommandContext,
  input: CaptureInput,
): Promise<CaptureResult> {
  const { id, flow, record, capture } = input;
  const output = capture.output;
  // 土台のアプリには前の画面がないので、後と同じ URL で埋める
  const withUrls = (urls: Map<string, string>): E2eApp[] =>
    input.apps.map((a) =>
      isBaseAppRow(a) ? a : { ...a, url: urls.get(a.name) ?? a.url },
    );
  const beforeApps = withUrls(
    new Map(input.bases.map((b) => [b.name, b.url ?? ""])),
  );

  const run = async (label: string, apps: E2eApp[]) => {
    const command = buildCommand(capture.command, apps, input.tests);
    if (!ctx.json) ctx.stdout(`${label}の画面で録っています：${command}`);
    const since = previewDeps.clock();
    const result = await runCommand(ctx, command, input.taskPath);
    return { since, result };
  };

  const before = await run("前", beforeApps);
  if (!before.result.ok && !ctx.json)
    ctx.stdout("前の画面では落ちました（録画があれば続けます）");
  const beforeFiles = await findCaptures(input.taskPath, output, before.since);
  if (!before.result.ok && beforeFiles.length !== 1)
    ctx.stderr(
      `${id} の worktree で前の画面の E2E が${before.result.timedOut ? "時間内に終わりませんでした" : "落ちました"}（最後の${TAIL_LINES}行）：\n${before.result.tailText}`,
    );
  const beforeTaken = await takeOne("前の画面", beforeFiles, output);

  const after = await run("後", input.apps);
  if (!after.result.ok) {
    ctx.stderr(
      `${id} の worktree で後の画面の E2E が${after.result.timedOut ? "時間内に終わりませんでした" : "落ちました"}（最後の${TAIL_LINES}行）：\n${after.result.tailText}\n録画は置きません`,
    );
    return { code: 1, placed: [] };
  }
  const afterTaken = await takeOne(
    "後の画面",
    await findCaptures(input.taskPath, output, after.since),
    output,
  );

  const app = record.apps.find((a) => a.name === input.appName)!;
  const dir = e2eCapturesDir(await gitCommonDir(ctx.runner, app.path), id);
  await mkdir(dir, { recursive: true });
  for (const side of ["before", "after"])
    for (const ext of EXTENSIONS)
      await rm(path.join(dir, `${flow}-${side}${ext}`), { force: true });
  const placed: string[] = [];
  for (const [side, taken] of [
    ["before", beforeTaken],
    ["after", afterTaken],
  ] as const) {
    const target = path.join(dir, `${flow}-${side}${taken.extension}`);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, taken.data);
    await rename(tmp, target);
    placed.push(target);
  }
  return { code: 0, placed };
}
