import { parseArgs } from "../lib/args.ts";
import { requireFlowConfig } from "../lib/flow-config.ts";
import { readCompanion } from "../lib/companion.ts";
import { commandFor } from "../lib/workspace.ts";
import {
  appReasons,
  buildCommand,
  inspectAllApps,
  isBaseAppRow,
  markMismatchReasons,
  type E2eApp,
} from "../lib/e2e.ts";
import {
  FLOW_PATTERN,
  baseReasons,
  inspectBases,
  runCapture,
  type BaseState,
} from "../lib/e2e-capture.ts";
import { clearE2eCaptures } from "../lib/preview-base.ts";
import { gitCommonDir } from "../lib/git.ts";
import { shellCommand } from "../lib/exec.ts";
import { requireActiveTask, requireRoot } from "../lib/git.ts";
import { redactSecrets } from "../lib/github.ts";
import { previewDeps } from "../lib/preview.ts";
import { requireIdShape } from "../lib/task-id.ts";
import { TAIL_LINES, VERIFY_TIMEOUT_MS } from "../lib/verified.ts";
import { FlowError, type Command, type CommandResult } from "../types.ts";

const USAGE =
  "使い方：orca-flow e2e 〈ID〉 [--wait [--base]] [--app 〈名前〉] [--capture 〈流れ〉] [--capture-clear] [--json] [-- 〈テストの指定〉…]";
const WAIT_INTERVAL_MS = 60_000;
const WAIT_LIMIT_MS = 24 * 60 * 60_000;

type Result = "passed" | "failed" | "not-run";

/** アプリごとのコマンドを1つ流した結果 */
interface AppRun {
  app: string;
  result: "passed" | "failed";
}

const tail = (text: string, lines: number) =>
  text.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");

/** 伴うアプリのブランチのプレビューに向けて、E2E のコマンドを流す */
export const run: Command = async (ctx) => {
  const dash = ctx.argv.indexOf("--");
  const head = dash < 0 ? ctx.argv : ctx.argv.slice(0, dash);
  const tests = dash < 0 ? [] : ctx.argv.slice(dash + 1);
  const { positionals, flags, values } = parseArgs(
    head,
    ["capture", "app"],
    ["wait", "base", "capture-clear"],
  );
  if (positionals.length !== 1) throw new FlowError(1, USAGE);
  const id = positionals[0]!;
  requireIdShape(id);
  const wait = flags.has("wait");
  const base = flags.has("base");
  const clear = flags.has("capture-clear");
  const flow = values.get("capture");
  const appName = values.get("app");
  if (base && !wait)
    throw new FlowError(1, `--base は --wait と一緒に使います。${USAGE}`);
  if (appName !== undefined && (wait || clear))
    throw new FlowError(
      1,
      `--app は --wait・--capture-clear と一緒に使えません。${USAGE}`,
    );
  if ([wait, clear, flow !== undefined].filter(Boolean).length > 1)
    throw new FlowError(
      1,
      `--wait・--capture・--capture-clear は同時に使えません。${USAGE}`,
    );
  if (flow !== undefined && !FLOW_PATTERN.test(flow))
    throw new FlowError(
      1,
      `--capture の流れの名前は、頭が英小文字か数字で、英小文字・数字・「-」の40文字までにしてください：${flow}`,
    );

  const root = await requireRoot(ctx.runner, ctx.cwd);
  const config = await requireFlowConfig(ctx.runner, root);
  const task = await requireActiveTask(ctx.runner, root, config, id);

  const finish = (
    code: 0 | 1 | 2,
    result: Result,
    apps: E2eApp[],
    reasons: string[],
    bases: BaseState[] | null = null,
    extra: Record<string, unknown> = {},
  ): CommandResult => ({
    code,
    data: {
      id,
      result,
      apps: bases
        ? apps.map((a) => {
            // 土台のアプリは前の画面でも後と同じ URL で埋める
            if (isBaseAppRow(a))
              return { ...a, baseUrl: a.url, baseAnswered: a.answered };
            const b = bases.find((x) => x.name === a.name);
            return {
              ...a,
              baseUrl: b?.url ?? null,
              baseAnswered: b?.answered ?? false,
            };
          })
        : apps,
      reasons,
      ...(bases ? { capture: record?.capture !== undefined } : {}),
      ...extra,
    },
  });
  let record: Awaited<ReturnType<typeof readCompanion>> = null;
  try {
    record = await readCompanion(ctx.runner, task.path, id);
  } catch (error) {
    // 印の名前が apps にないだけの記録は、壊れた記録でなく「流せない」として2で返す
    const marks = await markMismatchReasons(ctx.runner, task.path, id);
    if (marks.length === 0) throw error;
    for (const r of marks) ctx.stderr(r);
    return finish(2, "not-run", [], marks);
  }
  if (record === null) {
    const reason = `${id} の伴う記録がありません（親のタブで new --companion を付けて始めたタスクだけが流せます）`;
    ctx.stderr(reason);
    return finish(2, "not-run", [], [reason]);
  }
  if (
    appName !== undefined &&
    flow === undefined &&
    typeof record.command === "string"
  )
    throw new FlowError(
      1,
      `--app は、伴う記録の command がアプリごとのときか --capture と一緒に使います。${USAGE}`,
    );

  if (wait) {
    const started = previewDeps.clock();
    for (;;) {
      const apps = await inspectAllApps(ctx.runner, record, task.path);
      // 設定のない記録の --json は前の形のまま（キーを足さない）
      const bases =
        base || record.capture ? await inspectBases(ctx.runner, record) : null;
      const reasons = [
        ...appReasons(apps, id, task.branch),
        ...(base && bases ? baseReasons(bases, task.branch) : []),
      ];
      if (reasons.length === 0) {
        if (!ctx.json)
          ctx.stdout(
            base
              ? "伴うアプリと前の画面がそろいました。orca-flow e2e --capture で録れます"
              : "伴うアプリがそろいました。orca-flow e2e で流せます",
          );
        return finish(0, "not-run", apps, [], bases);
      }
      if (previewDeps.clock() - started >= WAIT_LIMIT_MS) {
        for (const r of reasons) ctx.stderr(r);
        ctx.stderr("24時間待ちましたがそろいませんでした");
        return finish(2, "not-run", apps, reasons, bases);
      }
      await previewDeps.sleep(WAIT_INTERVAL_MS);
    }
  }

  if (clear) {
    let cleared = 0;
    for (const app of record.apps)
      if (
        await clearE2eCaptures(
          ctx,
          await gitCommonDir(ctx.runner, app.path),
          id,
        )
      )
        cleared++;
    if (!ctx.json) ctx.stdout(`${id} の録画の置き場を${cleared}か所消しました`);
    return finish(0, "not-run", [], [], null, { cleared });
  }

  const apps = await inspectAllApps(ctx.runner, record, task.path);
  const reasons = appReasons(apps, id, task.branch);

  if (flow !== undefined) {
    const capture = record.capture;
    const notRunWith = (list: string[], bases: BaseState[] | null) => {
      for (const r of list) ctx.stderr(r);
      return finish(2, "not-run", apps, list, bases);
    };
    if (capture === undefined)
      return notRunWith(
        [
          `${id} の伴う記録に capture がありません。設定に companion.capture がないか、アプリごとの capture.command に \`--companion\` で渡したアプリの分が1つもないためです（録るなら、設定に書き、親のタブで new --companion を付けて始め直してください）`,
        ],
        null,
      );
    const bases = await inspectBases(ctx.runner, record);
    const all = [...reasons, ...baseReasons(bases, task.branch)];
    if (all.length > 0) return notRunWith(all, bases);
    const names = record.apps.map((a) => a.name);
    if (appName === undefined && names.length > 1)
      throw new FlowError(
        1,
        `--app で録画を置くアプリを選んでください：${names.join("・")}`,
      );
    const chosen = appName ?? names[0]!;
    if (!names.includes(chosen))
      throw new FlowError(
        1,
        `--app の ${chosen} は伴う記録のアプリにありません：${names.join("・")}`,
      );
    const captureCommand = commandFor(capture.command, chosen);
    if (captureCommand === undefined)
      throw new FlowError(
        1,
        `伴う記録の capture.command に ${chosen} の分がありません：${Object.keys(capture.command).join("・")}`,
      );
    const done = await runCapture(ctx, {
      id,
      flow,
      appName: chosen,
      record,
      capture: { command: captureCommand, output: capture.output },
      apps,
      bases,
      tests,
      taskPath: task.path,
    });
    if (done.code === 0 && !ctx.json)
      for (const file of done.placed) ctx.stdout(`録画を置きました：${file}`);
    return finish(
      done.code,
      done.code === 0 ? "passed" : "failed",
      apps,
      [],
      bases,
      { placed: done.placed },
    );
  }

  // アプリごとのコマンドは、そろうかを見る前に選び方の誤りを1で返す
  let targets: [string | null, string][];
  if (typeof record.command === "string") targets = [[null, record.command]];
  else {
    const commands = record.command;
    const keyed = record.apps
      .map((a) => a.name)
      .filter((name) => commandFor(commands, name) !== undefined);
    if (appName !== undefined && !keyed.includes(appName))
      throw new FlowError(
        1,
        `--app の ${appName} の分のコマンドが伴う記録にありません：${keyed.join("・")}`,
      );
    const chosen = appName !== undefined ? [appName] : keyed;
    if (tests.length > 0 && chosen.length > 1)
      throw new FlowError(
        1,
        `コマンドが2本以上あるので、テストの指定を足すアプリを --app で選んでください：${keyed.join("・")}`,
      );
    targets = chosen.map((name) => [name, commandFor(commands, name)!]);
  }

  const plainBases = record.capture
    ? await inspectBases(ctx.runner, record)
    : null;
  if (reasons.length > 0) {
    for (const r of reasons) ctx.stderr(r);
    return finish(2, "not-run", apps, reasons, plainBases);
  }

  // 並べて流すと道具の出力のフォルダがぶつかるので、1つずつ流し、落ちても残りを流す
  const runs: AppRun[] = [];
  for (const [name, text] of targets) {
    const label = name === null ? "" : `（${name}）`;
    // 文字列の記録の標準エラーは前と同じ「〈ID〉 の worktree で E2E が…」にする
    const errLabel = name === null ? " " : label;
    const command = buildCommand(text, apps, tests);
    if (!ctx.json) ctx.stdout(`E2E を流しています${label}：${command}`);
    const [cmd, args] = shellCommand(command);
    const result = await ctx.runner(cmd, args, {
      cwd: task.path,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    const ok = result.code === 0 && !result.timedOut;
    if (!ok) {
      const output = redactSecrets(
        tail(`${result.stdout}\n${result.stderr}`, TAIL_LINES),
      );
      ctx.stderr(
        `${id} の worktree で E2E${errLabel}が${result.timedOut ? "時間内に終わりませんでした" : "落ちました"}（最後の${TAIL_LINES}行）：\n${output}`,
      );
    }
    if (name !== null)
      runs.push({ app: name, result: ok ? "passed" : "failed" });
    else if (!ok) return finish(1, "failed", apps, [], plainBases);
  }
  const extra = typeof record.command === "string" ? {} : { runs };
  if (runs.some((r) => r.result === "failed"))
    return finish(1, "failed", apps, [], plainBases, extra);
  if (!ctx.json) ctx.stdout(`${id} の E2E が通りました`);
  return finish(0, "passed", apps, [], plainBases, extra);
};
