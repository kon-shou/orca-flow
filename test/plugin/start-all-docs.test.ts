import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 見出しの行から、同じ高さ以上の次の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i] ?? "");
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** `n. ` で始まる手順の行から、次の手順か見出しの前までを返す。 */
function step(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  expect(start, `手順${n}が見つかりません`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(\d+\. |## )/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** 頭の言葉で始まる行を1つ返す。 */
function item(text: string, head: string): string {
  const hits = text.split("\n").filter((l) => l.startsWith(head));
  expect(hits, `「${head}」で始まる行`).toHaveLength(1);
  return hits[0] as string;
}

function expectAll(text: string, words: string[]): void {
  for (const w of words) expect(text, `「${w}」がありません`).toContain(w);
}

const GUARDS = "skills/intake/guards.md";
const guard10 = async () => section(await read(GUARDS), /^## 手順10：/);

describe("intake：残りの全項目を始め、入っていない待つ先には前を待つ印をつける", () => {
  it("guards.md の手順10に、印・乗せ方・順・待つ条件の決め手がある", async () => {
    const l = item(await guard10(), "- 前を待つ印");
    expectAll(l, [
      "残りの全項目を、待つ先が前になる順",
      "同じ回に先に始めたもの",
      "`--start-after`",
      "同じリポジトリの項目がちょうど1つなら",
      "`--stack-on 〈ID〉`",
      "2つ以上なら乗せない",
      "待つ条件",
      "`new` が決める",
      "`page-format-prev.md`",
    ]);
  });

  it("guards.md：印のあとは待ち受けが承認だけのおまかせで承認し、統合は人のまま", async () => {
    const l = item(await guard10(), "- 印のあとの進み方");
    expectAll(l, [
      "実装完了",
      "baseBranch に入った",
      "`/orca-flow:auto`",
      "承認の番を立て",
      "承認だけのおまかせ",
      "統合は人の確認のまま",
    ]);
  });

  it("guards.md：「よい」を待つ一覧にタブの数と作業中の数と上限を1行で添え、上限で止まったら伝えて打ち直しで続ける", async () => {
    const l = item(await guard10(), "- 「よい」を待つ一覧には、立つタブの数");
    expectAll(l, [
      "作業中の数と上限",
      "maxActiveTasks",
      "1行で添える",
      "前のブランチから順に始め",
      "上限に当たったら残りを始めずに止め",
      "始めた ID・印（前の ID）・残りの項目を人に伝える",
      "同じ URL で打ち直す",
      "続きから始まる",
      "空きを自動では待たない",
    ]);
    const code2 = item(await guard10(), "- new が終了コード2");
    expectAll(code2, ["上限で止まったとき", "始めた ID・印・残り", "打ち直し"]);
  });

  it("SKILL.md の手順10が、全部を順に始め、--start-after と --stack-on を足し、数を読む", async () => {
    const s10 = step(await read("skills/intake/SKILL.md"), 10);
    expectAll(s10, [
      "を全部、待つ先が前になる順に始める",
      "同じ回に先に始めた待つ先は、`merged` に渡さず",
      "止めずに前を待つ印をつけて始める",
      "`--start-after 〈ID〉,…`",
      "`--stack-on 〈ID〉`",
      "`orca-flow active --json` の数",
      "maxActiveTasks",
    ]);
    expect(s10).not.toContain("今は始めない");
  });

  it("SKILL.md の手順11が、印をつけた項目と前の ID と /orca-flow:auto を伝える", async () => {
    const s11 = step(await read("skills/intake/SKILL.md"), 11);
    expectAll(s11, [
      "印をつけた項目は、前の ID と並べて伝え",
      "各リポジトリの統括役のタブで `/orca-flow:auto` を打つ",
      "統合は人の確認のまま",
      "作業中が上限に当たった",
    ]);
    expect(s11).not.toContain("依存がまだ入っていない");
  });

  it("workspace.md の手順10が、名前つきの --start-after を親に渡し、--start-after-json は書かない", async () => {
    const ws = await read("skills/intake/workspace.md");
    const s = section(ws, /^## 手順10の差し替え/);
    const mark = item(s, "- 前を待つ印：");
    expectAll(mark, [
      "`orca-flow workspace 〈名前〉 new … --start-after 〈名前〉:〈ID〉,…`",
      "名前を設定の実のパスに解いて子に渡す",
      "`--start-after-json` は親に書かない",
      "終了コード1",
      "名前を外した ID を `--stack-on 〈ID〉`",
      "同じブランチの共通は待つ先に入れない",
    ]);
    const count = item(s, "- 作業中の数と上限：");
    expectAll(count, [
      "`orca-flow workspace 〈名前〉 active --json`",
      "`orca-flow workspace 〈名前〉 config --json` の maxActiveTasks",
    ]);
    const deal = item(s, "- 配る：");
    expect(deal).toContain("残りの全項目を、待つ先が前になる順に");
    expect(deal).not.toContain("依存が入った項目だけ");
    expect(item(s, "- 失敗：")).toContain("印（前の 〈名前〉:〈ID〉）と残り");
  });
});

describe("auto・approve・spec：承認だけのおまかせと前の実装完了の待ち", () => {
  it("auto：承認だけのおまかせの扱い・統合の番は立たない・一覧と show と off", async () => {
    const auto = await read("skills/auto/SKILL.md");
    const intro = auto.slice(0, auto.indexOf("## 手順"));
    expectAll(intro, [
      "承認だけのおまかせ",
      "前を待つ印",
      "守りは今のおまかせの決まりのまま",
      "統合の番は立たない",
      "`/orca-flow:integrate`",
      "前が整っていなければ、spec-review でも承認の番は立たない",
      "承認だけのおまかせのタスクは統合待ちでも統合の番が立たず（承認だけのまま）",
      "前が整っていない印のタスクはおまかせにするが承認の番は立たない",
    ]);
    const steps = section(auto, /^## 手順/);
    expectAll(steps, [
      "前を待つタスクと前ごとの整い具合",
      "`off 〈ID〉`・`off --all` は前を待つ印を消さず、印のタスクの自動の承認を止める",
      "おまかせを外した形の記録を残す",
      "印だけのタスクにも書く",
      "`--all` は作業中の印のタスクにも当てる",
      "人が `/orca-flow:approve` で承認する",
      "残りのおまかせのタスクか前を待つタスクがあれば手順3へ",
    ]);
    expect(steps).not.toContain("印も消す");
    expectAll(section(auto, /^## 番が来たら/), [
      "おまかせのタスクも前を待つタスクもなくなった",
      "承認が済んだあとの、印だけか承認だけのおまかせのタスクは、残っていても数えない",
    ]);
  });

  it("approve：人が打って前が整っていなければ、承認の前に AskUserQuestion で聞く", async () => {
    const text = await read("skills/approve/SKILL.md");
    const before = text.slice(0, text.indexOf("\n## 手順\n"));
    const para = item(before, "前を待つ印");
    expectAll(para, [
      "`/orca-flow:approve $0`",
      "`orca-flow auto show $0`",
      "整っていない前があれば、承認の前に",
      "本文に",
      "AskUserQuestion",
      "「先に承認しておく（Recommended）」",
      "「待つ」",
      "「今承認する」",
      "おまかせの番で来たとき",
      "聞かない",
      "「おまかせを外しました」があれば",
      "もう一度 `/orca-flow:approve $0` を打つ",
    ]);
    // 聞く形の共通の節はそろえない（おまかせの番の止まる所のため）
    expect(text).not.toContain("## 人に聞くとき");
  });

  it("approve：おまかせの決まりに、承認だけのおまかせの項があり、統合の番は立たない", async () => {
    const rule = section(
      await read("skills/approve/SKILL.md"),
      /^## おまかせの決まり/,
    );
    const l = item(rule, "8. ");
    expectAll(l, [
      "承認だけのおまかせ",
      "守りは同じ",
      "推奨が決めきれない項目と大事な共有のファイル",
      "統合の番は立たない",
      "`/orca-flow:integrate`",
    ]);
  });

  it("spec：手順8に前の実装完了を待つ文があり、乗せたタスクは前の設計書を待つ。手順は9つのまま", async () => {
    const text = await read("skills/spec/SKILL.md");
    const s8 = step(text, 8);
    const l = item(
      s8.split("\n").slice(1).join("\n"),
      "   - `orca-flow status spec-review` の出力に「前の実装完了を待っています」",
    );
    expectAll(l, [
      "承認は前の実装完了のあと統括役が進めます",
      "止まる",
      "手順9",
      "「おまかせを外してある」が添えてあれば",
      "前が整ったら統括役のタブで /orca-flow:approve $0 で承認します",
      "「/orca-flow:approve で今承認できます」が添えてあれば",
      "記録の絶対パス",
    ]);
    const ready = item(
      s8.split("\n").slice(1).join("\n"),
      "   - `orca-flow status spec-review` の出力に「前が整っています」",
    );
    expectAll(ready, [
      "承認は統括役の待ち受けが進めます（統括役のタブで /orca-flow:auto が動いていなければ /orca-flow:approve $0）",
      "止まる",
      "手順9",
      "「おまかせを外してある」が添えてあれば",
      "/orca-flow:approve $0 で承認します",
      "「おまかせ」と両方あっても、この文にする",
    ]);
    const stacked = item(section(text, /^## 乗せたタスク/), "- 設計：");
    expectAll(stacked, [
      "乗せた先の設計書がまだなければ",
      "待ち",
      "「前の設計書が出直した」を含む知らせが来たら",
      "手順4から続ける",
    ]);
    const steps = section(text, /^## 手順$/);
    const nums = steps
      .split("\n")
      .flatMap((x) => /^(\d+)\. /.exec(x)?.[1] ?? [])
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("仕様書：前を待つ印・承認だけのおまかせ・intake の始め方", () => {
  it("6章に前を待つ印の記録がある", async () => {
    const ch6 = section(await read("docs/spec.md"), /^## 6\. /);
    const l = item(ch6, "**前を待つ印**：");
    expectAll(l, [
      "`〈git の共通ディレクトリ〉/orca-flow/start-after/〈ID〉.json`",
      "`new --start-after`",
      "同じリポジトリなら空",
      "実の絶対パス",
      "待つ条件",
      "`--stack-on` の ID とほかのリポジトリの前は実装完了",
      "ほかの同じリポジトリの前は入った",
      "統合待ちの行",
      "`merged`",
      "読めない前は整っていない",
      "`--start-after` も `--start-after-json` も付けない `new` は、同じ ID の古い印を消す",
      "統合のあとも消さない",
      "`auto off 〈ID〉`・`off --all` は印を消さず、印のタスクの自動の承認を止める",
    ]);
    expect(l).not.toContain("印も消す");
  });

  it("8章に new と workspace の --start-after と、承認だけのおまかせと表示がある", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    expect(item(ch8, "| `new --title 〈タスク名〉 --slug 〈短い名前〉")).toBe(
      item(ch8, "| `new --title"),
    );
    expectAll(item(ch8, "- `new --start-after 〈ID〉,…`"), [
      "`new --start-after-json 〈JSON〉`",
      "Orca を呼ぶ前に終了コード1",
      "worktree も記録も作らない",
    ]);
    expectAll(item(ch8, "- 待つ条件は `new` が決める："), [
      "`--stack-on` の ID とほかのリポジトリの前は実装完了",
      "baseBranch に入った",
    ]);
    expectAll(item(ch8, "- `new` に前を待つ印を渡す："), [
      "`workspace 〈名前〉 new … --start-after 〈名前〉:〈ID〉,…`",
      "子の `new --start-after-json`",
      "人が親に `--start-after-json` を書いたとき",
      "`--stack-on` は今までどおり",
    ]);
    expectAll(item(ch8, "- 承認だけのおまかせ："), [
      "spec-review",
      "前が整い",
      "承認の番を立てて拾う",
      "統合の番は立てない",
      "待ち受けは終わらない",
      "`auto on 〈ID〉` も、承認だけのおまかせのタスクには統合待ちでも統合の番を立てず（承認だけのまま）",
      "印があり前が整っていなければ spec-review でも承認の番を立てない（おまかせにはする）",
      "承認が済んだあと（段の記録の最後の spec-review のあとに承認がある）の、印だけか承認だけのおまかせのタスクは、待ち受けが終わらない理由に数えない",
      "ふつうのおまかせは今までどおり",
    ]);
    const shown = item(ch8, "- 前を待つ印の表示：");
    expectAll(shown, [
      "「前の実装完了を待っています」で始まる1行",
      "もとからおまかせでも",
      "「前が整っています」で始まる1行",
      "おまかせを外してあれば",
      "記録の絶対パスと「/orca-flow:approve で今承認できます」",
      "前ごとの整い具合",
      "`off 〈ID〉`・`off --all` は印を消さず、印のタスクの自動の承認を止める",
      "記録がなく印だけのタスクにも外した形の記録を書く",
      "`--all` は作業中の印のタスクにも当てる",
      "そのあとは人が `/orca-flow:approve` で承認する",
      "`/orca-flow:auto` を勧める1行",
      "承認が済んだあとの、印だけか承認だけのおまかせのタスクは数えない",
    ]);
    expect(shown).not.toContain("印も消す");
  });

  it("8章の前を待つ印の表示に、一覧の添え書きの条件・--json の off・auto on の読めないときの案内があり、項はちょうど1つ", async () => {
    const ch8 = section(await read("docs/spec.md"), /^## 8\. /);
    const shown = item(ch8, "- 前を待つ印の表示：");
    expectAll(shown, [
      "「おまかせを外してあります（/orca-flow:approve で承認）」",
      "作業中で、最後の spec-review のあとに承認がない",
      "`--json` の `off`",
      "外してあれば真",
      "`auto on 〈ID〉`",
      "印が壊れた・前が読めないときは",
      "「前が整ったら待ち受けが番を立てます」でなく",
    ]);
  });

  it("auto のスキルの手順1に、一覧の添え書きの条件がある", async () => {
    const s = step(await read("skills/auto/SKILL.md"), 1);
    expectAll(s, [
      "「おまかせを外してあります（/orca-flow:approve で承認）」",
      "作業中で、最後の spec-review のあとに承認がない",
      "`--json` の `off`",
    ]);
  });

  it("7章3番は変わらない", async () => {
    const ch7 = section(await read("docs/spec.md"), /^## 7\. /);
    const l = item(ch7, "3. **依存のあるタスクは同時に走らせない**");
    expect(l).toContain("止めるかどうかは統括役が判断する");
    expect(l).not.toContain("start-after");
    expect(l).not.toContain("前を待つ印");
  });

  it("10.1 の「始め方：」の項に、全項目を始め印と乗せ方をつけることがある", async () => {
    const s101 = section(await read("docs/spec.md"), /^### 10\.1 /);
    const l = item(s101, "- 始め方：「待つもの：ブランチ〈番号〉」の依存は");
    expectAll(l, [
      "残りの全項目を、待つ先が前になる順に始め",
      "前を待つ印（`new --start-after`",
      "`--stack-on` で前の枝に乗せる",
      "承認だけのおまかせ",
      "立つタブの数と、作業中の数と上限を1行で添え",
      "上限に当たったら残りを始めずに止め",
      "`/orca-flow:auto` を打つ",
    ]);
    expectAll(item(s101, "- 承認だけのおまかせ："), [
      "AskUserQuestion",
      "「前の実装完了を待っています」",
      "「前の設計書が出直した」",
    ]);
  });
});

describe("決定の記録", () => {
  it("分けたブランチを一度に始める項がちょうど1つある", async () => {
    const lines = (await read("docs/decisions.md")).split("\n");
    const hits = lines.filter((l) =>
      /^## \d{4}-\d{2}-\d{2} 分けたブランチを一度に始め、前の実装完了で後ろを承認する$/.test(
        l,
      ),
    );
    expect(hits).toHaveLength(1);
  });
});
