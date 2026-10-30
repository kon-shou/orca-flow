import { realpathSync } from "node:fs";
import path from "node:path";

/** シンボリックリンクを解いた絶対パス（なければそのまま） */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export const samePath = (a: string, b: string) =>
  canonicalPath(a) === canonicalPath(b);
