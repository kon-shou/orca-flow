import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

// 承認の門を通るコマンドを「引数つきで流す」見分け方：行内コードに限らず、
// パスつき・環境変数つき・コードブロックの中も含め、`orca-flow send`・
// `orca-flow merge` のあとに `*` 以外の引数が続く形を拾う。「流さない」と書くだけの
// `orca-flow send`（引数なし）や、許可の案内の `Bash(orca-flow send *)` は当たらない。
// 引数を引用符で囲む形（`orca-flow send "$0" …`）と、一重引用符で囲んだパスの形にも当たる。
const GATED_CALL =
  /orca-flow["']?\s+(?:send|merge)\s+(?!\*)(?:["'][^"'\s]|[^\s`"')])/;

// 予備のパス（フルパスや ${CLAUDE_PLUGIN_ROOT}）で send・merge を呼ぶ形。
// `${CLAUDE_PLUGIN_ROOT}/skills/send/SKILL.md` のような参照には当たらない。
const FALLBACK_CALL =
  /(?:bin\/|CLAUDE_PLUGIN_ROOT[^\n]*?)orca-flow["']?\s+(?:send|merge)\b/;

async function skillFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(path.join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(rel);
      else if (e.name.endsWith(".md")) out.push(rel);
    }
  }
  await walk("skills");
  return out.sort();
}

describe("承認の門の見分け方", () => {
  it("引数を引用符で囲む形と、引用符で囲んだパスの形にも当たる", () => {
    expect(GATED_CALL.test('orca-flow send "$0" --expect x')).toBe(true);
    expect(GATED_CALL.test("orca-flow merge 'T12' --head x")).toBe(true);
    expect(GATED_CALL.test("'/a/bin/orca-flow' send T12")).toBe(true);
    expect(FALLBACK_CALL.test("'/a/bin/orca-flow' send T12")).toBe(true);
    expect(
      FALLBACK_CALL.test('"${CLAUDE_PLUGIN_ROOT}/bin/orca-flow" merge T1'),
    ).toBe(true);
    expect(GATED_CALL.test("Bash(orca-flow send *)")).toBe(false);
    expect(GATED_CALL.test("`orca-flow send` は流さない")).toBe(false);
  });
});

describe("承認の門を通るスキル", () => {
  it("send のスキルは予備のパスを書かず、見つからなければ止まる", async () => {
    const text = await read("skills/send/SKILL.md");
    expect(text).not.toContain("bin/orca-flow");
    expect(text).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(text).toMatch(/見つからな[^\n]*止まる/);
    expect(text).toContain("/reload-plugins");
  });

  it("見分け方：引数つきで send を流すのは send のスキルだけ、merge を流すのは merge のスキルだけ", async () => {
    const hits: string[] = [];
    const mergeHits: string[] = [];
    const sendHits: string[] = [];
    for (const rel of await skillFiles()) {
      const text = await read(rel);
      if (GATED_CALL.test(text)) hits.push(rel);
      if (/orca-flow["']?\s+merge\s+(?!\*)(?:["'][^"'\s]|[^\s`"')])/.test(text))
        mergeHits.push(rel);
      if (/orca-flow["']?\s+send\s+(?!\*)(?:["'][^"'\s]|[^\s`"')])/.test(text))
        sendHits.push(rel);
    }
    expect(hits).toEqual(["skills/merge/SKILL.md", "skills/send/SKILL.md"]);
    expect(mergeHits).toEqual(["skills/merge/SKILL.md"]);
    expect(sendHits).toEqual(["skills/send/SKILL.md"]);
  });

  it("エージェントのスキルは gh pr merge を流さない（書くのは「流さない」の行だけ）", async () => {
    for (const rel of await skillFiles()) {
      const lines = (await read(rel)).split("\n");
      for (const line of lines) {
        if (!line.includes("gh pr merge")) continue;
        expect(line, `${rel}：${line}`).toMatch(/流さない|打たない|使わない/);
      }
    }
  });

  it("push・send・auto のスキルは、マージは /orca-flow:merge と書き、gh pr merge と orca-flow merge を流さない", async () => {
    for (const rel of [
      "skills/push/SKILL.md",
      "skills/send/SKILL.md",
      "skills/auto/SKILL.md",
    ]) {
      const text = await read(rel);
      expect(text, rel).toContain("/orca-flow:merge");
      expect(text, rel).not.toContain("マージは人が GitHub で行う");
      expect(text, rel).not.toContain("人間が GitHub で行う");
    }
    for (const rel of ["skills/push/SKILL.md", "skills/send/SKILL.md"]) {
      expect(await read(rel), rel).toContain(
        "`gh pr merge` と `orca-flow merge` を流さない",
      );
    }
  });

  it("init のスキルは、ブランチの保護を勧め、ask に merge を足すことを案内する", async () => {
    const text = await read("skills/init/SKILL.md");
    expect(text).toContain("ブランチの保護");
    expect(text).toContain("必須レビュー");
    expect(text).toContain("Bash(orca-flow merge *)");
    expect(text).toContain("send と merge を使わない");
  });

  it("merge のスキルは、人だけが打ち、--show のあと --head つきで流し、予備のパスや bash -c を使わず、PATH になければ止まる", async () => {
    const text = await read("skills/merge/SKILL.md");
    expect(text).toMatch(/^name: merge$/m);
    expect(text).toMatch(/^disable-model-invocation: true$/m);
    expect(text).toContain("orca-flow merge $0 --show");
    expect(text).toContain("orca-flow merge $0 --head 〈見せた先頭〉");
    expect(text.indexOf("orca-flow merge $0 --show")).toBeLessThan(
      text.indexOf("orca-flow merge $0 --head 〈見せた先頭〉"),
    );
    expect(text).toMatch(/見つからな[^\n]*止まる/);
    expect(text).toContain("/reload-plugins");
    expect(text).toContain("許可の画面");
    expect(text).toMatch(/1回目[^\n]*読むだけ/);
    expect(text).toMatch(/落ちたとき[^\n]*理由[^\n]*伝えて止まる/);
    expect(text).not.toContain("bin/orca-flow");
    expect(text).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(text).not.toMatch(/bash -c\s+['"]?\s*orca-flow/);
    // 包まず流す決まり
    expect(text).toMatch(/`bash -c` などで包まず/);
  });

  it("見分け方：当たる形", () => {
    const hit = [
      "`orca-flow send 1 --expect a --head b`",
      "`orca-flow merge 1`",
      '`"${CLAUDE_PLUGIN_ROOT}/bin/orca-flow" send T01 --expect a --head b`',
      "/x/bin/orca-flow send T01 --expect a --head b",
      "FOO=1 orca-flow send T01 --expect a --head b",
      "```\norca-flow send T01 --expect a\n```",
    ];
    for (const t of hit) expect(GATED_CALL.test(t), t).toBe(true);
  });

  it("見分け方：流さないと書くだけの行と許可の案内は当たらない", () => {
    const miss = [
      "`orca-flow send` は打たない",
      "`Bash(orca-flow send *)`",
      "`Bash(orca-flow merge *)`",
    ];
    for (const t of miss) expect(GATED_CALL.test(t), t).toBe(false);
  });

  it("予備のパスの形：フルパスで send・merge を呼ぶ形に当たり、参照には当たらない", () => {
    expect(
      FALLBACK_CALL.test('"${CLAUDE_PLUGIN_ROOT}/bin/orca-flow" send T01'),
    ).toBe(true);
    expect(FALLBACK_CALL.test("/x/bin/orca-flow send T01")).toBe(true);
    expect(FALLBACK_CALL.test("/x/bin/orca-flow merge T01")).toBe(true);
    expect(
      FALLBACK_CALL.test("${CLAUDE_PLUGIN_ROOT}/skills/send/SKILL.md"),
    ).toBe(false);
  });

  it("skills/ の下のどの .md も、予備のパスで send・merge を呼ばない", async () => {
    for (const rel of await skillFiles()) {
      expect(FALLBACK_CALL.test(await read(rel)), rel).toBe(false);
    }
  });

  it("引数つきで send・merge を流すスキルは、予備のパス bin/orca-flow を書かない", async () => {
    for (const rel of await skillFiles()) {
      const text = await read(rel);
      if (!GATED_CALL.test(text)) continue;
      expect(text, rel).not.toContain("bin/orca-flow");
      expect(text, rel).not.toContain("CLAUDE_PLUGIN_ROOT");
    }
  });
});

describe("仕様書の承認の門", () => {
  it("7章の7番に、予備のパスで呼ばない決まりがある", async () => {
    const spec = await read("docs/spec.md");
    const start = spec.indexOf("## 7. 競合を防ぐ決まり");
    const end = spec.indexOf("## 8. CLI");
    const sec7 = spec.slice(start, end);
    expect(sec7).toMatch(/予備のパス[^\n]*呼ばない/);
  });

  it("8章に、add と withdraw も同じロックを取る決まりがある", async () => {
    const spec = await read("docs/spec.md");
    expect(spec).toMatch(/`add`・`withdraw` も[^\n]*ロック/);
  });
});
