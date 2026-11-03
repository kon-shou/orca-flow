import type { FlowConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";
import { readPushRecord } from "./finish.ts";

// 依存のタスクが ref に入ったかの見分け。件名の行（integrate のマージ）か、push の記録のマージのコミット（PR のマージ）で決める。

/** どちらで分かったか */
export type MergedBy = "subject" | "push-record";

export type MergedResult =
  { merged: true; by: MergedBy } | { merged: false; by: null };

/** マージのコミットの名前として git に渡してよい形（16進の4〜64桁） */
const HEX_COMMIT = /^[0-9a-f]{4,64}$/i;

/**
 * タスクが ref に入ったか。件名の行を先に、なければ push の記録のマージのコミットを見る。
 * ref がコミットとして読めなければ FlowError(1)（手元にない origin/main などで「入っていない」と言わないため）
 */
export async function taskMergedInto(
  runner: Runner,
  root: string,
  config: Pick<FlowConfig, "integratorName">,
  id: string,
  ref: string,
): Promise<MergedResult> {
  if (ref === "" || ref.startsWith("-"))
    throw new FlowError(1, `比べる先 ${ref} をコミットとして読めません`);
  const verified = await runner(
    "git",
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: root },
  );
  if (verified.code !== 0)
    throw new FlowError(
      1,
      `比べる先 ${ref} をコミットとして読めません。名前を確かめるか、git fetch で取ってきてください`,
    );

  const log = await runner(
    "git",
    ["log", verified.stdout.trim(), "--format=%s"],
    {
      cwd: root,
    },
  );
  if (log.code !== 0)
    throw new FlowError(
      1,
      `git log ${ref} に失敗しました：${(log.stderr || log.stdout).trim()}`,
    );
  const line = `${config.integratorName}: ${id} をマージする`;
  if (log.stdout.split(/\r?\n/).includes(line))
    return { merged: true, by: "subject" };

  const record = await readPushRecord(runner, root, id);
  const commit = record?.mergeCommit;
  if (typeof commit === "string" && HEX_COMMIT.test(commit)) {
    // 0＝祖先、1＝祖先でない、128＝手元にないコミット
    const ancestor = await runner(
      "git",
      ["merge-base", "--is-ancestor", commit, verified.stdout.trim()],
      { cwd: root },
    );
    if (ancestor.code === 0) return { merged: true, by: "push-record" };
  }
  return { merged: false, by: null };
}
