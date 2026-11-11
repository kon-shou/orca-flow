import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const loadSpec = () => readFile(path.join(ROOT, "docs/spec.md"), "utf8");

/** 「## 〈番号〉. 」の見出しから、次の「## 」の前までを返す */
function chapter(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 先頭がマーカーの行（箇条・段落）を1つ返す */
function line(body: string, marker: string): string {
  const hit = body.split("\n").filter((l) => l.includes(marker));
  expect(hit, `行が1つ：${marker}`).toHaveLength(1);
  return hit[0] ?? "";
}

describe("仕様書：承認があれば未解決のスレッドで止めない", () => {
  it("8章の見張りの箇条に、今の先頭への人の承認があればスレッドを数えないとある", async () => {
    const body = chapter(await loadSpec(), 8);
    const watch = line(body, "見張りは CI の結果を見るが");
    expect(watch).toContain("今の先頭");
    expect(watch).toContain("人の承認");
    expect(watch).toContain("数えない");
  });

  it("8章の2段目の箇条に、レビューの種類と出した先のコミットを読み、本文は取らないとある", async () => {
    const body = chapter(await loadSpec(), 8);
    const second = line(body, "3. 2段目：動いた PR だけ");
    expect(second).toContain("レビューの種類");
    expect(second).toContain("出した先のコミット");
    expect(second).toContain("本文");
    expect(second).toContain("今の先頭に人の承認がある");
    expect(second).toContain("書き手の立場は承認の判定に使わない");
  });

  it("8章の全員 OK の判定に、承認の条件・添え書き・会話の解決の必須の理由がある", async () => {
    const body = chapter(await loadSpec(), 8);
    const judge = line(
      body,
      "全員 OK の判定は見張りの `merge-wait` と同じ1つの関数",
    );
    expect(judge).toContain("`APPROVED`");
    expect(judge).toContain("今の先頭");
    expect(judge).toContain("`headRefOid`");
    expect(judge).toContain("bot でない");
    expect(judge).toContain("数えきれない");
    expect(judge).toContain(
      "未解決のスレッドが〈n〉件あるが、今の先頭に承認があるので数えない",
    );
    expect(judge).toContain("件数");
    expect(judge).toContain(
      "ブランチの保護で会話の解決を必須にしていると、Resolve するまでマージできません",
    );
  });

  it("8章の全員 OK の判定で、bot でない人の承認を数え、前の先頭・bot・コメントだけは数えない", async () => {
    const body = chapter(await loadSpec(), 8);
    const judge = line(
      body,
      "全員 OK の判定は見張りの `merge-wait` と同じ1つの関数",
    );
    expect(judge).toContain(
      "bot でない人が PR の今の先頭（`headRefOid`）に出した承認",
    );
    expect(judge).toContain("書き手の立場は問わず数える");
    expect(judge).toContain(
      "前の先頭への承認・bot の承認・コメントだけのレビューは数えない",
    );
    expect(judge).not.toContain("書き込みの権限");
    expect(judge).not.toContain("`COLLABORATOR`");
    expect(judge).not.toContain("外の人");
  });

  it("8章の全員 OK の判定で、会話の解決の必須の旨は BLOCKED のときだけ添え、DIRTY・BEHIND では添えない", async () => {
    const body = chapter(await loadSpec(), 8);
    const judge = line(
      body,
      "全員 OK の判定は見張りの `merge-wait` と同じ1つの関数",
    );
    expect(judge).toMatch(
      /`BLOCKED` のときだけ[^。]*Resolve するまでマージできません/,
    );
    expect(judge).toMatch(/`DIRTY`[^。]*`BEHIND`[^。]*添えない/);
    expect(judge).not.toContain("マージできない状態（計算中でない）だけ");
  });

  it("8章の添え書きは、全員 OK が外れたときも出すとある", async () => {
    const body = chapter(await loadSpec(), 8);
    const judge = line(
      body,
      "全員 OK の判定は見張りの `merge-wait` と同じ1つの関数",
    );
    expect(judge).toMatch(/全員 OK が外れたとき[^。]*も[^。]*出す/);
  });

  it("8章のスレッドの数えの箇条に、承認があれば数えきれなくても通るとある", async () => {
    const body = chapter(await loadSpec(), 8);
    const count = line(body, "スレッドが30件以上あっても");
    expect(count).toContain("今の先頭に人の承認");
    expect(count).toContain("数えきれない");
    expect(count).toContain("外れの理由にしない");
  });

  it("8章の merge --show の全員 OK の行に、添え書きを出すとある", async () => {
    const body = chapter(await loadSpec(), 8);
    expect(body).toMatch(/--show[^\n]*添え書き|添え書き[^\n]*--show/);
  });

  it("12章のブランチの保護に、会話の解決を必須にすると Resolve するまで止まるとある", async () => {
    const body = chapter(await loadSpec(), 12);
    const prot = line(body, "**ブランチの保護**");
    expect(prot).toContain("会話の解決");
    expect(prot).toContain("Resolve");
    expect(prot).toContain("`BLOCKED`");
    expect(prot).toContain("承認があっても");
  });

  it("13章の表に、会話の解決を必須にしたときの BLOCKED の確かめの行が2列である", async () => {
    const body = chapter(await loadSpec(), 13);
    const rows = body
      .split("\n")
      .filter(
        (l) => l.startsWith("|") && l.includes("会話の解決を必須にしたとき"),
      );
    expect(rows).toHaveLength(1);
    const cells = (rows[0] ?? "")
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain("`BLOCKED`");
    expect(cells[0]).toContain("承認済み");
    expect(cells[1]).toContain("Resolve");
  });
});
