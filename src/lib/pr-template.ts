import type { Runner } from "./exec.ts";

/** 見つけた PR のテンプレート（baseBranch の木の版） */
export interface PrTemplate {
  /** リポジトリの根からのパス */
  path: string;
  content: string;
}

export type TemplateLookup =
  | { kind: "none" }
  | { kind: "one"; template: PrTemplate }
  | { kind: "many"; templates: PrTemplate[] };

/** 探す場所。この順で、最初に見つかった1つを使う（"" は根の直下） */
const PLACES = [".github", "", "docs"];

const FILE_RANK = [".md", ".txt", ""];

const lower = (s: string) => s.toLowerCase();

interface Entry {
  dir: string;
  name: string;
  path: string;
}

/** ref の木のファイル（ふつうのファイルだけ）を全部。シンボリックリンクは除く */
async function listBlobs(
  runner: Runner,
  cwd: string,
  ref: string,
): Promise<string[]> {
  const result = await runner("git", ["ls-tree", "-r", "-z", ref], { cwd });
  if (result.code !== 0) return [];
  const out: string[] = [];
  for (const record of result.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type] = record.slice(0, tab).split(" ");
    if (type !== "blob" || mode === "120000") continue;
    out.push(record.slice(tab + 1));
  }
  return out;
}

function splitPath(p: string): Entry {
  const slash = p.lastIndexOf("/");
  return {
    dir: slash < 0 ? "" : p.slice(0, slash),
    name: slash < 0 ? p : p.slice(slash + 1),
    path: p,
  };
}

/** ディレクトリを [親, 末尾の名前] に分ける */
function splitDir(dir: string): [string, string] {
  const slash = dir.lastIndexOf("/");
  return slash < 0 ? ["", dir] : [dir.slice(0, slash), dir.slice(slash + 1)];
}

/** `pull_request_template` + 拡張子（.md・.txt・なし）。大文字小文字を問わない */
function fileRank(name: string): number {
  const n = lower(name);
  const stem = "pull_request_template";
  if (!n.startsWith(stem)) return -1;
  return FILE_RANK.indexOf(n.slice(stem.length));
}

/**
 * ref（baseBranch）の木から PR のテンプレートを探す。作業ツリーは見ない。
 * 1) `.github/`・直下・`docs/` の順に pull_request_template 〈.md|.txt|なし〉 の最初の1つ
 * 2) なければ、同じ場所の PULL_REQUEST_TEMPLATE/ の下の .md を集める（1つなら one、2つ以上なら many）
 */
export async function findPrTemplate(
  runner: Runner,
  cwd: string,
  ref: string,
): Promise<TemplateLookup> {
  const entries = (await listBlobs(runner, cwd, ref)).map(splitPath);
  const placeIndex = (dir: string) =>
    PLACES.findIndex((p) => lower(p) === lower(dir));

  const single = entries
    .filter((e) => placeIndex(e.dir) >= 0 && fileRank(e.name) >= 0)
    .sort(
      (a, b) =>
        placeIndex(a.dir) - placeIndex(b.dir) ||
        fileRank(a.name) - fileRank(b.name) ||
        (a.path < b.path ? -1 : 1),
    )[0];
  if (single) {
    const content = await readBlob(runner, cwd, ref, single.path);
    if (content !== null)
      return { kind: "one", template: { path: single.path, content } };
  }

  const multi = entries
    .filter((e) => {
      if (!lower(e.name).endsWith(".md")) return false;
      const [parent, leaf] = splitDir(e.dir);
      return lower(leaf) === "pull_request_template" && placeIndex(parent) >= 0;
    })
    .sort(
      (a, b) =>
        placeIndex(splitDir(a.dir)[0]) - placeIndex(splitDir(b.dir)[0]) ||
        (a.path < b.path ? -1 : 1),
    );
  const templates: PrTemplate[] = [];
  for (const e of multi) {
    const content = await readBlob(runner, cwd, ref, e.path);
    if (content !== null) templates.push({ path: e.path, content });
  }
  if (templates.length === 1) return { kind: "one", template: templates[0]! };
  if (templates.length >= 2) return { kind: "many", templates };
  return { kind: "none" };
}

async function readBlob(
  runner: Runner,
  cwd: string,
  ref: string,
  file: string,
): Promise<string | null> {
  const result = await runner("git", ["show", `${ref}:${file}`], { cwd });
  return result.code === 0 ? result.stdout : null;
}

/**
 * Markdown の見出しの文を、出てくる順に返す。
 * `<!-- -->` の中とコードの囲み（``` と ~~~）の中の行は数えない
 */
export function headingsOf(text: string): string[] {
  const noComments = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of noComments.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const mark = f[1]!;
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h && h[1]) out.push(h[1].replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * 本文に欠けているテンプレートの見出し。候補が複数なら、欠けが最も少ない候補のもの
 * （どれか1つの見出しを全部含めば空）。テンプレートがなければ空
 */
export function missingHeadings(
  body: string,
  templates: readonly PrTemplate[],
): { path: string; missing: string[] } | null {
  const have = new Set(headingsOf(body));
  let best: { path: string; missing: string[] } | null = null;
  for (const t of templates) {
    const missing = headingsOf(t.content).filter((h) => !have.has(h));
    if (best === null || missing.length < best.missing.length)
      best = { path: t.path, missing };
  }
  return best !== null && best.missing.length > 0 ? best : null;
}

export function templatesOf(lookup: TemplateLookup): PrTemplate[] {
  if (lookup.kind === "one") return [lookup.template];
  if (lookup.kind === "many") return lookup.templates;
  return [];
}
