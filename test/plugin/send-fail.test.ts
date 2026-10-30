import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

describe("skills/integrate：送れなかったときの見分け方", () => {
  it("手順3の終了コード2の段は「送れませんでした」で見分ける", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const line = text
      .split("\n")
      .find((l) => l.includes("標準エラーに `orca-flow verify`"));
    expect(line, "verify の終了コード2の段が見つかりません").toBeDefined();
    expect(line).toContain("送れませんでした");
    expect(line).toContain("1つに決まらない");
    expect(line).toContain("打ちかけ");
  });

  it("「ターミナルが見つからない」だけの条件がない", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).not.toContain("「ターミナルが見つからない」か");
    expect(text).not.toContain("「ターミナルが見つからない」と警告");
  });
});

describe("tell の終了コード2の扱い", () => {
  for (const name of ["approve", "integrate"]) {
    it(`skills/${name}：送れなかった文と候補のタブを人間に伝えて止まる`, async () => {
      const text = await read(`skills/${name}/SKILL.md`);
      expect(text).toContain("orca-flow tell");
      expect(text).toContain("送れませんでした");
      expect(text).toContain("候補のタブ");
      expect(text).toMatch(/伝えて止まる/);
      expect(text).toContain("打ちかけ");
    });
  }

  it("skills/approve：終了コード2の例に1つに決まらない・打ちかけがある", async () => {
    const text = await read("skills/approve/SKILL.md");
    const line = text.split("\n").find((l) => /^ {3}- 2：/.test(l));
    expect(line, "終了コード2の行が見つかりません").toBeDefined();
    expect(line).toContain("タスク長のターミナルが1つに決まらない");
    expect(line).toContain("入力欄に打ちかけがある");
  });
});

describe("tell の終了コード2の段（送れなかった警告）", () => {
  it("skills/integrate：tell の終了コード2の段は「2 で、」の枝と別の段にある", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const lines = text.split("\n");
    const tellLine = lines.find(
      (l) =>
        /^ {3}- /.test(l) &&
        l.includes("orca-flow tell") &&
        l.includes("終了コード2") &&
        l.includes("候補のタブ"),
    );
    expect(tellLine, "tell の終了コード2の段が見つかりません").toBeDefined();
    expect(tellLine).not.toMatch(/^ {3}- 2 で、/);
    expect(tellLine).toMatch(/^ {3}- 1・3 の段で流した/);
    for (const word of [
      "bash モード",
      "入力欄を確かめられない",
      "打ちかけ",
      "伝えて止まる",
    ]) {
      expect(tellLine).toContain(word);
    }
    // tell の送信の失敗は終了コード1なので、終了コード2の段には入らない
    // （「Orca の送信の失敗は終了コード1」と断る文だけが入る）
    expect(tellLine).not.toMatch(/Orca の送信の失敗(?!は終了コード1)/);
    expect(tellLine).toContain("Orca の送信の失敗は終了コード1");
    // 「2 で、」の枝のどれにも、tell の終了コード2の説明が混ざっていない
    for (const l of lines.filter((x) => /^ {3}- 2 で、/.test(x))) {
      expect(l).not.toContain("`orca-flow tell` でタスク長に送れなかった");
    }
  });

  it("skills/approve：tell の終了コード2の段に orca-flow tell・終了コード2・候補のタブが入る", async () => {
    const text = await read("skills/approve/SKILL.md");
    const line = text
      .split("\n")
      .find(
        (l) => /^ {3}- /.test(l) && l.includes("`orca-flow tell` を流して"),
      );
    expect(line, "tell の終了コード2の段が見つかりません").toBeDefined();
    expect(line).toContain("orca-flow tell");
    expect(line).toContain("終了コード2");
    expect(line).toContain("候補のタブ");
    expect(line).toContain("bash モード");
    expect(line).toContain("入力欄を確かめられない");
  });

  it("skills/approve：終了コード2の例に bash モード・入力欄を確かめられない、流し直しがある", async () => {
    const text = await read("skills/approve/SKILL.md");
    const line = text.split("\n").find((l) => /^ {3}- 2：/.test(l));
    expect(line, "終了コード2の行が見つかりません").toBeDefined();
    expect(line).toContain("bash モード");
    expect(line).toContain("入力欄を確かめられない");
  });

  it("skills/approve：--prechanges-done で流していたら事前変更を入れ直さず流し直す", async () => {
    const text = await read("skills/approve/SKILL.md");
    const line = text
      .split("\n")
      .find(
        (l) =>
          /^ {3}- /.test(l) &&
          l.includes("`orca-flow approve $0 --prechanges-done`") &&
          l.includes("流し直"),
      );
    expect(line, "流し直しの段が見つかりません").toBeDefined();
    expect(line).toContain("終了コード2");
    expect(line).toContain("入れ直さ");
  });
});

describe("skills/integrate：手順5の送れなかった警告（送れなかった警告）", () => {
  it("終了コード0でも「送れませんでした」の警告があれば、どのタスクに届いていないかを人に伝える", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const start = text.indexOf("\n5. ");
    const end = text.indexOf("\n## 守ること");
    expect(start).toBeGreaterThan(-1);
    const step5 = text.slice(start, end);
    const line = step5.split("\n").find((l) => l.includes("送れませんでした"));
    expect(line, "手順5に警告の段がありません").toBeDefined();
    expect(line).toContain("終了コード0");
    expect(line).toContain("どのタスク");
    expect(line).toContain("人間");
  });
});

describe("送れなかった警告の確認事項：スキルと仕様の文", () => {
  it("skills/integrate：verify の終了コード2の段に理由が4つと新しい警告の形が入る", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const line = text
      .split("\n")
      .find((l) => l.includes("標準エラーに `orca-flow verify`"));
    expect(line).toBeDefined();
    for (const word of [
      "タスクのブランチが動いた",
      "main でテストに関係するファイルが変わった",
      "rebase したが競合した",
      "コマンドが変わった",
      "verify のやり直しの知らせを送れませんでした",
    ]) {
      expect(line).toContain(word);
    }
  });

  it("skills/integrate：記録を使ったときの段に、main がテストに関係しないファイルだけ動いた場合がある", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const line = text
      .split("\n")
      .find((l) =>
        l.includes("記録のあと main で変わったテストに関係しないファイル"),
      );
    expect(line, "記録を使ったときの段が見つかりません").toBeDefined();
    expect(line).toContain("rebase");
    expect(line).toContain("マージ");
  });

  it("skills/integrate：手順5の警告の形に main が進んだ知らせがある", async () => {
    const text = await read("skills/integrate/SKILL.md");
    expect(text).toContain("main が進んだ知らせを送れませんでした");
  });

  it("skills/approve：「もう一度 /orca-flow:approve」と頼まず、事前変更があれば入れ直さない", async () => {
    const text = await read("skills/approve/SKILL.md");
    expect(text).not.toContain("もう一度 /orca-flow:approve");
    const step3 = text.slice(text.indexOf("\n3. "), text.indexOf("\n4. "));
    expect(step3).toContain("の事前変更」のコミットがすでにある");
    expect(step3).toContain("入れ直さず");
    expect(step3).toContain("--prechanges-done");
  });

  it("docs/spec.md：8章に新しい警告の形・閉じの横線・--no-renames がある", async () => {
    const text = await read("docs/spec.md");
    expect(text).toContain(
      "警告：〈ID〉 のタスク長に〈何〉を送れませんでした：〈理由〉。〈すること〉",
    );
    expect(text).not.toContain("ので、〈何〉の知らせを送れませんでした");
    expect(text).toContain("閉じの横線");
    expect(text).toContain("git diff --name-only --no-renames");
  });
});

describe("approve の事前変更の確かめと仕様 8章の文", () => {
  it("skills/approve：手順3が first-parent・件名を先に出す書式・行頭の一致を含み、--grep を含まない", async () => {
    const text = await read("skills/approve/SKILL.md");
    const step3 = text.slice(text.indexOf("\n3. "), text.indexOf("\n4. "));
    expect(step3).toContain("--first-parent");
    expect(step3).toContain("--format='%s%x09%H'");
    expect(step3).not.toContain("%H %s");
    expect(step3).toContain("^〈integratorName〉: $0 の事前変更");
    expect(step3).toContain("いちばん上");
    expect(step3).toContain("git show -s --format=%b");
    expect(step3).not.toContain("--grep");
  });

  it("skills/approve：手順3の分かれ道ごとの行がある", async () => {
    const text = await read("skills/approve/SKILL.md");
    const step3 = text.slice(text.indexOf("\n3. "), text.indexOf("\n4. "));
    const lines = step3.split("\n").map((l) => l.trim());
    const find = (word: string) => lines.find((l) => l.startsWith(word));
    const same = find("- blob が同じなら");
    expect(same, "blob が同じ場合の行").toBeDefined();
    expect(same).toContain("入れ直さず");
    expect(same).toContain("--prechanges-done");
    const sec = find("- blob が違えば");
    expect(sec, "blob が違う場合の行").toBeDefined();
    expect(sec).toContain("git show 〈blob〉");
    expect(sec).toContain("節が同じなら");
    expect(sec).toContain("入れ直さず");
    expect(sec).toContain("--prechanges-done");
    const ask = find("- 節が違うか");
    expect(ask, "人間に聞く行").toBeDefined();
    expect(ask).toContain("設計書：");
    expect(ask).toContain("入れ直さず人間に");
    expect(ask).toContain("差を見せて");
    const unread = find("- 前の blob が");
    expect(unread, "blob が読めない場合の行").toBeDefined();
    expect(unread).toContain("16進");
    expect(unread).toContain("入れ直さず人間に聞く");
    const commit = lines.find(
      (l) => /^\d+\. /.test(l) && l.includes("の事前変更（〈要点〉）"),
    );
    expect(commit, "コミットの手順").toBeDefined();
    expect(commit).toContain("本文に「設計書：〈blob〉」の1行");
    expect(commit).toContain("git rev-parse 〈ブランチ〉:〈tasksDir〉/$0.md");
  });

  it("skills/approve：終了コード2の例に設計書未コミット・未コミットの変更がなく、終了コード1の段にある", async () => {
    const text = await read("skills/approve/SKILL.md");
    const lines = text.split("\n");
    const two = lines.find((l) => /^ {3}- 2：/.test(l));
    const one = lines.find((l) => /^ {3}- 1：/.test(l));
    expect(two, "終了コード2の行が見つかりません").toBeDefined();
    expect(one, "終了コード1の行が見つかりません").toBeDefined();
    expect(two).not.toContain("設計書がコミットされていない");
    expect(two).not.toContain("未コミットの変更がある");
    expect(one).toContain("設計書がコミットされていない");
    expect(one).toContain("未コミットの変更がある");
  });

  it("docs/spec.md：8章の integrate の行が --no-renames・送れない理由の文・送信の失敗を含む", async () => {
    const text = await read("docs/spec.md");
    const row = text
      .split("\n")
      .find((l) => l.startsWith("| `integrate 〈ID〉"));
    expect(row, "integrate の行が見つかりません").toBeDefined();
    expect(row).toContain("--no-renames 〈baseBranch〉...〈ブランチ〉");
    expect(row).toContain("送れない理由の文");
    expect(row).toContain("送信の失敗");
  });

  it("docs/spec.md：8章の new の行が片付け前の止める案内・元の名前の取り方・git branch の案内を含む", async () => {
    const text = await read("docs/spec.md");
    const row = text.split("\n").find((l) => l.startsWith("| `new --title"));
    expect(row, "new の行が見つかりません").toBeDefined();
    expect(row).toContain(
      "その前に、Orca でタスク長がもう動いているので先に止めてから流すよう1文で案内する",
    );
    expect(row).toContain(
      "元の名前は、Orca の結果、worktree の今のブランチ、`git worktree list` のその worktree の行、の順に取る",
    );
    expect(row).toContain("`git branch` で確かめて消すよう添える");
  });

  it("docs/spec.md：8章の段落が閉じのない「!」の扱いと integrate の〈すること〉の中身を含む", async () => {
    const text = await read("docs/spec.md");
    const input = text
      .split("\n")
      .find((l) => l.startsWith("**送る前の入力欄の確かめ**"));
    expect(input, "入力欄の確かめの段落が見つかりません").toBeDefined();
    expect(input).toContain(
      "閉じの横線のない「!」の行は、すぐ上の横線が入力欄の閉じの横線のとき",
    );
    expect(input).toContain("そうでなければ bash モードとして送らない");
    const reason = text
      .split("\n")
      .find((l) => l.startsWith("**送れない理由の文**"));
    expect(reason, "送れない理由の文の段落が見つかりません").toBeDefined();
    expect(reason).toContain("integrate の〈すること〉は");
    expect(reason).toContain("orca-flow tell 〈ID〉");
    expect(reason).toContain("main の取り込み");
    expect(reason).toContain("verify のやり直しと integrate-wait への戻し");
  });
});
