import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  differences,
  fingerprintOf,
  ownChange,
  ownChangeExclude,
  parseDiff,
  readReviewed,
  writeReviewed,
} from "../../src/lib/rebase-review.ts";
import { addTaskWorktree, git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const DOC = "docs/tasks/T12.md";
const REPORT = "docs/tasks/reports/T12.md";

describe("parseDiff", () => {
  it("ファイルごとに足した行と消した行を分け、行番号を見ない", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -3,1 +3,2 @@",
      "-古い",
      "+新しい",
      "+もう1行",
      "",
    ].join("\n");
    const change = parseDiff(text);
    expect(change.get("a.txt")).toEqual({
      added: ["新しい", "もう1行"],
      removed: ["古い"],
    });
    const moved = parseDiff(
      text.replace("@@ -3,1 +3,2 @@", "@@ -30,1 +31,2 @@"),
    );
    expect(fingerprintOf(moved)).toBe(fingerprintOf(change));
  });
  it("前後の行（空白で始まる行）と「改行なし」の行は数えない", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -2,5 +2,5 @@",
      " 前1",
      " 前2",
      "-古い",
      "+新しい",
      " 後1",
      " 後2",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(parseDiff(text).get("a.txt")).toEqual({
      added: ["新しい"],
      removed: ["古い"],
    });
    const other = text.replace(" 前1", " 別の前1").replace(" 後2", " 別の後2");
    expect(fingerprintOf(parseDiff(other))).toBe(
      fingerprintOf(parseDiff(text)),
    );
  });
  it("モードだけの変更で指紋が変わる", () => {
    const body = "diff --git a/s.sh b/s.sh\n";
    const none = parseDiff(`${body}`);
    const mode = parseDiff(`${body}old mode 100644\nnew mode 100755\n`);
    const other = parseDiff(`${body}old mode 100644\nnew mode 100644\n`);
    expect(fingerprintOf(mode)).not.toBe(fingerprintOf(none));
    expect(fingerprintOf(mode)).not.toBe(fingerprintOf(other));
  });
  it("バイナリの中身の変更で指紋が変わる（index の行を残す）", () => {
    const make = (after: string) =>
      parseDiff(
        `diff --git a/b.bin b/b.bin\nindex ${"1".repeat(40)}..${after} 100644\nBinary files a/b.bin and b/b.bin differ\n`,
      );
    expect(fingerprintOf(make("2".repeat(40)))).not.toBe(
      fingerprintOf(make("3".repeat(40))),
    );
  });
  it("スペースを含む名前を読める", () => {
    const change = parseDiff(
      "diff --git a/a b.txt b/a b.txt\n--- a/a b.txt\n+++ b/a b.txt\n@@ -0,0 +1 @@\n+x\n",
    );
    expect([...change.keys()]).toEqual(["a b.txt"]);
  });
});

describe("differences", () => {
  it("前にだけある行・今にだけある行を出し、同じファイルは出さない", () => {
    const before = parseDiff(
      "diff --git a/a b/a\n@@ -0,0 +1 @@\n+一\ndiff --git a/b b/b\n@@ -0,0 +1 @@\n+同じ\n",
    );
    const now = parseDiff(
      "diff --git a/a b/a\n@@ -0,0 +1 @@\n+二\ndiff --git a/b b/b\n@@ -0,0 +1 @@\n+同じ\n",
    );
    expect(differences(before, now)).toEqual([
      { file: "a", onlyBefore: ["+一"], onlyNow: ["+二"], reordered: false },
    ]);
  });
  it("並びだけが変わったときは reordered", () => {
    const a = parseDiff("diff --git a/a b/a\n@@ -0,0 +1,2 @@\n+1\n+2\n");
    const b = parseDiff("diff --git a/a b/a\n@@ -0,0 +1,2 @@\n+2\n+1\n");
    expect(differences(a, b)).toEqual([
      { file: "a", onlyBefore: [], onlyNow: [], reordered: true },
    ]);
  });
});

describe("ownChange（本物の git）", () => {
  it("設計書と報告を除き、main が進んでも前後の行だけの違いでは指紋が変わらない", async () => {
    const root = await makeRepo({}, { "f.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n" });
    const wt = await addTaskWorktree(root, "T12", "shop", { [DOC]: "doc\n" });
    await writeFiles(wt.path, {
      "f.txt": "1\n2\n3\n4\n5\n6\n7\n8\nNEW\n9\n",
      [REPORT]: "報告\n",
    });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "作る");
    const exclude = [DOC, REPORT];
    const first = await ownChange(testRunner, wt.path, "main", "HEAD", exclude);
    expect([...first.change.keys()]).toEqual(["f.txt"]);

    // main の先頭に行が増える（行番号と前後が変わる）
    await writeFiles(root, { "f.txt": "0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n" });
    await git(root, "commit", "--quiet", "-am", "main が進む");
    await git(wt.path, "rebase", "--quiet", "main");
    const second = await ownChange(
      testRunner,
      wt.path,
      "main",
      "HEAD",
      exclude,
    );
    expect(second.fingerprint).toBe(first.fingerprint);

    // 設計書・報告を変えても変わらない
    await writeFiles(wt.path, { [DOC]: "doc2\n", [REPORT]: "報告2\n" });
    await git(wt.path, "commit", "--quiet", "-am", "記録");
    const third = await ownChange(testRunner, wt.path, "main", "HEAD", exclude);
    expect(third.fingerprint).toBe(first.fingerprint);

    // 足す行が変われば変わる
    await writeFiles(wt.path, {
      "f.txt": "0\n1\n2\n3\n4\n5\n6\n7\n8\nOTHER\n9\n",
    });
    await git(wt.path, "commit", "--quiet", "-am", "直す");
    const fourth = await ownChange(
      testRunner,
      wt.path,
      "main",
      "HEAD",
      exclude,
    );
    expect(fourth.fingerprint).not.toBe(first.fingerprint);
  });

  it("main が diff の前後の行だけを変えても指紋が変わらない", async () => {
    const root = await makeRepo({}, { "f.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n" });
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, { "f.txt": "1\n2\n3\n4\n5\n6\n7\n8\nNEW\n9\n" });
    await git(wt.path, "commit", "--quiet", "-am", "作る");
    const first = await ownChange(testRunner, wt.path, "main", "HEAD", []);
    await writeFiles(root, { "f.txt": "1\n2\n3\n4\n5\nSIX\n7\n8\n9\n" });
    await git(root, "commit", "--quiet", "-am", "main が前後の行を変える");
    await git(wt.path, "rebase", "--quiet", "main");
    const second = await ownChange(testRunner, wt.path, "main", "HEAD", []);
    expect(second.fork).not.toBe(first.fork);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("本物の git：モードだけの変更・バイナリの中身の変更で指紋が変わる", async () => {
    const root = await makeRepo({}, { "s.sh": "echo\n" });
    const wt = await addTaskWorktree(root, "T12", "shop");
    const fp = async () =>
      (await ownChange(testRunner, wt.path, "main", "HEAD", [])).fingerprint;
    const start = await fp();
    await git(wt.path, "update-index", "--chmod=+x", "s.sh");
    await git(wt.path, "commit", "--quiet", "-m", "実行ビット");
    const mode = await fp();
    expect(mode).not.toBe(start);

    await writeFiles(wt.path, { "b.bin": "a\0b\n" });
    await git(wt.path, "add", "b.bin");
    await git(wt.path, "commit", "--quiet", "-m", "バイナリ");
    const bin1 = await fp();
    expect(bin1).not.toBe(mode);
    await writeFiles(wt.path, { "b.bin": "a\0c\n" });
    await git(wt.path, "commit", "--quiet", "-am", "バイナリを変える");
    expect(await fp()).not.toBe(bin1);
  });

  it("rebase の前のコミットがブランチの祖先でなくても分かれ目を求められる", async () => {
    const root = await makeRepo({}, { "f.txt": "a\n" });
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, { "g.txt": "x\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "作る");
    const before = await git(wt.path, "rev-parse", "HEAD");
    await writeFiles(root, { "f.txt": "b\n" });
    await git(root, "commit", "--quiet", "-am", "main が進む");
    await git(wt.path, "rebase", "--quiet", "main");
    const a = await ownChange(testRunner, wt.path, "main", before, []);
    const b = await ownChange(testRunner, wt.path, "main", "HEAD", []);
    expect(a.fork).not.toBe(b.fork);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("見直しの記録", () => {
  it("git の共通ディレクトリの orca-flow/reviewed/〈ID〉.json に書き、どの worktree からも読める", async () => {
    const root = await makeRepo();
    const wt = await addTaskWorktree(root, "T12", "shop");
    expect(await readReviewed(testRunner, wt.path, "T12")).toBeNull();
    const record = { id: "T12", head: "h", fingerprint: "f", at: "t" };
    await writeReviewed(testRunner, wt.path, record);
    expect(await readReviewed(testRunner, root, "T12")).toEqual(record);
    const file = path.join(root, ".git", "orca-flow", "reviewed", "T12.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
  });
});

describe("ownChangeExclude", () => {
  it("設計書・報告に加えて appendOnlyFiles を除く", () => {
    expect(
      ownChangeExclude({ appendOnlyFiles: ["docs/decisions.md"] }, DOC, REPORT),
    ).toEqual([DOC, REPORT, "docs/decisions.md"]);
    expect(ownChangeExclude({ appendOnlyFiles: [] }, DOC, REPORT)).toEqual([
      DOC,
      REPORT,
    ]);
  });

  it("追記だけのファイルが変わっても指紋は同じ（本物の git）", async () => {
    const root = await makeRepo({}, { "docs/decisions.md": "# 記録\n" });
    const wt = await addTaskWorktree(root, "T12", "shop");
    await writeFiles(wt.path, { "g.txt": "x\n" });
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--quiet", "-m", "作る");
    const exclude = ownChangeExclude(
      { appendOnlyFiles: ["docs/decisions.md"] },
      DOC,
      REPORT,
    );
    const a = await ownChange(testRunner, wt.path, "main", "HEAD", exclude);
    await writeFiles(wt.path, { "docs/decisions.md": "# 記録\n\n## 項\n" });
    await git(wt.path, "commit", "--quiet", "-am", "項を足す");
    const b = await ownChange(testRunner, wt.path, "main", "HEAD", exclude);
    expect(b.fingerprint).toBe(a.fingerprint);
    const withFile = await ownChange(testRunner, wt.path, "main", "HEAD", [
      DOC,
      REPORT,
    ]);
    expect(withFile.fingerprint).not.toBe(a.fingerprint);
  });
});
