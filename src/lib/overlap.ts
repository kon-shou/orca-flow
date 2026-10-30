import { normalizePath, type TaskDoc } from "./task-doc.ts";

const segments = (p: string): string[] =>
  normalizePath(p)
    .split("/")
    .filter((s) => s !== "" && s !== ".");

/** a が b と同じか、b の下にある（ディレクトリの区切りで比べる） */
export function isUnder(a: string, b: string): boolean {
  const sa = segments(a);
  const sb = segments(b);
  if (sb.length === 0) return true;
  if (sa.length < sb.length) return false;
  return sb.every((s, i) => sa[i] === s);
}

/** 片方がもう片方と同じか、その下にあれば重なり */
export function pathsOverlap(a: string, b: string): boolean {
  return isUnder(a, b) || isUnder(b, a);
}

/** sharedPaths のうちファイル名だけのもの（"/" を含まないもの、うしろの "/" は除く） */
const isBareName = (shared: string) =>
  !shared.replace(/\/+$/, "").includes("/");

/**
 * パスが共有のファイルに当たるか。
 * - ファイル名だけの共有のファイル（package.json など）は、どの階層のそのファイルにも当たる
 * - それ以外は重なりで判定する（`.claude/` は `.claude/settings.json` にも、ルート全体の `.` にも当たる）
 */
export function matchesShared(p: string, shared: string): boolean {
  const sp = segments(p);
  if (isBareName(shared) && !shared.endsWith("/")) {
    const name = normalizePath(shared);
    if (sp[sp.length - 1] === name) return true;
  }
  return pathsOverlap(p, shared);
}

export type OverlapKind = "workers" | "outside" | "shared" | "active" | "note";

export interface OverlapProblem {
  kind: OverlapKind;
  message: string;
}

export interface OtherTask {
  id: string;
  allowed: string[];
}

export interface OverlapInput {
  doc: TaskDoc;
  /** 共有のファイル。進捗表のファイルも入れて渡す */
  sharedPaths: readonly string[];
  /** 作業中のほかのタスク（自分は除いて渡す） */
  others: readonly OtherTask[];
}

/** 9.2 の4つを確かめる（4つ目は自分の設計書のバッククォートの中の全角の書き添え） */
export function checkOverlap(input: OverlapInput): OverlapProblem[] {
  const { doc, sharedPaths, others } = input;
  const problems: OverlapProblem[] = [];

  // 1. 担当同士の重なりと、「書き込んでよい場所」の外の担当の場所
  const workers = doc.workers;
  for (let i = 0; i < workers.length; i++) {
    for (let j = i + 1; j < workers.length; j++) {
      for (const a of workers[i]!.paths) {
        for (const b of workers[j]!.paths) {
          if (pathsOverlap(a, b))
            problems.push({
              kind: "workers",
              message: `担当「${workers[i]!.name}」の \`${a}\` と担当「${workers[j]!.name}」の \`${b}\` が重なっています`,
            });
        }
      }
    }
  }
  for (const worker of workers) {
    for (const p of worker.paths) {
      if (!doc.allowed.some((allowed) => isUnder(p, allowed)))
        problems.push({
          kind: "outside",
          message: `担当「${worker.name}」の \`${p}\` が「書き込んでよい場所」の外です`,
        });
    }
  }

  // 2. 「書き込んでよい場所」に共有のファイルが入っていない
  for (const p of doc.allowed) {
    for (const shared of sharedPaths) {
      if (matchesShared(p, shared))
        problems.push({
          kind: "shared",
          message: `「書き込んでよい場所」の \`${p}\` が共有のファイル \`${shared}\` に当たります。main への事前変更に回してください`,
        });
    }
  }

  // 3. 作業中のほかのタスクとの重なり
  for (const other of others) {
    for (const p of doc.allowed) {
      for (const q of other.allowed) {
        if (pathsOverlap(p, q))
          problems.push({
            kind: "active",
            message: `\`${p}\` が作業中の ${other.id} の \`${q}\` と重なっています`,
          });
      }
    }
  }
  // 4. バッククォートの中身が全角のかっこの書き添えで終わらない（自分の設計書だけ）
  for (const note of doc.notes ?? [])
    problems.push({
      kind: "note",
      message: `${note.where}の \`${note.content}\` の書き添えがバッククォートの中にあります。書き添えはバッククォートの外に書いてください（名前が全角のかっこで終わるディレクトリなら、うしろに「/」をつけてください）`,
    });
  return problems;
}

export interface RangeInput {
  files: readonly string[];
  allowed: readonly string[];
  /** 設計書と報告のパス */
  docs: readonly string[];
  appendOnlyFiles: readonly string[];
}

/** integrate の範囲の確認。外れたファイルを返す */
export function filesOutsideRange(input: RangeInput): string[] {
  const inside = [...input.allowed, ...input.appendOnlyFiles];
  const exact = new Set(input.docs.map(normalizePath));
  return input.files.filter(
    (file) =>
      !exact.has(normalizePath(file)) &&
      !inside.some((allowed) => isUnder(file, allowed)),
  );
}

/** pathVerify のうち、差分のファイルが当たるもののコマンド */
export function matchingPathVerify(
  files: readonly string[],
  pathVerify: readonly { paths: string[]; commands: string[] }[],
): string[] {
  const commands: string[] = [];
  for (const entry of pathVerify) {
    if (files.some((file) => entry.paths.some((p) => isUnder(file, p))))
      commands.push(...entry.commands);
  }
  return commands;
}
