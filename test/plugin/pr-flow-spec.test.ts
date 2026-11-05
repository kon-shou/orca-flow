import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function loadSpec(): Promise<string> {
  return readFile(path.join(ROOT, "docs/spec.md"), "utf8");
}

/** 「## 〈番号〉. 」の見出しの行から、次の「## 」の前までを返す。 */
function chapter(text: string, no: number): { heading: string; body: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return {
    heading: lines[start] ?? "",
    body: (end < 0 ? rest : rest.slice(0, end)).join("\n"),
  };
}

// タスクの番号の形と公開から抜く文書のパスは、自分のファイルに書かないよう実行時に組む。
const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const privateDocs = `docs/${"pr-flow"}`;

describe("仕様書：15章は閉じた（移した先に文があり、15章を指す文もない）", () => {
  it("「## 15. 」の見出しも「### 15.」の小見出しもなく、最後の「## 」の見出しは14章", async () => {
    const text = await loadSpec();
    expect(text.split("\n").filter((l) => l.startsWith("## 15. "))).toEqual([]);
    expect(text).not.toMatch(/^### 15\./m);
    const headings = text.split("\n").filter((l) => l.startsWith("## "));
    expect(headings[headings.length - 1]).toBe(
      "## 14. 契約のファイル（このリポジトリの開発）",
    );
    expect(chapter(text, 14).heading).toBe(
      "## 14. 契約のファイル（このリポジトリの開発）",
    );
  });

  it("「移す先：」の行も、まだ動かないという文も、1〜14章という言い方もない", async () => {
    const text = await loadSpec();
    expect(text).not.toMatch(/^移す先：/m);
    expect(text).not.toContain("まだ動かない");
    expect(text).not.toContain("1〜14章");
    expect(text).not.toContain("まだ作っていない");
    // 16章を外したときと同じ：15章を指す文も、15.〈数〉の小節の番号もない
    expect(text).not.toMatch(/15章/);
    expect(text).not.toMatch(/(^|[^0-9.])15\.[0-9]+/m);
  });

  it("確定した名前が、移し先の章にある（pushTaskBranch は仕様書に出さない）", async () => {
    const text = await loadSpec();
    // 15章に残っていた名前：移し先の章で確かめる
    const kept: [string, number, string][] = [
      ["orca-flow pr-watch", 8, "見張り"],
      ["/orca-flow:respond", 8, "見張りの起こし方"],
      ["responding", 4, "状態の表"],
      ["send-wait", 4, "印の表"],
      ["taskEnd", 4, "状態と印の全体の文"],
      ["createPr", 8, "Orca と git の呼び出し"],
      ["markPrReady", 8, "Orca と git の呼び出し"],
    ];
    for (const [name, no, what] of kept) {
      expect(
        chapter(text, no).body,
        `${name} が${no}章（${what}）にありません`,
      ).toContain(name);
    }
    expect(text).not.toContain("pushTaskBranch");
    // 移した名前：移し先の章で確かめる
    const moved: [string, number, string][] = [
      ["orca-flow outbox", 8, "outbox と send"],
      ["orca-flow send", 8, "outbox と send"],
      ["束の指紋", 8, "outbox と send"],
      ["束の指紋", 7, "7番"],
      ["redactSecrets", 7, "秘密の伏せ字"],
      ["outbound", 6, "outbound の段落"],
      ["束の指紋", 12, "許可の ask の手順"],
      ["prWatch", 6, "prWatch の行"],
      ["risk", 6, "risk の行"],
      ["push/〈ID〉.json", 6, "push の記録"],
      ["merge-wait", 4, "マージ待ちの印"],
      ["cleanup-stopped", 4, "状態の流れ"],
    ];
    for (const [name, no, what] of moved) {
      expect(
        chapter(text, no).body,
        `${name} が${no}章（${what}）にありません`,
      ).toContain(name);
    }
  });

  it("送りの案と send の部分を15章から外し、移し先の章に置いた", async () => {
    const text = await loadSpec();
    // 15章の見出しの言い方が残っていない
    for (const gone of [
      "決まりを1つ足す（7番）",
      "節を足す：『送る前の確かめ』",
      "- `outbox add|list|show|withdraw`",
      "- `/orca-flow:send 〈ID〉`：人間が統括役のタブで打つ",
      "- 『許可の ask』",
      "| `outbound` |",
      "- 統括役の場所の確認の対象に足すのは `send` と",
      "- 『おまかせ』のスキルの扱いに足す：send は飛ばさない",
      "- 『`init`』（8章）に足す：`Bash(orca-flow send *)`",
      "- カードが「送る前の確認待ち」になったら",
      "- 時刻の窓の外で積んだ案は積んだまま残り",
    ]) {
      expect(text, `${gone} が仕様書に残っています`).not.toContain(gone);
    }
    // 移し先にある
    expect(chapter(text, 6).body).toContain(
      "**outbound**（GitHub に書く案の設定",
    );
    expect(chapter(text, 7).body).toMatch(
      /^7\. \*\*GitHub への書き込みは、送りの案を通る\*\*/m,
    );
    const c8 = chapter(text, 8).body;
    expect(c8).toContain("**outbox と send**");
    expect(c8).toContain("**送る前の確かめ**");
    expect(c8).toMatch(/^\| `outbox add/m);
    expect(c8).toMatch(/^\| `send 〈ID〉 --expect/m);
    expect(chapter(text, 10).body).toMatch(/^\| `\/orca-flow:send 〈ID〉`/m);
    expect(chapter(text, 12).body).toContain("**許可の ask**");
    // 統括役の場所の確認（send と outbox の分）：8章
    expect(c8).toMatch(
      /\*\*統括役の場所の確認\*\*（[^）]*send で行う。`outbox` は行わず/,
    );
    // 『おまかせ』の send の項：10章
    expect(chapter(text, 10).body).toMatch(/^- send：飛ばさない。/m);
    // init の ask の項：8章
    expect(c8).toContain("**init の許可の案内**");
    // 「毎回」の send の項：12章の10番
    expect(chapter(text, 12).body).toMatch(
      /^10\. \*\*PR で出すタスクの送り\*\*[^\n]*送る前の確認待ち/m,
    );
    // 送る時間帯：6章の『送る時間帯』は今は効く案がないと書く
    expect(chapter(text, 6).body).toMatch(
      /\*\*送る時間帯\*\*[^\n]*今は効く案がない/,
    );
  });

  it("決めたこと：門は許可の画面と確かめた結果、保留中のレビュー、時間帯は今は効く案がない", async () => {
    const text = await loadSpec();
    // 1. 13章に ask を確かめた結果
    const row = chapter(text, 13)
      .body.split("\n")
      .find((l) => l.includes("Bash(orca-flow send *)"));
    expect(row, "13章に ask の行がありません").toBeDefined();
    expect(row).toContain("拒否");
    expect(row).toContain("bash -c");
    // 2. 7番に保留中のレビュー
    const seven = chapter(text, 7).body;
    expect(seven).toMatch(/保留中[^\n]*承認なしで CLI から許す/);
    expect(seven).toMatch(/本投稿[^\n]*send/);
    // 3. 時間帯は今は効く案がない（6章・8章の確かめ・13章に時間帯の行がない）
    const six = chapter(text, 6).body;
    expect(six).toMatch(/\*\*送る時間帯\*\*[^\n]*今は効く案がない/);
    expect(six).toContain("人が打つ `send` は今までどおり窓を見ない");
    expect(six).not.toContain(
      "窓で止めるのは、見張りが自分で送る `pr-ready` だけ（",
    );
    expect(chapter(text, 8).body).toMatch(
      /4\. 送る時間帯[^\n]*確かめない[^\n]*書いてあっても誤りにしない/,
    );
    expect(chapter(text, 13).body).not.toContain("時間帯の外で積んだ案");
  });

  it("仮の名前と古い言い方が仕様書に残っていない", async () => {
    const text = await loadSpec();
    for (const old of ["finish-stuck", "merged.jsonl", "名前は仮"]) {
      expect(text, `${old} が仕様書に残っています`).not.toContain(old);
    }
    // 古い名前の redact.ts だけを見る（伏せ字の中身を置く src/common/redact.ts を7章7番に書く作業があり、それは正しい名前なので当てない）
    expect(text, "redact.ts が仕様書に残っています").not.toMatch(
      /(?<!common\/)redact\.ts/,
    );
  });

  it("前から allow に入れている人が send を ask に足す手順が12章にある", async () => {
    const c = chapter(await loadSpec(), 12);
    const lines = c.body
      .split("\n")
      .filter(
        (l) =>
          l.includes("Bash(orca-flow *)") &&
          l.includes("Bash(orca-flow send *)") &&
          l.includes("allow") &&
          l.includes("ask"),
      );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/前から|すでに/);
  });

  it("状態とカードの印を「taskEnd が pr のときだけ」に絞る文がなく、4章に「taskEnd によらず」の全体の1文と integrate のリポジトリの扱いがある", async () => {
    const text = await loadSpec();
    const c4 = chapter(text, 4).body;
    // 全体：「taskEnd が "pr" のときだけ」の形がない
    expect(text).not.toMatch(
      /taskEnd[`\s]*(が|:)[`\s]*"pr"[`\s]*(の|で)[^。\n]*(ときだけ|場合だけ|ときに限|のみ)/,
    );
    const line = c4.split("\n").find((l) => /taskEnd[^。\n]*によらず/.test(l));
    expect(line, "4章に「taskEnd によらず」の文がありません").toBeDefined();
    expect(line).toContain("push で PR を出したタスク");
    expect(line).toContain("作業中のタスクのブランチの PR");
    expect(line).toContain('"integrate"');
    expect(line).toContain("automation があれば見張られる");
    const narrowing = c4
      .split("\n")
      .filter(
        (l) =>
          l.includes("taskEnd") &&
          /"?\bpr\b"?/.test(l) &&
          /だけ|のみ|限/.test(l),
      );
    expect(narrowing).toEqual([]);
  });

  it("まだ確かめていないこと（旧15.9）の行は13章にあり、「### 15.9」はない", async () => {
    const text = await loadSpec();
    expect(text).not.toMatch(/^### 15\.9/m);
    for (const key of [
      "orca terminal close",
      "agent launch",
      "bypass permissions",
      "閉じたタスク長の会話",
      "worktree set --pr",
      "今すぐ実行",
      "--match-head-commit",
      "マージの方式",
    ]) {
      expect(chapter(text, 13).body, `${key} の行が13章にありません`).toContain(
        key,
      );
    }
  });

  it("1章・2章・8章に、15章を指す行も「まだ作っていない」の行もない", async () => {
    const text = await loadSpec();
    for (const no of [1, 2, 8]) {
      const c = chapter(text, no);
      const hit = c.body
        .split("\n")
        .filter((l) => l.includes("15章") || l.includes("まだ作っていない"));
      expect(hit, `${no}章に15章を指す行があります`).toEqual([]);
    }
  });

  it("8章の push の節の最後の行は、15章を指さず、見張りが respond で起こす文", async () => {
    const c = chapter(await loadSpec(), 8);
    const lines = c.body.split("\n");
    const start = lines.findIndex((l) => l.startsWith("**push（PR の道）**"));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex(
      (l, i) =>
        i > start &&
        (l.startsWith("**見張り（pr-watch）**") ||
          l.startsWith("**おまかせ**")),
    );
    expect(end).toBeGreaterThan(start);
    const section = lines.slice(start, end).filter((l) => l.trim() !== "");
    const last = section[section.length - 1] ?? "";
    expect(last).not.toContain("15章");
    expect(last).toContain("/orca-flow:respond 〈ID〉");
    expect(last).toContain("保留中のレビュー");
    expect(last).toContain("send を通る");
  });

  it("spec.md 全体にタスクの番号の形と、公開から抜く文書のパスがない", async () => {
    const text = await loadSpec();
    expect(text.split("\n").filter((l) => idForm.test(l))).toEqual([]);
    expect(text).not.toContain(privateDocs);
  });
});

describe("仕様書：15章の中身を1・2・4・8章へ移した", () => {
  it("2章に、送ったあとの流れ（見張り・respond・保留中のレビューの下書き・合議・send の繰り返し・マージ待ち・merge --head）があり、8章を指す", async () => {
    const c2 = chapter(await loadSpec(), 2).body;
    for (const word of [
      "見張り（Orca の automation）",
      "/orca-flow:respond 〈ID〉",
      "保留中のレビューに下書き",
      "人が見る段",
      "合議（2票目",
      "tell と同じ道で送り",
      "/orca-flow:send 〈ID〉 …（繰り返し）",
      "カード「マージ待ち」",
      "merge 〈ID〉 --head 〈見せた先頭〉",
      "8章の『見張り（pr-watch）』『起こし方』",
    ]) {
      expect(c2, `2章に ${word} がありません`).toContain(word);
    }
    expect(c2).not.toContain("生きたタスク長がいれば tell、");
    // 順：人に聞く → 直して verify → 下書き → 人が見る段 → 案を積む → send
    const order = [
      "人に聞く",
      "直して verify",
      "保留中のレビューに下書き",
      "人が見る段",
      "OK なら、返信・直しの push の案を積む",
      "send 〈ID〉 …（繰り返し）",
    ].map((w) => c2.indexOf(w));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("4章に古い文（後の実装・まだ動かない）がなく、4つの直した文がある", async () => {
    const c4 = chapter(await loadSpec(), 4).body;
    expect(c4).not.toContain("後の実装");
    expect(c4).not.toContain("まだ動かない");
    expect(c4).toContain(
      "`responding` はタスク長が respond の手順で付け、見張りと `send` は付けない",
    );
    expect(c4).not.toContain(
      "承認した先頭と今の先頭が違うとき、送る前の確認待ちに戻す",
    );
    expect(c4).toContain(
      "見張りがレビュー待ちを付け、指摘対応中は respond が付ける",
    );
    expect(c4).toContain("見張りの背景もこの道（`cardForPushWatch`）を通る");
  });

  it("8章『Orca と git の呼び出し』に、GitHub への書き込みを集める場所と呼ぶ道がある", async () => {
    const c8 = chapter(await loadSpec(), 8).body;
    const at = c8.indexOf("**Orca と git の呼び出し**");
    expect(at).toBeGreaterThanOrEqual(0);
    const rest = c8.slice(at + 1);
    const next = rest.search(/^\*\*/m);
    const calls = c8.slice(at, next < 0 ? undefined : at + 1 + next);
    const para = calls
      .split("\n")
      .find((l) => l.startsWith("GitHub への書き込み"));
    expect(para).toBeDefined();
    for (const word of [
      "`src/lib/github.ts`",
      "`sendItems`",
      "`pushApprovedSha`",
      "`createPr`",
      "`markPrReady`",
      "`submitPendingReview`",
      "`requestReviewers`",
      "`mergePr`",
      "`respond draft`",
      "`push 〈ID〉 --branch`",
      "7章7番",
    ]) {
      expect(para, `${word} がありません`).toContain(word);
    }
    // 送りの案の関数の言い切りは --branch を除く。merge は7章7番の例外ではなく、送りの案にしない
    expect(para).toContain("`push 〈ID〉 --branch` を除き");
    expect(para).toContain("`mergePr` は送りの案にせず、`merge` だけが呼ぶ");
  });

  it("8章に「拾って直す仕組みはない」がなく、/orca-flow:respond で起こす文があり、『outbox と send』に「背景の待ち受けを起こす」がない", async () => {
    const c8 = chapter(await loadSpec(), 8).body;
    expect(c8).not.toContain("拾って直す仕組みはない");
    expect(c8).toMatch(
      /見張りが `\/orca-flow:respond 〈ID〉` でタスク長を起こして回す/,
    );
    const at = c8.indexOf("**outbox と send**");
    expect(at).toBeGreaterThanOrEqual(0);
    const rest = c8.slice(at + 1);
    const next = rest.search(/^\*\*/m);
    const part = c8.slice(at, next < 0 ? undefined : at + 1 + next);
    expect(part).not.toContain("背景の待ち受けを起こす");
    expect(c8).not.toContain("送り終えたあとに背景の待ち受けを起こす（");
  });

  it("6章の prReady は読み飛ばし、7章7番の例外は2つ、8章の関数の並びは createPr で createDraftPr がない", async () => {
    const text = await loadSpec();
    const six = chapter(text, 6).body;
    const row = six.split("\n").find((l) => l.startsWith("| prReady")) ?? "";
    expect(row).toContain("読み飛ばし");
    expect(row).toContain("設定の誤りにしない");
    const seven = chapter(text, 7).body;
    expect(seven).toMatch(/例外は2つ。1つ目：[^\n]*2つ目：/);
    expect(seven).not.toMatch(/3つ目/);
    const c8 = chapter(text, 8).body;
    const para =
      c8.split("\n").find((l) => l.startsWith("GitHub への書き込み")) ?? "";
    expect(para).toContain("`createPr`");
    expect(para).toContain("`markPrReady`");
    expect(para).not.toContain("createDraftPr");
    // 仕様書のどこにも、消した関数名・CI 待ちの案・--after-ci の使い方は残らない
    expect(text).not.toContain("createDraftPr");
    expect(text).not.toContain("PR を下書きで作成");
    expect(c8).toContain("`--after-ci` はなくなり");
    expect(six).toContain("`--after-ci` はなくなり");
    // 見張りは下書きを外さない。古い記録は読み飛ばす
    expect(c8).toContain("通っても下書きを外さない");
    expect(six).toContain("`releasePending`・`releaseStop` は読み飛ばす");
    expect(c8).not.toContain("下書きの解除を断られたとき");
  });

  it("1章は、承認なしには同僚に見える書き込みをしない（7章7番の例外）と書き、GitHub に書かないとは書かない", async () => {
    const c1 = chapter(await loadSpec(), 1).body;
    expect(c1).not.toContain("承認なしには GitHub に書かない");
    expect(c1).toContain(
      "承認なしには、同僚に見える書き込みをしない（例外は7章7番）",
    );
  });
});

describe("仕様書：マージは orca-flow merge の1本だけ（15章から移した）", () => {
  it("マージの分（『マージの前の確かめ』・merge の行・ブランチの保護・Bash(orca-flow merge *)）は移した先にあり、「GitHub でマージ」「GitHub で行う」の文はない", async () => {
    const text = await loadSpec();
    const c8 = chapter(text, 8).body;
    for (const word of [
      "『マージの前の確かめ』",
      "merge 〈ID〉 --show",
      "merge 〈ID〉 --head",
      "Bash(orca-flow merge *)",
      "`merge-wait`",
    ]) {
      expect(
        c8 + chapter(text, 4).body,
        `${word} が移した先にありません`,
      ).toContain(word);
    }
    expect(text).toContain("GitHub の画面からマージしない");
    // 「依存先が GitHub でマージ済み」は別の文なので除く
    expect(text).not.toMatch(/GitHub でマージ(?!済み)/);
    expect(text).not.toContain("GitHub で行う");
  });

  it("7章の7番と12章に「GitHub の画面からマージしない」があり、8章に merge の節がある", async () => {
    const text = await loadSpec();
    for (const no of [7, 12]) {
      expect(chapter(text, no).body, `${no}章にありません`).toContain(
        "GitHub の画面からマージしない",
      );
    }
    const c8 = chapter(text, 8).body;
    expect(c8).toContain("**merge（マージ）**");
    expect(c8).toMatch(/^\| `merge 〈ID〉 \[--show/m);
    expect(c8).toContain("--match-head-commit");
    expect(c8).toContain("--drop-depend");
  });

  it("8章の『マージの前の確かめ』に、依存・マージの順・全員 OK・先頭・finishMergedTask の語と終了コードがある", async () => {
    const c8 = chapter(await loadSpec(), 8).body;
    const at = c8.indexOf("**マージの前の確かめ**");
    expect(at).toBeGreaterThanOrEqual(0);
    const rest = c8.slice(at + 1);
    const next = rest.search(/^\*\*/m);
    const check = c8.slice(at, next < 0 ? undefined : at + 1 + next);
    for (const word of [
      "依存",
      "マージの順",
      "全員 OK",
      "先頭",
      "reviewDecision",
      "origin/〈baseBranch〉",
      "終了コード",
    ]) {
      expect(check, `${word} がありません`).toContain(word);
    }
    expect(check).toContain("cleanupMergedPr");
    expect(check).toContain("finishMergedTask");
    const line = c8
      .split("\n")
      .find((l) => l.startsWith("- `merge 〈ID〉 --head"));
    expect(line).toBeDefined();
    expect(line).toContain("cleanupMergedPr");
    expect(line).toContain("finishMergedTask");
  });

  it("6章の outbound の既定の許可リストに merge がなく、入れると設定の誤りと書いてある", async () => {
    const row = chapter(await loadSpec(), 6)
      .body.split("\n")
      .find((l) => l.startsWith("**outbound**"));
    expect(row).toBeDefined();
    const allow = /"allow":\s*\[([^\]]*)\]/.exec(row ?? "");
    expect(allow).not.toBeNull();
    expect(allow?.[1]).not.toContain("merge");
    expect(row).toMatch(/`allow` に `merge` を入れると設定の誤り/);
  });

  it("6章に依存の記録、4章に merge-wait の行がある", async () => {
    const text = await loadSpec();
    const c6 = chapter(text, 6).body;
    expect(c6).toContain("**依存の記録**");
    expect(c6).toContain("depends/〈ID〉.json");
    expect(chapter(text, 4).body).toMatch(/^\s*\| merge-wait\s+\|/m);
  });

  it("1・2・8章に15章を指す行はなく、merge は orca-flow merge の1本で書く。12章の PR で統合する道に merge を指す一言がある", async () => {
    const text = await loadSpec();
    for (const no of [1, 2, 8]) {
      const lines = chapter(text, no)
        .body.split("\n")
        .filter((l) => l.includes("15章") && l.includes("まだ作っていない"));
      expect(lines, `${no}章に15章を指す行があります`).toEqual([]);
    }
    expect(chapter(text, 8).body).toContain("orca-flow merge");
    const para = chapter(text, 12)
      .body.split("\n")
      .find((l) => l.startsWith("**PR で統合する道**"));
    expect(para).toBeDefined();
    expect(para).toContain("/orca-flow:merge");
  });
});

describe("仕様書：権限を飛ばす形と前から allow の人の手順に merge がある", () => {
  it("12章の前から allow の人の手順に Bash(orca-flow merge *) がある", async () => {
    const c = chapter(await loadSpec(), 12);
    const lines = c.body
      .split("\n")
      .filter(
        (l) =>
          l.includes("Bash(orca-flow *)") &&
          l.includes("allow") &&
          l.includes("ask") &&
          /前から|すでに/.test(l),
      );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("Bash(orca-flow merge *)");
  });

  it("「send を使わない」で merge を伴わない形が仕様書に残っていない。12章は send と merge を使わないと書く", async () => {
    const text = await loadSpec();
    // 13章の表は、権限を飛ばす形で確かめた結果を書くので、1〜12章で見る
    const upTo12 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      .map((no) => chapter(text, no).body)
      .join("\n");
    const bad = upTo12
      .split("\n")
      .filter(
        (l) => /send を使わない/.test(l) && !/send と merge を使わない/.test(l),
      );
    expect(bad).toEqual([]);
    expect(chapter(text, 12).body).toContain("send と merge を使わない");
  });

  it("マージの順に当たる3番は、7章の見出しの名前で、merge が止まる形を書く", async () => {
    const seven = chapter(await loadSpec(), 7).body;
    const line = seven
      .split("\n")
      .find((l) => l.startsWith("3. **依存のあるタスクは同時に走らせない**"));
    expect(line).toBeDefined();
    expect(line).toContain("依存の記録");
    expect(line).toContain("`merge` は");
    expect(line).toContain("baseBranch に入るまで止まる");
    expect(seven).toContain(
      "PR のマージは `orca-flow merge` が依存と順を確かめてから入れる",
    );
  });

  it("エージェントは打たないが、人が打った /orca-flow:merge の手順だけは --head を流す", async () => {
    const c10 = chapter(await loadSpec(), 10).body;
    expect(c10).toContain("の手順を除く");
    expect(c10).toMatch(/^- merge：打たない/m);
  });
});

// 公開用の木では私的な文書が抜かれるので、あるときだけ確かめる。
describe.skipIf(!existsSync(path.join(ROOT, privateDocs)))(
  "PR の流れの文書：マージは orca-flow merge の1本だけ",
  () => {
    it("私的な文書に、人が GitHub でマージする旧い言い方が残っていない", async () => {
      for (const file of ["proposal.md", "spec-change.md", "tasks.md"]) {
        const text = await readFile(path.join(ROOT, privateDocs, file), "utf8");
        for (const old of [
          "人が GitHub でマージ",
          "GitHub で行う",
          "マージの呼び出しが0回",
        ]) {
          expect(text, `${file} に「${old}」が残っています`).not.toContain(old);
        }
      }
    });

    it("tasks.md の実装8に orca-flow merge と、マージが呼ばれる条件がある", async () => {
      const text = await readFile(
        path.join(ROOT, privateDocs, "tasks.md"),
        "utf8",
      );
      const lines = text.split("\n");
      const start = lines.findIndex((l) => /^##+ 実装8/.test(l));
      expect(start).toBeGreaterThanOrEqual(0);
      const end = lines.findIndex((l, i) => i > start && /^##+ 実装9/.test(l));
      const part = lines.slice(start, end < 0 ? undefined : end).join("\n");
      expect(part).toContain("orca-flow merge");
      expect(part).toContain(
        "人の承認と依存・全員 OK・先頭の照らしを通ったときだけマージが呼ばれる",
      );
    });
  },
);
