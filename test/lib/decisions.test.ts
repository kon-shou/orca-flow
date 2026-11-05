import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { realRunner } from "../../src/lib/exec.ts";
import { parseConfig } from "../../src/config.ts";
import { FlowError } from "../../src/types.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import {
  checkDecisionsAppendOnly,
  fixDecisionsBlankLines,
  addedLinesOf,
  idLikeLines,
  readDecisionDraft,
  restoreBlankBeforeHeadings,
  startsWithBase,
} from "../../src/lib/decisions.ts";

const doc = (section: string) =>
  `# タスク\n\n## 目的\n\nテスト。\n\n${section}\n## 報告の形\n\n報告。\n`;

describe("readDecisionDraft", () => {
  it("節がなければ missing", () => {
    expect(readDecisionDraft(doc(""))).toBe("missing");
  });

  it("「なし」だけなら none（飾りや句点があっても）", () => {
    for (const body of ["なし", "- なし", "なし。", "\n- なし\n", "**なし**"])
      expect(readDecisionDraft(doc(`## 決定の記録の文案\n\n${body}\n`))).toBe(
        "none",
      );
  });

  it("中身があれば present", () => {
    expect(
      readDecisionDraft(
        doc("## 決定の記録の文案\n\n- 見出し：形を決めた\n- 決めたこと：A\n"),
      ),
    ).toBe("present");
  });

  it("「なし」の字を含む行があっても、ほかに中身があれば present", () => {
    expect(
      readDecisionDraft(
        doc("## 決定の記録の文案\n\n- 見出し：x\n- 捨てた案と理由：なし\n"),
      ),
    ).toBe("present");
  });

  it("無し・特になし・ない・かっこの書き添え・コメント行つきも none", () => {
    for (const body of [
      "- 無し",
      "- 特になし",
      "ない",
      "- なし（決めることがない）",
      "- なし\n<!-- 書くことがあれば足す -->",
      "<!-- メモ -->\n- なし",
    ])
      expect(readDecisionDraft(doc(`## 決定の記録の文案\n\n${body}\n`))).toBe(
        "none",
      );
  });

  it("中身が空の節は節がないのと同じ（missing）", () => {
    expect(readDecisionDraft(doc("## 決定の記録の文案\n\n"))).toBe("missing");
  });

  it("コードブロックの中の見出しは節にしない", () => {
    expect(
      readDecisionDraft("## 作るもの\n\n```\n## 決定の記録の文案\n- x\n```\n"),
    ).toBe("missing");
  });
});

describe("addedLinesOf / idLikeLines", () => {
  const diff = [
    "diff --git a/d.md b/d.md",
    "--- a/d.md",
    "+++ b/d.md",
    "@@ -1 +1,3 @@",
    " 古い T1 の行",
    "+## 2026-01-01 形",
    "+- T12 で決めた",
    "-消した T9",
  ].join("\n");

  it("足した行だけを返す（+++ の行と文脈の行は除く）", () => {
    expect(addedLinesOf(diff)).toEqual(["## 2026-01-01 形", "- T12 で決めた"]);
  });

  it("idPrefix と数字の形の行を返す", () => {
    expect(idLikeLines(addedLinesOf(diff), "T")).toEqual(["- T12 で決めた"]);
    expect(idLikeLines(["ITEM12 と T-1 と Tx"], "T")).toEqual([]);
  });
});

describe("startsWithBase", () => {
  it("先頭が同じなら true、行が消えたら false", () => {
    expect(startsWithBase("a\nb\n", "a\nb\nc\n")).toBe(true);
    expect(startsWithBase("a\nb\n", "a\nc\n")).toBe(false);
    expect(startsWithBase("a\nb\n", "")).toBe(false);
  });
});

describe("restoreBlankBeforeHeadings", () => {
  const main = "# 決定の記録\n";

  it("足された項の見出しが前の行にくっついていれば、空行を1つ入れる", () => {
    const merged = `${main}\n## A\n\n- a\n## B\n\n- b\n`;
    expect(restoreBlankBeforeHeadings(main, merged)).toBe(
      `${main}\n## A\n\n- a\n\n## B\n\n- b\n`,
    );
  });

  it("main の末尾にくっついた最初の見出しも直す", () => {
    expect(restoreBlankBeforeHeadings(main, `${main}## A\n\n- a\n`)).toBe(
      `${main}\n## A\n\n- a\n`,
    );
  });

  it("2つ以上くっついた見出しをすべて直す", () => {
    const merged = `${main}\n## A\n\n- a\n## B\n\n- b\n## C\n\n- c\n`;
    expect(restoreBlankBeforeHeadings(main, merged)).toBe(
      `${main}\n## A\n\n- a\n\n## B\n\n- b\n\n## C\n\n- c\n`,
    );
  });

  it("すでに空行があれば何も変えない", () => {
    const merged = `${main}\n## A\n\n- a\n\n## B\n\n- b\n`;
    expect(restoreBlankBeforeHeadings(main, merged)).toBe(merged);
  });

  it("コードの囲みの中の # の行は変えない", () => {
    const merged = `${main}\n## A\n\n\`\`\`sh\necho\n# コメント\n\`\`\`\n## B\n`;
    expect(restoreBlankBeforeHeadings(main, merged)).toBe(
      `${main}\n## A\n\n\`\`\`sh\necho\n# コメント\n\`\`\`\n\n## B\n`,
    );
  });

  it("# のあとに空白がない行は見出しではない", () => {
    const merged = `${main}\n## A\n\n- a\n#tag\n`;
    expect(restoreBlankBeforeHeadings(main, merged)).toBe(merged);
  });

  it("main の部分にくっついた見出しは変えない", () => {
    const tight = "# 決定の記録\n## 古い\n- x\n## 古い2\n";
    const merged = `${tight}\n## A\n\n- a\n## B\n`;
    expect(restoreBlankBeforeHeadings(tight, merged)).toBe(
      `${tight}\n## A\n\n- a\n\n## B\n`,
    );
  });

  it("main が先頭にない中身は変えない", () => {
    const merged = "# 別の\n\n## A\n- a\n## B\n";
    expect(restoreBlankBeforeHeadings(main, merged)).toBe(merged);
  });
});

describe("fixDecisionsBlankLines", () => {
  const MAIN = "# 決定の記録\n";
  const MERGED = `${MAIN}## A\n\n- a\n`;

  it("直してコミットする", async () => {
    const root = await makeRepo({}, { "d.md": MAIN });
    await writeFile(path.join(root, "d.md"), MERGED);
    await git(root, "commit", "--quiet", "-am", "項");
    expect(
      await fixDecisionsBlankLines(realRunner, root, "d.md", MAIN, "統括役"),
    ).toBe(true);
    expect(await readFile(path.join(root, "d.md"), "utf8")).toBe(
      `${MAIN}\n## A\n\n- a\n`,
    );
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("件名の頭は渡した名前になる", async () => {
    const root = await makeRepo({}, { "d.md": MAIN });
    await writeFile(path.join(root, "d.md"), MERGED);
    await git(root, "commit", "--quiet", "-am", "項");
    await fixDecisionsBlankLines(realRunner, root, "d.md", MAIN, "T12");
    expect(await git(root, "log", "-1", "--format=%s")).toBe(
      "T12: マージで欠けた決定の記録の空行を戻す",
    );
  });

  it("コミットが失敗したら、ステージを外して元の中身に戻し、何をしていたか分かる文で投げる", async () => {
    const root = await makeRepo({}, { "d.md": MAIN });
    await writeFile(path.join(root, "d.md"), MERGED);
    await git(root, "commit", "--quiet", "-am", "項");
    const hook = path.join(root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho フック失敗 >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const before = await git(root, "rev-parse", "HEAD");
    await expect(
      fixDecisionsBlankLines(realRunner, root, "d.md", MAIN, "統括役"),
    ).rejects.toThrow(
      "決定の記録の空行の戻しをコミットできませんでした（元に戻しました）",
    );
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await readFile(path.join(root, "d.md"), "utf8")).toBe(MERGED);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("checkDecisionsAppendOnly", () => {
  const FILE = "docs/decisions.md";
  const BASE = "# 決定の記録\n\n## 1\n\n- 決めたこと：a\n";
  const head = `main の ${FILE} が、タスクのブランチの ${FILE} の先頭と同じではありません（取り込みで記録の行が消えたか、すでにある項を書き換えています）。`;
  const config = (decisionsFile: string | null) => ({
    ...parseConfig({}),
    baseBranch: "main",
    decisionsFile,
  });
  const run = (
    root: string,
    decisionsFile: string | null,
    against: string,
    caller: "verify" | "integrate" | "push",
  ) =>
    checkDecisionsAppendOnly(realRunner, config(decisionsFile), root, {
      id: "T1",
      against,
      caller,
    });
  const stopOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FlowError);
    return error as FlowError;
  };
  const setup = async (taskText: string | null) => {
    const root = await makeRepo({}, { [FILE]: BASE });
    const task = await addTaskWorktree(
      root,
      "T1",
      "x",
      taskText === null ? { "other.txt": "x\n" } : { [FILE]: taskText },
    );
    return { root, task };
  };

  it("行が消えたとき、呼ぶ側ごとの今の文で、終了コード 1 で止める", async () => {
    const { root, task } = await setup("# 決定の記録\n");
    const verify = await stopOf(run(task.path, FILE, "HEAD", "verify"));
    expect(verify.code).toBe(1);
    expect(verify.message).toBe(
      `${head}行を戻し、自分の項を末尾に足し直してコミットしてから、orca-flow verify をやり直してください`,
    );
    const tail = (verb: string, end: string) =>
      `T1：${head}タスクのブランチで main の ${FILE} の行を戻し、自分の項を末尾に足し直してコミットし、orca-flow verify をやり直してから、もう一度 ${verb} してください。${end}`;
    const integrate = await stopOf(run(root, FILE, task.branch, "integrate"));
    expect(integrate.code).toBe(1);
    expect(integrate.message).toBe(tail("integrate", "マージしていません"));
    const push = await stopOf(run(root, FILE, task.branch, "push"));
    expect(push.code).toBe(1);
    expect(push.message).toBe(tail("push", "push も PR もしていません"));
  });

  it("比べる先に記録がないときは止まる", async () => {
    const { root, task } = await setup(null);
    await git(task.path, "rm", "-q", FILE);
    await git(task.path, "commit", "-q", "-m", "消す");
    for (const caller of ["verify", "integrate", "push"] as const)
      expect((await stopOf(run(root, FILE, task.branch, caller))).code).toBe(1);
  });

  it("decisionsFile がないとき・baseBranch に記録がないときは止まらず null", async () => {
    const { root, task } = await setup("# 決定の記録\n");
    expect(await run(root, null, task.branch, "integrate")).toBeNull();
    expect(await run(root, "docs/none.md", task.branch, "push")).toBeNull();
  });

  it("先頭がそのまま残るときは止まらず、baseBranch の中身を返す", async () => {
    const { root, task } = await setup(`${BASE}\n## 2\n\n- 決めたこと：b\n`);
    expect(await run(task.path, FILE, "HEAD", "verify")).toBe(BASE);
    expect(await run(root, FILE, task.branch, "integrate")).toBe(BASE);
    expect(await run(root, FILE, task.branch, "push")).toBe(BASE);
  });
});
