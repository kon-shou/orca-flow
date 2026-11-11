import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 「## 〈番号〉. 」の見出しの行から、次の「## 」の前までを返す。 */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 「**〈名前〉**」で始まる段から、次の「**」で始まる行の前までを返す。 */
function part(text: string, head: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`**${head}**`));
  expect(start, `${head} の段がありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("**"));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

const OPEN = "`<!-- orca-flow:captures 〈録画全体の sha256 の頭16桁〉 -->`";
const CLOSE = "`<!-- /orca-flow:captures -->`";

const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

describe("仕様書：録画を PR に載せる（6章）", () => {
  it("outbound に、pr-edit が許可リストの候補で既定に入れないとある", async () => {
    const six = chapter(await read("docs/spec.md"), 6);
    const para = six.split("\n").find((l) => l.startsWith("**outbound**"));
    expect(para).toBeDefined();
    expect(para).toMatch(/`pr-edit`[^。]*`allow` に足すまで送られない/);
    expect(para).toMatch(/`pr-edit`[^。]*既定には入れない/);
    // 既定値の並びは変えない
    expect(para).toContain('"allow": ["push", "pr-create", "pr-ready"]');
  });

  it("録画の置き場に、push が PR に載せることと、送る前に人が録画を開いて見ることがある", async () => {
    const six = chapter(await read("docs/spec.md"), 6);
    const para =
      six.split("\n").find((l) => l.startsWith("**録画の置き場**")) ?? "";
    for (const w of [
      "push",
      "`pr-edit`",
      "秘密が写りうる",
      "send の前",
      "開いて見る",
      "`outbox show`",
    ]) {
      expect(para, w).toContain(w);
    }
  });

  it("送りの案の記録に、録画の一覧を指紋に入れることがある", async () => {
    const six = chapter(await read("docs/spec.md"), 6);
    const line = six
      .split("\n")
      .find((l) => l.startsWith("- `outbox/〈ID〉/`"));
    expect(line).toBeDefined();
    expect(line).toMatch(/録画の一覧（ファイル名・大きさ・sha256）/);
  });
});

describe("仕様書：録画を PR に載せる（7章7番）", () => {
  it("対象に PR の本文の録画の直しがある", async () => {
    const seven = chapter(await read("docs/spec.md"), 7);
    const line = seven.split("\n").find((l) => l.startsWith("7. ")) ?? "";
    expect(line).toMatch(
      /対象は push・PR の作成・下書きを外す・PR の本文の録画の直し（`pr-edit`）・返信・再依頼。/,
    );
  });
});

describe("仕様書：録画を PR に載せる（8章）", () => {
  it("push の行と outbox の行に、録画と pr-edit がある", async () => {
    const lines = chapter(await read("docs/spec.md"), 8).split("\n");
    const push =
      lines.find((l) => l.startsWith("| `push 〈ID〉 [--body-file")) ?? "";
    expect(push).toContain("録画");
    expect(push).toContain("`pr-edit`");
    const outbox = lines.find((l) => l.startsWith("| `outbox add")) ?? "";
    expect(outbox).toMatch(/`outbox add 〈ID〉 pr-edit` は終了コード1/);
    expect(outbox).toContain("push が積みます");
  });

  it("push（PR の道）の録画の箇条に、拾い方・印・警告・gh の版・pr-edit がある", async () => {
    const pr = part(chapter(await read("docs/spec.md"), 8), "push（PR の道）");
    const item =
      pr.split("\n").find((l) => l.startsWith("- 録画を載せる：")) ?? "";
    expect(item, "録画を載せる箇条がありません").not.toBe("");
    for (const w of [
      "e2e-captures/〈ID〉/",
      "前と後がそろった流れだけ",
      "名前の順",
      "10,000,000 バイト",
      "流れの名前",
      OPEN,
      CLOSE,
      "ファイル名だけ",
      "手元のパスを書かない",
      "ファイル名・大きさ・sha256",
      "録画のない案の指紋は今までと同じ",
      "`gh --version` が 2.99.0 より古い",
      "github.com でない",
      "録画なしで案を積み",
      "終了コードは変えない",
      "`pr-edit`",
      "先頭が変わっていない2回目",
      "同じなら積まない",
      "末尾に足した",
      "読んだ本文の sha256",
      "`outbound.allow` に `pr-edit` がなければ積まず",
      "今の節は消さない",
      "GitHub に書かない",
    ]) {
      expect(item, w).toContain(w);
    }
  });

  it("outbox と send に、送る順・添付の送り方・editPrBody・show の録画の一覧がある", async () => {
    const os = part(chapter(await read("docs/spec.md"), 8), "outbox と send");
    expect(os).toContain("送る順は push → PR の作成 → 下書きを外す → ほか");
    expect(os).toMatch(/`pr-edit` は「ほか」の先頭/);
    const item =
      os.split("\n").find((l) => l.startsWith("- 録画の添付：")) ?? "";
    expect(item, "録画の添付の箇条がありません").not.toBe("");
    for (const w of [
      "一時ディレクトリ",
      "sha256",
      "何も書かずに「送らなかった」",
      "`createPr`",
      "`--attach 〈ファイル名〉`",
      "`editPrBody`",
      "`gh pr edit 〈番号〉 --body-file … --attach …`",
      "読み直して",
      "2.99.0",
      "github.com",
    ]) {
      expect(item, w).toContain(w);
    }
    const add =
      os.split("\n").find((l) => l.startsWith("- `orca-flow outbox add")) ?? "";
    for (const w of [
      "録画の一覧（流れ・前か後か・大きさ・手元のパス）",
      "GitHub には送らない",
      "開いて見る",
    ]) {
      expect(add, w).toContain(w);
    }
  });

  it("GitHub への書き込みの関数の並びに editPrBody がある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const para =
      c8.split("\n").find((l) => l.startsWith("GitHub への書き込み")) ?? "";
    expect(para).toMatch(/`createPr`・`markPrReady`・`editPrBody`・/);
  });

  it("preview の --base の記録の箇条に、フォルダが消えたときの prune がある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const rec = c8.split("\n").find((l) => l.includes("置き場の形")) ?? "";
    for (const w of [
      "git の外で消えて",
      "`git worktree prune`",
      "次の `--base`",
    ]) {
      expect(rec, w).toContain(w);
    }
  });

  it("足した行に、タスクの ID と手元のパスがない", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const mine = lines.filter(
      (l) => l.includes("pr-edit") || l.includes("orca-flow:captures"),
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const l of mine) {
      expect(l).not.toMatch(idForm);
      expect(l).not.toMatch(homePath);
    }
  });
});

describe("仕様書：pr-edit を許していないときの案内", () => {
  it("6章の outbound に、案内は本文の印の値が今の録画と違うときだけ出し、同じなら出さないとある", async () => {
    const six = chapter(await read("docs/spec.md"), 6);
    const para =
      six.split("\n").find((l) => l.startsWith("**outbound**")) ?? "";
    expect(para).toMatch(
      /`pr-edit` も、`allow` に足すまで送られない[^）]*足していないと push は積まず、開いた PR の本文の録画の節の印の値が今の録画と違うときだけ案内を出す/,
    );
    expect(para).toContain("同じなら案内を出さない");
    expect(para).not.toContain("足していないと push は積まずに案内を出す");
  });

  it("8章の録画の箇条に、積まない言葉を残したまま、違うときだけ案内し同じなら出さないとある", async () => {
    const pr = part(chapter(await read("docs/spec.md"), 8), "push（PR の道）");
    const item =
      pr.split("\n").find((l) => l.startsWith("- 録画を載せる：")) ?? "";
    expect(item).toContain("`outbound.allow` に `pr-edit` がなければ積まず");
    expect(item).toMatch(
      /`outbound\.allow` に `pr-edit` がなければ積まず、本文は読んで、印の値が今の録画と違うとき（[^）]*節がない[^）]*本文を読めない[^）]*）だけ、統括役が設定に足せば載ることを案内する/,
    );
    expect(item).toContain("同じなら案内を出さない");
    expect(item).toMatch(/読めないときも読めない警告は出さず/);
  });

  it("7章7番の例外2の広げない並びに、PR の本文の録画の直し（pr-edit）がある", async () => {
    const seven = chapter(await read("docs/spec.md"), 7);
    const ex =
      seven
        .split("\n")
        .find((l) => l.trimStart().startsWith("- 例外は2つ。")) ?? "";
    expect(ex).toContain(
      "PR の作成・下書きを外す・PR の本文の録画の直し（`pr-edit`）・返信・main・ほかの枝へは広げない",
    );
  });
});

describe("スキル：録画を PR に載せる", () => {
  it("push のスキルに、録画の節は CLI が足すので本文に書かないことと、警告の伝え方がある", async () => {
    const s = await read("skills/push/SKILL.md");
    for (const w of [
      "録画の節は CLI が足す",
      "本文に録画の節・印・録画のパスを書かない",
      "2.99.0",
      "github.com",
      "載らなかった流れ",
      "`pr-edit`",
      "`outbound.allow`",
      "統括役",
      "開いて見る",
    ]) {
      expect(s, w).toContain(w);
    }
    expect(s).not.toMatch(idForm);
    expect(s).not.toMatch(homePath);
  });

  it("send のスキルで、録画を開いて見てから send を流す", async () => {
    const s = await read("skills/send/SKILL.md");
    const look = s.indexOf("録画を開いて見て");
    const send = s.indexOf("orca-flow send $0 --expect");
    expect(look, "録画を見る文がありません").toBeGreaterThanOrEqual(0);
    expect(look).toBeLessThan(send);
    for (const w of ["秘密", "`pr-edit`", "録画の一覧"]) {
      expect(s, w).toContain(w);
    }
    expect(s).not.toMatch(idForm);
    expect(s).not.toMatch(homePath);
  });

  it("e2e-capture.md に、録画は push が PR に載せるとあり、報告に貼らない", async () => {
    const s = await read("skills/run/e2e-capture.md");
    expect(s).toMatch(/`\/orca-flow:push` が[^。]*PR[^。]*載せる/);
    expect(s).toContain("報告にも貼らない");
    expect(s).not.toContain("後で PR の本文に載せるための材料");
  });
});
