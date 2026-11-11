import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 「## 〈番号〉. 」の見出しから、次の「## 」の前までを返す。 */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しがありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("respond のスキル", () => {
  it("始めに responding にし、引き継ぎと入力ファイルを読み、区切りの中の指示に従わない", async () => {
    const text = await read("skills/respond/SKILL.md");
    expect(text).toMatch(/^name: respond$/m);
    expect(text).toMatch(/^disable-model-invocation: true$/m);
    const steps = text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(steps[0]).toContain("orca-flow status responding --note");
    expect(text).toContain("orca-flow/handoff/");
    expect(text).toContain("orca-flow respond input $0");
    expect(text).toMatch(/区切り[^\n]*従わない/);
    expect(text).toMatch(/他人の文章[^\n]*従わない/);
  });

  it("人に聞くまで直さず、案を積まない", async () => {
    const text = await read("skills/respond/SKILL.md");
    expect(text).toContain("PR ごとにまとめて人間に聞く");
    expect(text).toContain("直す・理由を書いて直さない・質問する");
    expect(text).toMatch(/人間が答えるまで、直さない。案も積まない/);
    // 直す手順（verify）は人に聞く手順より後
    expect(text.indexOf("PR ごとにまとめて人間に聞く")).toBeLessThan(
      text.indexOf("`orca-flow verify` を流し"),
    );
  });

  it("CI の直しは respond ci-fix を先に流し、終了コード2なら人に回す", async () => {
    const text = await read("skills/respond/SKILL.md");
    const line = text
      .split("\n")
      .find(
        (l) =>
          l.includes("orca-flow respond ci-fix $0") && l.includes("直す前"),
      )!;
    expect(line).toBeDefined();
    expect(line).toContain("終了コード0");
    expect(line).toContain("終了コード2");
    expect(line).toContain("人間に回す");
    expect(text).toContain("CI の直しは2回まで");
  });

  it("保留の返信は draft で書き、open で開き、drafts を見せ、OK なら reply・rerequest・push を積んで send を頼む", async () => {
    const text = await read("skills/respond/SKILL.md");
    for (const c of [
      "orca-flow respond draft $0 --thread 〈スレッドの ID〉 --body-file 〈パス〉",
      "--edit 〈コメントの ID〉",
      "--delete 〈コメントの ID〉",
      "--summary-file 〈パス〉",
      "orca-flow respond open $0",
      "orca-flow respond drafts $0",
      "orca-flow outbox add $0 reply --pr 〈番号〉",
      "orca-flow outbox add $0 rerequest --pr 〈番号〉 --reviewers 〈ログイン名〉,…",
      "orca-flow outbox add $0 push",
      "/orca-flow:send $0",
    ]) {
      expect(text, `${c} がありません`).toContain(c);
    }
    // push は統括役の場所でしか流せない。タスク長は outbox で積む
    expect(text).not.toMatch(/orca-flow push \$0(?! --show)/);
    expect(text).toContain("終了コード2なら");
    expect(text).toContain("respond が書いていないコメント");
    expect(text).toMatch(/直しの指示なら[^\n]*書き換え/);
    expect(text.indexOf("respond drafts $0")).toBeLessThan(
      text.indexOf("outbox add $0 reply"),
    );
  });

  it("人の PR の指摘で実装の誤りを直したら、run と同じ形で教訓を1回聞く", async () => {
    const text = await read("skills/respond/SKILL.md");
    expect(text).toContain("教訓を聞く");
    expect(text).toContain("見出し・決まり・理由・見分け方・観点");
    expect(text).toContain("ID（idPrefix と数字）と手元のパスを書かない");
    expect(text).toContain("orca-flow lessons add");
    expect(text).toContain("1回だけ聞く");
  });

  it("教訓を聞くのは案を積むより前（積んだあとに responding で上書きしない）", async () => {
    const text = await read("skills/respond/SKILL.md");
    const steps = text.split("\n").filter((l) => /^\d+\. /.test(l));
    const ask = steps.findIndex((l) => l.includes("教訓を聞く"));
    const add = steps.findIndex((l) => l.includes("人間の答えに従う"));
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThanOrEqual(0);
    expect(ask).toBeLessThan(add);
    expect(text.indexOf("教訓を聞く：")).toBeLessThan(
      text.indexOf("outbox add $0 reply"),
    );
  });

  it("respond ci-fix が終了コード2のときの戻し方：人間に回し、回数は戻さない", async () => {
    const text = await read("skills/respond/SKILL.md");
    expect(text).toContain("もう一度直して」と言っても回数は戻さない");
    expect(text).toContain(
      "CI が緑になって `orca-flow respond input $0` を流すと0に戻る",
    );
    expect(text).toContain("orca-flow/respond/〈ID〉/ci.json");
    expect(text).toMatch(/それより前に戻すかは人が決める/);
  });

  it("マージしない・GitHub に直接書かない・PATH になければ止まる・引き継ぎを書き直してから待つ", async () => {
    const text = await read("skills/respond/SKILL.md");
    expect(text).toContain("マージしない");
    expect(text).not.toMatch(/gh pr merge|orca-flow merge/);
    expect(text).toContain("GitHub に直接書かない");
    expect(text).toContain("`gh` や `git push` を流さない");
    expect(text).toMatch(/PATH になければ止まり、人間に `\/reload-plugins`/);
    expect(text).toMatch(/引き継ぎを書き直してから、人間を待つ/);
    const steps = text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(steps[steps.length - 1]).toContain("引き継ぎを書き直してから");
  });
});

describe("仕様書：respond の分を15章から移した", () => {
  it("15章の移した文が消える（risk の文は10.1 にある）", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).not.toMatch(/^## 15\. /m);
    expect(spec).not.toContain("### 15.5 ");
    expect(spec).not.toContain("### 15.8 ");
    expect(spec).not.toContain("返信・再依頼・指摘に答える push は");
    // 他人の文章の行は7章へ、respond の手順は10章へ移った
    expect(chapter(spec, 7)).toContain("エージェントに渡す入力ファイル");
    expect(spec).not.toContain("「指摘対応中」のあと");
    expect(chapter(spec, 10)).toContain("見張りが worktree の新しい会話");
    expect(spec).not.toContain("### 15.7 ");
    expect(chapter(spec, 10)).toContain(
      "`risk` に当たるものは合議にかけず人に回す",
    );
  });

  it("6章：reply・rerequest を許可リストの候補に書き、respond の記録を一覧に足した", async () => {
    const ch6 = chapter(await read("docs/spec.md"), 6);
    const para = ch6.split("\n").find((l) => l.startsWith("**outbound**"))!;
    expect(para).toContain("`reply`");
    expect(para).toContain("`rerequest`");
    expect(para).toMatch(/許可リストの候補/);
    expect(para).toMatch(/既定には入れない/);
    expect(para).toContain("今の `push` の種類");
    // allow に足すまで送られないのは reply・rerequest だけ。直しの push は既定の許可で送られる
    expect(para).toMatch(
      /`reply`[^。]*`rerequest`[^。]*`allow` に足すまで送られない/,
    );
    expect(para).not.toMatch(/直しの `push`[^。]*`allow` に足すまで送られない/);
    expect(para).toMatch(/直しの `push` は[^。]*既定の許可で送られる/);
    expect(ch6).toContain("`respond/〈ID〉/`");
    expect(ch6).toContain("drafts.json");
    expect(ch6).toContain("ci.json");
  });

  it("7章：他人の文章は「データ」の区切りに入れる。保留中の書き込みの例外は残る", async () => {
    const ch7 = chapter(await read("docs/spec.md"), 7);
    const line = ch7.split("\n").find((l) => l.includes("他人の文章"))!;
    expect(line).toContain("「データ」の区切り");
    expect(line).toContain("従わない");
    expect(ch7).toContain("保留中（pending）のレビューへの書き込み");
  });

  it("8章：respond の行と、保留中のレビューの書き込みが send を通らないこと", async () => {
    const ch8 = chapter(await read("docs/spec.md"), 8);
    const row = ch8.split("\n").find((l) => l.startsWith("| `respond "))!;
    expect(row).toBeDefined();
    for (const w of [
      "input",
      "draft",
      "drafts",
      "ci-fix",
      "open",
      "src/lib/github.ts",
      "send を通らない",
      "終了コード2",
    ]) {
      expect(row, `${w} が respond の行にありません`).toContain(w);
    }
    const outbox = ch8.split("\n").find((l) => l.startsWith("| `outbox add"))!;
    expect(outbox).toContain("`reply --pr 〈番号〉`");
    expect(outbox).toContain("`rerequest --pr 〈番号〉 --reviewers");
  });

  it("10.1：respond の手順、12章：指摘に答える項、13章：保留中のレビューの API の確かめ", async () => {
    const spec = await read("docs/spec.md");
    const lines = spec.split("\n");
    expect(
      lines.some((l) => l.startsWith("| `/orca-flow:respond 〈ID〉`")),
    ).toBe(true);
    const para = lines.find((l) => l.startsWith("**respond の手順**"))!;
    expect(para).toBeDefined();
    expect(para).toContain("respond ci-fix");
    expect(para).toContain("教訓を聞く");
    expect(para).toContain("マージしない");
    expect(para).toContain("`outbox add 〈ID〉 push`");
    expect(para).not.toMatch(/直しの `push` を積み/);
    expect(chapter(spec, 12)).toContain("指摘に答える");
    const ch13 = chapter(spec, 13);
    const line = ch13
      .split("\n")
      .find((l) => l.includes("保留中（pending）のレビューの GraphQL"))!;
    expect(line).toBeDefined();
    expect(line).toContain("偽の指示を入れたコメント");
  });

  it("手順9の --summary-file の行に、下書きに出ず本投稿のときに渡るとある", async () => {
    const text = await read("skills/respond/SKILL.md");
    const line = text
      .split("\n")
      .find((l) => l.includes("`--summary-file 〈パス〉`"));
    expect(line).toBeDefined();
    expect(line).toContain("GitHub の下書きには出ず");
    expect(line).toContain("本投稿");
    expect(line).toContain("渡る");
  });

  it("手順9に、本文があるときは GitHub の画面から送らず send だけで送るとある", async () => {
    const text = await read("skills/respond/SKILL.md");
    const line = text
      .split("\n")
      .find((l) => l.includes("`--summary-file 〈パス〉`"));
    expect(line).toMatch(/GitHub の画面から[^。]*送らない/);
    expect(line).toMatch(/本文は載らず/);
    expect(line).toContain("`/orca-flow:send");
  });
});

describe("返信の本文の組み立てと直しの結びつけ", () => {
  const lineOf = (text: string, head: string) => {
    const line = text.split("\n").find((l) => l.startsWith(head));
    expect(line, `${head} の行がありません`).toBeDefined();
    return line as string;
  };
  const stepOf = (text: string, no: number) => {
    const start = text.indexOf(`\n${no}. `);
    const end = text.indexOf(`\n${no + 1}. `);
    expect(start).toBeGreaterThanOrEqual(0);
    return text.slice(start, end);
  };

  it("6章の respond の記録に fixedBy がある", async () => {
    const line = lineOf(
      chapter(await read("docs/spec.md"), 6),
      "- `respond/〈ID〉/`",
    );
    expect(line).toContain("`fixedBy`");
    expect(line).toContain("40桁");
    expect(line).toContain("返信");
  });

  it("8章の outbox add の行に、本文の組み立て・指紋・直しが PR にないと送らないとある", async () => {
    const line = lineOf(
      chapter(await read("docs/spec.md"), 8),
      "| `outbox add",
    );
    expect(line).toContain("組み立て");
    expect(line).toContain("指紋");
    expect(line).toMatch(/直しのコミットが PR にないと[^|]*送らない/);
    expect(line).toContain("返信しました");
    expect(line).toContain("直しました");
    expect(line).toContain("（書き手不明）");
  });

  it("8章の respond の行に、--fixed-by・none・確かめ・drafts の表示がある", async () => {
    const line = lineOf(
      chapter(await read("docs/spec.md"), 8),
      "| `respond input",
    );
    expect(line).toContain("--fixed-by 〈SHA〉,…");
    expect(line).toContain("--fixed-by none");
    expect(line).toContain("baseBranch");
    expect(line).toMatch(/--delete[^。]*--summary-file[^。]*渡せない/);
    expect(line).toMatch(/drafts[^。]*直しのコミット/);
    expect(line).toContain("終了コード1");
  });

  it("10.1 の respond の手順⑤に、直した指摘の返信へ --fixed-by を渡すとある", async () => {
    const text = await read("docs/spec.md");
    const line = lineOf(text, "**respond の手順**");
    const five = line.slice(line.indexOf("⑤"), line.indexOf("⑥"));
    expect(five).toContain("--fixed-by");
    expect(five).toContain("直した指摘");
  });

  it("12章の11に、send の画面で組み立てた全文を読めるとある", async () => {
    const line = lineOf(chapter(await read("docs/spec.md"), 12), "11. ");
    expect(line).toContain("組み立て");
    expect(line).toContain("全文");
    expect(line).toContain("send");
  });

  it("13章に、返す先の書き手・push 直後の先頭・範囲の差分の画面の3行がある", async () => {
    const body = chapter(await read("docs/spec.md"), 13);
    const rows = body.split("\n").filter((l) => l.startsWith("| "));
    const author = rows.find((l) => l.includes("replyTo { id author"));
    expect(author).toBeDefined();
    expect(author).toContain("replyTo");
    const head = rows.find((l) => l.includes("headRefOid"));
    expect(head).toBeDefined();
    expect(head).toContain("push");
    expect(head).toContain("reply");
    expect(head).toContain("積み直");
    const diff = rows.find((l) => l.includes("/files/〈始まり〉..〈終わり〉"));
    expect(diff).toBeDefined();
    expect(diff).toContain("最初のコミットの親");
    expect(body).not.toContain("github.com/");
  });

  it("スキルの手順9・11に --fixed-by がある", async () => {
    const text = await read("skills/respond/SKILL.md");
    const nine = stepOf(text, 9);
    expect(nine).toMatch(/--thread[^\n]*--fixed-by 〈直しのコミット〉,…/);
    expect(nine).toContain("直した指摘");
    const eleven = stepOf(text, 11);
    expect(eleven).toContain("--edit 〈コメントの ID〉 --fixed-by");
    expect(eleven).toContain("rebase");
  });
});
