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

/** 「## 〈番号〉. 」の見出しから、次の「## 」の前まで。 */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章が見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 全角を2、ほかを1と数えた表示の幅（整形が表を揃える幅に近い）。 */
function width(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    w += c >= 0x2e80 && c <= 0xffe6 ? 2 : 1;
  }
  return w;
}

describe("仕様書：合議で自動で決める", () => {
  it("6章：自動の記録の置き場と中身があり、「記録だけで、自動では決めない」がない", async () => {
    const c6 = chapter(await read("docs/spec.md"), 6);
    expect(c6).toContain("`vote-auto.json`");
    expect(c6).toContain("自動で決めた件");
    expect(c6).toContain("ないときは全部切り");
    expect(c6).not.toContain("記録だけで、自動では決めない");
  });

  it("8章：vote の行は短く指すだけで、「自動で決める道はない」がなく、表の区切りの行の長さが揃っている", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const lines = c8.split("\n");
    const row = lines.find((l) => l.startsWith("| `vote "))!;
    expect(row).toContain("合議で自動で決める");
    expect(row).not.toContain("自動で決める道はない");
    const sep = lines.find((l) => /^\| -{10,}/.test(l))!;
    const rowIdx = lines.indexOf(row);
    // 同じ表の行は、整形で同じ幅に揃う（区切りの行と vote の行は同じ長さ）
    expect(width(row)).toBe(width(sep));
    expect(rowIdx).toBeGreaterThan(lines.indexOf(sep));
  });

  it("8章：新しい段落に、コマンド・下限・出す文・止める条件がある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    const para = c8
      .split("\n")
      .findIndex((l) => l.startsWith("**合議で自動で決める**"));
    expect(para).toBeGreaterThanOrEqual(0);
    const rest = c8.split("\n").slice(para);
    const end = rest.findIndex((l, i) => i > 0 && l.startsWith("**"));
    const text = rest.slice(0, end < 0 ? undefined : end).join("\n");
    for (const w of [
      "orca-flow vote auto",
      "vote auto on 〈種類〉",
      "vote auto off 〈種類〉",
      "`comment` だけ",
      "メインのチェックアウトだけ",
      "20件以上",
      "95%以上",
      "5件以上",
      "自動で決めました（〈キー〉）",
      "自動で決めた件が外れたので、〈種類〉の自動を切りました",
      "1件の外れで切り",
      "vote-auto.json",
      "send",
    ]) {
      expect(text, w).toContain(w);
    }
  });

  it("10.1：respond の手順⑧に自動で決めた指摘の扱いがあり、全部を聞く文は頭に断りがある", async () => {
    const c10 = chapter(await read("docs/spec.md"), 10);
    const para = c10
      .split("\n")
      .find((l) => l.startsWith("**respond の手順**"))!;
    expect(para).toContain("自動で決めました（〈キー〉）");
    expect(para).toContain("自動で決めた指摘のほかは、2票目の結果によらず");
    expect(para).toContain("「自動で決めた」の印とキー");
    expect(para).toContain("`vote answer`");
  });

  it("12章：使い方に入れ方・見方・切り方がある", async () => {
    const c12 = chapter(await read("docs/spec.md"), 12);
    expect(c12).toContain("`orca-flow vote auto on comment`");
    expect(c12).toContain("`orca-flow vote auto off comment`");
    expect(c12).toContain("20件以上");
    expect(c12).toContain("95%以上");
  });

  it("13章：2票目の行から「作らない」が消え、切ったままにする文がある", async () => {
    const c13 = chapter(await read("docs/spec.md"), 13);
    const row = c13.split("\n").find((l) => l.includes("2票目の `claude -p`"))!;
    expect(row).not.toContain("作らない");
    expect(row).toContain("切ったまま");
  });
});

describe("respond のスキル：自動で決めた指摘", () => {
  it("自動で決めた指摘は聞かずに進め、下書きを見せるときに印とキーで並べ、人の答えで vote answer を流す", async () => {
    const s = await read("skills/respond/SKILL.md");
    expect(s).toContain("自動で決めました（〈キー〉）");
    expect(s).toContain(
      "自動で決めた指摘のほかは、2票目の結果によらず、全部の指摘を人に聞く",
    );
    expect(s).toContain("「自動で決めた」の印とキー");
    expect(s).toContain(
      "自動で決めた件が外れたので、〈種類〉の自動を切りました",
    );
    expect(s).toMatch(/自動の指摘にも同じ `vote answer` を流す/);
    expect(s).not.toContain("記録だけで、自動では決めない");
  });
  it("手順の番号が合い、自動で決めた指摘の例外と外れたときの作り直しがある", async () => {
    const s = await read("skills/respond/SKILL.md");
    expect(s).toContain("人が確かめるのは手順9の下書きを見せるとき");
    expect(s).not.toContain("⑤の下書き");
    expect(s).toContain(
      "自動で決めた指摘のほかは、人間が答えるまで、直さない。案も積まない。",
    );
    expect(s).toContain(
      "- 自動で決めた指摘のほかは、人間が答えるまで直さない。答えがなくても",
    );
    expect(s).toContain("人の答えのとおりに手順8の直しと下書きを作り直す");
  });

  it("仕様書：10.1③に例外があり、8章と12章に確かめ待ち5件の片づけ方がある", async () => {
    const spec = await read("docs/spec.md");
    const para = chapter(spec, 10)
      .split("\n")
      .find((l) => l.startsWith("**respond の手順**"))!;
    expect(para).toContain(
      "自動で決めた指摘のほかは、人間が答えるまで直さず、案を積まない。",
    );
    const w = "確かめ待ちが5件で止まったら";
    expect(chapter(spec, 8)).toContain(w);
    expect(chapter(spec, 12)).toContain(w);
    expect(chapter(spec, 12)).toContain("`vote answer` を流して片づける");
  });
});
