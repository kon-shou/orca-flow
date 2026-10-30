/** 設計書（9.1）から、機械で使う節を読み取る */

export interface Worker {
  /** 「担当A：名前」の見出しの文字 */
  name: string;
  /** 書き込む場所 */
  paths: string[];
}

/** バッククォートの中身が全角のかっこの書き添えで終わるもの（`src/a.ts（新規）` など） */
export interface BacktickNote {
  /** 見つけた場所（「書き込んでよい場所」か「担当「〈名前〉」」） */
  where: string;
  /** バッククォートの中身（前後の空白を除く） */
  content: string;
}

export interface TaskDoc {
  /** 「書き込んでよい場所」のパス */
  allowed: string[];
  /** 「担当の分け方」の担当 */
  workers: Worker[];
  /** 「main への事前変更」の箇条書き。「なし」なら空 */
  prechanges: string[];
  /** パスとして読めなかった行など。落とさずに人間に見せる */
  warnings: string[];
  /** バッククォートの中の全角の書き添え。overlap が直すところとして扱う */
  notes?: BacktickNote[];
}

const SECTION_ALLOWED = "書き込んでよい場所";
const SECTION_WORKERS = "担当の分け方";
const SECTION_PRECHANGES = "main への事前変更";

/** パスとして読める文字だけでできていて、「/」か「.」を含む */
const PATH_LIKE = /^[A-Za-z0-9._\-/@+~*]+$/;

/** 「./」とうしろの「/」を取り、比べられる形にする */
export function normalizePath(p: string): string {
  let out = p.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  out = out.replace(/\/{2,}/g, "/");
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return out;
}

/** 「## 見出し」ごとに本文の行を分ける。### はそのまま本文に残す */
function splitSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && !line.startsWith("###")) {
      current = [];
      sections.set(heading[1]!.trim(), current);
      continue;
    }
    current?.push(line);
  }
  return sections;
}

function findSection(
  sections: Map<string, string[]>,
  name: string,
): string[] | undefined {
  const exact = sections.get(name);
  if (exact) return exact;
  for (const [key, lines] of sections) if (key.startsWith(name)) return lines;
  return undefined;
}

/** 箇条書きの1項目の中身（「- 」「* 」「1. 」を取ったもの）。箇条書きでなければ null */
function bulletBody(line: string): string | null {
  const match = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
  return match ? match[1]!.trim() : null;
}

/** かっこの中（「（…）」「(…)」）を取り除く。除外の書き添えをパスとして拾わないため */
function stripParens(text: string): string {
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/（[^（）]*）/g, " ").replace(/\([^()]*\)/g, " ");
  } while (out !== prev);
  return out;
}

/** 「これ以外のファイルは読むだけにする」のような、場所の外を述べるだけの行 */
const isRestNote = (body: string) => /^(これ|それ)以外/.test(body);

/**
 * パスの一部になっている半角のかっこ（「(core)/」「(a).ts」「/(core)」で終わるもの、閉じていない「/(core」など）。
 * 古い書き方では読み切れない
 */
const PAREN_IN_PATH = /(?:^|\/)\(|\)[/.]/;

/** 古い書き方の先頭のパスの部分。半角のかっこの中の空白では切らない（「apps/(my group)/x」を1つに読む） */
const OLD_HEAD = /^(?:[^\s（(]|\([^()]*\)?)*/;

/**
 * バッククォートの中身を取り出す。かっこを消すのはバッククォートの外の書き添えだけにし、
 * 中身のかっこ（`apps/mobile/app/(core)/` など）は残す。
 * 外のかっこの中にあるバッククォート（`test/`（`test/init/` を除く）の `test/init/`）は拾わない。
 */
function backtickContents(body: string): string[] {
  const contents: string[] = [];
  const masked = body.replace(/`([^`]+)`/g, (_, inner: string) => {
    contents.push(inner);
    return `\u0000${contents.length - 1}\u0000`;
  });
  const out: string[] = [];
  for (const match of stripParens(masked).matchAll(/\u0000(\d+)\u0000/g))
    out.push(contents[Number(match[1])]!);
  return out;
}

/**
 * 中身（前後の空白を除く）が全角の「（…）」で終わる。入れ子（「（新規（仮））」）も当たるよう、末尾の「）」だけを見る。
 * 途中の全角のかっこ（`docs/（下書き）/a.md`）や半角の「(…)」は当たらない
 */
const ENDS_WITH_FULLWIDTH_NOTE = /）$/;

export const hasFullwidthNote = (content: string): boolean =>
  ENDS_WITH_FULLWIDTH_NOTE.test(content.trim());

/** 書き添えの警告の文 */
export const fullwidthNoteMessage = (where: string, content: string): string =>
  `${where}：\`${content}\` はバッククォートの中が全角のかっこの書き添えで終わっています。書き添えはバッククォートの外に書いてください（名前が全角のかっこで終わるディレクトリなら、うしろに「/」をつけてください）`;

/**
 * 1行からパスを取り出す。
 * - バッククォートがあれば、かっこの外のバッククォートの中身をパスとする（中身のかっこは残す）。
 *   中身が全角の書き添えで終わるものも、そのままパスとして読み、警告して notes に足す
 * - なければ古い書き方：先頭から空白か「（」の前まで（半角のかっこの中の空白では切らない）を「、」で区切り、
 *   「/」か「.」を含むものだけをパスとする。かっこがパスの一部になっている項目（PAREN_IN_PATH）は、
 *   途中で切ると範囲が広がるので取らずに警告にする
 */
export function extractPaths(
  body: string,
  warnings: string[],
  where: string,
  notes?: BacktickNote[],
): string[] {
  if (body.includes("`")) {
    const paths: string[] = [];
    for (const content of backtickContents(body)) {
      const candidate = normalizePath(content);
      if (candidate !== "") paths.push(candidate);
      if (hasFullwidthNote(content)) {
        const trimmed = content.trim();
        warnings.push(fullwidthNoteMessage(where, trimmed));
        notes?.push({ where, content: trimmed });
      }
    }
    if (paths.length === 0 && !isRestNote(body))
      warnings.push(`${where}：「${body}」からパスを読み取れませんでした`);
    return paths;
  }
  if (isRestNote(body)) return [];
  const head = OLD_HEAD.exec(body)?.[0] ?? "";
  const paths: string[] = [];
  const unreadable: string[] = [];
  const parenPaths: string[] = [];
  for (const piece of head.split(/[、，,]/)) {
    if (PAREN_IN_PATH.test(piece)) {
      parenPaths.push(piece.trim());
      continue;
    }
    // ここから先は今までどおり、最初の「(」の前までを読む
    const cut = piece.indexOf("(");
    const candidate = (cut >= 0 ? piece.slice(0, cut) : piece).trim();
    if (candidate !== "") {
      if (PATH_LIKE.test(candidate) && /[/.]/.test(candidate))
        paths.push(normalizePath(candidate));
      else unreadable.push(candidate);
    }
    if (cut >= 0) break;
  }
  for (const piece of parenPaths)
    warnings.push(
      `${where}：「${piece}」はかっこを含むパスのため、パスとして取りませんでした（バッククォートで囲んでください）`,
    );
  if (paths.length === 0 && parenPaths.length === 0)
    warnings.push(`${where}：「${body}」をパスとして読めませんでした`);
  else if (unreadable.length > 0)
    warnings.push(
      `${where}：「${unreadable.join("、")}」をパスとして読めませんでした（「/」か「.」を含めてバッククォートで囲んでください）`,
    );
  return paths;
}

const unique = (items: string[]) => [...new Set(items)];

function parseWorkers(
  lines: string[],
  warnings: string[],
  notes: BacktickNote[],
): Worker[] {
  const workers: Worker[] = [];
  let current: Worker | null = null;
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1]!.trim(), paths: [] };
      workers.push(current);
      continue;
    }
    if (!current) continue;
    const body = bulletBody(line);
    if (body === null) continue;
    const field = /^(書き込む場所|書いてよい場所|場所)\s*[：:]\s*(.*)$/.exec(
      body,
    );
    if (!field) continue;
    current.paths.push(
      ...extractPaths(field[2]!, warnings, `担当「${current.name}」`, notes),
    );
  }
  for (const worker of workers) worker.paths = unique(worker.paths);
  return workers;
}

function parsePrechanges(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const body = bulletBody(line) ?? line.trim();
    if (body === "" || body.startsWith("<!--")) continue;
    items.push(body);
  }
  const isNone = (item: string) =>
    /^(なし|無し|ない|特になし)[。.]?$/.test(item);
  if (items.length === 0 || items.every(isNone)) return [];
  return items;
}

export function parseTaskDoc(text: string): TaskDoc {
  const sections = splitSections(text);
  const warnings: string[] = [];
  const notes: BacktickNote[] = [];

  const allowedLines = findSection(sections, SECTION_ALLOWED);
  const allowed: string[] = [];
  if (!allowedLines) {
    warnings.push(`「${SECTION_ALLOWED}」の節がありません`);
  } else {
    for (const line of allowedLines) {
      const body = bulletBody(line);
      if (body === null) continue;
      allowed.push(...extractPaths(body, warnings, SECTION_ALLOWED, notes));
    }
  }

  const workerLines = findSection(sections, SECTION_WORKERS);
  const workers = workerLines ? parseWorkers(workerLines, warnings, notes) : [];

  const preLines = findSection(sections, SECTION_PRECHANGES);
  const prechanges = preLines ? parsePrechanges(preLines) : [];

  return { allowed: unique(allowed), workers, prechanges, warnings, notes };
}
