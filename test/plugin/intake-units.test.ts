import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 見出しの行から、同じ高さ以上の次の見出しの前までを返す */
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

/** 手順の番号の行から、次の番号の行の前までを返す */
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

/** 並べた語が、この順で出ることを確かめる */
function expectInOrder(text: string, words: string[]): void {
  let from = 0;
  for (const w of words) {
    const at = text.indexOf(w, from);
    expect(at, `「${w}」が順に見つかりません`).toBeGreaterThanOrEqual(0);
    from = at + w.length;
  }
}

describe("独立の単位：分け方の基準（splitting.md）", () => {
  it("独立の単位の節に、依存を消す4つの道がこの順で並ぶ", async () => {
    const s = section(
      await read("skills/intake/splitting.md"),
      /^## 独立の単位/,
    );
    expectInOrder(s, [
      "並べる：",
      "契約で並べて入れる順を決める：",
      "下地：",
      "まとめる：",
    ]);
  });

  it("単位どうしは依存を持たず、待つのは土台の下地だけと書く", async () => {
    const s = section(
      await read("skills/intake/splitting.md"),
      /^## 独立の単位/,
    );
    expect(s).toContain("単位どうしは依存を持たない");
    expect(s).toContain("待つのは下地のタスクだけ");
    expect(s).toContain("単位をまたいで積まない");
  });

  it("共通を含むブランチは1つの単位の中に置き、既定は1つのままと書く", async () => {
    const s = section(
      await read("skills/intake/splitting.md"),
      /^## 独立の単位/,
    );
    expect(s).toContain("共通を含むブランチは1つの単位の中に置き");
    expect(s).toContain("既定は1つのまま");
    expect(s).toContain(
      "契約（名前・形・呼び方）を親のページの「同時に作るタスクの間で使い合うもの」に書き",
    );
  });

  it("今の基準が残っている", async () => {
    const t = await read("skills/intake/splitting.md");
    expect(t).toContain("既定は1つ");
    expect(t).toContain("約400行");
    expect(t).toContain("足す→呼び手を移す→古いものを消す");
    expect(t).toContain("縦");
  });

  it("1項目に書くことに、入れる順の欄があり、単位の名前は書かない", async () => {
    const s = section(
      await read("skills/intake/splitting.md"),
      /^## 1項目に書くこと/,
    );
    expect(s).toContain("入れる順（「ブランチ〈番号〉のあと」");
    expect(s).toContain("1項目には単位の名前を書かない");
    expect(s).not.toContain("単位（単位の番号）");
  });
});

describe("独立の単位：ページの形（前の形：page-format-prev.md）", () => {
  it("土台のページの並びが、要点から細部までこの順で書かれている", async () => {
    const s = section(
      await read("skills/intake/page-format-prev.md"),
      /^### 土台のページ/,
    );
    expectInOrder(s, [
      "要点",
      "決めてほしいこと",
      "単位の一覧",
      "契約",
      "下地のタスクの一覧",
      "細部",
    ]);
    expect(s).toContain("なし");
    expect(s).toContain("同時に始まる");
  });

  it("単位のページは、読み方の行の次につながりの行を置く", async () => {
    const t = await read("skills/intake/page-format-prev.md");
    const s = section(t, /^### 単位のページ/);
    expect(s).toContain("読み方の行の次");
    expect(s).toContain("つながり：");
    expect(s).toContain("チケット");
    expect(s).toContain("土台");
    expect(s).toContain("ほかの単位");
  });

  it("単位の番号・依存の欄に書けるもの・入れる順の列を決める", async () => {
    const s = section(
      await read("skills/intake/page-format-prev.md"),
      /^## 複数のページの形/,
    );
    expect(s).toContain("「単位1」「単位2」");
    expect(s).toContain("同じページのタスクと「土台のタスク〈番号〉」だけ");
    expect(s).toContain("入れる順");
    expect(s).toContain("単位〈番号〉のタスク〈番号〉のあと");
    expect(s).toContain("入れる順があるときだけ");
  });

  it("つながりの行がないページは今までどおりの1ページの形と読む", async () => {
    const s = section(
      await read("skills/intake/page-format-prev.md"),
      /^### 複数のページと1ページの見分け/,
    );
    expect(s).toContain("つながりの行がない");
    expect(s).toContain("今までどおりの1ページ");
    expect(s).toContain("単位の一覧");
  });

  it("Notion に書く文に orca-flow の語を入れない決まりが土台と単位にも効く", async () => {
    const s = section(
      await read("skills/intake/page-format-prev.md"),
      /^## 複数のページの形/,
    );
    expect(s).toContain("orca-flow の語を入れない");
  });
});

describe("独立の単位：手順（SKILL.md）", () => {
  it("単位が2つ以上のときだけ、ページを作る前に単位の案を示して「よい」を待つ", async () => {
    const t = await read("skills/intake/SKILL.md");
    expect(t).toContain("単位が2つ以上のときだけ");
    expect(t).toContain("単位の案");
    expect(t).toMatch(/ページを作る前に[^\n]*単位の案[^\n]*「よい」/);
  });

  it("親を先に作り、タスクのページを続けて作り、全部に印を入れる", async () => {
    const t = await read("skills/intake/SKILL.md");
    const s = step(t, 8);
    expectInOrder(s, [
      "親のページを作り",
      "タスクのページを親の子ページとして作る",
    ]);
    expect(s).toContain("自動で追記");
    expect(s).toContain("全部に");
  });

  it("下書きとレビュー役の2回は、全部のページをまとめて扱う", async () => {
    const t = await read("skills/intake/SKILL.md");
    expect(step(t, 6)).toContain("全部のページをまとめて");
    expect(step(t, 7)).toContain("全部のページをまとめて");
  });

  it("打ち直しは、親の URL でもタスクのページの URL でも親の全部の項目を続ける", async () => {
    const t = await read("skills/intake/SKILL.md");
    expect(t).toContain("打ち直しの URL が親でもタスクのページでも");
    expect(t).toContain("親の全部の項目を続ける");
    expect(t).toContain("つながりの行から親をたどって親と同じに扱う");
  });

  it("前の形の打ち直しは、土台の URL なら全部、単位の URL ならその単位だけを続け、始め方は前の形の文書を指す", async () => {
    const t = await read("skills/intake/SKILL.md");
    expect(t).toContain("土台の URL なら全部のページ");
    expect(t).toContain("単位の URL ならその単位だけ");
    expect(t).toContain("page-format-prev.md");
    const prev = section(
      await read("skills/intake/page-format-prev.md"),
      /^### 始め方（前の形）/,
    );
    expect(prev).toContain("土台の URL なら全部のページ");
    expect(prev).toContain("単位の URL ならその単位だけ");
  });

  it("子に印のあるページが2つ以上あれば、並べて示して聞く", async () => {
    const t = await read("skills/intake/SKILL.md");
    const s = step(t, 4);
    expect(s).toContain("印のあるページが2つ以上");
    expect(s).toContain("並べて示し");
    expect(s).toContain("続けるか新しく作るか");
  });

  it("全部のページのリンクを示す", async () => {
    const t = await read("skills/intake/SKILL.md");
    expect(step(t, 9)).toContain("親のリンクと、タスクのページのリンク");
  });
});

describe("独立の単位：前の形の始め方（page-format-prev.md）", () => {
  const startSec = async () =>
    section(
      await read("skills/intake/page-format-prev.md"),
      /^### 始め方（前の形）/,
    );

  it("土台のタスクの依存は、土台のページの状態の欄の ID で入ったかを決める", async () => {
    const s = await startSec();
    expect(s).toContain("土台のタスク〈番号〉");
    expect(s).toContain("土台のページの状態の欄の ID");
    expect(s).toContain("形の確かめは今の ID の決まりのまま");
  });

  it("入れる順のある項目は、前の項目が開始済みか入ったときだけ始める", async () => {
    const s = await startSec();
    expect(s).toContain("前の項目が開始済みか入ったときだけ始める");
    expect(s).toContain("前の項目の ID も `merged` の1回に含める");
    expect(s).toContain("前の項目を先に始め");
  });

  it("依頼のファイルに、土台の契約・土台の質問と答え・入れる順を文で写し、土台の URL は写さない", async () => {
    const s = await startSec();
    expect(s).toContain("土台の契約・土台の質問と答え・入れる順を文で写す");
    expect(s).toContain("土台の URL は写さない");
  });

  it("始める範囲を、土台の URL と単位の URL で分けて書く", async () => {
    const s = await startSec();
    expect(s).toContain(
      "土台のページなら、土台の下地のタスクと各単位のタスクの全部",
    );
    expect(s).toContain("その単位のタスクと、それが待つ土台の下地のタスクだけ");
    expect(s).toContain("状態の欄を読むためだけに読み");
    expect(s).toContain(
      "つながりの行（か土台の単位の一覧）のリンクからそのページをたどり",
    );
  });

  it("ワークスペースの道：土台のタスクへの依存の解き方と、共通に置く下地の置き場", async () => {
    const s = await startSec();
    expect(s).toContain("に置く下地は土台に置かない");
    expect(s).toContain("土台の下地のタスクは、アプリのリポジトリの中だけ");
    expect(s).toContain(
      "土台のページの状態の欄の `〈名前〉:〈ID〉` に解いてから",
    );
  });

  it("落とさない決まり：両方を「よい」の一覧に入れ、入っていれば order は流さず、作業中どうしの順は guards.md の手順に従う", async () => {
    const s = await startSec();
    expect(s).toContain("「よい」を待つ一覧には、前と後の両方を入れる");
    expect(s).toContain("前の項目がすでに入っていれば order は流さない");
    expect(s).toContain(
      "両方が作業中なら、後の項目の new のあとに入れる順を CLI に足す",
    );
    expect(s).toContain(
      "ワークスペースの道で流さないことは `guards.md` の手順10のとおり",
    );
    expect(s).toContain(
      "「よい」を待つ一覧は、全部のページの始める項目をまとめて示す",
    );
    const g = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    expect(g).toContain("前の形のページにも効く");
    const iOrder = g.indexOf("両方が作業中なら");
    const iNew = g.indexOf("ブランチの形の親とタスクのページ（");
    expect(iOrder).toBeGreaterThan(-1);
    expect(iOrder).toBeLessThan(iNew);
  });

  it("guards.md はこの節を指す", async () => {
    const s = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    expect(s).toContain("page-format-prev.md");
    expect(s).toContain("始め方（前の形）");
  });
});

describe("独立の単位：始める前の守り（guards.md）", () => {
  it("「待つもの：ブランチ〈番号〉」の依存は、親のブランチの全部の項目の状態の行の ID に解いて入ったかを決める", async () => {
    const s = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    expect(s).toContain("「待つもの：ブランチ〈番号〉」");
    expect(s).toContain(
      "親のそのブランチの全部の項目の状態の行の ID に解いてから",
    );
    expect(s).toContain(
      "全部の項目が入ったときだけ、そのブランチを入ったとし、待つ項目を印なしで始める",
    );
    expect(s).toContain(
      "入っていない待つ先があれば、そのブランチを待つ項目に前を待つ印をつけて始める",
    );
    expect(s).toContain("形の確かめは今の ID の決まりのまま");
  });

  it("入れる順のある項目の始め方と order の流し方を決める", async () => {
    const s = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    expect(s).toContain("前の項目が開始済みか入ったときだけ始める");
    expect(s).toContain("両方が作業中なら");
    expect(s).toContain("`orca-flow order 〈前の ID〉,〈後の ID〉`");
    expect(s).toContain("0以外なら人に伝え、止めずに進める");
  });

  it("依頼のファイルに、親の質問と答え・親の細部の決定と結果・契約・入れる順を文で写し、親の URL は写さない", async () => {
    const s = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    expect(s).toContain("そのタスクのページの URL にする");
    expect(s).toContain("親の URL は写さない");
    expect(s).toContain(
      "親の質問と答えと、親の細部のうちその項目に効く決定と結果",
    );
    expect(s).toContain("契約");
    expect(s).toContain("入れる順");
  });
});

describe("独立の単位：ワークスペースの道（workspace.md）", () => {
  it("共通を含むブランチを1つの単位の中に置き、入れる順の道は使わない", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(t).toContain("共通を含むブランチは1つの単位の中に置き");
    expect(t).toContain("入れる順の道は使わない");
    expect(t).toContain("親は子で order を流せない");
  });
});

describe("独立の単位：docs/spec.md", () => {
  it("10.1 の2つの段落に、単位と土台のページの要約がある", async () => {
    const t = await read("docs/spec.md");
    const intake = t.slice(
      t.indexOf("**Notion の要件から始める**"),
      t.indexOf("**複数のリポジトリをまたぐ要件**（`/orca-flow:intake`"),
    );
    expect(intake).toContain("独立に作れる単位");
    expect(intake).toContain("親のページ");
    expect(intake).toContain("入れる順");
    expect(intake).toContain("単位の案");
    const wsPara = t.slice(
      t.indexOf("**複数のリポジトリをまたぐ要件**（`/orca-flow:intake`"),
    );
    const para = wsPara.slice(0, wsPara.indexOf("\n\n", 10));
    expect(para).toContain("1つの単位の中");
  });

  it("12章の9番に、単位と土台のページの要約がある", async () => {
    const ch12 = section(await read("docs/spec.md"), /^## 12\. /);
    const item = ch12.split("\n").find((l) => l.startsWith("9. ")) ?? "";
    expect(item).toContain("単位");
    expect(item).toContain("親のページ");
    expect(item).toContain("単位の案");
  });
});

describe("独立の単位：例の文", () => {
  it("例に本物の Notion の URL や中身を書かない", async () => {
    for (const f of [
      "skills/intake/splitting.md",
      "skills/intake/page-format.md",
      "skills/intake/page-format-prev.md",
      "skills/intake/SKILL.md",
      "skills/intake/guards.md",
      "skills/intake/workspace.md",
    ]) {
      const t = await read(f);
      expect(t, f).not.toMatch(/notion\.(so|com)\//i);
      expect(t, f).not.toMatch(/https?:\/\/[^\s)]*notion/i);
    }
  });
});

describe("独立の単位：確認と直し", () => {
  it("手順10の節は page-format の読みの行で始まり、空行で割れない", async () => {
    const s = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    const body = s.trimEnd().split("\n").slice(1);
    expect(body[0]).toBe("");
    expect(body[1]).toContain("page-format.md");
    expect(body.slice(1).every((l) => l !== "")).toBe(true);
  });

  it("order は手順10の節の中だけで、ワークスペースの道では流さず人に伝えると書く", async () => {
    const g = await read("skills/intake/guards.md");
    const h10 = section(g, /^## 手順10：/);
    const outside = g.replace(h10, "");
    expect(outside).not.toMatch(/`orca-flow order\b/);
    expect(h10).toContain("ワークスペースの道では入れる順の道を使わないので");
    expect(h10).toContain("order は流さない。入れる順の列があれば、人に伝える");
  });

  it("始める範囲は、渡された URL にかかわらず親の全部のブランチで、タスクのページの URL なら親をたどる", async () => {
    const s = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    expect(s).toContain("つながりの行のリンクから親をたどる");
    expect(s).toContain("親と同じに扱う");
    expect(s).toContain(
      "始める項目は、親の全ブランチの項目のうち、状態の行が空のもの",
    );
    expect(s).toContain(
      "そのブランチの待つものが入っていなくても、前を待つ印をつけて始める",
    );
  });

  it("前の形のpage-format は入れる順を依存の欄に書かず、guards.md の始め方に任せる", async () => {
    const s = await read("skills/intake/page-format-prev.md");
    expect(s).toContain(
      "入れる順は依存の欄には書かない（`merged` にも渡さない）",
    );
    expect(s).not.toContain("始めるのを止めない");
    expect(s).toMatch(/下地のタスクがあれば、その分の「タスクへの分け方」/);
  });

  it("page-format は入れる順を待つものに書かず、guards.md の始め方に任せる", async () => {
    const s = await read("skills/intake/page-format.md");
    expect(s).toContain(
      "入れる順は「待つもの」には書かない（`merged` にも渡さない）",
    );
    expect(s).toContain("入れる順：ブランチ〈番号〉のあと");
    expect(s).toContain("始めてよいかは `guards.md` のとおり");
  });

  it("order は鎖の一部だけを断るので、今の鎖を読んで全体を1本で流す書き方をする", async () => {
    const s = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    expect(s).toContain("`orca-flow order --json`");
    expect(s).toContain(
      "その鎖の全体の並びの末尾に後の ID を足した並びを1回流す",
    );
    expect(s).toContain("1本の並び");
    const sp = section(
      await read("skills/intake/splitting.md"),
      /^## 独立の単位/,
    );
    expect(sp).toContain("入れる順は1本の列に並べる");
  });

  it("前の項目の ID も merged に含め、同じ回なら前を先に始めて後も始めてよい", async () => {
    const s = section(await read("skills/intake/guards.md"), /^## 手順10：/);
    expect(s).toContain("前の項目の ID も `merged` の1回に含める");
    expect(s).toContain("前の項目を先に始め");
    expect(s).toContain("前と後の両方を入れる");
  });

  it("単位の案の「よい」待ちは how のあとに並び、レビュー役の直しで変わればもう一度示す", async () => {
    const s = step(await read("skills/intake/SKILL.md"), 6);
    expectInOrder(s, ["guards.md", "/how", "単位の案", "書かない確かめ"]);
    expect(s).toContain("手順7のレビュー役の直しで単位の分け方が変わったら");
  });

  it("ワークスペースの道の依存の書き方・共通の下地の置き場を決める", async () => {
    const t = await read("skills/intake/workspace.md");
    expect(t).toContain("に置く下地は、待つものがない下地のブランチに置かない");
    expect(t).toContain("下地のタスクは、アプリのリポジトリの中だけ");
    expect(t).toContain(
      "親のそのブランチの全部の項目の状態の行の `〈名前〉:〈ID〉` に解いてから",
    );
    expect(t).toContain("ほかのリポジトリの依存");
  });

  it("12章の9番は、単位の一文を括弧の注のあとに置く", async () => {
    const t = await read("docs/spec.md");
    const line =
      t
        .split("\n")
        .find((l) => l.startsWith("9. **Notion の要件から始める**")) ?? "";
    const note = line.indexOf("このときも始める項目の一覧が出るので");
    const units = line.indexOf("ほかを待たずに作れる単位に分かれるときは");
    expect(note).toBeGreaterThan(0);
    expect(units).toBeGreaterThan(note);
  });

  it("10.1の要約も、打ち直しの範囲と order の流し方をそろえる", async () => {
    const t = await read("docs/spec.md");
    expect(t).toContain(
      "タスクのページの URL を渡されたら、つながりの行から親をたどり、親と同じに扱う",
    );
    expect(t).toContain("関わる項目を前が後より前になる1本の並びにして流す");
    expect(t).toContain(
      "単位の URL ならその単位だけを続ける（その単位のタスクと、それが待つ土台の下地のタスクだけ",
    );
    expect(t).toContain("土台の契約・土台の質問と答え・入れる順を文で写し");
    expect(t).toContain("土台の URL は写さない");
  });
});
