import { FlowError } from "../types.ts";

export interface ParsedArgs {
  positionals: string[];
  /** 値つきのフラグ（--title 名前） */
  values: Map<string, string>;
  /** 値なしのフラグ（--yes） */
  flags: Set<string>;
}

/**
 * 引数を分ける。valueFlags に挙げたものは次の引数を値とする（--name=値 も読む）。
 * booleanFlags に挙げたもの以外の「--」で始まる引数は FlowError(1)
 */
export function parseArgs(
  argv: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (valueFlags.includes(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined)
        throw new FlowError(1, `--${name} に値を書いてください`);
      values.set(name, value);
    } else if (booleanFlags.includes(name) && eq < 0) {
      flags.add(name);
    } else {
      throw new FlowError(1, `知らない引数です：${arg}`);
    }
  }
  return { positionals, values, flags };
}
