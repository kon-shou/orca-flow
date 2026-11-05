// 秘密らしい値を伏せる、共通の部品。Node の標準以外を読み込まない（test/common/common.test.ts が確かめる）。
// 伏せる印は呼ぶ側が渡す。中身を変えたら manifest.json の版と要約値を直す。

export interface RedactMarks {
  /** GitHub のトークンの形の値を置き換える印 */
  token: string;
  /** そのほかの秘密を置き換える印 */
  hidden: string;
}

/** 文字を割るのに使われる幅のない字（書式文字 Cf 全部・ゼロ幅・ソフトハイフン・BOM・双方向制御・タグ文字・結合用の字・異体字選択子・見えない埋め字） */
const INVISIBLE =
  /^[\p{Cf}\u034F\u115F\u1160\u180B-\u180E\u3164\uFE00-\uFE0F\uFFA0]$/u;

/**
 * regex を当て、見つけた範囲（元の文字列の上の範囲）を replacer の返す文字列に替える。replacer が undefined を返したら元の範囲のまま残す。
 * ignoreInvisible のときは幅のない字を無いものとして当てる（割った秘密も見つけ、割っていない部分の文章は変えない）
 */
function replaceRange(
  text: string,
  re: RegExp,
  replacer: (match: RegExpExecArray) => string | undefined,
  ignoreInvisible: boolean,
): string {
  let plain = "";
  const origin: number[] = [];
  let i = 0;
  for (const ch of text) {
    if (ignoreInvisible && INVISIBLE.test(ch)) {
      i += ch.length;
      continue;
    }
    plain += ch;
    for (let k = 0; k < ch.length; k++) origin.push(i + k);
    i += ch.length;
  }
  let out = "";
  let copied = 0;
  for (const m of plain.matchAll(re)) {
    if (m[0] === "") continue;
    const start = origin[m.index]!;
    const end = origin[m.index + m[0].length - 1]! + 1;
    const to = replacer(m as RegExpExecArray);
    if (to === undefined) continue;
    out += text.slice(copied, start) + to;
    copied = end;
  }
  return out + text.slice(copied);
}

/**
 * 元の文字列に当ててから、幅のない字を除いた文字列にも当てる。
 * 除いた文字列だけに当てると、字の境目（\b）や空白（U+FEFF は \s に入る）の見え方が変わって、前は伏せていた形が残るため
 */
function replaceIgnoringInvisible(
  text: string,
  re: RegExp,
  replacer: (match: RegExpExecArray) => string | undefined,
): string {
  return replaceRange(
    replaceRange(text, re, replacer, false),
    re,
    replacer,
    true,
  );
}

/** 名前の区切りの単位（小文字にした語）。単位がこの語と一致するか、この語で終わるとき秘密の名前とみなす */
const KEY_UNITS = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "credentials",
  "apikey",
  "accesskey",
  "privatekey",
]);

/** 名前（`AWS_SECRET_ACCESS_KEY`・`clientSecret`・`db.password`）が秘密の名前か。`tokens`・`tokenizer`・`secretary` は当たらない */
function isSecretName(name: string): boolean {
  const units = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_.-]+/)
    .map((u) => u.toLowerCase());
  return units.some(
    (u, i) =>
      KEY_UNITS.has(u) ||
      // PGPASSWORD・clientsecret のように、区切りなしで秘密の語で終わる単位。始まるだけの tokenizer・secretary は当てない
      [...KEY_UNITS].some((w) => u.endsWith(w)) ||
      (["api", "access", "private"].includes(u) && units[i + 1] === "key"),
  );
}

/** 母音の割合が低い（英単語らしくない）小文字の列か */
const lowVowelRatio = (value: string) =>
  (value.match(/[aeiou]/gi)?.length ?? 0) / value.length < 0.3;

/** Basic の値が base64 として読めて、中身に : があるか（user:pass） */
function isBasicPair(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("latin1").includes(":");
}

/** 認証の見出しの値が秘密らしいか（散文の「token validation」などを伏せないため） */
function looksLikeCredential(head: string, value: string): boolean {
  // Bearer のあとは、散文で出ることが少ないので、8字以上を全部伏せる
  if (/^bearer$/i.test(head)) return true;
  if (/[0-9+/=_~]/.test(value) || value.length >= 16) return true;
  // 2字目以降に大文字がある（camelCase・大文字と小文字が混ざる）
  if (/[a-z][A-Z]|[A-Z]{2}/.test(value)) return true;
  if (/^basic$/i.test(head) && isBasicPair(value)) return true;
  return lowVowelRatio(value);
}

/** 引用符のない設定の値が秘密らしいか。コードの識別子・a.b.c の形・変数の参照・省略は外す */
function looksLikeSecretValue(value: string): boolean {
  if (/^eyJ/.test(value)) return true;
  // 省略は、最初の , ( ) ` より前の部分にあるときだけ（値のあとの「,…」では伏せる）
  if (/[…]|^\.{3}/.test(value.split(/[,()`]/, 1)[0]!)) return false;
  if (/^[A-Za-z_$][A-Za-z_$]*$/.test(value)) return false;
  // a.b.c・x[0] の形。区切りの名前に数字を含むもの（Tr0ub4dor.and3）は識別子と見ない
  if (
    /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*|\[[^\]]*\])+$/.test(value)
  )
    return false;
  if (/^\$\{?[A-Za-z_]\w*\}?$/.test(value)) return false;
  if (/^[{<]/.test(value)) return false;
  // GitHub Actions の式・型の形（Record<string, string>）。型の名前に数字を含むもの（aB3dE5<fG7）と、< の直後が英字・_・$・{・[・( でも値の終わりでもないもの（Ab<12345）は型と見ない。値は < で切れることがある（prettier が折った Promise<）
  if (
    /^\$\{\{/.test(value) ||
    /^[A-Za-z_$][A-Za-z_$.]*<(?:[A-Za-z_${[(]|$)/.test(value)
  )
    return false;
  return true;
}

/**
 * 名前つきの値（`=` の形・YAML の形）を伏せるとき、値のあとに残す記号（`)`・`,` など）を返す。伏せない値なら undefined。
 * 引用符つきは中身が空・伏せ済みでなければ伏せる。引用符なしは、呼び出し・識別子・変数の参照などを外す
 */
function maskedTail(raw: string, marks: RedactMarks): string | undefined {
  const { token, hidden } = marks;
  let value = raw;
  const quoted = /^["']/.test(value);
  let tail = "";
  if (!quoted) {
    // 呼び出し（数字を含まない名前＋`(`）で始まる値は外す。数字を含む名前（Xy7(）は秘密と区別できないので伏せる
    if (/^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*)*\(/.test(value))
      return undefined;
    // 値の終わりの ) , ` . は、まわりの文の記号として値に入れない（終わりから1字ずつ見る）
    let n = value.length;
    while (n > 0 && ")`,.".includes(value[n - 1]!)) n--;
    tail = value.slice(n);
    value = value.slice(0, n);
  }
  const inner = quoted ? value.slice(1, -1) : value;
  if (inner === "" || inner.startsWith(hidden) || inner.startsWith(token))
    return undefined;
  if (!quoted && !looksLikeSecretValue(value)) return undefined;
  return tail;
}

/** 秘密らしい値を伏せる。エラー文・記録に出す前に必ず通す。extra は環境変数などで分かっている秘密（8字以上のものだけ） */
export function redact(
  text: string,
  marks: RedactMarks,
  extra: readonly (string | undefined)[] = [],
): string {
  const { token, hidden } = marks;
  let out = text;
  // 秘密鍵の塊（終わりの行がなければ最後まで）
  out = replaceIgnoringInvisible(
    out,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    () => hidden,
  );
  out = replaceIgnoringInvisible(
    out,
    /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
    () => token,
  );
  out = replaceIgnoringInvisible(
    out,
    /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
    () => token,
  );
  // 認証の見出しと値
  out = replaceIgnoringInvisible(
    out,
    /\b(Bearer|token|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    (m) =>
      looksLikeCredential(m[1]!, m[2]!) ? `${m[1]} ${hidden}` : undefined,
  );
  // 資格情報つきの URL。パスワードに @ を含んでも、ユーザー名がなくても伏せる（scheme の長さに上限をつけて、長い入力で遅くならないようにする）
  out = replaceIgnoringInvisible(
    out,
    /([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)([^\s/]+)@/g,
    (m) =>
      /https?:\/\/$/i.test(m[1]!) || m[2]!.includes(":")
        ? `${m[1]}${hidden}@`
        : undefined,
  );
  // GitHub の環境変数は値を丸ごと伏せる
  out = replaceIgnoringInvisible(
    out,
    /\b((?:GH|GITHUB)_[A-Z_]*TOKEN)=(\S+)/g,
    (m) =>
      m[2]!.startsWith(hidden) ||
      m[2]!.startsWith(token) ||
      m[2]!.startsWith("${{")
        ? undefined
        : `${m[1]}=${hidden}`,
  );
  // 名前に秘密らしい語を含む設定の値（password=…・AWS_SECRET_ACCESS_KEY=…・"token": "…"）。
  // 名前は区切りの直後から1つの塊で取り（長さに上限）、秘密の名前かは置き換えの中で調べる
  out = replaceIgnoringInvisible(
    out,
    /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,80})(["']?)(\s*=(?![=>])\s*|\s*:\s*(?=["']))("[^"]*"|'[^']*'|[^\s"',;&`()](?:[^\s"',;&]|,(?![A-Za-z0-9_.-]{1,80}["']?\s*[=:]))*)/g,
    (m) => {
      if (!isSecretName(m[1]!)) return undefined;
      const tail = maskedTail(m[4]!, marks);
      return tail === undefined
        ? undefined
        : `${m[1]}${m[2]}${m[3]}${hidden}${tail}`;
    },
  );
  // YAML の引用符のない値（行の頭の `password: hunter2`・`- token: abc123xyz`）。コロンのあとに空白が要る。
  // 文の途中の「説明 token: 期限切れ」は読めなくなるので当てない（行の頭から。字下げと名前に長さの上限）
  out = replaceIgnoringInvisible(
    out,
    /^([+-]?[ \t]{0,100}(?:-[ \t]{1,10}){0,5})([A-Za-z0-9_.-]{1,80})(:[ \t]{1,20})([^\s"',;&`()](?:[^\s"',;&]|,(?![A-Za-z0-9_.-]{1,80}["']?\s*[=:]))*)/gm,
    (m) => {
      if (!isSecretName(m[2]!)) return undefined;
      // ブロックの値の印だけ（|・>-）は値ではない。ASCII の印字できる字以外を含む値は文章とみなす
      if (/^[|>][-+]?\d?$/.test(m[4]!) || /[^\x21-\x7e]/.test(m[4]!))
        return undefined;
      const tail = maskedTail(m[4]!, marks);
      return tail === undefined
        ? undefined
        : `${m[1]}${m[2]}${m[3]}${hidden}${tail}`;
    },
  );
  // AWS のアクセスキー（AKIA と大文字・数字16字。前後が語の境目）
  out = replaceIgnoringInvisible(out, /\bAKIA[A-Z0-9]{16}\b/g, () => hidden);
  for (const secret of extra)
    if (secret && secret.length >= 8) out = out.split(secret).join(hidden);
  return out;
}
