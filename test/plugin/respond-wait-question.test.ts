import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 手順の番号から、次の手順の前までを返す。 */
function step(text: string, no: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${no}. `));
  expect(start, `手順${no}がありません`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || l.startsWith("## "));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

describe("respond のスキル：答えを待つあいだの question", () => {
  it("手順6と9で、待つ前に question にし、答えが来たら最初に responding に戻す", async () => {
    const text = await read("skills/respond/SKILL.md");
    for (const no of [6, 9]) {
      const s = step(text, no);
      expect(s, `手順${no}`).toContain("orca-flow status question --note");
      expect(s, `手順${no}`).toMatch(
        /答えが来たら、?最初に `orca-flow status responding/,
      );
    }
  });

  it("案を積んだあと（手順11・12）は question にせず、理由を添える", async () => {
    const text = await read("skills/respond/SKILL.md");
    const s12 = step(text, 12);
    expect(s12).toContain("案を積んだあと（手順11・12）は `question` にしない");
    expect(s12).toMatch(/理由：[^\n]*send[^\n]*段を戻す人がいない/);
    expect(step(text, 11)).not.toContain("status question");
  });
});

describe("respond のスキル：引き継ぎと起こされたとき", () => {
  it("引き継ぎに答え済み・下書き済み・答え待ちの3つがある", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 6);
    expect(s).toMatch(
      /答え済みの指摘：場所[^\n]*ノード ID[^\n]*人の答えのキー/,
    );
    expect(s).toMatch(/下書き済みの返信：スレッドの場所/);
    expect(s).toMatch(/聞いて答え待ちの指摘：場所/);
  });

  it("起こされたら、答え済み・下書き済みを聞き直さず、前からの分と新しい分を分けて並べる", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 2);
    expect(s).toContain("orca-flow respond drafts $0");
    expect(s).toMatch(/答え済み[^\n]*下書き済み[^\n]*聞き直さずに進める/);
    expect(s).toMatch(/新しい分だけを[^\n]*合議にかけ/);
    expect(s).toContain("「前からの分」と「新しい分」を分けて並べる");
    expect(s).toMatch(
      /新しい分がなければ[^\n]*起こされる前にしていた手順[^\n]*に戻る/,
    );
  });

  it("答え済みでも新しい返信があれば新しい分として聞き、戻り先は元の手順で、答え待ちなら question にし直す", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 2);
    expect(s).toMatch(
      /答え済みでも[^\n]*新しい返信がある[^\n]*新しい分として人に聞く/,
    );
    expect(s).toMatch(
      /起こされる前にしていた手順[^\n]*`orca-flow status question --note …` にし直して待つ/,
    );
    const spec = (await read("docs/spec.md"))
      .split("\n")
      .find((l) => l.startsWith("**respond の手順**"));
    expect(spec).toMatch(
      /答え済みでも[^。]*新しい返信がある[^。]*新しい分として人に聞く/,
    );
    expect(spec).toMatch(/`orca-flow status question --note …` にし直して待つ/);
  });

  it("答え済みは、最後の書き手が自分でなく返信の数が聞いたときより多いときだけ新しい分にする", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 2);
    expect(s).toMatch(
      /答え済みでも[^\n]*最後の書き手が自分でなく[^\n]*返信の数」が聞いたときの数より多い[^\n]*新しい分として人に聞く/,
    );
    expect(s).toMatch(/答え済みには[^\n]*この会話で人が答えた指摘/);
    expect(s).toMatch(
      /数のない古い引き継ぎ[^\n]*\n?[^\n]*自分の返信があり[^\n]*最後の書き手が自分でない/,
    );
    expect(s).toContain("区切りの外");
    const spec = (await read("docs/spec.md"))
      .split("\n")
      .find((l) => l.startsWith("**respond の手順**"));
    expect(spec).toMatch(
      /最後の書き手が自分でなく[^。]*返信の数が聞いたときの数より多い/,
    );
    expect(spec).toMatch(/この会話で人が答えたもの/);
    expect(spec).toMatch(/数のない古い引き継ぎは[^。]*自分の返信があって/);
  });

  it("数のない古い引き継ぎの見分けにかぎり、区切りの中の名札を使ってよい", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 2);
    expect(s).toMatch(
      /数のない古い引き継ぎ[^\n]*この見分けにかぎり名札を使ってよい[^\n]*聞き落としにはならない/,
    );
    const spec = (await read("docs/spec.md"))
      .split("\n")
      .find((l) => l.startsWith("**respond の手順**"));
    expect(spec).toMatch(
      /数のない古い引き継ぎは[^。]*。[^。]*この見分けにかぎり名札を使ってよい/,
    );
  });

  it("引き継ぎの答え済みの指摘に聞いたときの返信の数があり、中身の箇条は6つのまま", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 6);
    expect(s).toMatch(/答え済みの指摘：[^\n]*聞いたときの返信の数/);
    const bullets = s.split("\n").filter((l) => l.startsWith("   - "));
    expect(bullets).toHaveLength(6);
    const spec = await read("docs/spec.md");
    const lines = spec.split("\n");
    expect(lines.find((l) => l.startsWith("- `handoff/"))).toMatch(
      /答え済みの指摘（[^）]*聞いたときの返信の数）/,
    );
    expect(lines.find((l) => l.startsWith("**respond の手順**"))).toMatch(
      /⑩[^。]*答え済みの指摘（[^）]*聞いたときの返信の数/,
    );
  });

  it("聞き直して答えが来たら数とキーを書き直し、読み直した数は写さない", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 6);
    expect(s).toMatch(
      /答え済みの指摘：[^\n]*聞き直して答えが来たら[^\n]*返信の数と答えのキー[^\n]*書き直す/,
    );
    expect(s).toMatch(
      /答え済みの指摘：[^\n]*聞いたあとに読み直した数は写さない/,
    );
    expect(s.split("\n").filter((l) => l.startsWith("   - "))).toHaveLength(6);
    const lines = (await read("docs/spec.md")).split("\n");
    const handoff = lines.find((l) => l.startsWith("- `handoff/"));
    expect(handoff).toMatch(/聞き直して答えが来たら[^。]*書き直す/);
    expect(handoff).toMatch(/読み直した数は写さない/);
    const flow = lines.find((l) => l.startsWith("**respond の手順**"));
    expect(flow).toMatch(/⑩.*聞き直して答えが来たら[^。]*書き直す/);
    expect(flow).toMatch(/⑩[^⑪]*読み直した数は写さない/);
  });

  it("比べる相手は最後に聞いたときの数で、返信の数は自分の下書きを数えない", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 2);
    expect(s).toMatch(/比べる相手は[^\n]*最後に聞いたときの入力ファイルの数/);
    expect(s).not.toContain("この会話で人に聞いたときの入力ファイルの数");
    expect(s).toMatch(/返信の数」は[^\n]*自分の保留中の下書きは数えない/);
    const lines = (await read("docs/spec.md")).split("\n");
    const flow = lines.find((l) => l.startsWith("**respond の手順**"));
    expect(flow).toMatch(/⑪.*最後に聞いたときの数/);
    expect(flow).toMatch(/⑪.*自分の保留中の下書きは数えない/);
    expect(lines.find((l) => l.startsWith("- `respond/"))).toMatch(
      /「返信の数：N 件」[^。]*自分の保留中の下書きは数えない/,
    );
  });

  it("引き継ぎは仕様書6章でも答え済み・下書き済み・答え待ちを含む", async () => {
    const line = (await read("docs/spec.md"))
      .split("\n")
      .find((l) => l.startsWith("- `handoff/"));
    expect(line).toMatch(
      /答え済みの指摘[^。]*下書き済みの返信[^。]*聞いて答え待ちの指摘/,
    );
  });

  it("status question を流す指示は6つの中身の箇条の外にある", async () => {
    const s = step(await read("skills/respond/SKILL.md"), 6);
    const l = s.split("\n").find((x) => x.includes("status question --note"));
    expect(l?.trimStart().startsWith("- ")).toBe(false);
  });

  it("手順の番号は12まで変わらない", async () => {
    const text = await read("skills/respond/SKILL.md");
    const nums = text
      .split("\n")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n) => n !== undefined);
    expect(nums).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  });
});

describe("仕様書：人の答え待ち", () => {
  it("8章の起こし方に、待つ条件と外れた次の回に起こすことがある", async () => {
    const text = await read("docs/spec.md");
    const line = text
      .split("\n")
      .find((l) => l.startsWith("- 人の答え待ち（キー `question`"));
    expect(line, "人の答え待ちの項がありません").toBeDefined();
    expect(line).toContain("人の答えを待っています");
    expect(line).toContain("段の記録");
    expect(line).toMatch(/最後の行が `question`/);
    expect(line).toContain("ターミナルが見つかるとき");
    expect(line).toMatch(
      /ターミナルが見つからないとき[^。]*新しい会話を立てる/,
    );
    expect(line).toMatch(/上限は設けず/);
    expect(line).toMatch(/外れた次の回に[^。]*起こす/);
    expect(line).toMatch(
      /`question` のまま残ったとき[^。]*\/orca-flow:respond[^。]*`responding` に戻って続く/,
    );
  });

  it("10.1の respond の手順に、question・引き継ぎ・前からの分と新しい分がある", async () => {
    const text = await read("docs/spec.md");
    const para = text
      .split("\n")
      .find((l) => l.startsWith("**respond の手順**"));
    expect(para).toBeDefined();
    expect(para).toContain("`orca-flow status question --note …` にし");
    expect(para).toContain("`status responding` に戻す");
    expect(para).toMatch(/案を積んだあと[^。]*`question` にしない/);
    expect(para).toMatch(
      /答え済みの指摘[^。]*下書き済みの返信[^。]*聞いて答え待ちの指摘/,
    );
    expect(para).toContain("「前からの分」と「新しい分」を分けて並べる");
  });
});
