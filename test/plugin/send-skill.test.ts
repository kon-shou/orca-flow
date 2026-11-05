import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

function frontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(0);
  const out: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1] as string] = (m[2] ?? "").replace(/^"|"$/g, "");
  }
  return out;
}

describe("/orca-flow:send のスキル", () => {
  it("name が send で、disable-model-invocation: true", async () => {
    const fm = frontmatter(await read("skills/send/SKILL.md"));
    expect(fm.name).toBe("send");
    expect(fm["disable-model-invocation"]).toBe("true");
    expect(fm.description).toBeTruthy();
  });

  it("手順が outbox show → send --expect --head の順", async () => {
    const text = await read("skills/send/SKILL.md");
    const show = text.indexOf("orca-flow outbox show");
    const send = text.search(/orca-flow send [^\n]*--expect[^\n]*--head/);
    expect(show).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(show);
    expect(text).toMatch(/^1\. .*outbox show/m);
    expect(text).toMatch(/^2\. .*send .*--expect/m);
  });

  it("落ちたら理由を伝えて止まる。bash -c などで包まない。会話を閉じる命令は流さない（閉じるのは send の中）", async () => {
    const text = await read("skills/send/SKILL.md");
    expect(text).toMatch(/落ちた[^\n]*理由[^\n]*止まる/);
    expect(text).toContain("bash -c");
    expect(text).toMatch(/包まず/);
    expect(text).not.toMatch(/terminal close/);
  });

  it("最後の手順で、会話を閉じた結果と閉じなかった理由の伝え方を書く", async () => {
    const text = await read("skills/send/SKILL.md");
    const steps = text.split("\n").filter((l) => /^\d+\. /.test(l));
    const last = steps[steps.length - 1]!;
    expect(last).toContain("会話");
    expect(last).toContain("閉じ");
    expect(last).toContain("閉じませんでした");
    expect(last).toMatch(/タスク長/);
    expect(last).toMatch(/自分で閉じ/);
    // 打ち直すのは積んだ案が残っているときだけ。それ以外は Orca で閉じる
    expect(last).toContain("残っているときだけ");
    expect(last).toContain("Orca で閉じる");
    expect(text).not.toMatch(/orca terminal close/);
  });

  it("おまかせのスキルが send を打たないと書いている", async () => {
    const text = await read("skills/auto/SKILL.md");
    expect(text).toMatch(/send は打たない/);
  });
});
