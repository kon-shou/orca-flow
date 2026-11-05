import { realpathSync } from "node:fs";
import { realRunner } from "../../src/lib/exec.ts";
import { FlowError } from "../../src/types.ts";
import { build } from "./build.ts";
import { check } from "./check.ts";
import { say, type Ctx, type Io } from "./common.ts";
import { prePush, setup } from "./hook.ts";
import { local } from "./local.ts";

const USAGE =
  "使い方：node scripts/public/main.ts 〈build|check|local|pre-push|setup〉";

export type Overrides = Partial<Ctx>;

async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

export const processIo: Io = {
  stdin: readStdin,
  stderr: (text) => void process.stderr.write(text),
};

export function defaultCtx(overrides: Overrides = {}): Ctx {
  return {
    runner: realRunner,
    cwd: process.cwd(),
    env: process.env,
    io: processIo,
    now: () => new Date(),
    mainFile: import.meta.filename,
    nodePath: process.execPath,
    ...overrides,
  };
}

/** 終了コードを返す。0＝成功、1＝確かめに落ちた・失敗、2＝人の作業が先に要る */
export async function run(
  argv: readonly string[],
  overrides: Overrides = {},
): Promise<number> {
  const ctx = defaultCtx(overrides);
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "build":
        return await build(ctx, rest);
      case "check":
        return await check(ctx, rest);
      case "local":
        return await local(ctx, rest);
      case "pre-push":
        return await prePush(ctx);
      case "setup":
        return await setup(ctx, rest);
      default:
        say(ctx, USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof FlowError) {
      say(ctx, error.message);
      return error.code;
    }
    say(ctx, `予期しないエラー：${(error as Error).message}`);
    return 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exitCode = await run(process.argv.slice(2));
}
