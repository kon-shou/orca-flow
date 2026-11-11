import { FlowError } from "../../src/types.ts";
import { git, gitOrThrow, type Ctx } from "./common.ts";

// 形の文字は、このファイルと README が自分の確かめに当たらないよう、つないで作る
const BS = "\\\\";
const NAME_CHAR = "[A-Za-z0-9._-]";

interface Shape {
  kind: string;
  /** テストのファイルの中でも見るか（メールだけ） */
  inTests: boolean;
  /** 1行の中の当たりの数 */
  count: (line: string, publicEmails: ReadonlySet<string>) => number;
}

const regexShape = (kind: string, pattern: RegExp): Shape => ({
  kind,
  inTests: false,
  count: (line) => (pattern.test(line) ? 1 : 0),
});

const TOKEN = new RegExp(
  `(?<![A-Za-z0-9_-])(?:(?:${["gh" + "p_", "github" + "_pat_", "s" + "k-", "xo" + "x[bap]-"].join("|")})[A-Za-z0-9_-]{20,}|${"AK" + "IA"}[0-9A-Z]{16}(?![A-Za-z0-9]))`,
);
const PRIVATE_KEY = new RegExp(
  `-{5}${"BEG" + "IN"} [A-Z ]*${"PRIV" + "ATE"} KEY-{5}`,
);
const WINDOWS = new RegExp(
  `(?:[A-Za-z]:${BS}+${"Us" + "ers"}${BS}+|${BS}${BS}+${"ws" + "l"}(?:\\.localhost|\\$)${BS}+[^\\\\\\s]+${BS}+home${BS}+|(?<![A-Za-z0-9_.-])\\/${"mn" + "t"}\\/[A-Za-z]\\/)${NAME_CHAR}`,
  "i",
);
const HEX32 = new RegExp(
  `(?<![A-Za-z0-9])[0-9a-fA-F]{${16 * 2}}(?![A-Za-z0-9])`,
);

const AT = "@";
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const USERINFO = /[^\s/?#@]*@/y;
const EMAIL_LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/y;
/** ユーザー名は空でもよい（redis の形など）。パスワードが置き場（〈…〉・${…}・<…>）で始まるものは作り物として当てない */
const PASSWORD_INFO = /^[^:]*:(?!〈|\$\{|<).+$/;

/**
 * 行の中の URL の認証情報（〈scheme〉:// から @ まで）。終わりの @ の位置と、パスワードがあるか。
 * 正規表現で行の頭から探すと、長い英数字の行で遅くなる（後戻りが行の長さの2乗になる）ので、:// と @ から広げる
 */
function userinfos(line: string): Array<{ at: number; password: boolean }> {
  const found: Array<{ at: number; password: boolean }> = [];
  for (
    let sep = line.indexOf("://");
    sep >= 0;
    sep = line.indexOf("://", sep + 1)
  ) {
    let head = sep;
    while (head > 0 && SCHEME_CHAR.test(line[head - 1] ?? "")) head -= 1;
    if (!/[A-Za-z]/.test(line.slice(head, sep))) continue;
    USERINFO.lastIndex = sep + 3;
    const m = USERINFO.exec(line);
    if (!m) continue;
    const info = m[0].slice(0, -1);
    found.push({
      at: sep + 3 + info.length,
      password: PASSWORD_INFO.test(info),
    });
  }
  return found;
}

function countPasswords(line: string): number {
  return userinfos(line).filter((u) => u.password).length;
}

/** 作り物のメールのドメイン */
function fictionalDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  const reserved = ["example.com", "example.net", "example.org"];
  if (reserved.some((r) => d === r || d.endsWith(`.${r}`))) return true;
  return [".example", ".invalid", ".test", ".localhost"].some((tld) =>
    d.endsWith(tld),
  );
}

function countEmails(line: string, publicEmails: ReadonlySet<string>): number {
  if (!line.includes(AT)) return 0;
  const inUrl = new Set(userinfos(line).map((u) => u.at));
  let hits = 0;
  for (let at = line.indexOf(AT); at >= 0; at = line.indexOf(AT, at + 1)) {
    if (inUrl.has(at)) continue;
    let head = at;
    while (head > 0 && EMAIL_LOCAL_CHAR.test(line[head - 1] ?? "")) head -= 1;
    if (head === at) continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    const domain = EMAIL_DOMAIN.exec(line)?.[0];
    if (domain === undefined) continue;
    const local = line.slice(head, at);
    if (local === "git" || fictionalDomain(domain)) continue;
    if (publicEmails.has(`${local}${AT}${domain}`.toLowerCase())) continue;
    hits += 1;
  }
  return hits;
}

const SHAPES: readonly Shape[] = [
  regexShape("トークンの形", TOKEN),
  regexShape("秘密鍵の頭の行", PRIVATE_KEY),
  { kind: "パスワードつきの接続文字列", inTests: false, count: countPasswords },
  { kind: "メールアドレス", inTests: true, count: countEmails },
  regexShape("Windows のパス", WINDOWS),
  regexShape("32桁の16進", HEX32),
];

/** git grep（拡張正規表現・大文字小文字の区別なし）で候補のファイルを絞る形。本判定より広く拾う */
const CANDIDATES = [
  `(${"gh" + "p_"}|${"github" + "_pat_"}|${"s" + "k-"}|${"xo" + "x"}[a-z]-)[A-Za-z0-9_-]{20}`,
  `${"AK" + "IA"}[0-9A-Z]{16}`,
  `${"PRIV" + "ATE"} KEY-----`,
  `://[^[:space:]]*${AT}`,
  `${AT}[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}`,
  `:${BS}+${"Us" + "ers"}${BS}`,
  `${BS}${BS}${"ws" + "l"}`,
  `/${"mn" + "t"}/[A-Za-z]/`,
  `[0-9a-fA-F]{${16 * 2}}`,
];

const SECRET_FILE = /^(?:\.env.*|.*\.pem|.*\.key|id_rsa.*)$/;

/**
 * テストのファイル：どの階層でも test/・tests/・__tests__/・__snapshots__/ の下と、
 * 名前が *.test.*・*.spec.*・*_test.*・test_*.py のもの。秘密を置くファイルは、テストの場所でもテストにしない
 */
export function isTestFile(file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (SECRET_FILE.test(name)) return false;
  if (/(?:^|\/)(?:test|tests|__tests__|__snapshots__)\//.test(file))
    return true;
  return /^.+\.(?:test|spec)\..+$|^.+_test\..+$|^test_.+\.py$/.test(name);
}

/** 1行の当たりの種類と数（値は返さない） */
export function findShapes(
  line: string,
  file: string,
  publicEmails: ReadonlySet<string> = new Set(),
): Array<{ kind: string; count: number }> {
  const test = isTestFile(file);
  const hits: Array<{ kind: string; count: number }> = [];
  for (const shape of SHAPES) {
    if (test && !shape.inTests) continue;
    const count = shape.count(line, publicEmails);
    if (count > 0) hits.push({ kind: shape.kind, count });
  }
  return hits;
}

/**
 * 木の中身にある秘密・メール・Windows のパス・32桁の16進の当たり。「パス：行：種類」を返し、値は出さない。
 * パスに語の一覧の語か手元のパスを含むファイルは、パスを出すと見えるので、種類ごとの件数だけにする
 */
export async function shapeTreeProblems(
  ctx: Ctx,
  tree: string,
  options: {
    words: readonly string[];
    publicEmails: readonly string[];
    hidePath?: (file: string) => boolean;
  },
): Promise<string[]> {
  const lowered = options.words.map((word) => word.toLowerCase());
  const hasWord = (file: string) => {
    const haystack = file.toLowerCase();
    return lowered.some((word) => haystack.includes(word));
  };
  const publicEmails = new Set(
    options.publicEmails.map((email) => email.toLowerCase()),
  );

  const out = await git(
    ctx,
    [
      "grep",
      "--no-color",
      "-a",
      "-l",
      "-z",
      "-i",
      "-E",
      ...CANDIDATES.flatMap((pattern) => ["-e", pattern]),
      tree,
      "--",
      ".",
    ],
    { env: { LC_ALL: "C" } },
  );
  if (out.code !== 0 && out.code !== 1) {
    const detail = out.stderr.trim();
    throw new FlowError(
      1,
      `中身の照合に失敗しました${detail ? `：${detail}` : ""}`,
    );
  }
  if (out.code === 1) return [];

  const problems: string[] = [];
  const hiddenByWord = new Map<string, number>();
  const hiddenByLocal = new Map<string, number>();
  const add = (map: Map<string, number>, kind: string, n: number) =>
    map.set(kind, (map.get(kind) ?? 0) + n);
  // grep の出力のパスは区切り目で壊れうるので、ファイルは ls-tree の sha で読み、パスは表示と件数にだけ使う
  const listing = await gitOrThrow(
    ctx,
    ["ls-tree", "-r", "-z", "--full-tree", tree],
    "ファイルの一覧の取得",
  );
  const blobs = new Map<string, string>();
  for (const record of listing.split("\0")) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (!m) continue;
    const [, mode = "", sha = "", file = ""] = m;
    if (mode !== "120000" && mode !== "160000") blobs.set(file, sha);
  }
  const files = out.stdout
    .split("\0")
    .filter((r) => r !== "")
    .map((r) => r.slice(tree.length + 1));
  if (files.length === 0)
    throw new FlowError(1, "中身の照合の結果を読み取れませんでした");
  for (const file of files) {
    const sha = blobs.get(file);
    if (sha === undefined)
      throw new FlowError(1, "中身の照合の結果とファイルの一覧が合いません");
    const text = await gitOrThrow(
      ctx,
      ["cat-file", "blob", sha],
      "ファイルの読み取り",
    );
    if (text.includes("\0")) continue;
    for (const [index, line] of text.split("\n").entries()) {
      for (const { kind, count } of findShapes(line, file, publicEmails)) {
        if (hasWord(file)) add(hiddenByWord, kind, count);
        else if (options.hidePath?.(file)) add(hiddenByLocal, kind, count);
        else problems.push(`${file}：${index + 1}：${kind}`);
      }
    }
  }
  // ASCII で始まる種類の前は、ほかのメッセージ（「に ID の形」）と同じく空ける
  const of = (kind: string) => (/^[A-Za-z]/.test(kind) ? ` ${kind}` : kind);
  for (const [kind, n] of hiddenByWord)
    problems.push(`パスに語を含むファイルに${of(kind)}（${n} 件）`);
  for (const [kind, n] of hiddenByLocal)
    problems.push(`パスに手元のパスを含むファイルに${of(kind)}（${n} 件）`);
  return problems;
}
