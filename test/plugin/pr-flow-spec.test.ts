import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function loadSpec(): Promise<string> {
  return readFile(path.join(ROOT, "docs/spec.md"), "utf8");
}

/** 「## 〈番号〉. 」の見出しの行から、次の「## 」の前までを返す。 */
function chapter(text: string, no: number): { heading: string; body: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${no}. `));
  expect(start, `${no}章の見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return {
    heading: lines[start] ?? "",
    body: (end < 0 ? rest : rest.slice(0, end)).join("\n"),
  };
}

// タスクの番号の形と公開から抜く文書のパスは、自分のファイルに書かないよう実行時に組む。
const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const privateDocs = `docs/${"pr-flow"}`;

describe("仕様書の15章：自分の PR をマージまで回す（まだ作っていない）", () => {
  it("「## 15. 」の見出しが「まだ作っていない」を含んで1つだけあり、14章は今のまま", async () => {
    const text = await loadSpec();
    const headings = text.split("\n").filter((l) => l.startsWith("## 15. "));
    expect(headings).toHaveLength(1);
    expect(headings[0]).toContain("まだ作っていない");
    expect(chapter(text, 14).heading).toBe(
      "## 14. 契約のファイル（このリポジトリの開発）",
    );
  });

  it("小見出しが9つで、どれにも「移す先：」の行がある", async () => {
    const c = chapter(await loadSpec(), 15);
    const parts = c.body.split(/^### /m).slice(1);
    expect(parts).toHaveLength(9);
    for (const part of parts) {
      const title = part.split("\n")[0];
      expect(part, `${title} に「移す先：」の行がありません`).toMatch(
        /^移す先：/m,
      );
    }
  });

  it("冒頭に、決めた形でまだ動かないこと・今の動きは1〜14章と書いてある", async () => {
    const c = chapter(await loadSpec(), 15);
    const intro = c.body.split(/^### /m)[0] ?? "";
    expect(intro).toContain("まだ動かない");
    expect(intro).toContain("1〜14章");
  });

  it("確定した名前が15章にある", async () => {
    const c = chapter(await loadSpec(), 15);
    for (const name of [
      "orca-flow outbox",
      "orca-flow send",
      "orca-flow pr-watch",
      "/orca-flow:respond",
      "responding",
      "send-wait",
      "merge-wait",
      "cleanup-stopped",
      "taskEnd",
      "outbound",
      "prWatch",
      "risk",
      "pushTaskBranch",
      "createDraftPr",
      "markPrReady",
      "redactSecrets",
      "push/〈ID〉.json",
      "束の指紋",
    ]) {
      expect(c.body, `${name} が15章にありません`).toContain(name);
    }
  });

  it("仮の名前と古い言い方が15章に残っていない", async () => {
    const c = chapter(await loadSpec(), 15);
    for (const old of [
      "finish-stuck",
      "merged.jsonl",
      "名前は仮",
      "redact.ts",
    ]) {
      expect(c.body, `${old} が15章に残っています`).not.toContain(old);
    }
  });

  it("前から allow に入れている人が send を ask に足す手順がある", async () => {
    const c = chapter(await loadSpec(), 15);
    const lines = c.body
      .split("\n")
      .filter(
        (l) =>
          l.includes("Bash(orca-flow *)") &&
          l.includes("Bash(orca-flow send *)") &&
          l.includes("allow") &&
          l.includes("ask"),
      );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/前から|すでに/);
  });

  it("状態とカードの印を「taskEnd が pr のときだけ」に絞る文がない", async () => {
    const c = chapter(await loadSpec(), 15);
    // 15章の全体：「taskEnd が "pr" のときだけ」の形がない
    expect(c.body).not.toMatch(
      /taskEnd[`\s]*(が|:)[`\s]*"pr"[`\s]*(の|で)[^。\n]*(ときだけ|場合だけ|ときに限|のみ)/,
    );
    // 15.3：によらず使うと書き、taskEnd と pr を含む行で絞らない
    const lines = c.body.split("\n");
    const start = lines.findIndex((l) => l.startsWith("### 15.3 "));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && l.startsWith("### "));
    expect(end).toBeGreaterThan(start);
    const part = lines.slice(start, end);
    expect(part.join("\n")).toMatch(/taskEnd[^。\n]*によらず/);
    const narrowing = part.filter(
      (l) =>
        l.includes("taskEnd") && /"?\bpr\b"?/.test(l) && /だけ|のみ|限/.test(l),
    );
    expect(narrowing).toEqual([]);
  });

  it("まだ確かめていないことに、提案の表の行が全部ある", async () => {
    const c = chapter(await loadSpec(), 15);
    const part = c.body.split(/^### /m).slice(-1)[0] ?? "";
    const rows = part.split("\n").filter((l) => l.startsWith("| "));
    // 見出しの行と区切りの行を除いて、12行以上
    expect(rows.length - 2).toBeGreaterThanOrEqual(12);
    for (const key of [
      "閉じたタスク長の会話",
      "時間帯の外で積んだ案",
      "bypass permissions",
      "今すぐ実行",
      "orca terminal close",
      "worktree set --pr",
    ]) {
      expect(part, `${key} の行がありません`).toContain(key);
    }
  });

  it("1章・2章・8章に、15章を指す行がある", async () => {
    const text = await loadSpec();
    for (const no of [1, 2, 8]) {
      const c = chapter(text, no);
      const hit = c.body
        .split("\n")
        .some((l) => l.includes("15章") && l.includes("まだ作っていない"));
      expect(hit, `${no}章に15章を指す行がありません`).toBe(true);
    }
  });

  it("8章の push の節の最後に、15章を指す行がある", async () => {
    const c = chapter(await loadSpec(), 8);
    const lines = c.body.split("\n");
    const start = lines.findIndex((l) => l.startsWith("**push（PR の道）**"));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex(
      (l, i) => i > start && l.startsWith("**おまかせ**"),
    );
    expect(end).toBeGreaterThan(start);
    const section = lines.slice(start, end).filter((l) => l.trim() !== "");
    expect(section[section.length - 1]).toContain("15章");
  });

  it("spec.md 全体にタスクの番号の形と、公開から抜く文書のパスがない", async () => {
    const text = await loadSpec();
    expect(text.split("\n").filter((l) => idForm.test(l))).toEqual([]);
    expect(text).not.toContain(privateDocs);
  });
});

/** 15章の「### 〈番号〉 」の小見出しから、次の小見出しの前までを返す。 */
function section(body: string, no: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`### ${no} `));
  expect(start, `${no} の小見出しが見つかりません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("### "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("仕様書15章：マージは orca-flow merge の1本だけ", () => {
  it("15章に merge の名前があり、「GitHub でマージ」「GitHub で行う」の文がない", async () => {
    const c = chapter(await loadSpec(), 15);
    for (const name of [
      "orca-flow merge",
      "/orca-flow:merge",
      "Bash(orca-flow merge *)",
    ]) {
      expect(c.body, `${name} が15章にありません`).toContain(name);
    }
    expect(c.body).not.toContain("GitHub でマージ");
    expect(c.body).not.toContain("GitHub で行う");
  });

  it("15.5 と 15.8 に「GitHub の画面からマージしない」がある", async () => {
    const c = chapter(await loadSpec(), 15);
    for (const no of ["15.5", "15.8"]) {
      expect(section(c.body, no), `${no} にありません`).toContain(
        "GitHub の画面からマージしない",
      );
    }
  });

  it("『マージの前の確かめ』に、依存・マージの順・全員 OK・先頭・finishMergedTask の語がある", async () => {
    const c = chapter(await loadSpec(), 15);
    const part = section(c.body, "15.6");
    const at = part.indexOf("節を足す：『マージの前の確かめ』");
    expect(at).toBeGreaterThanOrEqual(0);
    const rest = part.slice(at + 1);
    const next = rest.indexOf("節を足す：");
    const check = part.slice(at, next < 0 ? undefined : at + 1 + next);
    for (const word of [
      "依存",
      "マージの順",
      "全員 OK",
      "先頭",
      "finishMergedTask",
    ]) {
      expect(check, `${word} がありません`).toContain(word);
    }
  });

  it("15.4 の outbound の既定の許可リストに merge がない", async () => {
    const c = chapter(await loadSpec(), 15);
    const row = section(c.body, "15.4")
      .split("\n")
      .find((l) => l.startsWith("| `outbound`"));
    expect(row).toBeDefined();
    const allow = /"allow":\s*\[([^\]]*)\]/.exec(row ?? "");
    expect(allow).not.toBeNull();
    expect(allow?.[1]).not.toContain("merge");
  });

  it("1・2・8章の15章を指す行に orca-flow merge があり、12章の PR で統合する道に15章を指す一言がある", async () => {
    const text = await loadSpec();
    for (const no of [1, 2, 8]) {
      const lines = chapter(text, no)
        .body.split("\n")
        .filter((l) => l.includes("15章") && l.includes("まだ作っていない"));
      expect(lines.length).toBeGreaterThan(0);
      expect(
        lines.join("\n"),
        `${no}章の15章を指す行に orca-flow merge がありません`,
      ).toContain("orca-flow merge");
    }
    const para = chapter(text, 12)
      .body.split("\n")
      .find((l) => l.startsWith("**PR で統合する道**"));
    expect(para).toBeDefined();
    expect(para).toContain("15章");
  });
});

describe("仕様書15章：権限を飛ばす形と前から allow の人の手順に merge がある", () => {
  it("15.8 の前から allow の人の手順に Bash(orca-flow merge *) がある", async () => {
    const c = chapter(await loadSpec(), 15);
    const lines = section(c.body, "15.8")
      .split("\n")
      .filter(
        (l) =>
          l.includes("Bash(orca-flow *)") &&
          l.includes("allow") &&
          l.includes("ask") &&
          /前から|すでに/.test(l),
      );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("Bash(orca-flow merge *)");
  });

  it("15章に、「send を使わない」で merge を伴わない形が残っていない", async () => {
    const c = chapter(await loadSpec(), 15);
    const bad = c.body
      .split("\n")
      .filter(
        (l) => /send を使わない/.test(l) && !/send と merge を使わない/.test(l),
      );
    expect(bad).toEqual([]);
  });

  it("マージの順に当たる3番は、7章の見出しの名前で呼ぶ", async () => {
    const c = chapter(await loadSpec(), 15);
    expect(section(c.body, "15.5")).toContain(
      "3番（依存のあるタスクは同時に走らせない）",
    );
  });

  it("エージェントは打たないが、人が打った /orca-flow:merge の手順だけは --head を流す", async () => {
    const c = chapter(await loadSpec(), 15);
    expect(section(c.body, "15.7")).toContain("の手順を除く");
  });
});

// 公開用の木では私的な文書が抜かれるので、あるときだけ確かめる。
describe.skipIf(!existsSync(path.join(ROOT, privateDocs)))(
  "PR の流れの文書：マージは orca-flow merge の1本だけ",
  () => {
    it("私的な文書に、人が GitHub でマージする旧い言い方が残っていない", async () => {
      for (const file of ["proposal.md", "spec-change.md", "tasks.md"]) {
        const text = await readFile(path.join(ROOT, privateDocs, file), "utf8");
        for (const old of [
          "人が GitHub でマージ",
          "GitHub で行う",
          "マージの呼び出しが0回",
        ]) {
          expect(text, `${file} に「${old}」が残っています`).not.toContain(old);
        }
      }
    });

    it("tasks.md の実装8に orca-flow merge と、マージが呼ばれる条件がある", async () => {
      const text = await readFile(
        path.join(ROOT, privateDocs, "tasks.md"),
        "utf8",
      );
      const lines = text.split("\n");
      const start = lines.findIndex((l) => /^##+ 実装8/.test(l));
      expect(start).toBeGreaterThanOrEqual(0);
      const end = lines.findIndex((l, i) => i > start && /^##+ 実装9/.test(l));
      const part = lines.slice(start, end < 0 ? undefined : end).join("\n");
      expect(part).toContain("orca-flow merge");
      expect(part).toContain(
        "人の承認と依存・全員 OK・先頭の照らしを通ったときだけマージが呼ばれる",
      );
    });
  },
);
