import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (file: string) => readFile(path.join(ROOT, file), "utf8");

/** 「## 〈番号〉. 」の見出しの行から、次の「## 」の前まで */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しがありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("仕様書：GitHub の見張りの移し", () => {
  it("15章がなく、見張りの節・見積もり・見張りの設定と記録・見張りの人の使い方の移した文が残っていない", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).not.toMatch(/^## 15\. /m);
    for (const gone of [
      "節を足す：『見張り（pr-watch）』",
      "GitHub の回数の見積もり（1リポジトリ、PR 50本）",
      "- 動きの種類：",
      "| `prWatch` |",
      "節を足す：『送りの案と見張りの記録』",
      "- `pr-watch [usage]`（automation の precheck）",
      "- 『見張り』：リポジトリごとに automation が1つ動く。",
      "- カードの `comment` に、他人の文章を入れない",
    ]) {
      expect(spec, `${gone} が仕様書に残っています`).not.toContain(gone);
    }
    // この2行は13章の「まだ確かめていないこと」へ移った
    const c13 = chapter(spec, 13);
    for (const moved of [
      "| precheck が0以外で終わったとき",
      "| 5分おきの cron が",
    ]) {
      expect(c13, `${moved} が13章にありません`).toContain(moved);
    }
  });

  it("8章に、pr-watch の行と見張りの節（--root・install の2回目・今すぐ実行）がある", async () => {
    const c8 = chapter(await read("docs/spec.md"), 8);
    expect(c8).toMatch(/^\| `pr-watch \[usage\\\|install\\\|uninstall\]`/m);
    const part = c8.slice(c8.indexOf("**見張り（pr-watch）**"));
    expect(part).toContain("`--root 〈パス〉`");
    expect(part).toContain("PATH の `orca-flow` に頼らず");
    expect(part).toContain("`--workspace`・`--reuse-session` は渡さない");
    expect(part).toContain("2つ目は作らず今の中身に直す");
    expect(part).toContain("`pr-watch background`");
    expect(part).toContain("自分のアカウントの書き込みと、send が送った push");
    expect(part).toContain("約96点");
    expect(c8).toContain("`push 〈ID〉 --watch` は受け取らない");
    expect(c8).toContain("`pr-watch` は automation の precheck から呼ばれる");
  });

  it("1章：automation を作る道（init と pr-watch install）と、push の案内が taskEnd によらないこと", async () => {
    const c1 = chapter(await read("docs/spec.md"), 1);
    expect(c1).toContain('`init` が `taskEnd: "pr"` のときに作る');
    expect(c1).toContain("`orca-flow pr-watch install`");
    expect(c1).toContain("`taskEnd` によらず");
  });

  it("4章・6章・7章に移した部分がある", async () => {
    const text = await read("docs/spec.md");
    expect(chapter(text, 4)).toContain("他人の文章");
    const c6 = chapter(text, 6);
    expect(c6).toMatch(/^\| prWatch /m);
    expect(c6).toContain("`pr-watch/state.json`");
    expect(c6).toContain("`pr-watch/usage-〈日付〉.jsonl`");
    expect(chapter(text, 7)).toContain("見張りが見つけたときも");
  });

  it("12章に見張りの項、13章に precheck の絶対パスと --root の行がある", async () => {
    const text = await read("docs/spec.md");
    const c12 = chapter(text, 12);
    expect(c12).toContain("**見張り**");
    expect(c12).toContain("今すぐ実行");
    expect(c12).toContain("`pr-watch install` を打ち直す");
    const c13 = chapter(text, 13);
    expect(c13).toContain("`--root`");
    expect(c13).toContain("絶対パスが古くなったら");
    expect(c13).toContain("今すぐ実行");
  });
});

describe("スキル：見張りの案内", () => {
  it("push は、automation がないときの作り方と「今すぐ実行」を押さないことを伝える", async () => {
    const text = await read("skills/push/SKILL.md");
    expect(text).toContain("見張りの automation がない");
    expect(text).toContain("orca-flow pr-watch install");
    expect(text).toContain("今すぐ実行");
    expect(text).not.toContain("--watch");
  });

  it("send と init も、見張りの作り方と「今すぐ実行」を押さないことを伝える", async () => {
    for (const skill of ["send", "init"]) {
      const text = await read(`skills/${skill}/SKILL.md`);
      expect(text, skill).toContain("orca-flow pr-watch install");
      expect(text, skill).toContain("今すぐ実行");
    }
  });
});

describe("仕様書：見張りの直し", () => {
  it("古い待ち受けの文が残らず、確認待ちに戻す・他人の push・ロックの持ち主・確かめられない案内を書く", async () => {
    const spec = await read("docs/spec.md");
    for (const gone of [
      "今はタスクごとの待ち受け",
      "待ち受け（15章で見張りに替わる）",
      "（戻すのは実装4）",
      "push の道（8章 push）の待ち受けの記録",
      "後始末が済んだ PR は、待ち受けが",
    ]) {
      expect(spec, gone).not.toContain(gone);
    }
    expect(spec).toContain("他人の push");
    for (const owner of [
      "見張りが後始末をしています",
      "ほかの push が後始末をしています",
      "古い待ち受けが後始末をしています",
    ]) {
      expect(spec, owner).toContain(owner);
    }
    expect(spec).toContain("見張りの automation があるか確かめられません");
    expect(spec).toContain("GitHub 上の PR の先頭だけが違うとき");
    const marker = "- Orca の外（ターミナルだけ）での利用";
    expect(spec.split(marker).length - 1).toBe(1);
  });

  it("push のスキルは、ロックの持ち主の3つの文と、確かめられないときの案内を書く", async () => {
    const text = await read("skills/push/SKILL.md");
    for (const m of [
      "見張りが後始末をしています",
      "ほかの push が後始末をしています",
      "古い待ち受けが後始末をしています",
    ])
      expect(text, m).toContain(m);
    expect(text).toContain("push を打ち直さず");
  });
});
