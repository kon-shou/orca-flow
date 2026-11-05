import { parseArgs } from "../lib/args.ts";
import { resolvePstackFile } from "../lib/pstack.ts";
import { FlowError, type Command } from "../types.ts";

const USAGE = "使い方：orca-flow pstack 〈pstack の中の相対パス〉 [--json]";

/** pstack の入手元を確かめて、中のファイルの絶対パスを答える（8章）。設定も git も orca も使わない */
export const run: Command = async (ctx) => {
  const { positionals } = parseArgs(ctx.argv, []);
  if (positionals.length !== 1) throw new FlowError(1, USAGE);
  const found = await resolvePstackFile(ctx.runner, positionals[0]!);
  if (found.warning !== null) ctx.stderr(found.warning);
  if (!ctx.json) ctx.stdout(found.file);
  return {
    code: 0,
    data: {
      file: found.file,
      harness: found.harness,
      plugin: found.plugin,
      source: found.source,
      warning: found.warning,
    },
  };
};
