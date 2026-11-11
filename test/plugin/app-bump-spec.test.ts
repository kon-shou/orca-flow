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

const OLD_STAGE = "アプリの同じブランチで正式な版に戻す";

describe("スキル：共通の版上げ（bump）", () => {
  it("frontmatter が他のスキルと同じ形で、人が名前で呼ぶときだけ動く", async () => {
    const t = await read("skills/bump/SKILL.md");
    expect(t).toMatch(/^---\nname: bump\ndescription: [^\n]+\n/);
    expect(t).toMatch(/\nargument-hint: "\[ID\]"\n/);
    expect(t).toMatch(/\ndisable-model-invocation: true\n---\n/);
  });

  it("コミットのあとに preview --restart を流し、手順の番号は変わらない", async () => {
    const t = await read("skills/bump/SKILL.md");
    expect(t).toContain("orca-flow preview $0 --restart");
    const steps = t
      .split("\n")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const six = t.split("\n").find((l) => l.startsWith("6. ")) ?? "";
    expect(six).toContain("orca-flow preview $0 --restart");
  });

  it("app-bump を読み、記録の branchCommand と bumpCommand を記録の文字のまま流す", async () => {
    const t = await read("skills/bump/SKILL.md");
    expect(t).toContain("orca-flow app-bump $0 --json");
    expect(t).toContain("cross-depends/$0.json");
    expect(t).toMatch(
      /「取り込み直す」：記録の `branchCommand` を、記録の文字のまま/,
    );
    expect(t).toMatch(
      /「版を上げる」：記録の `bumpCommand` を、記録の文字のまま流す（版を足して組み直さない/,
    );
    expect(t).toMatch(/コミットの前は `app-bump` を流し直さず/);
    expect(t).toMatch(
      /作業ツリーのパッケージの定義とロックファイルを読んで、記録の共通の枝の名前が残っていないこと/,
    );
    expect(t).toMatch(/`app-bump` の版以上であることを確かめる/);
    expect(t).toMatch(
      /コミットのあとなので、ブランチの先頭に効きが出る）、版を上げた共通が「済んだ」（枝の名前が消えたため）、取り込み直した共通が「待つ」（版がまだ出ていないため。枝の名前は残る）になったか/,
    );
    expect(t).not.toMatch(/取り込み直し[^、]*枝の名前が消えたか/);
    expect(t).not.toMatch(
      /その共通が「済んだ」になったか（枝の名前が消えたか）/,
    );
    expect(t).toMatch(
      /コミットを消さず `orca-flow status question` にして人間に伝える/,
    );
    expect(t).not.toMatch(
      /流したあと、`orca-flow app-bump \$0 --json` を流し直して/,
    );
    expect(t).toMatch(/`record: false`/);
    expect(t).toMatch(
      /`bump`＝版を上げる、`reimport`＝取り込み直す、`wait`＝待つ、`done`＝済んだ/,
    );
    expect(t).toMatch(/報告だけして止まる（push の案を積まない）/);
    expect(t).not.toContain("コマンドを流さずに報告して止まる（手順8へ）");
    expect(t).not.toMatch(/コミットせず手順8へ進む/);
    expect(t).toMatch(/コミットせず、手順7の `app-bump` の流し直しだけを通す/);
    expect(t).toMatch(/自分でコマンドを組み直さない/);
  });

  it("verify を通して outbox add push を積み、人に /orca-flow:send を頼む", async () => {
    const t = await read("skills/bump/SKILL.md");
    expect(t).toContain("`orca-flow verify`");
    expect(t).toContain("`orca-flow outbox add $0 push`");
    expect(t).toMatch(/人間に `\/orca-flow:send \$0` を頼む/);
    expect(t).toMatch(/GitHub に直接書かない/);
  });

  it("コマンドが落ちたら変更を戻して status question にする", async () => {
    const t = await read("skills/bump/SKILL.md");
    expect(t).toMatch(/コマンドが落ちたとき/);
    expect(t).toContain("git checkout -- 〈ファイル〉");
    expect(t).toMatch(
      /`orca-flow status question --note "版上げのコマンドが落ちた"`/,
    );
  });

  it("版を人に聞かず、手元のパスやタスクの ID を書かない", async () => {
    const t = await read("skills/bump/SKILL.md");
    expect(t).toMatch(/版を人間に聞かない/);
    expect(t).not.toMatch(/(^|[^A-Za-z0-9_.-])\/(home|Users)\//);
    expect(t).not.toMatch(/(^|[^A-Za-z0-9])P[0-9]{3,}([^A-Za-z0-9]|$)/);
  });
});

describe("intake のワークスペースの道：共通の項目はアプリと必ず同じブランチにする", () => {
  it("users のアプリと同じブランチにし、変えないアプリは版上げだけの項目、users が空の共通だけが1つで始まる", async () => {
    const t = await read("skills/intake/workspace.md");
    const l = t.split("\n").find((x) => x.startsWith("- 共通を含むブランチ："));
    expect(l).toBeDefined();
    expect(l).toContain("`orca-flow workspace --json`");
    expect(l).toContain("`users`");
    expect(l).toMatch(/必ず1つのブランチ（ひとまとまり）にする/);
    expect(l).toMatch(/変えないアプリは、アプリの版上げだけの項目/);
    expect(l).toMatch(
      /`users` が空の共通だけが、ほかの項目と同じブランチにせず今までどおり1つで始める/,
    );
  });

  it("版は見張りが起こす形で、順の段が人の段でなくなり、--bumps は渡さないまま残る", async () => {
    const t = await read("skills/intake/workspace.md");
    const order = t.split("\n").find((x) => x.startsWith("- 順："));
    expect(order).toContain(
      "共通の版を出す（人が行う）→ 見張りがアプリのタスク長を起こして正式な版に上げる",
    );
    expect(order).not.toContain(OLD_STAGE);
    expect(t).not.toContain(OLD_STAGE);
    expect(t).toMatch(/`\/orca-flow:bump`/);
    for (const l of t.split("\n")) {
      if (l.includes("--bumps")) expect(l).toContain("渡さない");
    }
  });

  it("page-format の組の進め方の順が、見張りが起こす段になっている", async () => {
    const t = await read("skills/intake/page-format.md");
    expect(t).toContain(
      "共通の版を出す（人が行う）→ 見張りがアプリのタスク長を起こして正式な版に上げる → アプリの PR をマージ",
    );
    expect(t).not.toContain(OLD_STAGE);
  });
});

describe("run と merge：版は app-bump を先に使い、出ないときだけ人に聞く", () => {
  it("run の戻すは app-bump の版を先に使い、版が出ないときだけ人間に聞く", async () => {
    const t = await read("skills/run/SKILL.md");
    const at = t.indexOf("## 共通の枝を取り込むとき");
    const sec = t.slice(at, t.indexOf("## ローカルレビュー", at));
    const l = sec.split("\n").find((x) => x.startsWith("- 戻す：")) ?? "";
    expect(l).toMatch(/人間に版を聞く前に `orca-flow app-bump \$0 --json`/);
    expect(l).toMatch(/判定が「版を上げる」の要素の版を使う/);
    expect(l).toMatch(/版が出ないとき[^。]*だけ、人間に共通の版を聞き/);
    expect(l).toContain("/orca-flow:bump $0");
    expect(l).toMatch(/記録の文字のまま流し（版を足して組み直さない）/);
    expect(l).toMatch(/「済んだ」になったか/);
    expect(l).toMatch(/合わなければ戻して `orca-flow status question` にする/);
    expect(l.indexOf("app-bump")).toBeLessThan(
      l.indexOf("人間に共通の版を聞き"),
    );
  });

  it("run の手順の番号は1〜11のまま増えない", async () => {
    const t = await read("skills/run/SKILL.md");
    const nums = [...t.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(nums.slice(0, 11)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(Math.max(...nums.slice(0, 12))).toBe(11);
  });

  it("merge の枝を取り込んだままの止まりは、app-bump の版を先に使い、出ないときだけ人間に聞く", async () => {
    const t = await read("skills/merge/SKILL.md");
    const l =
      t
        .split("\n")
        .find((x) => x.includes("枝を取り込んだままで止まったとき")) ?? "";
    expect(l).toMatch(
      /人間に版を聞く前に、`orca-flow app-bump \$0 --json` を流し/,
    );
    expect(l).toMatch(/判定が「待つ」）ときだけ、共通の版を人間に聞く/);
    expect(l).toContain("`--drop-depend` で外さない");
    expect(l).toMatch(
      /記録の文字のまま流し、作業ツリーのファイルで枝の名前が消え入った版が `app-bump` の版以上かを確かめ/,
    );
    expect(l).toMatch(
      /verify のあとに `app-bump` を流し直して「済んだ」を確かめる/,
    );
    expect(l).not.toMatch(/流し、`app-bump` を流し直して「済んだ」になり/);
    const run = await read("skills/run/SKILL.md");
    expect(run).toMatch(/コミットの前は `app-bump` を流し直さない/);
    expect(run).toMatch(
      /そのあとに `orca-flow app-bump \$0 --json` を流し直して/,
    );
    const spec = await read("docs/spec.md");
    expect(spec).not.toContain("`bumpCommand`（その版で）");
    expect(spec).not.toContain("その版で）を記録の文字のまま");
  });
});

describe("仕様書：共通の版上げは見張りが起こす", () => {
  it("2章と10.1 の順から、人の段が外れて見張りが起こす段になっている", async () => {
    const text = await read("docs/spec.md");
    expect(text).not.toContain(OLD_STAGE);
    const flow =
      chapter(text, 2)
        .split("\n")
        .find((l) => l.includes("設定 → 親の intake")) ?? "";
    expect(flow).toContain(
      "共通の版を出す（人）→ 見張りがアプリのタスク長を起こして、アプリの PR で正式な版に上げる",
    );
    const order =
      chapter(text, 10)
        .split("\n")
        .find((l) => l.startsWith("- 順：")) ?? "";
    const bumpAt = flow.indexOf("正式な版に上げる");
    expect(bumpAt).toBeGreaterThanOrEqual(0);
    expect(flow.indexOf("アプリの PR をマージ")).toBeGreaterThan(bumpAt);
    expect(order).toContain(
      "共通の版を出す（人）→ 見張りがアプリのタスク長を起こして正式な版に上げる → アプリの PR をマージ",
    );
    expect(order).toMatch(/`users`[^。]*必ず1つのブランチにし/);
    expect(order).toMatch(/`users` が空の共通だけが1つで始まる/);
  });

  it("5章の木に bump があり、10.1 の表に /orca-flow:bump の行がある", async () => {
    const text = await read("docs/spec.md");
    expect(chapter(text, 5)).toMatch(
      /skills\/\{[^}]*\brun,bump,integrate\b[^}]*\}/,
    );
    const row = chapter(text, 10)
      .split("\n")
      .find((l) => l.startsWith("| `/orca-flow:bump 〈ID〉`"));
    expect(row).toBeDefined();
    expect(row).toContain("見張りが新しい会話に渡す");
    expect(row).toContain("`orca-flow outbox add 〈ID〉 push`");
    expect(row).toContain("`/orca-flow:send 〈ID〉`");
    expect(row).toContain("`orca-flow status question`");
  });

  it("7章3番に、共通の項目へアプリを必ず対にすることと、見張りが起こすことがある", async () => {
    const line =
      chapter(await read("docs/spec.md"), 7)
        .split("\n")
        .find((l) =>
          l.startsWith("3. **依存のあるタスクは同時に走らせない**"),
        ) ?? "";
    expect(line).toMatch(/共通を使うアプリ[^。]*ごとの項目が必ず組になる/);
    expect(line).toMatch(/版上げだけの項目/);
    expect(line).toMatch(/共通を使うアプリがないときだけ、共通は1つで始める/);
    expect(line).toMatch(/見張りが起こしたタスク長（`\/orca-flow:bump`）/);
  });

  it("8章に app-bump の行、users、共通の版上げ、見張りの起こしがある", async () => {
    const ch8 = chapter(await read("docs/spec.md"), 8);
    const row = ch8.split("\n").find((l) => l.startsWith("| `app-bump "));
    expect(row).toBeDefined();
    expect(row).toContain("読むだけ");
    expect(row).toContain("終了コード0");
    const json =
      ch8.split("\n").find((l) => l.includes("一覧の `--json`")) ?? "";
    expect(json).toMatch(/`users`（共通だけ。その共通を使うアプリの名前の並び/);
    expect(json).toMatch(/読めないアプリがあれば null/);
    const bump = ch8.split("\n").find((l) => l.startsWith("- 共通の版上げ"));
    expect(bump).toBeDefined();
    expect(bump).toMatch(/一番小さい `v数\.数\.数` のタグ/);
    expect(bump).toMatch(/前置きつき（`-rc` など）のタグは数えず/);
    expect(bump).toMatch(/「取り込み直す」/);
    expect(bump).toMatch(/「済んだ」/);
    expect(bump).toMatch(/同じ鍵では2回起こさない/);
    const wake = ch8
      .split("\n")
      .find((l) => l.startsWith("- 共通の版上げの起こし"));
    expect(wake).toBeDefined();
    expect(wake).toContain("`/orca-flow:bump 〈ID〉`");
    expect(wake).toContain("`appBumpCheck`");
    expect(wake).toContain("`bumpWakes`");
    expect(wake).toMatch(/時間切れのない背景が/);
    expect(wake).toMatch(/動きがなくても毎回背景を起こす/);
    expect(wake).toMatch(/カードの一言に理由を足して/);
    expect(wake).toContain("（版上げを起こせていません：〈理由〉）");
    expect(wake).toMatch(/今の一言の後ろに[^。]*足し/);
    expect(wake).toMatch(/起こせたか待ちが終わったら[^。]*外し/);
    expect(wake).toMatch(/背景がカードを書き直したら[^。]*次の回に足し直す/);
    expect(wake).toMatch(/respond の一言を書くときも[^。]*後ろに残す/);
    expect(wake).not.toContain("共通の版上げを待っています");
    expect(wake).toMatch(
      /一覧にタスクの worktree が見つからないとき[^。]*一言を書かず（空の一言とみなさない）、警告を出して次の回にやり直す/,
    );
    expect(wake).toMatch(/同じ場所を指すかで比べる/);
    expect(wake).not.toMatch(/回の時間の上限（45秒）を越えない範囲で行い/);
    expect(wake).toMatch(
      /`--bumps` の記録・PR のないタスクは、並べず、判定もしない/,
    );
    expect(ch8).toMatch(
      /版は `app-bump` の版を先に使い、出ないときだけ人に聞く/,
    );
  });

  it("8章の起こせないときの行に、会話が生きていれば二つ目を立てずに待つことがある", async () => {
    const ch8 = chapter(await read("docs/spec.md"), 8);
    const l =
      ch8.split("\n").find((x) => x.startsWith("- 起こせないとき")) ?? "";
    expect(l).toMatch(/同じタスクの会話が生きて[^。]*二つ目を立てず[^。]*待つ/);
    expect(l).toContain("前に立てた会話がまだ動いています");
  });

  it("10.1 の bump の行に、取り込み直した共通は「待つ」になったかの確かめがある", async () => {
    const row =
      (await read("docs/spec.md"))
        .split("\n")
        .find((x) => x.startsWith("| `/orca-flow:bump ")) ?? "";
    expect(row).toMatch(
      /版を上げた共通は「済んだ」、取り込み直した共通は「待つ」/,
    );
    expect(row).not.toMatch(/流し直して「済んだ」を確かめて/);
  });

  it("12章の人がすることに、アプリの版上げが残らない", async () => {
    const ch12 = chapter(await read("docs/spec.md"), 12);
    expect(ch12).not.toContain(OLD_STAGE);
    expect(ch12).not.toMatch(/アプリのマージの直前に版へ戻す/);
    expect(ch12).toMatch(/人は版を出して `\/orca-flow:send` で承認するだけ/);
    expect(ch12).toMatch(/アプリを正式な版に上げる作業は人が覚えなくてよい/);
  });

  it("5番の何も起こさない例外に、版上げを確かめるタスクがある", async () => {
    const line =
      (await read("docs/spec.md"))
        .split("\n")
        .find((l) => l.startsWith("5. precheck は動いた PR を見つけて")) ?? "";
    expect(line).toMatch(
      /動きも待ちの起こしもなければ何も起こさない。ただし、共通の版上げを確かめるタスク[^。]*背景を起こす/,
    );
  });

  it("決定の記録に、共通の版上げは見張りが起こす項がちょうど1つある", async () => {
    const lines = (await read("docs/decisions.md")).split("\n");
    const hits = lines.filter((l) =>
      /^## \d{4}-\d{2}-\d{2} 共通の版上げは見張りが起こし、共通の項目にはアプリの PR を必ず対にする$/.test(
        l,
      ),
    );
    expect(hits).toHaveLength(1);
  });

  it("13章に、見張りのタグの取得を本物の共通のリポジトリで確かめていない行がある", async () => {
    const ch13 = chapter(await read("docs/spec.md"), 13);
    const row = ch13
      .split("\n")
      .find((l) => l.includes("見張りが共通の clone でタグだけを取ってきて"));
    expect(row).toBeDefined();
    expect(row).toContain("本物の共通のリポジトリでは確かめていない");
    expect(row).toContain("`orca-flow app-bump 〈ID〉 --json`");
  });
});
