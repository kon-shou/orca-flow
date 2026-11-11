import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_CAPTURE_BYTES } from "./e2e-capture.ts";
import { e2eCapturesDir } from "./preview-base.ts";

// 録画を PR の本文に載せる部品（8章『push（PR の道）』の録画を載せる）。
// 本文の参照はファイル名だけにし、手元のパスを書かない（送るときに一時ディレクトリへ写して gh を流す）

export type CaptureSide = "before" | "after";

/**
 * 案に入れる録画1つ。path は手元のパス（show が人に見せるだけ。指紋・本文・GitHub には入れない）。
 * 案のファイルには path を保存せず、読むときに置き場とファイル名から組み立て直す（restoreCaptureRefs）
 */
export interface CaptureRef {
  flow: string;
  side: CaptureSide;
  /** 置き場の中のファイル名（〈流れ〉-before.〈拡張子〉） */
  name: string;
  size: number;
  sha256: string;
  path: string;
}

export interface CollectedCaptures {
  /** 載せる録画（流れの名前の順、流れの中は前・後の順） */
  captures: CaptureRef[];
  /** 載せなかった流れの警告（流れの名前つき。手元のパスは書かない） */
  warnings: string[];
}

export const CAPTURES_OPEN = (digest: string) =>
  `<!-- orca-flow:captures ${digest} -->`;
export const CAPTURES_CLOSE = "<!-- /orca-flow:captures -->";

const OPEN_PATTERN = /<!-- orca-flow:captures ([0-9a-f]{16}) -->/;

/** 置き場のファイル名の形（流れの名前は e2e --capture の FLOW_PATTERN と同じ） */
const CAPTURE_NAME =
  /^([a-z0-9][a-z0-9-]{0,39})-(before|after)\.(webm|mp4|gif)$/;

export const isCaptureName = (name: string) => CAPTURE_NAME.test(name);

/**
 * 案から読んだ録画の流れ・側・パスを、置き場 dir とファイル名から組み立て直す。
 * 案のファイルはエージェントが書き換えられ、指紋に入るのはファイル名・大きさ・sha256 だけなので、
 * 人に見せる値も send が送るのと同じファイルから決める。名前の形が外れたら path は空（send も送らない）
 */
export function restoreCaptureRefs(
  dir: string,
  captures: readonly CaptureRef[],
): CaptureRef[] {
  return captures.map((c) => {
    const match = CAPTURE_NAME.exec(c.name);
    if (!match) return { ...c, path: "" };
    return {
      ...c,
      flow: match[1]!,
      side: match[2] as CaptureSide,
      path: path.join(dir, c.name),
    };
  });
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

const SIDE_LABEL: Record<CaptureSide, string> = { before: "前", after: "後" };

export const sideLabel = (side: CaptureSide) => SIDE_LABEL[side];

/**
 * 録画の置き場から、前と後がそろった流れだけを名前の順に拾う。
 * 片方だけ・同じ側が2つ・上限を超える流れは載せず、流れの名前つきで警告する。置き場がなければ空
 */
export async function collectCaptures(dir: string): Promise<CollectedCaptures> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { captures: [], warnings: [] };
  }
  const flows = new Map<string, Record<CaptureSide, string[]>>();
  for (const entry of entries) {
    // シンボリックリンクは辿らない（置き場の外のファイルを載せないため）
    if (!entry.isFile()) continue;
    const match = CAPTURE_NAME.exec(entry.name);
    if (!match) continue;
    const flow = match[1]!;
    const side = match[2] as CaptureSide;
    const sides = flows.get(flow) ?? { before: [], after: [] };
    sides[side].push(entry.name);
    flows.set(flow, sides);
  }
  const captures: CaptureRef[] = [];
  const warnings: string[] = [];
  for (const flow of [...flows.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const sides = flows.get(flow)!;
    if (sides.before.length === 0 || sides.after.length === 0) {
      warnings.push(
        `流れ ${flow} は前と後の録画の片方しかないので、PR に載せません`,
      );
      continue;
    }
    if (sides.before.length > 1 || sides.after.length > 1) {
      warnings.push(
        `流れ ${flow} は同じ側の録画が2つ以上あるので、PR に載せません（e2e --capture で録り直してください）`,
      );
      continue;
    }
    const picked: CaptureRef[] = [];
    let tooLarge = false;
    for (const side of ["before", "after"] as const) {
      const name = sides[side][0]!;
      const file = path.join(dir, name);
      const size = (await stat(file)).size;
      if (size > MAX_CAPTURE_BYTES) {
        tooLarge = true;
        break;
      }
      picked.push({
        flow,
        side,
        name,
        size,
        sha256: sha256(await readFile(file)),
        path: file,
      });
    }
    if (tooLarge) {
      warnings.push(
        `流れ ${flow} の録画が ${MAX_CAPTURE_BYTES.toLocaleString("en-US")} バイトを超えるので、PR に載せません`,
      );
      continue;
    }
    captures.push(...picked);
  }
  return { captures, warnings };
}

/** タスクの録画の置き場から拾う */
export const collectTaskCaptures = (common: string, id: string) =>
  collectCaptures(e2eCapturesDir(common, id));

/** 指紋と show に使う形（手元のパスは除く） */
export const captureKey = (captures: readonly CaptureRef[] | undefined) =>
  (captures ?? []).map((c) => ({
    name: c.name,
    size: c.size,
    sha256: c.sha256,
  }));

/** 録画全体の sha256 の頭16桁（節の印に書く値） */
export function capturesDigest(captures: readonly CaptureRef[]): string {
  return sha256(JSON.stringify(captureKey(captures))).slice(0, 16);
}

/** 本文の録画の節（印の2行で囲む。末尾の改行はつけない） */
export function buildCapturesSection(captures: readonly CaptureRef[]): string {
  const lines = [
    CAPTURES_OPEN(capturesDigest(captures)),
    "## 動きの録画",
    "",
    "E2E のテストを、変える前（前）と変えたあと（後）の画面に流して録りました。",
  ];
  let flow: string | null = null;
  for (const c of captures) {
    if (c.flow !== flow) {
      flow = c.flow;
      lines.push("", `### ${c.flow}`);
    }
    // GitHub は段落に URL が1つだけのときに動画として出すので、録画ごとに段落を分ける
    lines.push("", `${SIDE_LABEL[c.side]}：`, "", `![](${c.name})`);
  }
  lines.push("", CAPTURES_CLOSE);
  return lines.join("\n");
}

/** 本文の節の印の値。印がなければ null */
export function capturesDigestOf(body: string): string | null {
  return OPEN_PATTERN.exec(body)?.[1] ?? null;
}

/**
 * 本文の録画の節を差し替える（なければ末尾に足す）。節の外は1文字も変えない。
 * 始まりの印があるのに終わりの印がなければ、どこまでが節か分からないので null
 */
export function replaceCapturesSection(
  body: string,
  section: string,
): string | null {
  const open = OPEN_PATTERN.exec(body);
  if (open) {
    const end = body.indexOf(CAPTURES_CLOSE, open.index);
    if (end < 0) return null;
    return (
      body.slice(0, open.index) +
      section +
      body.slice(end + CAPTURES_CLOSE.length)
    );
  }
  if (body === "") return `${section}\n`;
  const gap = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${gap}${section}\n`;
}

/**
 * 案の録画を置き場から一時ディレクトリへ写し、大きさと sha256 を照らす。
 * 合わない・ない・名前の形が外れたら、その理由（ファイル名だけ。手元のパスは書かない）を返す。合えば null
 */
export async function stageCaptures(
  sourceDir: string,
  captures: readonly CaptureRef[],
  destDir: string,
): Promise<string | null> {
  for (const c of captures) {
    if (!isCaptureName(c.name))
      return `録画の名前の形が正しくありません：${c.name}`;
    let data: Buffer;
    try {
      const file = path.join(sourceDir, c.name);
      // シンボリックリンクは辿らない（置き場の外のファイルを送らないため）
      if (!(await lstat(file)).isFile())
        return `録画 ${c.name} が置き場にありません`;
      data = await readFile(file);
    } catch {
      return `録画 ${c.name} が置き場にありません`;
    }
    if (data.length !== c.size || sha256(data) !== c.sha256)
      return `録画 ${c.name} が積んだときから変わっています`;
    await writeFile(path.join(destDir, c.name), data);
  }
  return null;
}

/** 本文の sha256（pr-edit が積むときに読んだ PR の本文と、送る直前に読み直した本文を照らす） */
export const textSha256 = (text: string) => sha256(text);
