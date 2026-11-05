import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function spec(): Promise<string> {
  return readFile(path.join(ROOT, "docs/spec.md"), "utf8");
}

/** 「## 〈番号〉. 」の見出しから、次の「## 」の前までを返す。 */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しがありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("11章の最初の段落", () => {
  it("試運転で確かめるを残さず、結果と逆の向きの未確認を書く", async () => {
    const body = chapter(await spec(), 11);
    const first = body.split("\n").find((l) => l.trim() !== "") ?? "";
    expect(first).not.toContain("試運転で確かめる");
    expect(first).toContain("1.4.245");
    expect(first).toContain("start-immediately");
    expect(first).toMatch(/逆の向き[^。]*確かめていない/);
    expect(first).toContain("Orca 1.4.229 の本体で確かめた値");
  });
});

describe("12章：閉じた会話に戻る", () => {
  it("段落がちょうど1つあり、claude --resume と権限の形を書く", async () => {
    const body = chapter(await spec(), 12);
    const paras = body
      .split("\n")
      .filter((l) => l.startsWith("**閉じた会話に戻る**"));
    expect(paras).toHaveLength(1);
    expect(paras[0]).toContain("`claude --resume`");
    expect(paras[0]).toContain("worktree のターミナル");
    expect(paras[0]).toMatch(/権限の形[^。]*引き継がれない/);
  });

  it("8章の会話を閉じる項に戻り方の案内がある", async () => {
    const line = (await spec())
      .split("\n")
      .find((l) => l.startsWith("- 会話を閉じる："));
    expect(line).toBeDefined();
    expect(line).toContain("戻り方");
    expect(line).toContain("`claude --resume`");
  });
});

describe("保留中のレビューの本文の置き場所", () => {
  it("6章の drafts.json の説明に本文を持つことと本投稿で渡すことがある", async () => {
    const line = chapter(await spec(), 6)
      .split("\n")
      .find((l) => l.startsWith("- `respond/〈ID〉/`"));
    expect(line).toBeDefined();
    expect(line).toContain("本文");
    expect(line).toContain("`summary`");
    expect(line).toMatch(/本投稿のときに渡す/);
  });

  it("12章の11に、下書きの画面に出ず respond drafts と outbox show で読むとある", async () => {
    const line = chapter(await spec(), 12)
      .split("\n")
      .find((l) => l.startsWith("11. **指摘に答える**"));
    expect(line).toBeDefined();
    expect(line).toContain("下書きの画面に出ない");
    expect(line).toContain("respond drafts");
    expect(line).toContain("outbox show");
  });

  it("12章の11に、本文があるときは GitHub の画面から送らず send だけで送るとある", async () => {
    const line = chapter(await spec(), 12)
      .split("\n")
      .find((l) => l.startsWith("11. **指摘に答える**"));
    expect(line).toMatch(/GitHub の画面から[^。]*送らない/);
    expect(line).toMatch(/本文は載らず/);
    expect(line).toContain("`/orca-flow:send");
  });

  it("8章の respond と outbox add の行に、本文を記録から読み本投稿で渡すとある", async () => {
    const rows = chapter(await spec(), 8).split("\n");
    const respond = rows.find((l) => l.startsWith("| `respond input"));
    const outbox = rows.find((l) => l.startsWith("| `outbox add"));
    expect(respond).toContain("drafts.json");
    expect(respond).toContain("本投稿で渡す");
    expect(outbox).toContain("記録の本文を含む");
    expect(outbox).toContain("`body`");
  });
});

describe("13章：本文を渡す本投稿の行", () => {
  it("ちょうど1つで、2列で、置き換わると確かめた結果・日付と版・代わりがある", async () => {
    const rows = chapter(await spec(), 13)
      .split("\n")
      .filter((l) => l.startsWith("|"))
      .filter((l) => l.includes("本文（`body`）を渡して本投稿"));
    expect(rows).toHaveLength(1);
    const cells = rows[0]!
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain("`submitPullRequestReview`");
    expect(cells[0]).toContain("置き換わるか");
    expect(cells[1]).not.toContain("まだ確かめていない");
    expect(cells[1]).toContain("置き換わ");
    expect(cells[1]).toContain("編集の履歴");
    expect(cells[1]).toContain("`userContentEdits`");
    expect(cells[1]).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(cells[1]).toMatch(/\d+\.\d+\.\d+/);
    expect(cells[1]).toContain("載らなければ");
    expect(cells[1]).toContain("置き換わらなければ、両方あるとき送らずに断る");
  });
});

describe("8章の approve の行の順", () => {
  it("カードを working にする文が /clear を送る文より前にある", async () => {
    const row = chapter(await spec(), 8)
      .split("\n")
      .find((l) => l.startsWith("| `approve "));
    expect(row).toBeDefined();
    const card = row!.indexOf("カードを working にする");
    const clear = row!.indexOf("`/clear` を送り");
    const launch = row!.indexOf("`orca agent launch`");
    expect(card).toBeGreaterThan(row!.indexOf("入力欄をもう一度確かめ"));
    expect(card).toBeLessThan(clear);
    expect(card).toBeLessThan(launch);
    expect(row).toContain("「設計書のレビュー待ち」に戻");
  });
});
