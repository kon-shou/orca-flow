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

/** Windows の形（区切りが \ か /、ドライブ文字と大文字小文字の違い）をそろえた比べる用の文字列 */
function windowsKey(p: string): string {
  let key = path.win32.normalize(p).replaceAll("\\", "/").toLowerCase();
  if (key.length > 3 && key.endsWith("/")) key = key.slice(0, -1);
  return key;
}

/**
 * 同じ場所を指すパスか。platform が win32 のときは、区切りと大文字小文字の違いを無視する
 * （git の出す `C:/a/b` と Node の出す `c:\a\b` を同じと見なす）。
 * platform は、テストから別の OS の形を確かめるためのもので、省略すると今の OS。
 */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    const keyOf = (p: string) => {
      try {
        return windowsKey(realpathSync(p));
      } catch {
        return windowsKey(p);
      }
    };
    return keyOf(a) === keyOf(b);
  }
  return canonicalPath(a) === canonicalPath(b);
}
