import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  restoreDecisionsAfterMerge,
  restoreLostLines,
} from "../../src/lib/decisions.ts";
import { realRunner } from "../../src/lib/exec.ts";
import { git, makeRepo } from "../helpers/repo.ts";

const BASE = "# 決定の記録\n";
const A = "\n## 2026-01-01 A\n\n- 決めたこと：A\n";
const B = "\n## 2026-01-02 B\n\n- 決めたこと：B\n";

describe("restoreLostLines", () => {
  it("main の中身のあとに、タスクが分かれ目から足した部分を置く", () => {
    const result = restoreLostLines(BASE + A, BASE, BASE + B);
    expect(result).toEqual({ ok: true, text: BASE + A + B });
  });

  it("足した部分の見出しの前の空行が欠けていたら入れる", () => {
    const result = restoreLostLines(
      BASE + A,
      BASE,
      `${BASE}## 2026-01-02 B\n\n- x\n`,
    );
    expect(result).toEqual({
      ok: true,
      text: `${BASE}${A}\n## 2026-01-02 B\n\n- x\n`,
    });
  });

  it("main の部分は変えない", () => {
    const main = "# 決定の記録\n## 詰めた見出し\n- a\n";
    const result = restoreLostLines(main, BASE, BASE + B);
    expect(result.ok && result.text.startsWith(main)).toBe(true);
  });

  it("分かれ目からの追記でなければ、理由を返す", () => {
    const result = restoreLostLines(BASE + A, BASE + A, `${BASE}${B}`);
    expect(result).toEqual({
      ok: false,
      reason: "分かれ目からの追記ではありません",
    });
  });

  it("足した部分が空なら、理由を返す", () => {
    expect(restoreLostLines(BASE + A, BASE, BASE).ok).toBe(false);
    expect(restoreLostLines(BASE + A, BASE, `${BASE}\n\n`).ok).toBe(false);
  });

  it("足した部分に見出しがなければ、理由を返す（コードの囲みの中の # は見出しでない）", () => {
    expect(restoreLostLines(BASE + A, BASE, `${BASE}- a\n`).ok).toBe(false);
    const fenced = restoreLostLines(
      BASE + A,
      BASE,
      `${BASE}\n\`\`\`\n## 囲みの中\n\`\`\`\n`,
    );
    expect(fenced.ok).toBe(false);
  });

  it("足す項の見出しが main にすでにあれば、理由を返す", () => {
    const result = restoreLostLines(BASE + A, BASE, BASE + A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("## 2026-01-01 A");
  });

  it("項の中の小見出しが main と同じでも、項の見出しが違えば戻せる", () => {
    const sub = (name: string) =>
      `\n## 2026-01-0${name === "A" ? 1 : 2} ${name}\n\n### 理由\n\n- ${name}\n`;
    const result = restoreLostLines(BASE + sub("A"), BASE, BASE + sub("B"));
    expect(result.ok).toBe(true);
  });
});

describe("restoreLostLines（つなぎ目と見出しの重なり）", () => {
  it("main の末尾に改行がなく足しが見出しで始まっても、見出しは自分の行になり前に空行が入る", () => {
    const main = "# 決定の記録\n\n## 1 A\n\n- 人が選んだこと：なし";
    const base = "# 決定の記録\n";
    const result = restoreLostLines(main, base, `${base}## 3 B\n\n- x\n`);
    expect(result).toEqual({
      ok: true,
      text: `${main}\n\n## 3 B\n\n- x\n`,
    });
  });

  it("足しの中で一番浅い段の見出しの2つめだけが main にあっても止まる", () => {
    const added = "\n## 2026-01-02 B\n\n- b\n\n## 2026-01-01 A\n\n- a\n";
    const result = restoreLostLines(BASE + A, BASE, BASE + added);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("## 2026-01-01 A");
  });
});

describe("restoreDecisionsAfterMerge", () => {
  async function setup() {
    const root = await makeRepo({}, { "d.md": BASE });
    await git(root, "checkout", "--quiet", "-b", "task");
    await writeFile(path.join(root, "d.md"), BASE + B);
    await git(root, "commit", "--quiet", "-am", "B");
    const beforeHead = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "--quiet", "main");
    await writeFile(path.join(root, "d.md"), BASE + A);
    await git(root, "commit", "--quiet", "-am", "A");
    // rebase 後の task：main の記録の先頭と合わない（union で行が欠けた）
    await git(root, "checkout", "--quiet", "task");
    await writeFile(path.join(root, "d.md"), `${BASE}- 欠けた\n`);
    await git(root, "commit", "--quiet", "-am", "rebase 後");
    return { root, beforeHead };
  }

  it("コミットが失敗したら、記録を元に戻し、ステージを空にし、先頭を動かさず、ID と 取り込みの前の先頭を添えて投げる", async () => {
    const { root, beforeHead } = await setup();
    const hook = path.join(root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho フック失敗 >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const head = await git(root, "rev-parse", "HEAD");
    await expect(
      restoreDecisionsAfterMerge(
        realRunner,
        root,
        "d.md",
        "main",
        beforeHead,
        "T14",
        "統括役",
        () => {},
      ),
    ).rejects.toThrow(
      `T14：決定の記録の行の戻しをコミットできませんでした（記録のファイルを元に戻しました。worktree は取り込んだままです。取り込みの前の先頭 ${beforeHead}）`,
    );
    expect(await readFile(path.join(root, "d.md"), "utf8")).toBe(
      `${BASE}- 欠けた\n`,
    );
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
  });

  it("取り込みの前の先頭がすでに main の先頭を含むときは、警告も戻しもなく false", async () => {
    const { root } = await setup();
    // 一度 rebase したあとの形：task が main の先頭の上にある
    await git(root, "checkout", "--quiet", "-B", "again", "main");
    await writeFile(path.join(root, "d.md"), `${BASE}- 欠けた\n`);
    await git(root, "commit", "--quiet", "-am", "rebase 後");
    const warnings: string[] = [];
    const result = await restoreDecisionsAfterMerge(
      realRunner,
      root,
      "d.md",
      "main",
      await git(root, "rev-parse", "HEAD"),
      "T14",
      "統括役",
      (m) => warnings.push(m),
    );
    expect(result).toBe(false);
    expect(warnings).toEqual([]);
  });
});
