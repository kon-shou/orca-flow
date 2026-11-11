import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const SKILL = "skills/qa-check/SKILL.md";

function frontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(0);
  const out: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1] as string] = (m[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function expectAll(text: string, words: string[]) {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

/** 見出し（`## ` か `### `）から次の同じ深さ以上の見出しの前まで */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `${heading} がありません`).toBeGreaterThanOrEqual(0);
  const depth = /^(#+) /.exec(lines[start] ?? "")?.[1]?.length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+) /.exec(l);
    return m !== null && (m[1]?.length ?? 0) <= depth;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function cells(row: string): string[] {
  return row
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .slice(1, -1)
    .map((c) => c.replace(/\u0000/g, "\\|").trim());
}

describe("qa-check のスキル", () => {
  it("人が名前で呼ぶときだけ動く（disable-model-invocation: true）", async () => {
    const fm = frontmatter(await read(SKILL));
    expect(fm["name"]).toBe("qa-check");
    expect(fm["disable-model-invocation"]).toBe("true");
    expect(fm["description"] ?? "").not.toBe("");
  });

  it("依頼のファイルの QA 項目を読み、項目がなければ止まる", async () => {
    const text = await read(SKILL);
    expectAll(text, [
      "orca-flow/requests/$0.md",
      "git rev-parse --path-format=absolute --git-common-dir",
      "QA 項目がない",
    ]);
  });

  it("qa-check の各フラグを使う", async () => {
    const text = await read(SKILL);
    expectAll(text, [
      "orca-flow qa-check $0 --clear",
      "orca-flow qa-check $0 --open",
      "--open --base",
      "--shot",
      "--record --input",
      "--show",
      "orca-flow qa-check $0 --close",
      "orca-flow preview $0",
      "orca-flow preview $0 --base",
    ]);
  });

  it("--record の入力の形を CLI と同じ名前で書く", async () => {
    const text = await read(SKILL);
    expectAll(text, [
      "`text`",
      "`weight`",
      "`kind`",
      "`result`",
      "`reason`",
      "`before`",
      "`after`",
      "`notices`",
      "`pass`",
      "`fail`",
      "`unverified`",
      "`human`",
      "必須",
      "できれば",
      "事実",
      "目で見る",
    ]);
  });

  it("目で見る項目は判定せず human にし、確かめられない項目は unverified に理由を書く", async () => {
    const text = await read(SKILL);
    const lines = text.split("\n");
    const human = lines.filter(
      (l) => l.includes("`human`") && l.includes("判定しない"),
    );
    expect(human.length).toBeGreaterThanOrEqual(1);
    const unverified = lines.filter(
      (l) => l.includes("`unverified`") && l.includes("理由"),
    );
    expect(unverified.length).toBeGreaterThanOrEqual(1);
    expectAll(text, ["本物のアカウント", "秘密", "seed"]);
  });

  it("開いた origin の外へ goto しない・ほかの URL で流さない", async () => {
    const text = await read(SKILL);
    expectAll(text, ["origin", "goto", "--page", "本番"]);
  });

  it("崩れは notices に入れ、項目の結果は変えない", async () => {
    const text = await read(SKILL);
    expectAll(text, ["orca eval", "はみ出し", "`notices`", "結果は変えない"]);
  });

  it("コードを直さない、と書いてあり、終わりに result.md の絶対パスを示す", async () => {
    const text = await read(SKILL);
    expectAll(text, [
      "コードを直さない",
      "result.md",
      "絶対パス",
      "このタブで直す所を頼んでください",
    ]);
  });

  it("タブを閉じるのは最後の片づけだけで、後の画面は手順4のページの ID で続ける", async () => {
    const lines = (await read(SKILL)).split("\n");
    const step = (n: number) => lines.find((l) => l.startsWith(`${n}. `)) ?? "";
    expect(step(5)).not.toContain("--close` を流す");
    expectAll(step(9), ["orca-flow qa-check $0 --close"]);
    expectAll(step(6), ["手順4", "orca-flow qa-check $0 --open --json"]);
  });

  it("--shot の終了コード1を、origin が違うときとタブが読めないときで分ける", async () => {
    const text = await read(SKILL);
    const lines = text.split("\n");
    const origin = lines.find(
      (l) => l.includes("origin が違う") && l.includes("`unverified`"),
    );
    expect(origin, "origin が違うときの扱いがありません").toBeDefined();
    const reopen = lines.find(
      (l) => l.includes("開き直し") && l.includes("--open --base --json"),
    );
    expect(reopen, "タブが読めないときの開き直しがありません").toBeDefined();
    expect(reopen).toContain("新しく出たページの ID");
  });

  it("orca goto で戻るときは --page と --url を渡す", async () => {
    const text = await read(SKILL);
    const gotos = text.match(/`orca goto --page [^`]*`/g) ?? [];
    expect(gotos.length).toBeGreaterThanOrEqual(1);
    for (const g of gotos) expect(g).toContain("--url");
  });

  it("orca eval には --page と --expression を渡す", async () => {
    const text = await read(SKILL);
    const evals = text.match(/`orca eval --page [^`]*`/g) ?? [];
    expect(evals.length).toBeGreaterThanOrEqual(1);
    for (const e of evals) expect(e).toContain("--expression");
  });

  it("--shot の終了コード1は、origin の違い・タブが読めない・それ以外に分け、開き直しは1回まで", async () => {
    const text = await read(SKILL);
    expectAll(text, [
      "origin が違う",
      "タブが読めない",
      "それ以外（画像を読めない",
      "1つの項目につき1回まで",
      "`human` のまま後の画面だけを撮り",
    ]);
  });

  it("前の画面の撮影が落ちても止めず、目で見る項目は後だけ撮る。撮るのをやめても項目を抜かない", async () => {
    const lines = (await read(SKILL)).split("\n");
    const before = lines.find((l) =>
      l.includes("前の画面の撮影がどの理由で落ちても"),
    );
    expect(
      before,
      "前の画面の撮影が落ちたときの扱いがありません",
    ).toBeDefined();
    expectAll(before ?? "", ["`human` のまま", "止めない"]);
    const stopOnTwo = lines.find((l) => l.includes("開き直しが終了コード2"));
    expectAll(stopOnTwo ?? "", ["後の画面の開き直し", "前の画面なしで進む"]);
    const giveUp = lines.find((l) => l.includes("どの項目も入力から抜かない"));
    expect(giveUp, "撮るのをやめたときの扱いがありません").toBeDefined();
    // 撮るのをやめたことと、撮れない崩れは人に伝える
    expectAll(giveUp ?? "", ["`notices` に入れず", "手順10", "人に伝える"]);
  });

  it("途中で止まるときも、タブを閉じ自分が立てたものを止めてから止まる", async () => {
    const lines = (await read(SKILL)).split("\n");
    const guard = lines.find((l) => l.includes("途中で止まる"));
    expect(guard, "途中で止まるときの片づけがありません").toBeDefined();
    expectAll(guard ?? "", ["orca-flow qa-check $0 --close", "--stop"]);
    const preview = lines.find(
      (l) =>
        l.includes("`orca-flow preview` が終了コード1") && l.includes("片づけ"),
    );
    expect(
      preview,
      "preview が終了コード1のときの扱いがありません",
    ).toBeDefined();
  });

  it("QA の筋書きは確かめる項目に入れず、流さないと人に添える", async () => {
    const lines = (await read(SKILL)).split("\n");
    const notCollected = lines.find(
      (l) =>
        l.startsWith("1. ") &&
        l.includes("QA の筋書き") &&
        l.includes("集めない"),
    );
    expect(notCollected, "筋書きを集めない文がありません").toBeDefined();
    const told = lines.find(
      (l) => l.startsWith("10. ") && l.includes("このスキルでは流さない"),
    );
    expect(told, "筋書きを流さないと人に添える文がありません").toBeDefined();
    expect(lines.some((l) => /筋書き.*1項目/.test(l))).toBe(false);
  });

  it("タブは --open が開いたものだけを使い、サインイン済みの画面なら操作も撮影もせず unverified にする", async () => {
    const lines = (await read(SKILL)).split("\n");
    const own = lines.find(
      (l) =>
        l.includes("`--open` が開いたタブだけ") &&
        l.includes("`orca tab create`"),
    );
    expect(own, "--open が開いたタブだけを使う文がありません").toBeDefined();
    expect(own).toContain("直に流さない");
    const signedIn = lines.find((l) => l.includes("サインイン済み"));
    expect(signedIn, "サインイン済みの画面の守りがありません").toBeDefined();
    expectAll(signedIn ?? "", [
      "自分がサインインする前",
      "試しの値でない",
      "操作も撮影もしない",
      "`unverified`",
      "理由",
      "片づけ",
      "人に伝える",
    ]);
    const openFails = lines.find(
      (l) => l.includes("`--open`") && l.includes("終了コード1"),
    );
    expect(openFails, "--open の終了コード1の扱いがありません").toBeDefined();
    expectAll(openFails ?? "", ["人に伝え", "手順9の片づけ", "止まる"]);
  });

  it("送り・マージのコマンドを流さない", async () => {
    const text = await read(SKILL);
    expect(text).not.toMatch(/orca-flow["']?\s+(?:send|merge)\s+\S/);
  });
});

describe("仕様書の qa-check", () => {
  it("8章の表に qa-check の行がちょうど1つあり、段落がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 8\. /);
    const rows = s.split("\n").filter((l) => l.startsWith("| `qa-check "));
    expect(rows).toHaveLength(1);
    const c = cells(rows[0] ?? "");
    expect(c).toHaveLength(3);
    expect(c[1]).toBe("人間");
    const para = s.split("\n").find((l) => l.startsWith("**qa-check"));
    expect(para, "qa-check の段落がありません").toBeDefined();
    expectAll(s, [
      "qa-checks/〈ID〉/",
      "result.json",
      "result.md",
      "`unverified`",
      "`human`",
    ]);
  });

  it("6章に QA の確かめの記録の置き場がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 6\. /);
    const line =
      s.split("\n").find((l) => l.startsWith("**QA の確かめの記録**")) ?? "";
    expectAll(line, [
      "〈git の共通ディレクトリ〉/orca-flow/qa-checks/〈ID〉/",
      "-after.png",
      "-before.png",
      "コミットしない",
    ]);
  });

  it("10.1 の表に /orca-flow:qa-check の行がちょうど1つある", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1 /);
    const rows = s
      .split("\n")
      .filter((l) => l.startsWith("| `/orca-flow:qa-check"));
    expect(rows).toHaveLength(1);
    expect(cells(rows[0] ?? "")).toHaveLength(3);
    expect(rows[0]).toContain("disable-model-invocation: true");
  });

  it("10.1 の「- QA 項目：」の行に、目で見るの印の文がある", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1 /);
    const qa = s.split("\n").filter((l) => l.startsWith("- QA 項目："));
    expect(qa).toHaveLength(1);
    expectAll(qa[0] ?? "", ["（目で見る）", "/orca-flow:qa-check"]);
  });

  it("12章の13に qa-check の文がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 12\. /);
    const line = s.split("\n").find((l) => l.startsWith("13. ")) ?? "";
    expectAll(line, ["/orca-flow:qa-check 〈ID〉", "result.md"]);
  });

  it("6章の記録と8章の qa-check の段落に、回ごとの isolated の profile の文がある", async () => {
    const spec = await read("docs/spec.md");
    const record =
      section(spec, /^## 6\. /)
        .split("\n")
        .find((l) => l.startsWith("**QA の確かめの記録**")) ?? "";
    expectAll(record, ["profile の ID"]);
    const s = section(spec, /^## 8\. /).split("\n");
    const start = s.findIndex((l) => l.startsWith("**qa-check"));
    const end = s.findIndex((l, i) => i > start && l.startsWith("**"));
    const para = s.slice(start, end).join("\n");
    expectAll(para, [
      "isolated",
      "`orca-flow qa-check 〈ID〉`",
      "--profile",
      "`orca tab profile show`",
      "`orca tab profile delete --profile 〈ID〉`",
      "既定の区画",
    ]);
  });

  it("8章の qa-check の段落に、既定の profile を作成で使わず片づけで消さない文がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 8\. /).split("\n");
    const start = s.findIndex((l) => l.startsWith("**qa-check"));
    const end = s.findIndex((l, i) => i > start && l.startsWith("**"));
    const lines = s.slice(start, end);
    const open = lines.find((l) => l.startsWith("- `--open")) ?? "";
    expectAll(open, ["既定の profile（`default`）を返したら、使わず"]);
    const cleanup = lines.find((l) => l.startsWith("- profile の片づけ")) ?? "";
    expectAll(cleanup, ["既定の profile（`default`）なら", "消さず"]);
  });

  it("13章の表に isolated の profile の確かめていない行がちょうど1つあり、2列", async () => {
    const s = section(await read("docs/spec.md"), /^## 13\. /);
    const rows = s
      .split("\n")
      .filter((l) => l.startsWith("| ") && l.includes("isolated"));
    expect(rows).toHaveLength(1);
    const c = cells(rows[0] ?? "");
    expect(c).toHaveLength(2);
    expect(c[1]).toMatch(/^2026-11-12：確かめていない。/);
    expectAll(c[1] ?? "", ["/orca-flow:qa-check", "終了コード1"]);
  });

  it("13章の表に orca screenshot の出力の形の行があり、2列", async () => {
    const s = section(await read("docs/spec.md"), /^## 13\. /);
    const rows = s
      .split("\n")
      .filter((l) => l.startsWith("| ") && l.includes("`orca screenshot`"));
    expect(rows).toHaveLength(1);
    expect(cells(rows[0] ?? "")).toHaveLength(2);
  });
});
