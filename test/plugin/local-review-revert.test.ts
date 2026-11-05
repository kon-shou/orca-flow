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

/** 開始の行から、終わりの条件に合う行の前まで */
function slice(text: string, start: RegExp, end: RegExp): string {
  const lines = text.split("\n");
  const s = lines.findIndex((l) => start.test(l));
  expect(s, `見出しが見つかりません：${start}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(s + 1);
  const e = rest.findIndex((l) => end.test(l));
  return (e < 0 ? rest : rest.slice(0, e)).join("\n");
}

function lineStarting(text: string, re: RegExp): string {
  const line = text.split("\n").find((l) => re.test(l));
  expect(line, `行が見つかりません：${re}`).toBeDefined();
  return line ?? "";
}

async function localCommon(): Promise<string> {
  const run = await read("skills/run/SKILL.md");
  const local = slice(
    run,
    /^## ローカルレビュー（reviewBackend: local）/,
    /^## /,
  );
  return slice(local, /^### 共通の決まり/, /^### /);
}

async function runStep6(): Promise<string> {
  const run = await read("skills/run/SKILL.md");
  return slice(run, /^6\. /, /^7\. /);
}

describe("ローカルレビューで戻す判断事項はタスク長が確かめる", () => {
  it("run のローカルの共通の決まりに「戻した判断事項の確かめ」の箇条がある", async () => {
    const line = lineStarting(
      await localCommon(),
      /^- 戻した判断事項の確かめ：/,
    );
    for (const s of [
      "`light`",
      "`full`",
      "根拠のファイルと行",
      "担当に戻",
      "2回",
      "`orca-flow status question`",
      "人が「戻す」を選んだ",
    ])
      expect(line, s).toContain(s);
    for (const s of [
      "`record-fix`",
      "`revertJustification`",
      "「タスク長が確かめた」",
      "「コードレビュー」の節",
    ])
      expect(line, s).toContain(s);
  });

  it("codeReview: full の手順3・6から、その箇条を指す", async () => {
    const run = await read("skills/run/SKILL.md");
    const full = slice(run, /^### codeReview: full/, /^## /);
    const p = "「戻す」なら、共通の決まりの「戻した判断事項の確かめ」のとおり";
    expect(lineStarting(full, /^3\. /)).toContain(p);
    expect(lineStarting(full, /^4\. /)).toContain(p);
    expect(lineStarting(full, /^6\. /)).toContain(p);
  });

  it("run の手順6は、検証役が確かめるのを claude の full だけにし、local はローカルの節に従う", async () => {
    const step6 = await runStep6();
    const line = lineStarting(step6, /^\s*- 戻した判断事項の確かめ：/);
    expect(line).toContain("`full` は検証役が確かめる");
    expect(line).toContain("`reviewBackend` が `claude` の");
    expect(line).toContain("`local` は");
    expect(line).toContain("「ローカルレビュー（reviewBackend: local）」");
    expect(line).toContain("「戻した判断事項の確かめ」");
    const chosen = lineStarting(step6, /^\s*- 人が「直す」と選んだとき/);
    expect(chosen).toContain(
      "「戻した判断事項」は、文書だけ・`light`・`off` では、上の「戻した判断事項の確かめ」のとおりタスク長が確かめる",
    );
    expect(chosen).toContain("`local` では");
  });

  it("review のスキルの local の段落が、redo は確かめず run が確かめると書く", async () => {
    const review = await read("skills/review/SKILL.md");
    const para = lineStarting(
      review,
      /^設定の `reviewBackend` が `local` のとき/,
    );
    expect(para).toContain("やり直しの形");
    expect(para).toContain("「戻した判断事項」");
    expect(para).toContain("確かめない");
    expect(para).toContain("run が確かめる");
  });

  it("仕様書の 9.1・10.1・10.3 に、local では run（タスク長）が確かめると書く", async () => {
    const spec = await read("docs/spec.md");
    const s91 = lineStarting(spec, /^- 統合の前に人が決めるもの/);
    const row = lineStarting(spec, /^\| `\/orca-flow:run /);
    const para = lineStarting(spec, /^review は、`判断事項：〈項目の名前〉`/);
    const s103 = slice(spec, /^### 10\.3 /, /^### /);
    for (const [name, t] of [
      ["9.1", s91],
      ["10.1 run の行", row],
      ["10.1 続きの段落", para],
    ] as const) {
      expect(t, name).toContain("local");
      expect(t, name).toContain("タスク長");
      expect(t, name).toContain("確かめ");
    }
    // 検証役が確かめるのは claude の full だけ
    expect(s91).toContain("`full` では検証役が確かめる");
    expect(s91).toContain("reviewBackend が `claude`");
    expect(para).toContain("reviewBackend が `claude`");
    // run の行は main の時点で「タスク長」「確かめ」を含むので、足した文の芯で確かめる
    expect(row).toMatch(
      /local では[^。]*「戻す」の判断事項[^。]*タスク長が[^。]*確かめる/,
    );
    const item = lineStarting(s103, /^- redo は/);
    expect(item).toContain("humanReview");
    expect(item).toContain("needs_human");
    expect(item).toContain("やり直しの検証に入れない");
    expect(item).toContain("戻した判断事項");
    expect(item).toContain("run（タスク長）が");
    expect(item).toContain("根拠のファイルと行");
  });
});
