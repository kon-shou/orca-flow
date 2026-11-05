import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (file: string) => readFile(path.join(ROOT, file), "utf8");

const CARD_NOTE = "（起こしません：手で開いた PR です）";
const ENTRY =
  "統括役のタブで `/orca-flow:push 〈ID〉` と `/orca-flow:send 〈ID〉` を通す";

function lineWith(text: string, head: string): string {
  const line = text.split("\n").find((l) => l.startsWith(head));
  expect(line, `「${head}」で始まる行がありません`).toBeDefined();
  return line ?? "";
}

describe("手で開いた PR は respond の対象外（仕様書とスキル）", () => {
  it("4章の項：見張りは手で開いた PR でタスク長を起こさない", async () => {
    const spec = await read("docs/spec.md");
    const line = lineWith(spec, "- 状態と印は、`taskEnd` によらず使う。");
    expect(line).toContain("手で開いた PR");
    expect(line).toContain("起こさない");
    const resp = lineWith(spec, "- `responding` は、push の記録");
    expect(resp).toContain("手で開いた PR は respond の対象外");
  });

  it("8章の status の行：断る文に対象外と入り方がある", async () => {
    const spec = await read("docs/spec.md");
    const line = lineWith(spec, "| `status 〈状態〉 [--note 〈一言〉]`");
    expect(line).toContain("手で開いた PR は respond の対象外");
    expect(line).toContain(ENTRY);
  });

  it("『起こし方』：起こす PR の条件の行とカードの一言の固定の文", async () => {
    const spec = await read("docs/spec.md");
    const line = lineWith(spec, "- 起こす PR：");
    expect(line).toContain("push の記録の PR と同じ番号");
    expect(line).toContain("記録がない");
    expect(line).toContain(CARD_NOTE);
    expect(line).toContain("会話の記録も消す");
  });

  it("10.1 の respond の手順の①：止まったときの扱い", async () => {
    const spec = await read("docs/spec.md");
    const line = lineWith(spec, "**respond の手順**");
    expect(line).toContain("終了コード1で止まったら");
    expect(line).toContain("手で開いた PR は respond の対象外");
    expect(line).toContain(ENTRY);
  });

  it("スキルの手順1：status responding が終了コード1なら止まって伝える", async () => {
    const skill = await read("skills/respond/SKILL.md");
    const step = lineWith(skill, "1. 始めに");
    expect(step).toContain("終了コード1");
    expect(step).toContain("先へ進まず");
    expect(step).toContain("手で開いた PR は respond の対象外");
    expect(step).toContain(ENTRY);
  });
});
