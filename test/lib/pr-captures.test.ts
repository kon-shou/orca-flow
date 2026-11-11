import {
  mkdir,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPTURES_CLOSE,
  buildCapturesSection,
  capturesDigest,
  capturesDigestOf,
  collectCaptures,
  replaceCapturesSection,
  stageCaptures,
} from "../../src/lib/pr-captures.ts";
import { tempDir } from "../helpers/repo.ts";

async function capturesDir(files: Record<string, string | number>) {
  const dir = await tempDir("orca-flow-captures-");
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (typeof content === "number") {
      await writeFile(file, "");
      await truncate(file, content);
    } else await writeFile(file, content);
  }
  return dir;
}

describe("録画を拾う", () => {
  it("前と後がそろった流れだけを名前の順に拾い、前・後の順に並べる", async () => {
    const dir = await capturesDir({
      "zeta-after.webm": "z2",
      "zeta-before.webm": "z1",
      "alpha-before.mp4": "a1",
      "alpha-after.gif": "a2",
      "note.txt": "x",
      "alpha-after.webm.123.tmp": "t",
    });
    const { captures, warnings } = await collectCaptures(dir);
    expect(warnings).toEqual([]);
    expect(captures.map((c) => [c.flow, c.side, c.name, c.size])).toEqual([
      ["alpha", "before", "alpha-before.mp4", 2],
      ["alpha", "after", "alpha-after.gif", 2],
      ["zeta", "before", "zeta-before.webm", 2],
      ["zeta", "after", "zeta-after.webm", 2],
    ]);
    expect(captures[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(captures[0]!.path).toBe(path.join(dir, "alpha-before.mp4"));
  });

  it("片方だけの流れと上限を超える録画は載せず、流れの名前つきで警告する（パスは書かない）", async () => {
    const dir = await capturesDir({
      "only-before.webm": "x",
      "big-before.webm": "x",
      "big-after.webm": 10_000_001,
      "ok-before.webm": "x",
      "ok-after.webm": 10_000_000,
    });
    const { captures, warnings } = await collectCaptures(dir);
    expect(captures.map((c) => c.name)).toEqual([
      "ok-before.webm",
      "ok-after.webm",
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings.find((w) => w.includes("only"))).toContain("片方");
    expect(warnings.find((w) => w.includes("big"))).toContain(
      "10,000,000 バイト",
    );
    for (const w of warnings) expect(w).not.toContain(dir);
  });

  it("シンボリックリンクは拾わない。置き場がなければ空", async () => {
    const outside = await capturesDir({ "secret.webm": "s" });
    const dir = await capturesDir({ "f-before.webm": "x" });
    await symlink(
      path.join(outside, "secret.webm"),
      path.join(dir, "f-after.webm"),
    );
    const { captures, warnings } = await collectCaptures(dir);
    expect(captures).toEqual([]);
    expect(warnings[0]).toContain("f");
    expect(await collectCaptures(path.join(dir, "none"))).toEqual({
      captures: [],
      warnings: [],
    });
  });
});

describe("本文の録画の節", () => {
  const sample = async () =>
    (
      await collectCaptures(
        await capturesDir({
          "cart-before.webm": "1",
          "cart-after.webm": "2",
        }),
      )
    ).captures;

  it("印の2行で囲み、参照はファイル名だけで、動画は段落に1つだけ置く", async () => {
    const captures = await sample();
    const section = buildCapturesSection(captures);
    const lines = section.split("\n");
    expect(lines[0]).toBe(
      `<!-- orca-flow:captures ${capturesDigest(captures)} -->`,
    );
    expect(lines.at(-1)).toBe("<!-- /orca-flow:captures -->");
    expect(capturesDigest(captures)).toMatch(/^[0-9a-f]{16}$/);
    const refs = lines.filter((l) => l.startsWith("!["));
    expect(refs).toEqual(["![](cart-before.webm)", "![](cart-after.webm)"]);
    for (const ref of refs) {
      const i = lines.indexOf(ref);
      expect(lines[i - 1]).toBe("");
      expect(lines[i + 1]).toBe("");
    }
    expect(section).not.toContain(path.sep + "cart-");
    expect(capturesDigestOf(`前\n${section}\n後`)).toBe(
      capturesDigest(captures),
    );
    expect(capturesDigestOf("印なし")).toBeNull();
  });

  it("録画が変わると印の値が変わる", async () => {
    const captures = await sample();
    const changed = captures.map((c, i) =>
      i === 0 ? { ...c, sha256: "0".repeat(64) } : c,
    );
    expect(capturesDigest(changed)).not.toBe(capturesDigest(captures));
    // 手元のパスは値に入らない
    const moved = captures.map((c) => ({ ...c, path: "/elsewhere" }));
    expect(capturesDigest(moved)).toBe(capturesDigest(captures));
  });

  it("差し替えは印の中だけで、ほかの本文は1文字も変わらない。なければ末尾に足す", async () => {
    const captures = await sample();
    const section = buildCapturesSection(captures);
    const old = `<!-- orca-flow:captures ${"f".repeat(16)} -->\n古い https://github.com/user-attachments/assets/x\n${CAPTURES_CLOSE}`;
    const head = "## 概要\r\n人が直した  本文\r\n\r\n";
    const tail = "\r\n\r\n## あと\r\n末尾";
    expect(replaceCapturesSection(`${head}${old}${tail}`, section)).toBe(
      `${head}${section}${tail}`,
    );
    expect(replaceCapturesSection("本文\n", section)).toBe(
      `本文\n\n${section}\n`,
    );
    expect(replaceCapturesSection("本文", section)).toBe(
      `本文\n\n${section}\n`,
    );
    expect(replaceCapturesSection("本文\n\n", section)).toBe(
      `本文\n\n${section}\n`,
    );
  });

  it("終わりの印がなければ差し替えない", () => {
    expect(
      replaceCapturesSection(
        `前\n<!-- orca-flow:captures ${"a".repeat(16)} -->\n人の文`,
        "節",
      ),
    ).toBeNull();
  });
});

describe("録画を一時ディレクトリへ写す", () => {
  it("大きさと sha256 が合えば写し、変わった・消えた録画は名前だけを理由にする", async () => {
    const dir = await capturesDir({
      "cart-before.webm": "1",
      "cart-after.webm": "2",
    });
    const { captures } = await collectCaptures(dir);
    const dest = await tempDir("orca-flow-stage-");
    expect(await stageCaptures(dir, captures, dest)).toBeNull();
    expect(await readFile(path.join(dest, "cart-after.webm"), "utf8")).toBe(
      "2",
    );

    await writeFile(path.join(dir, "cart-after.webm"), "3");
    const changed = await stageCaptures(
      dir,
      captures,
      await tempDir("orca-flow-stage-"),
    );
    expect(changed).toContain("cart-after.webm");
    expect(changed).toContain("変わって");
    expect(changed).not.toContain(dir);

    const empty = await tempDir("orca-flow-captures-");
    await mkdir(empty, { recursive: true });
    const missing = await stageCaptures(
      empty,
      captures,
      await tempDir("orca-flow-stage-"),
    );
    expect(missing).toContain("ありません");
    expect(missing).not.toContain(empty);

    const bad = await stageCaptures(
      dir,
      [{ ...captures[0]!, name: "../x-before.webm" }],
      await tempDir("orca-flow-stage-"),
    );
    expect(bad).toContain("形が正しくありません");
  });
});
