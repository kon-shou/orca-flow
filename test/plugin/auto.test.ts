import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 見出しに当たる行の次から、同じ深さ以下の見出しの前までを返す。 */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const depth = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+) /.exec(l);
    return m !== null && (m[1]?.length ?? 99) <= depth;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 表示の幅（全角は2）。 */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x1100 && (c < 0xe000 || (c >= 0xff00 && c <= 0xff60)) ? 2 : 1;
  }
  return w;
}

function longestTableRow(text: string): number {
  const rows = text.split("\n").filter((l) => l.startsWith("|"));
  expect(rows.length).toBeGreaterThan(0);
  return Math.max(...rows.map(displayWidth));
}

describe("おまかせ：スキル", () => {
  it("auto のスキルがあり、名前の呼び出しだけで動く", async () => {
    const auto = await read("skills/auto/SKILL.md");
    const front = /^---\n([\s\S]*?)\n---/.exec(auto)?.[1] ?? "";
    expect(front).toContain("name: auto");
    expect(front).toContain("disable-model-invocation: true");
  });

  it("auto：一覧・背景の待ち受け・引数の受け渡し", async () => {
    const auto = await read("skills/auto/SKILL.md");
    expect(auto).toContain("orca-flow auto wait");
    expect(auto).toContain("run_in_background");
    expect(auto).toContain("orca-flow auto 〈引数〉");
    // 待ち受けの終了コード2（ほかの待ち受けが動いている）の扱いの文
    const steps = section(auto, /^## 手順/);
    expect(steps).toMatch(
      /`orca-flow auto wait`[^\n]*終了コード2は[^\n]*何もしない/,
    );
  });

  it("auto：拾われたまま進まない番を on で立て直し、カードが合わないときは人に1行伝える", async () => {
    const auto = await read("skills/auto/SKILL.md");
    const steps = section(auto, /^## 手順/);
    const first = steps.split("\n").find((l) => l.startsWith("1. ")) ?? "";
    expect(first).toContain("拾われました");
    expect(first).toContain("orca-flow auto on 〈ID〉");
    expect(first.indexOf("orca-flow auto on 〈ID〉")).toBeLessThan(
      first.indexOf("手順3"),
    );
    const turn = section(auto, /^## 番が来たら/);
    const second = turn.split("\n").find((l) => l.startsWith("2. ")) ?? "";
    expect(second).toContain("人間に1行伝える");
    expect(second).toContain("/orca-flow:approve");
    expect(second).toContain("/orca-flow:integrate");
    expect(second).toContain("orca-flow auto on 〈ID〉");
    expect(second).not.toContain("何もせず");
  });

  it("引用符：文は一重引用符で囲み、二重引用符の形を残さない", async () => {
    const auto = await read("skills/auto/SKILL.md");
    expect(auto).toContain("一重引用符");
    for (const rel of [
      "skills/approve/SKILL.md",
      "skills/integrate/SKILL.md",
    ]) {
      const rule = section(await read(rel), /^## おまかせの決まり/);
      expect(rule, rel).toContain("一重引用符");
      expect(rule, rel).toContain("'\\''");
      expect(rule, rel).not.toMatch(/orca-flow auto log \$0 "/);
      expect(rule, rel).not.toMatch(/--reason "/);
      expect(rule, rel).toContain("orca-flow auto log $0 '〈決めたこと〉'");
    }
    const integrate = section(
      await read("skills/integrate/SKILL.md"),
      /^## おまかせの決まり/,
    );
    expect(integrate).toContain("--reason '〈止まった理由の一言〉'");
  });

  it("おまかせでは、戻れば統括役が続け、人に打たせない（二重に進めない）", async () => {
    const integrate = section(
      await read("skills/integrate/SKILL.md"),
      /^## おまかせの決まり/,
    );
    const rule3 = integrate.split("\n").find((l) => l.startsWith("3. ")) ?? "";
    expect(rule3).toContain("打たなくてよい");
    expect(rule3).toContain("統括役が続けます");
    // 「先に」は番が立たないので分けて書く
    expect(rule3).toContain("orca-flow auto on 〈次の ID〉");
    const approve = section(
      await read("skills/approve/SKILL.md"),
      /^## おまかせの決まり/,
    );
    expect(approve).toContain("統括役が続けます");
    expect(approve).toContain("打たなくてよい");
  });

  it("auto：番が来たら、手順の前にカードが番と合うかを確かめる", async () => {
    const auto = await read("skills/auto/SKILL.md");
    const turn = section(auto, /^## 番が来たら/);
    expect(turn).toContain("途中なら");
    expect(turn).toContain("orca-flow active");
    expect(turn).toContain("承認も統合もしない");
    expect(turn).toContain("skills/approve/SKILL.md");
    expect(turn).toContain("skills/integrate/SKILL.md");
    expect(turn).toContain("おまかせの決まり");
    expect(turn).toContain("$0");
    expect(turn).toContain("流し直す");
    expect(turn.indexOf("orca-flow active")).toBeLessThan(
      turn.indexOf("skills/approve/SKILL.md"),
    );
  });

  it("new：--auto を外して orca-flow new --auto にし、待ち受けを背景で流す", async () => {
    const text = await read("skills/new/SKILL.md");
    expect(text).toContain("`--auto`");
    expect(text).toContain("orca-flow new --auto");
    expect(text).toContain("orca-flow auto wait");
    expect(text).toContain("背景");
    expect(text).toContain("orca-flow auto show");
    expect(text).toContain("/orca-flow:auto off");
    expect(text).toContain("後続のタスクを作る流れ");
  });

  it("approve：おまかせの決まり（推奨どおり・止まる・大事な共有のファイル）", async () => {
    const text = await read("skills/approve/SKILL.md");
    const rule = section(text, /^## おまかせの決まり/);
    expect(rule).toContain("推奨どおり");
    expect(rule).toContain("止まり、人間に聞く");
    expect(rule).toContain("大事な共有のファイル");
    expect(rule).toContain("「入れる」「止める」");
    expect(rule).toContain("orca-flow auto log $0");
    expect(rule).toContain("orca-flow auto show $0");
    expect(rule).toContain("`--auto` をつけない");
  });

  it("approve：おまかせで入力欄の問題（終了コード2）が出たら、直したあと /orca-flow:auto を打つよう伝える", async () => {
    const rule = section(
      await read("skills/approve/SKILL.md"),
      /^## おまかせの決まり/,
    );
    const line = rule.split("\n").find((l) => l.startsWith("7. "));
    expect(line).toBeDefined();
    // カードが動かないので番は立ち直らない。人が /orca-flow:auto を打つと、拾われた番を立て直して続ける
    expect(line).toMatch(/終了コード2[^\n]*カードが動かない/);
    expect(line).toMatch(/終了コード2[^\n]*\/orca-flow:auto/);
    // 終了コード3（競合）は、カードが spec-review に戻れば番が立ち直る
    expect(line).toMatch(/終了コード3[^\n]*spec-review に戻れば番が立ち直り/);
  });

  it("integrate：おまかせの決まり（聞くのは決めきれない項目と大事な共有のファイルだけ）", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const rule = section(text, /^## おまかせの決まり/);
    expect(rule).toContain("すべて推奨どおり");
    expect(rule).toContain("聞くのは次の2つだけ");
    expect(rule).toContain("大事な共有のファイル");
    expect(rule).toContain("orca-flow auto off $0 --reason");
    expect(rule).toContain("終了コード1・3");
    expect(rule).toContain("main の確かめ");
    expect(rule).toContain("integrate-wait に戻れば");
    expect(rule).toContain("orca-flow auto log $0");
    expect(rule).toContain("orca-flow auto show $0");
    expect(rule).toContain("`--auto` をつけない");
  });

  it("spec と run：status の出力に「おまかせ」があれば統括役が進めると伝えて止まる", async () => {
    const specText = await read("skills/spec/SKILL.md");
    const step8 = specText
      .split("\n")
      .slice(specText.split("\n").findIndex((l) => l.startsWith("8. ")))
      .slice(0, 4)
      .join("\n");
    expect(step8).toContain("「おまかせ」");
    expect(step8).toContain("統括役が進めます");
    const runLine =
      (await read("skills/run/SKILL.md"))
        .split("\n")
        .find((l) => l.startsWith("11. ")) ?? "";
    expect(runLine).toContain("「おまかせ」");
    expect(runLine).toContain("統括役が進めます");
  });
});

describe("おまかせ：仕様", () => {
  it("8章に auto の行と「おまかせ」の段落がある", async () => {
    const spec = await read("docs/spec.md");
    const ch8 = section(spec, /^## 8\. CLI/);
    expect(ch8).toMatch(/^\| `auto \[show /m);
    expect(ch8).toContain("**おまかせ**");
    expect(ch8).toContain("new：`--auto`");
    expect(ch8).toContain("auto wait");
    expect(ch8).toContain("wait.lock");
  });

  it("10.1・10.4・12章・13章が合っている", async () => {
    const spec = await read("docs/spec.md");
    const s101 = section(spec, /^### 10\.1/);
    expect(s101).toMatch(/^\| `\/orca-flow:auto/m);
    expect(s101).toContain("9つ。");
    expect(s101).toContain("ほかの8つ");
    expect(section(spec, /^### 10\.4/)).toContain("/orca-flow:auto");
    expect(section(spec, /^## 12\./)).toContain("`/orca-flow:new --auto");
    const ch13 = section(spec, /^## 13\./);
    expect(ch13).toContain("orca-flow auto wait");
    expect(ch13).toContain("/orca-flow:auto");
  });

  it("8章と10.1 の表の行が、変更の前のいちばん長い行より長くない", async () => {
    const spec = await read("docs/spec.md");
    // 変更の前の値（表示の幅）。新しい決まりは表の下の段落に書く
    expect(longestTableRow(section(spec, /^## 8\. CLI/))).toBeLessThanOrEqual(
      2969,
    );
    expect(longestTableRow(section(spec, /^### 10\.1/))).toBeLessThanOrEqual(
      4708,
    );
  });
});
